# Video delivery release — 18 October 2026

Application commit: `eeb4e27622a6942d79c4a9169dc61bd99e364074`.
Runtime: `studio-v29-video-delivery`.
Migration: `20261018160000_video_provisional_expense` (37 total).

## Delivered implementation

- Real Higgsfield adapter registration behind an explicit disabled-by-default operator gate, exact supported route checks, verified account/expiry/host configuration and a fingerprint shared by quotes and workers.
- Account-quote delivery with signed parameter-bound evidence; separate provisional supplier amount, independently reconciled final amount and customer credit settlement.
- Completed footage proceeds through private immutable storage and actual silent normalization before customer settlement; it then requires human clip, storyboard and final-export review.
- Failure and cancellation release customer credits without erasing supplier exposure. Uncertain submission/response paths retain holds and never automatically resubmit generation.
- Independent final invoice reconciliation preserves delivered output and customer pricing, rejects changed replays and records overruns against future supplier capacity.
- Cross-day budget accounting includes unresolved provisional invoices, and the read-only queue report identifies invoice-due records without exposing private evidence.

See [operations and activation](VIDEO-DELIVERY-ACCOUNTING.md). No production provider is implicitly activated by this release.

## Verification performed locally

- Initial full regression: 957 tests across 55 suites passed. One additional full-chain real-encoding test was then added; all 81 generated-shot integration cases passed, including that new case.
- The full-chain test uses injected provider HTTP and an in-memory private object store, but genuine FFmpeg footage, normalization and final rendering. It verifies H.264, 720×1280, five seconds, no audio, final-review download denial before approval, downloadable bytes afterward and unchanged bytes/customer balance after final invoice reconciliation. It is not a live Higgsfield or S3 test.
- Production build and type checking passed; 32 browser journeys passed. One private-storage journey is skipped without a designated test bucket.
- Dependency audit: zero known vulnerabilities at verification time. This does not replace an independent security review.
- Synthetic local PostgreSQL restore: 37 migrations, 52 tables, 75 rows; provisional expense fields and constraints preserved. No production backup or object-storage recovery claim.
- The first updated restore fixture was rejected because it attempted a new reservation after intentionally creating account debt. The fixture was reordered to reserve/release before adding debt; the final rehearsal passes. No production data was involved.

## CI and deployment

GitHub CI [39117885911](https://github.com/fxunlockdev/Marketingbus/actions/runs/39117885911) reported SUCCESS for the exact application commit above: **958 tests across 55 suites**, 32 browser journeys, one private-storage journey skipped, production build, synthetic restore and zero-vulnerability dependency audit. The real-encoding delivery test is included in that final 958-test run. Source delivery and CI success alone are not deployment or live-provider evidence.

Worker deployment `afc520ac-c311-4063-a3fc-52e4fb7ce281` reported SUCCESS. Its startup logs confirm migration 37 applied, the worker started and the `/health` check passed. Web deployment `337c8886-4b16-425b-b23e-fa3a268cc8c1` then reported SUCCESS, with 37 migrations present and none pending. Both were uploaded from the same fresh tracked-file archive of the exact CI-tested commit, excluding local secrets and test output.

Hosted verification: `/api/health` returned 200, `status:ok` and no-store; signed-out `/studio` returned 307 to `/login`; anonymous generated-shot, clip and social reads returned 401/no-store. Facebook, Instagram and LinkedIn denial callbacks returned the fixed relative 303 recovery URL, empty bodies, no-store and no-referrer. No authenticated customer/provider acceptance is implied by those smoke checks.

## Boundaries

No new paid AI/media calls, real social posts, emails, charges or refunds. No changes to credentials, spending limits, execution flags or infrastructure resources. Credentials and live approval/budget are still needed for provider acceptance, with production encoder isolation and private storage verification. Voice/music, reference-led revisions, richer media publishing, mixed-media orchestration, creative-quality measurement and broader production assurance remain unfinished. The complete seven-module product is not declared finished.
