# Social connection workflow release

This release adds the application-side OAuth connection lifecycle and publishing-only destination management. It does not enable a live Meta or LinkedIn integration. The production OAuth and publishing adapter registries remain empty.

## Implemented and tested

Owner/admin authorization uses a business- and session-bound ten-minute request, hashed one-use state, mandatory S256 PKCE and a fixed per-provider callback. The exchange is claimed before provider work and is not retried after uncertain completion. Temporary account grants are encrypted; only opaque selection IDs and labels reach the browser. Explicit selection atomically saves the chosen encrypted account, removes temporary secrets and writes an audit event. Current permissions, session validity, expiry and configuration are checked again. Logout, cancellation and bounded expiry cleanup remove temporary credentials.

The Connections screen displays scoped records and setup status for Instagram, Facebook and LinkedIn, with X and YouTube identified as planned. Provider keys remain outside customer Connections. Callback responses redirect only to a fixed local path, do not reflect query parameters and use no-referrer headers. Browser verification caught and corrected a global-header override before release.

Local acceptance: 288 tests across 33 unit/database suites; 22 browser journeys; production build; TypeScript checks; dependency audit with zero known vulnerabilities. One private-storage browser case remains skipped. The new tests use local-only fixtures and injected exchange results, not registered production adapters. There were no paid calls, real social posts, payments or emails.

## Deployment

Source release `5af22d301ed605cc4c7fd85989a0cc647b916709` is deployed on both existing Railway services. The web deployment `3441b2b9-f77a-4bd1-b2ae-92f1245e1302` and worker deployment `0294814a-d829-480b-902b-eed6c85235be` both reported SUCCESS. Migration `20261016030000_social_oauth` applied successfully; the worker confirmed no pending migrations among all 24. Both use runtime `studio-v12-social-oauth`.

[GitHub CI run 38864919029](https://github.com/fxunlockdev/Marketingbus/actions/runs/38864919029) independently passed tests, build, browser journeys and audit. Read-only hosted checks returned health 200, studio 307 to login, unauthenticated connections 401 with no-store, callback 303 to the fixed recovery page with no-store/no-referrer, and recovery page 200 with no-referrer. The worker passed its private health check. No production test account or fixture was created. Authenticated live-provider acceptance remains separate.

## Remaining gates

Official authorization endpoints, PKCE support, client credentials, token audience, granted permissions and account-management rights require provider-specific adapters and acceptance. Refresh/revoke, platform media transfer and publishing/analytics mappings remain unfinished. Proxy access-log query redaction and actual account selection need live acceptance with designated accounts. No credentials or setup flags alone activate these missing adapters. The broader product still requires generated-shot/audio production, Stripe, measured learning and production hardening described in the module ledger.
