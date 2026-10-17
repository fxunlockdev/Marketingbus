# Video export formats release evidence

This release adds portrait, square, 4:5 feed and landscape output to the bounded silent motion renderer. Each uses a finite logo/media/caption layout, not an arbitrary resize of approved pixels. See [motion operations](VIDEO-PRODUCTION.md).

## Implemented scope

- An accessible format selector, exact output dimensions, format-specific draft footage window and format-named browser downloads.
- Format-bound scene approval: changes clear all shot reviews, cancel queued older output and block old delivery without overwriting stored bytes.
- Measured caption-fit validation before save/review, with repair support for earlier overflowing drafts.
- Exact dimensions, bounded pixels and finite duration checked before private storage. The renderer probes real encoded output.
- Legacy documents without a format retain portrait meaning and their previous JSON/hash representation.

Runtime: `studio-v19-video-formats`. Renderer: `motion-cards-v5-formats`. No schema migration; the existing 31 migrations remain required. No dependency or paid infrastructure was added, and execution flags are unchanged.

## Verification

Local verification passes 473 tests across 39 unit/database suites, 27 browser journeys, production build/type checking and dependency audit (zero known vulnerabilities). One private-storage browser journey remains skipped without local bucket credentials. The 22 new unit/database cases exercise actual encoded dimensions and pixels, original logo/image placement, footage visibility, review invalidation, malformed formats, invalid worker dimensions/duration, mid-render changes, caption overflow and repair. The new browser journey covers keyboard format selection, actual landscape encoding/playback, approval, JSON download, changed-format delivery refusal, viewer denial, automated accessibility and mobile width. Tests do not call paid providers.

Browser verification initially exposed two test-harness issues, now corrected: native select type-ahead avoids an unintended form submission on macOS, and the clip seeking test waits for playback to advance before seeking beyond the selected range. The full browser rerun passes without retries.

## Delivery

Source push, CI and deployment pending. The preceding deployed runtime remains `studio-v18-shot-jobs` until successful deployment evidence is recorded here.

## Remaining boundaries

These are export shapes, not certified social-platform profiles. Actual publishing/media transfer, 1080p/4K delivery, audio, live Higgsfield transport, reference-led video revision and semantic continuity/fidelity evaluation remain. Authenticated production rendering and bucket/decoder isolation acceptance remain separate from local encoder tests.
