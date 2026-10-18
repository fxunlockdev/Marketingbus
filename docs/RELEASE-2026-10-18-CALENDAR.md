# Business-calendar release — 18 October 2026

Initial source: `9688932f06d1c41ed9123600ed3a06472585017c`, with a follow-up focus fix awaiting verification. Runtime: `studio-v22-business-calendar`. Additive migration: `20261018020000_calendar_versions` (33 migrations total).

## Local verification

- 538 unit/database tests in 44 suites pass, including ten calendar integration cases and three timezone/date cases.
- 30 browser journeys pass; one private-storage journey remains explicitly skipped. Calendar browser coverage includes all-plan reads, empty-date recovery, month/week views, keyboard/focus, drag proposals without submission, confirmation, stale edits, removal, unchanged linked posts/wallets, viewer/anonymous denial, automated accessibility and mobile width.
- Production build/type checking and dependency audit pass (zero known vulnerabilities at verification time).
- Real isolated synthetic PostgreSQL restore verifies 33 migrations, 52 tables and 59 rows, including tenant, credit replay/debt, uncertain operations and encryption-key checks. Temporary databases are removed. This is not production backup or object-storage recovery acceptance.
- Initial test fixtures incorrectly repeated inherited relation fields and omitted required synthetic published receipts; both were corrected. An exact-label dropdown test locator was corrected. A transient browser-context startup timeout was followed by two passing complete browser regressions. The final run includes the empty-date loading-state correction.

## Delivery verification

Initial source is pushed to main. [GitHub CI run 39100900161](https://github.com/fxunlockdev/Marketingbus/actions/runs/39100900161) passed unit/database tests, restore and build but caught a genuine post-save focus race: an animation frame could precede React's enabled-button commit. Focus restoration now runs in a post-commit effect. Deployment is held until the fix passes verification; no failing release was uploaded. Final source, deployment IDs and CI/live results will be recorded after verification.

## Scope

See [business-calendar operations](BUSINESS-CALENDAR.md). This release replaces the selected-plan-only internal agenda with bounded business-wide reservations, not a live social-post scheduler. Mutations require current authority, exact reservation versions and existing approval/brand checks. Linked queued, uncertain or published social posts block internal move/removal; internal removal no longer cancels real publishing work.

No paid supplier calls, real emails, payments or social publications were initiated. No customer credits, provider settings, spending limits or infrastructure resources are changed. Official platform adapters, generated-video/audio production, semantic quality evaluation, mixed-media autopilot and full enterprise acceptance remain unfinished.
