# LinkedIn text publishing release — 18 October 2026

## Scope

- Actual LinkedIn company text POST transport behind independent configuration gates, with current application/token/admin validation.
- Durable submission fence and candidate-ID journal; exact published-post read-back; read-only known-ID recovery and no automatic resend after uncertain writes.
- Exact-post organic metric mapping into scoped snapshots; missing values remain null, company totals are not post metrics, negative organic-like adjustments do not create positive engagement evidence.
- Worker receipt/metric context and lease revalidation. Migration `20261018040000_social_submission_journal`, runtime `studio-v25-linkedin-publishing`.
- Synthetic recovery now preserves uncertain publication state and candidate IDs and verifies the new database constraint.
- [Activation checklist](ACTIVATION-CHECKLIST.md) separating owner credentials/accounts/consent from unfinished engineering.

## Verification and deployment

Source release `5cc807ae02e9bc888ec7336bdd80541a743dff1b`. Local final verification and [CI run 39108182921](https://github.com/fxunlockdev/Marketingbus/actions/runs/39108182921) pass 717 tests/49 suites, build, synthetic restoration and dependency audit (zero reported vulnerabilities). Local type checking passes. CI browser acceptance passes 31 journeys with one private-storage case explicitly skipped.

Both services were deployed from a clean archive of that exact passing revision:

- Worker: `28e5ed16-e249-4c7d-93d7-450105f48393`, observed `SUCCESS`. Logs confirm the new migration applied and worker startup.
- Web: `5d1b27e7-46ec-4937-bffb-bdaebf101e78`, observed `SUCCESS`. Logs confirm 36 migrations and no pending migrations.
- Runtime contract: `studio-v25-linkedin-publishing`.

Hosted health returns 200/no-store with `status: ok`. Signed-out studio returns 307 to login. Anonymous connections, account-data and social reads return 401/no-store. Facebook, Instagram and LinkedIn callback denial paths return 303 to the fixed `/social-connect?failed=1` page with no-store/no-referrer and empty bodies. Provider configuration, execution flags and budget settings were not changed. No real provider acceptance is implied by deployment health.

Isolated synthetic restoration passes 36 migrations, 52 tables and 68 rows, including publication-journal preservation. This does not verify production backup or object recovery. No real provider post, paid AI generation, email, payment or customer-data fixture was created. Provider settings, budgets and publishing flags remain unchanged.

## Explicit remaining boundary

Live LinkedIn publication/reporting permissions and designated-account acceptance remain. Facebook/Instagram publishing, image/video transfer, token renewal/provider revocation, Higgsfield/audio transport, mixed-media automation and wider production assurance remain unfinished. Per-post ingestion feeds evidence storage; text-only posts do not satisfy the current two-format learning cohort rule and do not prove improved creative quality. Credentials alone do not complete the product.
