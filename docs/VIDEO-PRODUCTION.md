# Motion reel operations

The video module turns a reviewed storyboard into a silent, captioned MP4 using approved original brand images or approved generated artwork. Reusing existing artwork makes no new model call and spends no AI credits. It does not generate footage, clone voices, add music or call Higgsfield. Customer Connections remains for publishing destinations only.

## Customer workflow

1. Confirm the brand, create a content plan and approve any copy already attached to the planned item.
2. Open Video studio and create a storyboard. Edit its title, background, original logo, captions, images, timing and hold/fade transitions. Add, remove or reorder up to six shots within 30 seconds.
3. Save a version. Unchanged shots retain their exact-content reviews; changed shots require review again. Approve every shot, then the complete storyboard. An independent reviewer is required when the business approval policy demands one.
4. Queue a render. The application reserves private storage and checks the operator's daily CPU allowance and a fresh matching worker heartbeat. This path uses no paid AI and charges no AI credits; infrastructure still costs money.
5. Refresh status, preview the saved video, and review continuity, captions and brand fidelity. Final approval enables MP4, VTT captions and storyboard JSON downloads. Rejection does not spend money or regenerate automatically.
6. For a revision, change the relevant shot and save a new version. Previous output becomes unavailable for delivery. Remove unused settled output from its version history.

Fact checks are lexical guards, not semantic truth verification. Human review is not an automated continuity or agency-quality score. Uploaded/generated video clips are not supported yet.

## Approved artwork reuse

Scene image choices distinguish approved originals from approved generated artwork. Only assets belonging to the same business are eligible; reuse across its planned creatives is explicit. Generated artwork must have current human approval, approved latest source copy, a current source plan/brand version and unchanged reference permissions and hashes. An authorized newer image version, blocking source-copy comment, rejection, archive or changed source copy makes it unavailable. Original logos cannot be replaced with generated artwork.

These checks run on storyboard save/review, before and after encoding, before storage acceptance, during recovery and before/after downloading. Batch provenance reads avoid one database round trip per image. An unavailable image remains labelled in the editor until the user selects a replacement or removes it; saving the repaired draft requires fresh review of changed scenes. No model call occurs during reuse. Generated imagery is supporting artwork, not evidence that a depicted product or claim is accurate.

## Operator configuration

Apply migrations through `20261015210000_motion_storyboards` and deploy matching web/worker runtime `studio-v10-motion-artwork`. Artwork reuse requires no new migration. Video rendering stays disabled unless all of these requirements are met:

- `MOTION_RENDERING_ENABLED=true` and an integer `MOTION_RENDER_DAILY_LIMIT` from 1 to 100, explicitly chosen by the operator. Start low and measure costs before increasing it.
- Absolute `FFMPEG_PATH` and `FFPROBE_PATH` pointing to operator-installed binaries, with `libx264` available. No runtime binary downloads occur. Keep matching configuration on web and worker because it participates in the readiness fingerprint.
- A configured private S3-compatible bucket with immutable writes, bounded reads and deletion. The application does not require Amazon specifically. Real provider compatibility and retention must be verified before release.
- A fresh worker heartbeat reporting encoder readiness. `PAID_EXECUTION_ENABLED` does not enable or disable this independent, non-AI rendering path.

Production packaging must install the binaries and fonts and enforce container memory, CPU and temporary-disk limits. Fixed arguments and restricted protocols are defense layers, not an OS sandbox. The application workflow is deployed; rendering enablement, packaging and production storage acceptance remain outstanding.

## Rendering and cost limits

The renderer uses app-owned templates, never customer HTML, JavaScript, shell commands, FFmpeg filters or remote media URLs. Original image hashes and permissions are checked again before rendering and delivery. Child processes receive a minimal environment without application secrets. Media protocols are restricted to local files.

Output is one H.264 stream at 720 × 1280 and 24 fps, without audio. Stream metadata, resolution, frame rate and duration are validated before storage. Encoding has a 90-second deadline and 30-second child-process deadlines. Files must be smaller than 20 MB. Character-based caption fitting and reading-time guards are conservative heuristics; multilingual typography and professional visual evaluation remain work to do.

A database lock permits one active render/storage job across worker replicas; the renderer also permits one encode per process. Active jobs cannot be cancelled through the customer API, avoiding premature release of that slot. Queued jobs can be cancelled. A 180-second job lease bounds recovery after a crash.

Each business is limited to six render requests per UTC day, ten retained renders and 100 MB of reserved/stored output. Each queued render reserves 20 MB. The global daily admission ledger has no customer deletion cascade, so deleting customer data cannot replenish that day's CPU allowance. Failed attempts consume the daily allowance and may retain reserved storage until cleanup. These limits are pilot safeguards, not a measured monthly hosting-cost guarantee.

## Failure and retention behavior

Repeated render requests for one storyboard/renderer version return the existing job. Failed or expired jobs are never automatically rerendered. Saving a new version is an explicit new attempt subject to the daily limits.

Before storage, the worker records the output hash and length. If acknowledgement is lost, “Check stored video” only reads and validates the existing object; it does not re-encode or upload again. A changed brand, copy, asset permission, storyboard or editing role prevents delivery. Downloads recheck authorization after the bounded private read and reject tampered bytes.

Outputs expire after 30 days. Removal immediately revokes application access and schedules physical deletion after seven days. Repeated removal does not extend that deadline. Failed deletion retains the private tombstone and quota for bounded cleanup retries. Previously downloaded files and backups are separate retention obligations.

## Verification and remaining video work

Local tests exercise actual encoding and probing, single-worker admission, tenant isolation, changed/revoked inputs, shot/final approval invalidation, fabricated-date rejection, ambiguous storage recovery and deletion failures. Browser tests cover storyboard versions, real encoded playback, final review, captions export and removal. The browser media response is test-only; bucket acceptance is not implied.

The supplied Hyperframes contract informed finite timeline and asset-reference constraints. Its runtime is not installed. The current implementation is an app-owned FFmpeg renderer. OpenMontage code was not copied.

Still required for the full video product: verified Higgsfield model/rate transports; per-shot generation quotes, supplier authorization and uncertain-outcome reconciliation; quarantined uploaded/generated clips; licensed music/voiceover and audio captions; automated continuity/fidelity evaluation; mixed-media assembly, provider revisions and platform-specific export/transfer. Finish these before describing video as complete with only credentials remaining.
