# Motion reel operations

The video module turns a reviewed storyboard into a silent, captioned MP4 using approved original brand images, approved generated artwork or reviewed uploaded clips. Reusing media makes no new model call and spends no AI credits. It does not generate footage, clone voices, add music or call Higgsfield. Customer Connections remains for publishing destinations only.

## Customer workflow

1. Confirm the brand, create a content plan and approve any copy already attached to the planned item.
2. Open Video studio and create a storyboard. Edit its title, output format, background, original logo, captions, images, timing and hold/fade transitions. Add, remove or reorder up to six shots within 30 seconds.
3. Save a version. Unchanged shots retain their exact-content reviews; changed shots require review again. Approve every shot, then the complete storyboard. An independent reviewer is required when the business approval policy demands one.
4. Queue a render. The application reserves private storage and checks the operator's daily CPU allowance and a fresh matching worker heartbeat. This path uses no paid AI and charges no AI credits; infrastructure still costs money.
5. Refresh status, preview the saved video, and review continuity, captions and brand fidelity. Final approval enables MP4, VTT captions and storyboard JSON downloads. Rejection does not spend money or regenerate automatically.
6. For a revision, change the relevant shot and save a new version. Previous output becomes unavailable for delivery. Remove unused settled output from its version history.

Fact checks are lexical guards, not semantic truth verification. Human review is not an automated continuity or agency-quality score. The generated-shot job lifecycle is implemented separately; the real supplier transport and live acceptance remain unfinished. See [generated-shot operations](GENERATED-SHOTS.md).

## Export formats

The finite layouts provide four output shapes. The format is part of the saved storyboard, scene review and immutable render authorization. There is no free-form dimension or filter input.

| Format | Dimensions | Layout |
|---|---|---|
| Portrait 9:16 | 720 × 1280 | Logo above media, captions below |
| Square 1:1 | 720 × 720 | Shorter media window, captions below |
| Feed 4:5 | 720 × 900 | Logo above media, captions below |
| Landscape 16:9 | 1280 × 720 | Logo above media, captions alongside |

Changing format creates a new version and invalidates every scene review. Captions reflow within measured boxes; unsupported characters and overflow are rejected before saving or approving the new version. A previously overflowing draft can be repaired. No caption is silently clipped, shortened or rewritten. Fit preserves the complete media frame; Fill uses the existing crop controls within the selected layout's media window. The draft footage preview updates its window ratio, but final encoded review remains required.

New storyboards explicitly use portrait. Older documents without a format keep their original portrait meaning and JSON/hash representation. Changing only an internal title retains scene reviews; changing layout does not. Stored bytes are never resized in place. The current renderer requires new output and final review for old renderer versions, with prior bytes retained for normal cleanup. A single storyboard version has one format; making another shape does not create free parallel approved variants or bypass render/storage admission.

These shapes are downloadable media formats, not validated platform profiles. Platform-specific duration, bitrate, media-transfer and publishing acceptance remain separate. Current output is bounded pilot-resolution video, not 1080p or 4K delivery.

## Reviewed uploaded footage

The private footage library accepts licensed H.264 MP4 clips of 1–8 seconds and at most 20 MB. Inputs must be upright, 8-bit YUV 4:2:0, no larger than 1920 pixels on either edge or 2,073,600 pixels overall, at 1–60 fps. One optional AAC audio track is accepted but removed; subtitles, extra video tracks, rotated media and unsupported codecs are rejected. Export unsupported source files into this format first. Silence does not establish music or likeness rights: the uploader must confirm permission and the reviewer must check visible people, products and claims.

Upload reserves a private original and normalized output pair before writing. Raw originals have no preview or download route. The worker verifies the original hash, probes and fully re-encodes it to silent H.264 at 24 fps, removes metadata and chapters, checks output duration/streams and verifies immutable storage. New normalization preserves aspect ratio within 720 × 1280 without upscaling or baked-in padding; anamorphic sources must be exported to square pixels first. Only then can workspace members preview the normalized clip. An authorized reviewer must explicitly approve it; the independent-review policy applies. A changed brand or expired retention makes the clip unavailable.

Each scene selects an image or footage, never both. Footage starts at an editable quarter-second offset; the complete selected range must fit the approved clip. Fit preserves the whole frame with brand-color padding. Fill crops to the scene area with horizontal/vertical positioning in five-percent steps. Original logo and measured caption layout remain unchanged. The timeline lists output and source intervals separately; reordering recalculates output timing without changing source selection. A draft footage preview plays only the selected range, but browser cropping is approximate and never substitutes for final encoded review.

Trim and framing settings belong to the exact shot approval hash. Saving changes retains only unchanged shot reviews and prevents delivery of older renders. Source range, current brand, rights and fingerprints are rechecked before/after encoding and delivery. Rejection or removal invalidates dependent storyboard and finished-video approvals; reapproving a clip does not silently restore them. Legacy `silent-clip-v1` bytes remain readable as reviewed, including their baked-in letterboxing. Reupload the original to use native-aspect normalization; pending jobs from an older processor are not silently upgraded.

Input parsing uses a fixed MP4 demuxer, disabled external data references, local-file-only protocols, a secret-free child environment, one decoder thread and bounded process output. Normalization has a 60-second total deadline and 30-second process deadlines. These controls do not replace patched binaries, OS/container CPU/memory/disk limits or decoder isolation. Production enabling requires that packaging and private storage acceptance.

Uploads are limited to two concurrent requests per web process, six per user per hour, six per business per UTC day, and five retained clip pairs per business (up to 200 MB reserved). Clip processing shares the existing operator daily motion limit and the single active CPU lease across replicas; it does not add an independent spend allowance. Failed/ambiguous uploads still consume admission and retained-pair capacity until cleanup. Processing failures are not automatically retried. “Check stored clip” only verifies already-normalized output by hash and returns it to human review.

Original and normalized files expire after 30 days. Removal blocks use immediately and schedules both files for deletion after seven days. Failed or interrupted processing schedules cleanup after seven days. Failed deletion retains a private tombstone and both-file quota until both deletions are acknowledged. Downloaded copies and backups are separate obligations.

## Approved artwork reuse

Scene image choices distinguish approved originals from approved generated artwork. Only assets belonging to the same business are eligible; reuse across its planned creatives is explicit. Generated artwork must have current human approval, approved latest source copy, a current source plan/brand version and unchanged reference permissions and hashes. An authorized newer image version, blocking source-copy comment, rejection, archive or changed source copy makes it unavailable. Original logos cannot be replaced with generated artwork.

These checks run on storyboard save/review, before and after encoding, before storage acceptance, during recovery and before/after downloading. Batch provenance reads avoid one database round trip per image. An unavailable image remains labelled in the editor until the user selects a replacement or removes it; saving the repaired draft requires fresh review of changed scenes. No model call occurs during reuse. Generated imagery is supporting artwork, not evidence that a depicted product or claim is accurate.

## Operator configuration

Apply all 31 migrations through `20261017102000_shot_settlement_date` and deploy matching web/worker runtime `studio-v19-video-formats`. Renderer `motion-cards-v5-formats` requires a new render and review for delivery of older storyboard output; old bytes are retained until normal cleanup. New clips use `silent-clip-v2-native-aspect`; reviewed v1 clips remain usable. No new migration is needed for export formats. Video rendering and clip processing stay disabled unless all of these requirements are met:

- `MOTION_RENDERING_ENABLED=true` and an integer `MOTION_RENDER_DAILY_LIMIT` from 1 to 100, explicitly chosen by the operator. Start low and measure costs before increasing it.
- Absolute `FFMPEG_PATH` and `FFPROBE_PATH` pointing to operator-installed binaries, with `libx264` available. No runtime binary downloads occur. Keep matching configuration on web and worker because it participates in the readiness fingerprint.
- A configured private S3-compatible bucket with immutable writes, bounded reads and deletion. The application does not require Amazon specifically. Real provider compatibility and retention must be verified before release.
- A fresh worker heartbeat reporting encoder readiness. `PAID_EXECUTION_ENABLED` does not enable or disable this independent, non-AI rendering path.

Production packaging must install the binaries and fonts and enforce container memory, CPU and temporary-disk limits. Fixed arguments and restricted protocols are defense layers, not an OS sandbox. The application workflow is deployed; rendering enablement, packaging and production storage acceptance remain outstanding.

## Rendering and cost limits

The renderer uses app-owned templates, never customer HTML, JavaScript, shell commands, FFmpeg filters or remote media URLs. Original image hashes and permissions are checked again before rendering and delivery. Child processes receive a minimal environment without application secrets. Media protocols are restricted to local files.

Output is one H.264 stream at the selected finite layout's dimensions and 24 fps, without audio. Every format stays within the original 921,600-pixel frame ceiling. Stream metadata, exact authorized resolution, frame rate and finite duration are validated before storage. Encoding has a 90-second deadline and 30-second child-process deadlines. Files must be smaller than 20 MB. Captions use measured bundled Figtree outlines, overflow rejection and a conservative reading-time guard; multilingual typography and professional visual evaluation remain work to do.

A database lock permits one active render/storage job across worker replicas; the renderer also permits one encode per process. Active jobs cannot be cancelled through the customer API, avoiding premature release of that slot. Queued jobs can be cancelled. A 180-second job lease bounds recovery after a crash.

Each business is limited to six render requests per UTC day, ten retained renders and 100 MB of reserved/stored output. Each queued render reserves 20 MB. The global daily admission ledger has no customer deletion cascade, so deleting customer data cannot replenish that day's CPU allowance. Failed attempts consume the daily allowance and may retain reserved storage until cleanup. These limits are pilot safeguards, not a measured monthly hosting-cost guarantee.

## Failure and retention behavior

Repeated render requests for one storyboard/renderer version return the existing job. Failed or expired jobs are never automatically rerendered. Saving a new version is an explicit new attempt subject to the daily limits.

Before storage, the worker records the output hash and length. If acknowledgement is lost, “Check stored video” only reads and validates the existing object; it does not re-encode or upload again. A changed brand, copy, asset permission, storyboard or editing role prevents delivery. Downloads recheck authorization after the bounded private read and reject tampered bytes.

Outputs expire after 30 days. Removal immediately revokes application access and schedules physical deletion after seven days. Repeated removal does not extend that deadline. Failed deletion retains the private tombstone and quota for bounded cleanup retries. Previously downloaded files and backups are separate retention obligations.

## Verification and remaining video work

Local tests exercise actual encoding and probing, single-worker admission, tenant isolation, changed/revoked inputs, shot/final approval invalidation, fabricated-date rejection, ambiguous storage recovery and deletion failures. Browser tests cover storyboard versions, real encoded playback, final review, captions export and removal. The browser media response is test-only; bucket acceptance is not implied.

The supplied Hyperframes contract informed finite timeline and asset-reference constraints. Its runtime is not installed. The current implementation is an app-owned FFmpeg renderer. OpenMontage code was not copied.

Still required for the full video product: verified Higgsfield model/rate/expense transports and real output retrieval; licensed music/voiceover and audio captions; automated continuity/fidelity evaluation; reference-led provider revisions and platform-specific validation/transfer. Per-shot quotes, supplier authorization, receipt/provenance checks and uncertain-outcome reconciliation are implemented but use injected transports in local tests. The bounded storyboard timeline is not a multitrack editor. Finish these before describing video as complete with only credentials remaining.
