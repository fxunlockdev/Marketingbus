# Stripe billing release 16 October 2026

## Scope

This release adds the concrete Stripe adapter, operator refund and event-recovery procedures, and checkout/refund status in Credits. It does not activate live payments or complete all seven product modules. Connections remains publishing-only.

The adapter verifies raw webhook signatures, freshness, account, live/test mode, API snapshot version, immutable event evidence, provider payment state and frozen workspace/price terms. Monthly subscription and one-time top-up grants share the existing durable inbox and credit ledger. Browser returns never allocate credits. Portal configuration permits cancellation at period end but rejects subscription plan changes. Tax, discount, proration and dispute policy remain release gates.

Refund operations are durably recorded before submission. Unknown outcomes block new attempts; an operator may look up the exact existing operation without another monetary request. Verified refund webhooks, not refund-request responses, reclaim credits. Event recovery independently retrieves provider evidence and cannot bypass conflicting terms or create arbitrary credits. See [billing configuration and procedures](BILLING.md).

## Local acceptance

- 336 tests pass across 36 unit/database suites on an explicitly local PostgreSQL database.
- 23 browser journeys pass; one private-storage journey is skipped without test-bucket credentials.
- The billing browser journey verifies forged return parameters do not grant credits, owner/viewer boundaries, hidden operator evidence, refund uncertainty, current records, automated accessibility and mobile width.
- Production build and type checking pass. The dependency audit reports zero known vulnerabilities at this verification time.
- Test fixtures inject Stripe HTTP responses while using actual SDK signature verification. No live Stripe calls, charges, refunds, AI generation, emails or social posts were made.
- A signature-expiry test initially crossed a real-time boundary; the boundary test now freezes the clock and the complete suite passes.

The mobile billing status screenshot is saved in `../outputs/marketingbus-billing-status.png`. It contains local test records, not a real payment.

## Deployment

Pending release verification. Runtime is `studio-v14-stripe-billing`. Both web and worker must deploy together. Additive migrations `20261016173000_stripe_refunds` and `20261016174000_billing_reconciliation` bring the total to 27. Existing production data is retained; no fixture records or payment configuration are deployed.

## Remaining acceptance

Actual Stripe test-mode and live-account acceptance, webhook setup, commercial margin/tax/discount/dispute policy, settlement reconciliation and an operator dashboard remain. Generated video/audio, official social adapters, measured learning, Firecrawl deployment and enterprise assurance are separate unfinished modules. Test counts do not establish creative quality or production security certification.
