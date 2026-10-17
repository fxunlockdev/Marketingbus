# Reviewed footage release

The video studio now supports private uploaded footage alongside still-image motion cards. This release closes the bounded upload, quarantine, normalization, human review, scene selection and dependent-delivery workflow. It does not complete supplier-generated video, audio production or the full product.

## Implementation

- Migration `20261017060000_video_clips` stores scoped originals, normalized-output fingerprints, leases, review and retention states. Runtime `studio-v16-reviewed-clips` prevents admission against an older worker.
- Raw originals have no delivery route. Fixed-demuxer processing normalizes bounded H.264 clips to silent 720 × 1280 output, strips metadata/audio and checks streams, duration and immutable private storage. Input/output hashes are checked again before reuse.
- The footage library provides upload, preview, approval, rejection, removal and read-back-only recovery. Rights confirmation and current editing authority are required; independent review applies when configured.
- Storyboards mix approved footage and motion cards. A scene cannot select both footage and an image or exceed the clip duration. Rejection/removal invalidates dependent storyboard and finished-output approvals, including after a clip is reapproved.
- Original and normalized files expire after 30 days; removal or failed processing queues both for deletion after seven days. Failed deletes retain quota. Processing shares global motion CPU admission and the single active replica lease. No automatic retry follows an uncertain result.

## Verification

Local unit/database verification: 388 passing tests across 38 suites. New cases cover malformed/oversized media, actual audio stripping and encoding, mixed assembly, rights, worker readiness, scopes/roles, independent review, changed brands, corrupted originals/output, duration mismatch, concurrent CPU work, stale leases, uncertain upload/storage recovery, quotas and partial deletion. The production build and dependency audit pass; audit reports zero known vulnerabilities.

All 25 browser journeys pass; one private-storage journey remains skipped without a test bucket. The new journey plays real local encoder bytes through test-only media transport and exercises actual scoped approval, scene selection, dependent invalidation, repair, viewer/anonymous denial, automated accessibility and mobile width. Its initial exact-label selector was corrected to use the control's accessible role/name. The footage-library screenshot was inspected for layout and readability.

Deployment results are recorded after their final verification. No paid model calls, social posts, payment operations, real emails or production fixtures were used.

## Release gates

Production clip processing stays gated by the configured video worker and operator motion allowance. Real private-bucket acceptance and patched decoder packaging with OS/container memory, CPU, disk and isolation controls remain required before enabling uploads for customers. Fixed arguments and process deadlines are not a security sandbox. Browser transport fixtures and local encoding do not establish those operational guarantees.

Remaining video work includes supplier jobs/rates/settlement/reconciliation, approved audio/voiceover, semantic visual and continuity evaluation, timeline editing and platform-specific media transfer. The seven-module ledger retains the other unfinished work.
