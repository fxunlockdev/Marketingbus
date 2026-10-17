# Generated shot lifecycle release evidence

This release adds the supporting-footage generation lifecycle around approved storyboard scenes. It does not activate Higgsfield or claim end-to-end provider acceptance. See [operations](GENERATED-SHOTS.md) and [remaining scope](MODULE-PLAN.md).

## Implemented scope

The workflow now persists quotes, explicit rights/budget authorization, customer credit holds, a single supplier submission, bound job receipts, read-only polling/backoff, private MP4 quarantine and normalization-gated settlement. Human clip review and source approval checks gate downstream storyboard use and exports. Unknown expense retains the hold; operator reconciliation releases it only after independently verified accounting. Daily supplier limits retain older pending jobs and expense settled today.

The runtime is `studio-v18-shot-jobs`; the motion renderer remains `motion-cards-v4-framing`. Three additive migrations bring the schema to 31 migrations: generated jobs and clip relations, generated-clip database guards, and settlement-date tracking. Production adapters remain unregistered and no environment gate is enabled by this release.

## Local verification

- 451 unit/database tests pass across 39 suites, including 42 generated-shot cases.
- Production build and TypeScript compilation pass.
- Production dependency audit reports zero known vulnerabilities.
- 26 browser journeys pass against the final build; one private-storage journey is skipped because the local run has no live test bucket.
- No paid AI/media, real payments, emails or social posts were performed.

The new generation suite uses injected provider, storage and normalization fixtures. Existing encoder tests separately validate actual FFmpeg output. Browser coverage is not provider acceptance or a security certification.

## Delivery

Runtime source commit: `e99d29a36153521f874871b7908d82621a845f8a`, pushed to `origin/main`.

[GitHub CI run 39007817819](https://github.com/fxunlockdev/Marketingbus/actions/runs/39007817819) succeeded with 451 tests, 26 browser journeys, one skipped private-storage journey, build/type checking and zero known audit vulnerabilities. The runner reports upcoming action/runtime and Ubuntu-image migrations; those warnings are not failures and remain separate maintenance work.

Railway production environment `e6d8a03f-faea-48a0-9da4-d9287dd01bd5` in project `f89a6ab2-df15-4380-8f7a-f7ba6818764f`:

| Service | Deployment | Observed result |
|---|---|---|
| marketingbus-web | `68ef74e5-fc78-47bc-88af-0b4b12743caa` | SUCCESS |
| marketingbus-worker | `25a9cbf3-72c7-44cd-b2b9-c5e4b46068cb` | SUCCESS |

Deployment logs confirm all three new migrations applied and no pending migrations across the 31-migration schema. The web starts successfully and the worker starts without an error in the inspected startup log window. No new services or buckets were created, and no execution flags or provider secrets were changed.

Hosted checks at `https://marketingbus-web-production.up.railway.app`:

- `/api/health`: 200, `{"status":"ok"}`, no-store.
- `/studio`: 307 to `/login` for a signed-out request.
- Generated-shot and clip endpoints: 401 for signed-out requests, no-store.

These public checks verify startup/schema/access denial, not authenticated live generation, private bucket behavior or production capacity.

## Remaining boundaries

Actual Higgsfield HTTP/schema/usage integration, reference-led video revisions, licensed audio, semantic continuity/fidelity evaluation, broader platform exports and live storage/decoder acceptance remain. Other unfinished modules include official social adapters/media transfer, mixed-media autopilot, semantic claim evaluation and enterprise operational assurance. Credentials alone do not complete them.
