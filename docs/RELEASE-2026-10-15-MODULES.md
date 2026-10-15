# Marketingbus module release verification

Release `53c5b1e3cc6f2fcc2583370a57e6c3af6c196c7a` is deployed on web and worker. It adds bounded uncertain-publication recovery to the preceding plan-history and module releases. Connections contains publishing destinations only. Provider credentials remain operator-managed. Deployment does not establish live media-provider, payment or social-platform acceptance.

## Production release

| Service | Deployment | Observed result |
|---|---|---|
| Web | `2fc11ed0-eee7-4338-a34d-e48bfcdfa99b` | SUCCESS |
| Worker | `fe91dc8e-56cb-4f28-a824-b83f8dd04fac` | SUCCESS |

Both services use Node 26. Web predeployment applied `20261015230000_social_reconciliation`; worker predeployment confirmed all 23 migrations with none pending. Worker runtime is `studio-v11-social-recovery`. Both deployment health checks succeeded, public `/api/health` returned HTTP 200 with `{"status":"ok"}`, unauthenticated `/studio` redirected to `/login`, and unauthenticated social access returned 401 with no-store caching.

No new infrastructure services were created. Existing paid-execution flags and supplier budgets were preserved. No generation, email, payment or publishing request was submitted. Motion rendering remains disabled until production encoder/font packaging and storage acceptance; deploying its workflow does not activate rendering.

## Invitation update

New account registration from a valid invitation creates only the authorized membership. Existing accounts sign in, including their existing MFA requirement, then explicitly accept. Preview does not consume the invitation. Exact email, current inviter authority, expiry, revocation and membership limits are enforced on the server. Atomic acceptance prevents duplicate signup and token replay.

The update is deployed on web and requires no schema or worker-runtime change. Hosted checks returned 200 for health and the invitation page, redirected unauthenticated studio visits to login, rejected unauthenticated video access with 401, and rejected malformed invitation preview with 400. These checks created no users, businesses or valid invitations. Live invitation delivery still requires Resend, a verified sender and a designated test recipient.

## Verification and limitations

The current social-recovery release passes 271 unit/database tests across 32 suites and 20 browser journeys; one private-storage journey remains skipped. Production build, type checking and dependency audit pass locally and in [GitHub CI run 38773733797](https://github.com/fxunlockdev/Marketingbus/actions/runs/38773733797). New coverage includes queue corruption isolation, immutable rescheduling, five-check backoff, concurrent/crashed lookup leases, destination changes, malformed receipts, audited operator resumption, viewer controls and rejection of forged receipt actions. Browser accessibility and mobile-width checks pass, and the stopped-lookup card was visually inspected.

No production fixtures or live provider outcomes were created. The adapter registry remains empty, so deployment cannot activate actual social publishing. See [social operations](SOCIAL-AND-COMPOSITION.md) for recovery limits and operator requirements.

### Previous plan history release

The plan-history release passes 254 unit/database tests across 32 suites and 19 browser journeys, with one private-storage journey skipped. Production build, TypeScript checks and dependency audit pass locally and in [GitHub CI run 38768304268](https://github.com/fxunlockdev/Marketingbus/actions/runs/38768304268). The new browser flow covers earlier-plan editing, selection across pages, read-only superseded copy, server-side mutation rejection, automated accessibility and mobile width. Visual inspection led to a stacked mobile status notice; the affected browser test passed again after that correction.

The earlier plan-history web deployment `8a0194d1-820a-44a4-ba96-d8b30cdf28f6` reported SUCCESS. Startup confirmed no pending migrations. Hosted health returned 200, unauthenticated studio access redirected to login, and the new plan-history route returned 401 with no-store caching to an unauthenticated request. These read-only checks created no production fixtures. That earlier release had no worker runtime or schema change.

### Previous artwork release

The local unit/database suite passes all 248 tests across 31 suites. Eighteen browser journeys pass, including invitation journeys and artwork selection/revocation/repair with accessibility and mobile-width checks. The private-storage case remains skipped without a test bucket. Production compilation and TypeScript checks pass. GitHub CI run [38756304205](https://github.com/fxunlockdev/Marketingbus/actions/runs/38756304205) also passed these suites, build and dependency audit. The audit reports zero known vulnerabilities at this check, not an independent security assessment.

Earlier runs were interrupted by recorded macOS sleep events. Rerunning while temporarily preventing idle sleep completed the unit/database suite in 23 seconds. Run database and browser suites sequentially against a shared fixture database: the identity expiry test intentionally advances its cleanup time and can invalidate concurrently created browser invitations. CI already runs these suites sequentially.

Earlier CI runs, including `38733996454`, `38747595472` and `38749298218`, were cancelled during browser dependency installation. The latter's logs showed Chrome installed successfully and the Playwright FFmpeg downloader stalling afterward. CI now verifies an existing Chrome installation first, with a bounded fallback installer. The successful source-release CI run above verifies that this change reaches and passes browser acceptance.

Authenticated hosted acceptance, real private-bucket tests, provider output quality, restoration drills and comprehensive security/load/accessibility reviews remain outstanding. See [the acceptance ledger](BUILD-STATUS.md) for internal implementation gaps, separately from credentials and third-party approvals.
