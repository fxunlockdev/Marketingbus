# LinkedIn text publishing release — 18 October 2026

## Scope

- Actual LinkedIn company text POST transport behind independent configuration gates, with current application/token/admin validation.
- Durable submission fence and candidate-ID journal; exact published-post read-back; read-only known-ID recovery and no automatic resend after uncertain writes.
- Exact-post organic metric mapping into scoped snapshots; missing values remain null, company totals are not post metrics, negative organic-like adjustments do not create positive engagement evidence.
- Worker receipt/metric context and lease revalidation. Migration `20261018040000_social_submission_journal`, runtime `studio-v25-linkedin-publishing`.
- Synthetic recovery now preserves uncertain publication state and candidate IDs and verifies the new database constraint.
- [Activation checklist](ACTIVATION-CHECKLIST.md) separating owner credentials/accounts/consent from unfinished engineering.

## Verification and deployment

Local final verification passed 717 tests/49 suites, production build and type checking. Browser acceptance passed 31 journeys (one private-storage case skipped); the final gate/query changes are also subject to the complete CI run before deployment. Dependency audit reported zero vulnerabilities. Exact CI and deployment evidence will be recorded after verification.

Isolated synthetic restoration passes 36 migrations, 52 tables and 68 rows, including publication-journal preservation. This does not verify production backup or object recovery. No real provider post, paid AI generation, email, payment or customer-data fixture was created. Provider settings, budgets and publishing flags remain unchanged.

## Explicit remaining boundary

Live LinkedIn publication/reporting permissions and designated-account acceptance remain. Facebook/Instagram publishing, image/video transfer, token renewal/provider revocation, Higgsfield/audio transport, mixed-media automation and wider production assurance remain unfinished. Per-post ingestion feeds evidence storage; text-only posts do not satisfy the current two-format learning cohort rule and do not prove improved creative quality. Credentials alone do not complete the product.
