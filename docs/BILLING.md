# Billing implementation and integration contract

Payments are disabled while `paymentAdapter()` returns null. No public route can grant credits, choose an adapter or submit trusted normalized payment data. `BILLING_OFFERS_JSON=[]` means there are no offers on sale. Customers manage billing through Credits; provider keys remain server-side.

## Offer and checkout rules

Each configured offer has `id`, `name`, `kind` (`SUBSCRIPTION` or `TOPUP`), `currency` (`usd`), `amountMinor`, `generalCredits` and `revisionCredits`. Subscription offers are monthly. No price is inferred from a browser submission. Terms are copied to a checkout and reused across retries; a timeout does not create a new payment attempt. Existing non-cancelled subscriptions must be managed rather than duplicated. Returned destinations are restricted to HTTPS Stripe checkout/portal hosts.

The adapter must use the internal checkout ID as the provider idempotency key, enforce expiry and frozen price terms, and bind the provider checkout/customer to that workspace. No credit grant occurs on checkout creation or a browser return URL.

## Payment inbox and worker

The raw webhook route bounds actual bytes to 256 KB and delegates signature verification before durable ingestion. The adapter must verify signature timestamp, account and live/test mode, retrieve authoritative paid/refund state where necessary, and normalize events consistently. IDs must be stable within the configured provider account. Renewal events use the subscription mapping and no new checkout ID; initial payments carry the internal checkout ID.

Event IDs are immutable and digest-checked. Database conflict handling makes concurrent delivery safe. A network-free transaction serializes payment applications, then locks the wallet. Rejected events roll back to a savepoint before being marked for review. A missing predecessor retries hourly up to 24 attempts; unresolved or mismatched events remain `NEEDS_REVIEW`. General database failures leave the event pending for retry.

Successful payments grant once per payment ID. Subscription renewals additionally grant once per period start. Amount/currency/offer mismatches do not grant credits. Provider discounts, taxes or prorations require explicit adapter/commercial policy; do not silently normalize an unexpected amount into a full grant. Subscription updates are ordered by provider event time.

## Credit and refund accounting

Initial production cannot consume protected revision credits. Revisions consume their protected pool first, then general credits. Settlement releases unused amounts to their original pools. Refund processing uses the successful cumulative refunded amount, reclaims the corresponding proportional credits, and ignores older cumulative values. A fully refunded payment reclaims its whole allocation.

If credits are already held or spent, an unpaid adjustment is recorded as debt rather than a negative spendable balance. New work is blocked while debt remains. Reservation releases and future grants repay the corresponding debt first. Existing authorized jobs are not silently cancelled. Credit history records grants, reservations, consumption, release and refund reclamation.

## Remaining release work

Connect and test the Stripe adapter, customer portal, cancellation/renewal behavior, refund initiation, disputed payments, tax/discount handling and operator reconciliation. Do not activate offers before these policies are verified. The current code processes verified refund outcomes; it does not itself initiate a monetary refund. No live payments or refunds were made by the local tests.
