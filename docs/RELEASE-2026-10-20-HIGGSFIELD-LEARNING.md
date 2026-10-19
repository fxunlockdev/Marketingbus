# Higgsfield credential compatibility and procedure outcomes

## Changes

- The production Higgsfield shot adapter accepts the complete copied API key unchanged in `HIGGSFIELD_API_KEY`, with `HF_CREDENTIALS` / `HF_API_KEY` aliases. No manual credential splitting is needed. Legacy split credentials remain supported. Conflicting formats fail without printing secrets. Equivalent formats preserve account/quote identity; credential rotation invalidates it.
- Official `@higgsfield/client@0.2.6` and `dotenv@18.0.8` are pinned. The standalone operator example defaults to a no-network syntax check; an explicit paid-demo flag is required to submit. The published SDK returns `status` / `video.url`. No SDK example was submitted to the provider in this release.
- Production keeps its persistent estimate → single submission → resumed polling → private download/normalization lifecycle. Native audio in the standalone SDK example does not expand the current silent-footage product adapter.
- Memory now reports exact procedure-context usage and subsequent current review states, independently scoped to business, brand, task and destination. Source examples and human edits are excluded from new AI-output counts. The 90-day / 200-record-per-format sample is explicit. No extra model calls, automatic promotion, causal claims or model training are introduced.
- Native disclosure controls follow the accessibility skill guidance; existing product layout and approval controls are preserved.

## Verification

- Focused Higgsfield transport/registration checks after complete-key support: 99 passed. Procedure-outcome projection: 20 passed.
- Production build and TypeScript: passed.
- Browser suite with fresh local PostgreSQL, real loopback private S3/TLS and FFmpeg: 52 passed. Includes keyboard disclosure and automated accessibility checks of the Memory panel, onboarding, tenant isolation and actual local media playback.
- Production dependency audit: zero reported vulnerabilities.
- SDK demonstration with synthetic credentials, default mode: no-network syntax check passed. `.env.local` is ignored by Git.
- Final full backend/media regression run without concurrent build: 84 suites / 1,721 tests passed (`/tmp/marketingbus-v54-regression-serial.log`). An earlier concurrent run had three timeouts and a following queue assertion; affected suites passed unchanged, then the entire regression passed. An earlier run without explicit FFmpeg paths is not acceptance evidence.

## Provider configuration

The owner's staged Gemini and Higgsfield key additions were applied to production web. Worker now references web's `OPENAI_API_KEY`, `GEMINI_API_KEY` and `HIGGSFIELD_API_KEY`; resolved equality for all three was verified without exposing values. No keys were added to PostgreSQL. Model/rate cards and capability gates were not fabricated or bulk-enabled. Source `5cf81b4` was deployed to web `60614a3a-79ac-49f5-af27-8b94eacd27e7` and worker `bbd66938-6aa5-42b0-be89-5d522399bb64`; both observed SUCCESS.

## Limits

No real Higgsfield generation, Gemini image, social post or payment was made during this release. Credential presence is not account validation. Generation still requires verified model rates, output-host configuration and the existing execution controls. Live integrations, semantic/visual holdout quality and full-product acceptance remain incomplete.
