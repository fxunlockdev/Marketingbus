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

Source `d5cb6155a88ec56f8cb4e6687fd26b933195b683` is pushed to GitHub and deployed on both services. Runtime is `studio-v14-stripe-billing`.

| Service | Deployment | Observed result |
|---|---|---|
| Web | `056005dd-9cfb-4ddd-953b-da89ac21b424` | SUCCESS |
| Worker | `e7965a9d-2a54-4f7e-982d-b08856f68836` | SUCCESS |

Both startup logs report 27 migrations with none pending, including `20261016173000_stripe_refunds` and `20261016174000_billing_reconciliation`. Existing production data is retained; no fixture records or payment configuration were deployed. Hosted health returned 200 with no-store; signed-out studio access redirected to login; unauthenticated billing and publishing-connections requests returned 401. [GitHub CI run 38941026255](https://github.com/fxunlockdev/Marketingbus/actions/runs/38941026255) passed the complete test, build, browser and audit workflow for this source commit.

The deployed source includes a final compatibility correction for compound Stripe Checkout identifiers such as `cs_test_…`. Updated transport fixtures, all 336 tests, the production build and all 23 browser journeys pass after this correction. The earlier candidate deployment is superseded.

## Remaining acceptance

Actual Stripe test-mode and live-account acceptance, webhook setup, commercial margin/tax/discount/dispute policy, settlement reconciliation and an operator dashboard remain. Generated video/audio, official social adapters, measured learning, Firecrawl deployment and enterprise assurance are separate unfinished modules. Test counts do not establish creative quality or production security certification.
