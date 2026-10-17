# Shot trimming and framing release

The video studio now edits which part of reviewed footage appears in each scene and how it is framed. These changes complete bounded shot trimming and reframing, not supplier-generated video, audio or the full product.

## Implementation

- Source start times use quarter-second steps. The selected source interval must fit the approved clip; output timing remains separate. Fit preserves the whole frame; Fill uses bounded horizontal and vertical crop positions.
- Keyboard-accessible controls include range errors and a draft footage preview restricted to the selected interval. The preview is approximate and does not replace final encoded review.
- Saved trim and crop values participate in the exact shot hash. Only unchanged reviews survive a new storyboard version. Changes invalidate older render delivery; ranges and source permissions are rechecked before encoding, after encoding and before download.
- New clip normalization preserves aspect ratio within 720 × 1280 without upscaling or baked-in padding. Anamorphic sources are rejected. Previously reviewed padded clips remain usable without rewriting their bytes; pending old-processor jobs are not silently upgraded.
- Runtime `studio-v17-shot-editing`, renderer `motion-cards-v4-framing` and processor `silent-clip-v2-native-aspect` identify the new contracts. No migration is added. Older rendered output requires a new render and final review for delivery.

## Verification

Actual encoder tests inspect output pixels to verify source-time selection, left/right crop positions and Fit padding. Database tests cover source bounds, rollback of invalid saves, unchanged-review retention, delivery invalidation, legacy compatibility and unavailable clip selection. No AI credits are charged for these edits or local rendering.

All 25 local browser journeys pass; one private-storage journey remains skipped. The footage journey verifies invalid-range feedback, keyboard crop control, preview seeking/playback bounds, exact timeline labels, review retention, removal/repair, role/access denial, automated accessibility and mobile width. The editor screenshot was inspected. Browser video bytes use a test-only transport; production bucket acceptance remains separate.

All 409 local unit/database tests across 38 suites pass, along with the production build, type checking and dependency audit. The audit reports zero known vulnerabilities, not comprehensive security certification. GitHub CI run [39004187425](https://github.com/fxunlockdev/Marketingbus/actions/runs/39004187425) passes the same 409 tests, 25 browser journeys, build and audit for source `85dd5da33d7bd46d6785ead98b4c17c80fe2236c`.

Web deployment `a2e9ed2d-d8f6-44b8-937e-ab191679991e` and worker deployment `eb1a8d01-d30d-4504-a83a-32815cec7336` both reported SUCCESS. Migration logs confirm all 28 migrations applied. Hosted `/api/health` returns 200 with no-store; `/studio` redirects signed-out users to login; unauthenticated clip-library and clip-media reads return 401 with no-store. These smoke checks do not establish authenticated hosted rendering or storage acceptance.

## Remaining release gates

Real bucket acceptance and patched decoder/container resource isolation still gate customer processing. Supplier-generated shot jobs and cost settlement, licensed audio/voiceover, semantic continuity/fidelity evaluation and platform-specific exports/transfer remain unfinished. No paid AI/media calls, real payments, emails or social posts are part of this verification.
