# Social connection workflow release

This release adds the application-side OAuth connection lifecycle and publishing-only destination management. It does not enable a live Meta or LinkedIn integration. The production OAuth and publishing adapter registries remain empty.

## Implemented and tested

Owner/admin authorization uses a business- and session-bound ten-minute request, hashed one-use state, mandatory S256 PKCE and a fixed per-provider callback. The exchange is claimed before provider work and is not retried after uncertain completion. Temporary account grants are encrypted; only opaque selection IDs and labels reach the browser. Explicit selection atomically saves the chosen encrypted account, removes temporary secrets and writes an audit event. Current permissions, session validity, expiry and configuration are checked again. Logout, cancellation and bounded expiry cleanup remove temporary credentials.

The Connections screen displays scoped records and setup status for Instagram, Facebook and LinkedIn, with X and YouTube identified as planned. Provider keys remain outside customer Connections. Callback responses redirect only to a fixed local path, do not reflect query parameters and use no-referrer headers. Browser verification caught and corrected a global-header override before release.

Local acceptance: 288 tests across 33 unit/database suites; 22 browser journeys; production build; TypeScript checks; dependency audit with zero known vulnerabilities. One private-storage browser case remains skipped. The new tests use local-only fixtures and injected exchange results, not registered production adapters. There were no paid calls, real social posts, payments or emails.

## Deployment

Pending. Both existing Railway services require migration `20261016030000_social_oauth` and runtime `studio-v12-social-oauth`. The migration is additive and is applied locally. The previous production release remains `53c5b1e` until the new deployments report success.

## Remaining gates

Official authorization endpoints, PKCE support, client credentials, token audience, granted permissions and account-management rights require provider-specific adapters and acceptance. Refresh/revoke, platform media transfer and publishing/analytics mappings remain unfinished. Proxy access-log query redaction and actual account selection need live acceptance with designated accounts. No credentials or setup flags alone activate these missing adapters. The broader product still requires generated-shot/audio production, Stripe, measured learning and production hardening described in the module ledger.
