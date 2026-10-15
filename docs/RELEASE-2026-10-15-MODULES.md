# Marketingbus module release verification

Release `fbea44aa6cb81573dd6efc525f1bba03108abdeb` is deployed to production. This replaces the older provider-list Connections screen with publishing destinations only. Provider credentials remain operator-managed. Deployment does not establish live media-provider, payment or social-platform acceptance.

## Production release

| Service | Deployment | Observed result |
|---|---|---|
| Web | `aa64af8a-785e-4b82-b2cb-455bd608765e` | SUCCESS |
| Worker | `994a9099-cf57-48b3-ac38-dedad263b52d` | SUCCESS |

Both services use Node 26. Their existing predeployment migration step applied all 22 migrations through `20261015210000_motion_storyboards`. Worker runtime is `studio-v9-motion-storyboards`. The public `/api/health` check returned HTTP 200 with `{"status":"ok"}` and `Cache-Control: no-store`.

No new infrastructure services were created. Existing paid-execution flags and supplier budgets were preserved. No generation, email, payment or publishing request was submitted. Motion rendering remains disabled until production encoder/font packaging and storage acceptance; deploying its workflow does not activate rendering.

## Invitation update

New account registration from a valid invitation creates only the authorized membership. Existing accounts sign in, including their existing MFA requirement, then explicitly accept. Preview does not consume the invitation. Exact email, current inviter authority, expiry, revocation and membership limits are enforced on the server. Atomic acceptance prevents duplicate signup and token replay.

The update is pending web deployment. It requires no schema or worker-runtime change. Live invitation delivery still requires Resend, a verified sender and a designated test recipient.

## Verification and limitations

The local unit/database suite passes all 238 tests across 31 suites. Seventeen browser journeys pass, including three new invitation journeys with accessibility and mobile-width checks. The private-storage case remains skipped without a test bucket. Production compilation and TypeScript checks pass. The production dependency audit reports zero known vulnerabilities at this check, not an independent security assessment.

Earlier runs were interrupted by recorded macOS sleep events. Rerunning while temporarily preventing idle sleep completed the unit/database suite in 23 seconds. Run database and browser suites sequentially against a shared fixture database: the identity expiry test intentionally advances its cleanup time and can invalidate concurrently created browser invitations. CI already runs these suites sequentially.

GitHub run `38733996454` for the earlier release was cancelled during browser dependency installation; it is not a passing CI result. Subsequent source delivery triggers a new run.

Authenticated hosted acceptance, real private-bucket tests, provider output quality, restoration drills and comprehensive security/load/accessibility reviews remain outstanding. See [the acceptance ledger](BUILD-STATUS.md) for internal implementation gaps, separately from credentials and third-party approvals.
