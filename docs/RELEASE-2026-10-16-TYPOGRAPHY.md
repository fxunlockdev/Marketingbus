# Measured typography release

Static compositions and silent motion captions now use bundled Figtree glyph outlines, measured wrapping and explicit overflow rejection. This replaces approximate character-count fitting and system-font fallback. It does not complete generated video, professional art direction or multilingual typography.

## Implementation and approval

The pinned font package contains Latin and Latin-extended faces at weights 400, 600 and 700. The renderer measures actual advances, kerning, bearings, ascenders and descenders; preserves explicit line breaks; normalizes combining marks; and rejects unsupported characters, hidden controls and overflowing words or boxes. SVG exports contain fixed outlines with escaped accessible text. Editable copy and JSON layouts remain available. No customer-uploaded or remote font is parsed.

Static export manifests bind six font fingerprints and renderer `static-outlines-v2`. Motion uses `motion-cards-v2-outlines`; worker runtime `studio-v13-measured-type` binds the font manifest into its configuration hash. Health checks validate packaged fonts and the new approval column.

Migration `20261016080000_typography_approval` adds nullable `StaticComposition.approvedRendererVersion`. Existing approvals are not silently transferred to changed rendering. Users must preview and approve the current layout before exporting again. Stale client approval requests fail validation. Older saved images and videos remain stored under their existing retention rules but cannot be delivered as current approved output. New renders use separate immutable records and require review. Retention/removal controls remain available.

## Local verification

299 tests pass across 34 unit/database suites, including actual local FFmpeg encoding. Coverage includes measured widths, kerning, Latin-extended characters, normalization, overflow, escaping, deterministic pixels, font fingerprints, legacy approval rejection, immutable replacement and current-role checks. All 22 browser journeys pass; the composition journey additionally verifies outlined SVGs, stale approval rejection, preview and explicit reapproval. One private-bucket browser case remains skipped without test credentials. Production build, TypeScript checks and the dependency audit pass with zero known vulnerabilities.

The generated static preview was visually inspected. Browser checks also confirm that customer Connections contains publishing destinations rather than AI providers. Provider and storage responses are injected only in tests. No paid AI calls, real email, payment, social post or production fixture was created.

## Deployment

Source `952d4dccaa8121a9f6839a61dbb4f7fd40a00e45` is deployed on both existing Railway services. Web deployment `b01a08a0-375e-474b-93b4-69c4313edc17` and worker deployment `fffca608-c2bc-4367-b188-ef42173a1263` both reported SUCCESS. The web applied migration `20261016080000_typography_approval`; the worker confirmed all 25 migrations with none pending and passed its private health check. Both run `studio-v13-measured-type`.

[GitHub CI run 38868944015](https://github.com/fxunlockdev/Marketingbus/actions/runs/38868944015) passed tests, build, browser checks and audit independently. Hosted read-only checks returned health 200 with no-store, studio 307 to login, and unauthenticated connections/compositions 401 with no-store. These checks establish deployment and access gating, not authenticated live-provider or bucket acceptance. No production fixture was created.

## Remaining scope

Custom font upload, other writing systems, emoji, calibrated creative-quality evaluation and broader template art direction remain separate work. Actual generated-shot/audio production, official social adapters/media transfer, Stripe, measured learning and production hardening remain in the [module completion plan](MODULE-PLAN.md). This release neither enables missing integrations nor proves live media-storage or provider acceptance.
