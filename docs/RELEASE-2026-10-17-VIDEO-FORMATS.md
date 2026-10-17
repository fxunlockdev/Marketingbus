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

Source commit `4e217d7fdf890dffb32818d8b6ae8baaf43fee8e` is pushed to `main`. [GitHub CI run 39010515376](https://github.com/fxunlockdev/Marketingbus/actions/runs/39010515376) passes all 473 tests in 39 suites, 27 browser journeys, build/type checking and dependency audit. One private-storage journey remains skipped. CI reports existing action-runtime and upcoming Ubuntu-runner migration notices; neither is a failed check.

Both exact Railway deployments reported SUCCESS:

- Web: `b1b710b1-95c6-4831-b581-5a50d931a2b6`.
- Worker: `1c147423-f4ed-4167-ba09-ee796271eeff`.

Both migration logs report all 31 migrations with no pending migration. Runtime logs show the web server ready and worker started. Hosted `/api/health` returns 200 with `status: ok`; signed-out `/studio` redirects to `/login` with 307; unauthenticated video access returns 401. These checks verify deployment and access boundaries, not authenticated hosted rendering or real bucket/provider acceptance. No production fixture, paid supplier call, email, payment or social post was created.

## Remaining boundaries

These are export shapes, not certified social-platform profiles. Actual publishing/media transfer, 1080p/4K delivery, audio, live Higgsfield transport, reference-led video revision and semantic continuity/fidelity evaluation remain. Authenticated production rendering and bucket/decoder isolation acceptance remain separate from local encoder tests.
