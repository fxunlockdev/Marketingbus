# Learning evidence release 17 October 2026

This release binds experiment approval and copy-production preferences to reproducible, age-matched observations. It closes unsupported legacy promotion and stale-memory use; it does not establish causal improvement or complete all product modules. See [learning evidence policy](LEARNING-EVIDENCE.md).

## Verification

360 unit/database tests across 37 suites pass. Added cases cover stable cohort ordering, minimum observations, repeated posts, account/provider/definition separation, mismatched ages, old/future data, exposure outliers, source mutation/deletion, disconnected accounts, current roles, legacy evidence, concurrent decisions, expiring memory, and preference changes before acceptance, before submission and after a provider response. Production build/type checking passes and the dependency audit reports zero known vulnerabilities at verification time.

24 browser journeys pass, with one private-storage journey skipped without a test bucket. The new journey reviews saved evidence, approves and reverts an experiment, then changes a local metric and verifies promotion is refused. It also checks viewer denial, no credit reservation, automated accessibility and mobile width. An initial test locator matched both the page error and the framework route announcer; scoping it to main content resolves the test ambiguity.

All observations are local fixtures; provider responses are injected. No paid generation, real social publication, email, payment or refund was performed. The experiment panel screenshot is saved at `../outputs/marketingbus-learning-evidence.png` and contains synthetic test data only.

## Deployment

Source `c1f8ab869206f020a89849ddafa2ed2d221ac7e6` is pushed to GitHub and deployed on both services at runtime `studio-v15-evidence-memory`.

| Service | Deployment | Observed result |
|---|---|---|
| Web | `039afa85-e72a-45fe-b745-0ec54d23b7d9` | SUCCESS |
| Worker | `140be525-2ee3-458b-a3b1-98d997d983c6` | SUCCESS |

Both startup logs report 27 migrations with none pending. Hosted health returns 200 with no-store, signed-out studio redirects to login, and unauthenticated social/analytics reads return 401. [GitHub CI run 38999965782](https://github.com/fxunlockdev/Marketingbus/actions/runs/38999965782) passed tests, production build, browser acceptance and dependency audit for this source commit.

No new migration or infrastructure was created. Legacy unaccepted quotes need replacement, and queued work without a current preference fingerprint stops before supplier submission with customer credits released. Stored historical records and delivered outputs are retained.

## Remaining work

Official social metrics/publishing adapters, paid-distribution separation, holdouts and measured outcomes, mixed-media automation, generated video/audio, stronger brand/image evaluations, Firecrawl deployment and enterprise assurance remain unfinished. This release provides guarded observational experiment use, not model training or an agency-quality guarantee.
