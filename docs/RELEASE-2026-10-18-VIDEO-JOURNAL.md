# Higgsfield transport and durable video journals — 18 October 2026

## Scope

- Fixed silent portrait Seedance 2.5 and Kling 3.0 Standard requests, exact parameter-bound account estimates, integer micro-USD parsing, signed acceptance journals and stable single-attempt idempotency keys.
- Fixed authenticated API origin, bounded JSON/body deadlines and sanitized failures; credential-free HTTPS output downloads with public DNS validation inside socket lookup, exact host policy, TLS verification and byte/time limits.
- Read-only preparation followed by fresh lease/configuration/permission/approval checks before submission; durable estimate/submission journals and bound polling after restart; unknown charges retain holds without downloading or delivering footage. Operator reconciliation retains original evidence.
- Runtime `studio-v28-video-journal`. No schema migration or dependency addition. No provider settings, budgets, execution flags or customer policy changed.

The concrete job bridge is not registered for production while independently verified final expense and successful delivery integration remain unfinished. Keys alone cannot activate it. This is not a completed generated-video/audio module or an enterprise-completion claim.

## Local verification

- 909 unit/database tests across 54 suites pass, including 129 new network/download/job-journal checks. Sixteen new PostgreSQL cases exercise the real bridge with injected HTTP responses, restart, late authority changes, tampered/missing journals, credential changes and uncertain submissions. Media/network fixtures never register as production providers.
- Production build and type checking pass.
- The first full run, concurrent with a production build, exceeded the five-second limit in two existing encoder tests. The isolated 56-test video suite and both subsequent full suites passed without that overlap. No test timeout was increased and no failed check was hidden.
- Browser regression passes 32 journeys; one private-storage journey is explicitly skipped without a test bucket. No test was newly skipped for this release.
- Synthetic restoration passes all 36 migrations, 52 tables and 68 rows. Both temporary databases were removed; existing fixture/production data were untouched. This is not actual production/object-storage recovery.
- Dependency audit reports zero known vulnerabilities; whitespace checks pass. Exact source `717deee90a674bd816d43375ae2c35806dd7266c` passed [CI 39115470817](https://github.com/fxunlockdev/Marketingbus/actions/runs/39115470817), including full unit/database and browser regression, build, synthetic restore and audit.

No authenticated/paid provider request, real email, social post or financial transaction was made. Actual Node HTTPS private-DNS denial is tested without connecting to the private address. Real footage quality, billing reconciliation, account/model access and hosted storage/decoder acceptance remain separate.

## Delivery

Both services were uploaded from a fresh tracked-file archive of exact CI-passed commit `717deee90a674bd816d43375ae2c35806dd7266c`, excluding local secrets and generated artifacts. Worker `26425f47-65a6-4ef2-b2d3-5b2146112d20` reported SUCCESS before web `7828e51c-ec2f-4c05-82e7-e535d8907aa4`, which also reported SUCCESS. Both startup logs confirm 36 migrations and none pending; the worker started and the web server became ready. A bounded worker-error query returned only the existing npm configuration warning.

Hosted `/api/health` returns 200/no-store and `status: ok`; `/studio` redirects signed-out users to `/login`. Anonymous video-generation, clip, connection, account-data and social reads return 401/no-store. Facebook, Instagram and LinkedIn denial callbacks return fixed relative `/social-connect?failed=1` with 303/no-store/no-referrer and empty bodies. These checks do not establish authenticated production/provider acceptance.

The deployed runtime is `studio-v28-video-journal`. No provider flags, credentials, spending limits, customer pricing policy or infrastructure resources were changed. The complete seven-module product remains unfinished; the existing completion heartbeat is not paused.

See [transport and remaining gates](HIGGSFIELD-TRANSPORT.md), [module plan](MODULE-PLAN.md) and [owner setup checklist](ACTIVATION-CHECKLIST.md).
