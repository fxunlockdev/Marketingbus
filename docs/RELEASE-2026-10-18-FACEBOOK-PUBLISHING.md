# Facebook Page text publishing release

Runtime: `studio-v26-facebook-publishing`. No new database migration. Source/CI/deployment identifiers will be recorded after verification; this document is not itself deployment evidence.

## Implemented

- Explicitly gated real Facebook text-publishing transport with app/token/Page/scope/posting-capability checks.
- Single durable submission fence, account-bound candidate IDs, exact post read-back and known-ID-only reconciliation. Unknown writes are never resent.
- Explicitly unavailable Facebook per-post metrics: no metric polling or fabricated snapshots. LinkedIn's existing post-metric collection remains supported.
- Shared safe-permalink helper separated from the provider registry to avoid runtime initialization cycles.
- Customer Connections remains publishing-only. No customer AI keys or production fixture adapters.

## Local verification

- 766 tests across 50 unit/database suites pass, including 45 new Facebook transport cases and four actual PostgreSQL worker/journal cases.
- 32 browser journeys pass; one private-storage journey remains skipped. The new receipt-display journey checks link safety, hidden submission context, unknown performance, automated accessibility and mobile width. It uses a local display fixture; transport/worker validation is in database tests.
- Production build and type checking pass; dependency audit reports zero known vulnerabilities.
- Synthetic local restoration passes 36 migrations, 52 tables and 68 rows, including uncertain-publication state, candidate journal constraints and retained/missing-key behavior. Both temporary databases were removed. This is not production recovery or object-storage acceptance.
- An initial production build detected a circular import; extracting the dependency-free permalink validator fixed it. The initial parallel regression run saw four account-data failures before that fix; the complete post-fix run passes all 766 tests.

## Remaining boundaries

No real Facebook post, provider authentication, paid AI request, email, payment or refund was performed. No budgets, provider flags or infrastructure resources were changed. Facebook/Instagram per-post metrics, Instagram publication, media transfer, token renewal/revocation, generated-video transport/audio, mixed-media automation and wider production assurance remain engineering work. Approved developer applications and explicit designated-account acceptance remain external gates. This is not the finished seven-module product.

See [Facebook operations](FACEBOOK-PUBLISHING.md), [completion plan](MODULE-PLAN.md) and [owner activation checklist](ACTIVATION-CHECKLIST.md).
