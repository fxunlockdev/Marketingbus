# LinkedIn connection release — 18 October 2026

Runtime: `studio-v23-linkedin-connection`. Additive migration: `20261018020000_linkedin_confidential_oauth` (34 migrations total). Source/CI/deployment identifiers will be recorded after verification.

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

## Delivery gate

CI and deployment are pending. Do not treat source implementation or mocked provider responses as live integration acceptance. Enable customer connections only after approved permissions, current API-version verification and a designated-account acceptance test. Publishing and metrics require their own implementations and acceptance.
