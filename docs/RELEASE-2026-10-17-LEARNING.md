# Learning evidence release 17 October 2026

This release binds experiment approval and copy-production preferences to reproducible, age-matched observations. It closes unsupported legacy promotion and stale-memory use; it does not establish causal improvement or complete all product modules. See [learning evidence policy](LEARNING-EVIDENCE.md).

## Verification

360 unit/database tests across 37 suites pass. Added cases cover stable cohort ordering, minimum observations, repeated posts, account/provider/definition separation, mismatched ages, old/future data, exposure outliers, source mutation/deletion, disconnected accounts, current roles, legacy evidence, concurrent decisions, expiring memory, and preference changes before acceptance, before submission and after a provider response. Production build/type checking passes and the dependency audit reports zero known vulnerabilities at verification time.

24 browser journeys pass, with one private-storage journey skipped without a test bucket. The new journey reviews saved evidence, approves and reverts an experiment, then changes a local metric and verifies promotion is refused. It also checks viewer denial, no credit reservation, automated accessibility and mobile width. An initial test locator matched both the page error and the framework route announcer; scoping it to main content resolves the test ambiguity.

All observations are local fixtures; provider responses are injected. No paid generation, real social publication, email, payment or refund was performed. The experiment panel screenshot is saved at `../outputs/marketingbus-learning-evidence.png` and contains synthetic test data only.

## Deployment

Pending. Runtime `studio-v15-evidence-memory` requires web and worker to deploy together. No new migration; the existing 27 remain. Legacy unaccepted quotes need replacement, and queued work without a current preference fingerprint stops before supplier submission with customer credits released. Stored historical records and delivered outputs are retained.

## Remaining work

Official social metrics/publishing adapters, paid-distribution separation, holdouts and measured outcomes, mixed-media automation, generated video/audio, stronger brand/image evaluations, Firecrawl deployment and enterprise assurance remain unfinished. This release provides guarded observational experiment use, not model training or an agency-quality guarantee.
