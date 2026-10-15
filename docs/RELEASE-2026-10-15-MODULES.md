# Marketingbus module release verification

Release `ac9c00e6885a8ba5ddef6bf114d0e5792807bf1b` is deployed on web and worker. It adds approved-artwork reuse to the preceding module and invitation releases. Connections contains publishing destinations only. Provider credentials remain operator-managed. Deployment does not establish live media-provider, payment or social-platform acceptance.

## Production release

| Service | Deployment | Observed result |
|---|---|---|
| Web | `3e31c0d1-c601-48da-86eb-30fa7940d5c3` | SUCCESS |
| Worker | `fad61a10-4a7a-4e97-a5be-a7b35dfe02da` | SUCCESS |

Both services use Node 26. Their existing predeployment migration step confirms all 22 migrations through `20261015210000_motion_storyboards` with none pending. Worker runtime is `studio-v10-motion-artwork`. The worker deployment health check succeeded, public `/api/health` returned HTTP 200 with `{"status":"ok"}`, unauthenticated `/studio` redirected to `/login`, and unauthenticated video access returned 401.

No new infrastructure services were created. Existing paid-execution flags and supplier budgets were preserved. No generation, email, payment or publishing request was submitted. Motion rendering remains disabled until production encoder/font packaging and storage acceptance; deploying its workflow does not activate rendering.

## Invitation update

New account registration from a valid invitation creates only the authorized membership. Existing accounts sign in, including their existing MFA requirement, then explicitly accept. Preview does not consume the invitation. Exact email, current inviter authority, expiry, revocation and membership limits are enforced on the server. Atomic acceptance prevents duplicate signup and token replay.

The update is deployed on web and requires no schema or worker-runtime change. Hosted checks returned 200 for health and the invitation page, redirected unauthenticated studio visits to login, rejected unauthenticated video access with 401, and rejected malformed invitation preview with 400. These checks created no users, businesses or valid invitations. Live invitation delivery still requires Resend, a verified sender and a designated test recipient.

## Verification and limitations

The local unit/database suite passes all 248 tests across 31 suites. Eighteen browser journeys pass, including invitation journeys and artwork selection/revocation/repair with accessibility and mobile-width checks. The private-storage case remains skipped without a test bucket. Production compilation and TypeScript checks pass. GitHub CI run [38756304205](https://github.com/fxunlockdev/Marketingbus/actions/runs/38756304205) also passed these suites, build and dependency audit. The audit reports zero known vulnerabilities at this check, not an independent security assessment.

Earlier runs were interrupted by recorded macOS sleep events. Rerunning while temporarily preventing idle sleep completed the unit/database suite in 23 seconds. Run database and browser suites sequentially against a shared fixture database: the identity expiry test intentionally advances its cleanup time and can invalidate concurrently created browser invitations. CI already runs these suites sequentially.

Earlier CI runs, including `38733996454`, `38747595472` and `38749298218`, were cancelled during browser dependency installation. The latter's logs showed Chrome installed successfully and the Playwright FFmpeg downloader stalling afterward. CI now verifies an existing Chrome installation first, with a bounded fallback installer. The successful source-release CI run above verifies that this change reaches and passes browser acceptance.

Authenticated hosted acceptance, real private-bucket tests, provider output quality, restoration drills and comprehensive security/load/accessibility reviews remain outstanding. See [the acceptance ledger](BUILD-STATUS.md) for internal implementation gaps, separately from credentials and third-party approvals.
