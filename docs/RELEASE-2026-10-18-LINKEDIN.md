# LinkedIn connection release — 18 October 2026

Verified source: `ab51ba738683d151c3978115bc5f95d3a8484472`. Runtime: `studio-v23-linkedin-connection`. Additive migration: `20261018020000_linkedin_confidential_oauth` (34 migrations total).

## Implemented scope

Official confidential web authorization-code exchange, same-application active-token introspection, approved company-page administrator discovery and bounded company lookups now feed the existing session/business-bound encrypted account-selection workflow. Configuration is disabled by default and expires at an explicit operator verification deadline. Authentication method is constrained in PostgreSQL as well as application code. Other adapters retain S256 by default; no error-driven downgrade exists.

No publishing, media-upload, analytics, refresh or platform-revocation adapter is registered. No production provider flag, secret, spending cap or customer policy was changed. See [operator setup and limitations](LINKEDIN-CONNECTIONS.md).

## Local verification

- All 578 unit/database tests across 45 suites pass. Forty new cases comprise 37 transport/gating tests and three database authorization cases; the complete focused authorization/adapter suite has 58 cases.
- Negative cases cover wrong application, inactive/revoked/application-only tokens, missing scopes, invalid expiry, unapproved/non-admin relationships, conflicting or duplicate pages, malicious paging URLs, pagination overflow, malformed/oversized responses, cancellation, credential rotation and cross-session/provider/tenant attempts.
- The real adapter with injected HTTP responses completes authorization, selection and encrypted tenant-bound persistence. No provider network calls occur.
- All 30 browser journeys pass; one private-storage journey remains explicitly skipped. Existing tests cover scoped Connections, role restrictions, cancellation, callback redaction, no-referrer behavior, accessibility and mobile layout. They do not perform live LinkedIn authorization.
- Production build/type checking and dependency audit pass with zero known reported vulnerabilities at verification time.
- Isolated synthetic PostgreSQL dump/restore verifies 34 migrations, 52 tables and 60 rows, including tenant/credit/uncertain-operation/key invariants. Both temporary databases are removed. This does not establish production or object-storage restoration.
- The first focused test run caught the existing database constraint that required a PKCE verifier for every pending provider. The new additive migration explicitly models confidential LinkedIn flows while retaining strict secret-state checks. A parameterized test's array shape was also corrected before the passing runs.

## Delivery verification

Source is pushed to main. [GitHub CI run 39103855256](https://github.com/fxunlockdev/Marketingbus/actions/runs/39103855256) passed all checks in 4m32s: 578 tests/45 suites, 30 browser journeys with one explicit storage skip, 34-migration synthetic restoration, production build and audit. CI reports non-blocking action-runtime deprecations and an upcoming ubuntu-latest image change; pin/update that toolchain in a separately verified hardening release.

Both services were deployed from a fresh tracked-source archive of `ab51ba7`, excluding local secrets, dependencies and test artifacts. The worker was deployed first and its logs confirm migration 34 was applied before web deployment.

| Service | Exact deployment | Observed result |
|---|---|---|
| Worker | `ca63b877-f13c-4f0b-b7e4-d290677e3666` | SUCCESS |
| Web | `d9a54a06-9db5-4538-94bb-acbc21bfcd0d` | SUCCESS |

Hosted smoke checks after web SUCCESS:

- `/api/health`: 200, `no-store`, `status: ok`.
- `/studio`: 307 to `/login` for a signed-out visitor.
- Anonymous business connections: 401, `no-store`.
- LinkedIn callback with a synthetic non-credential query: fixed 303 to `/social-connect?failed=1`, `no-store`, `no-referrer`; query values are not reflected.

No hosted accounts or production fixture records were created. No paid AI/provider tests, real emails, financial actions or social posts were initiated. Provider flags, credentials, spending ceilings and customer policies are unchanged. The existing build-loop automation remains active.

Do not treat source implementation, deployment health or mocked provider responses as live integration acceptance. Enable customer connections only after approved permissions, current API-version verification and a designated-account acceptance test. Publishing and metrics require their own implementations and acceptance. Generated video/audio, semantic quality evaluation, mixed-media automation and wider production hardening also remain unfinished.
