# Billing implementation and integration contract

The Stripe adapter is implemented, with billing disabled by default. No public route can grant credits, choose an adapter or submit trusted normalized payment data. `BILLING_OFFERS_JSON=[]` means there are no offers on sale. Customers manage billing through Credits; provider keys remain server-side. Local transport fixtures are not registered in production.

## Configuration and activation

Set the following privately on both web and worker, initially in Stripe test mode:

- `BILLING_EXECUTION_ENABLED=true`, `STRIPE_MODE=test`, `STRIPE_ACCOUNT_ID`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
- `APP_ORIGIN` must be the exact HTTPS application origin. Only test mode permits localhost HTTP.
- `STRIPE_PORTAL_CONFIGURATION_ID` must identify an active configuration with subscription changes disabled and cancellation enabled at period end. The adapter validates these settings before creating a portal session.
- `BILLING_OFFERS_JSON` is the server-owned offer catalog. Every Stripe offer needs an exact `stripePriceId`; monthly licensed quantity-one prices and one-time top-ups are supported. No default credit quantity or $800-plan margin is inferred.
- Keep `STRIPE_REFUNDS_ENABLED=false` until operator refunds are explicitly authorized. This is independent of customer checkout activation.

The transport and webhook snapshot contract is pinned to `2024-06-20`. Configure the webhook destination at `/api/billing/webhook` with that API version. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `charge.refunded`. Dispute and credit-note events are recorded for review if delivered; they do not implement a dispute-resolution policy. Unowned or unrelated supported events are acknowledged without grants.

Checkout requires a fresh worker heartbeat matching the web runtime and billing configuration. Deploy both services together after migrations. A browser return opens Credits but cannot confirm payment or allocate credits. The status screen distinguishes open, uncertain, expired and verified checkouts and exposes only scoped refund status, not operator evidence or provider secrets.

## Offer and checkout rules

Each configured offer has `id`, `name`, `kind` (`SUBSCRIPTION` or `TOPUP`), `currency` (`usd`), `amountMinor`, `generalCredits`, `revisionCredits` and `stripePriceId`. Subscription offers are monthly. No price is inferred from a browser submission. Terms are copied to a checkout and reused across retries; a timeout does not create a new payment attempt. Existing non-cancelled subscriptions must be managed rather than duplicated. Returned destinations are restricted to HTTPS Stripe checkout/portal hosts.

The adapter uses the internal checkout ID in the provider idempotency key, enforces expiry and frozen price terms, and binds the provider checkout/customer to that workspace. Price IDs and a hash of frozen terms travel in provider metadata. Paid events must match this binding before credit allocation. Current workspace membership is checked again before a newly created checkout or portal URL is released.

## Payment inbox and worker

The raw webhook route bounds actual bytes to 256 KB. Stripe's SDK verifies the exact raw bytes and signature; the adapter additionally checks timestamp, configured account, live/test mode and API version, rejects connected-account context, and retrieves authoritative immutable event evidence and current paid/refund state. Outbound requests use a fixed Stripe host, no redirects or automatic retries, a 10-second per-request timeout and a 256 KB streamed response ceiling. Renewal events use the subscription mapping and no new checkout ID; initial payments carry the internal checkout ID.

Event IDs are immutable and digest-checked. Database conflict handling makes concurrent delivery safe. A network-free transaction serializes payment applications, then locks the wallet. Rejected events roll back to a savepoint before being marked for review. A missing predecessor retries hourly up to 24 attempts; unresolved or mismatched events remain `NEEDS_REVIEW`. General database failures leave the event pending for retry.

Successful payments grant once per payment ID. Subscription renewals additionally grant once per line-item period start. Amount/currency/offer mismatches do not grant credits. Manually marked paid invoices and incompatible payment intents are rejected. Provider discounts, taxes, prorations and multiple lines are held for review; they are not silently normalized into full grants. Subscription updates are ordered by provider event time, terminal cancellation wins same-second ordering, and delayed paid events cannot reactivate a cancelled subscription.

## Credit and refund accounting

Initial production cannot consume protected revision credits. Revisions consume their protected pool first, then general credits. Settlement releases unused amounts to their original pools. Refund processing uses the successful cumulative refunded amount, reclaims the corresponding proportional credits, and ignores older cumulative values. A fully refunded payment reclaims its whole allocation.

If credits are already held or spent, an unpaid adjustment is recorded as debt rather than a negative spendable balance. New work is blocked while debt remains. Reservation releases and future grants repay the corresponding debt first. Existing authorized jobs are not silently cancelled. Credit history records grants, reservations, consumption, release and refund reclamation.

## Operator refund requests

Refund requests are privileged server procedures, not customer HTTP actions. Before running one, confirm the exact workspace, verified payment, amount in minor currency units and support evidence. Generate one UUID for the logical operation and retain it:

```sh
npx tsx scripts/billing-refund.ts --id UUID --payment pi_PAYMENT --workspace WORKSPACE --amount-minor 1000 --operator OPERATOR --evidence "Approved support case reference" --confirm
```

The database records the operation before contacting Stripe. Concurrent requests or retries with the same UUID do not submit twice; changed replay terms are rejected. An uncertain or in-flight operation blocks additional requests for that payment. Never replace the UUID to retry an uncertain request. Inspect the existing outcome with:

```sh
npx tsx scripts/billing-refund.ts --id UUID --lookup
```

Lookup searches provider refunds for the exact operation metadata without creating a new refund. Missing evidence leaves the hold intact. A provider success updates refund status only; verified cumulative refund events separately reclaim credits. Refunds do not implicitly cancel a subscription. Manual refunds outside the app require timely webhook reconciliation; Stripe remains the authority for the remaining monetary balance.

## Operator payment recovery

The worker retries missing predecessors hourly up to 24 times. After investigating and resolving that dependency, an operator can retrieve and re-verify the original Stripe event:

```sh
npx tsx scripts/reconcile-billing.ts --id UUID --event evt_EVENT --operator OPERATOR --evidence "Resolved predecessor and support case" --confirm
```

This records an immutable operator audit, checks event digest and uses the same application lock as the worker. Already-applied events do not grant again. It can restart dependency retries, but cannot override unsupported commercial terms, mismatched payment bindings or arbitrary review decisions. The per-event operator retry allowance is 20. The application does not accept hand-written payment amounts or manual grants through this procedure.

## Read-only workspace credit integrity

Run `npm run ops:credits -- --organization WORKSPACE_ID` with operator database access to inspect one shared workspace wallet. Add `--check` for exit status 0 when the supported invariants balance, 2 when attention is required, or 1 on invalid scope/database/schema errors. No business-only or global fallback is accepted: credits belong to the workspace, not an individual business. This command is not a customer endpoint and does not authorize repair.

The report uses a PostgreSQL read-only repeatable-read transaction, three-second statement timeout and integer-safe lifetime sums. It checks:

- Net wallet credits (available + revision available + held − both debts) against grants − consumption − refund reclamation. Reserve/release entries transfer existing credits and are not counted twice.
- Held balance against active reservations, and each reservation's exact reserve, consume and unused-release entries, including zero consumption and mixed revision/general credits.
- Unsupported ledger entries and orphan reservation entries, with no cross-workspace matching.

Only fixed issue codes/counts and aggregate credit values are returned; entry keys, prompts, customer names and provider references are not printed. A timeout is an incomplete check, never a healthy result. The report scans the selected workspace's history without truncating totals; it is intended for bounded operator use, not per-request polling. It has no network client, accounting mutation, automatic hold release or retry behavior.

The conservation check assumes the application's zero opening wallet with every grant recorded. Historical manual balances without entries need investigation, not an automatic compensating grant. A balanced result does not verify authentic payments, correct general/revision allocation, provider invoices, taxes, disputes, cash settlement or creative delivery. Those acceptance gates remain below.

## Remaining release gates

Verify the UAE Stripe account, pinned webhook contract, actual test-mode checkout, renewal, cancellation, portal and refund lifecycle before enabling live offers. Define tax/discount, dispute handling and commercial margin policy; the current implementation rejects or holds unsupported terms rather than implementing those policies. A full operator dashboard, financial settlement reconciliation and alert routing remain. Credits carry forward with no expiration scheduler. No real payments or refunds were made by the automated tests or this release.

Contract references: [Stripe event endpoints](https://docs.stripe.com/events/set-up-events), [invoice snapshot](https://docs.stripe.com/api/invoices/object?api-version=2024-06-20), [Checkout creation](https://docs.stripe.com/api/checkout/sessions/create?api-version=2024-06-20), [refund creation](https://docs.stripe.com/api/refunds/create), and [portal configuration](https://docs.stripe.com/api/customer_portal/configurations/create).
