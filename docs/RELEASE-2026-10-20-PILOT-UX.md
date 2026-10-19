# Pilot UX and reviewed creative procedures

## Implemented

- Compact responsive six-step onboarding, narrower content, balanced columns, readable fields and a sticky primary-action area. First step fits at 1440×900; mobile 390px has no horizontal overflow.
- Publishing destination catalogue remains visible before business setup: Instagram, Facebook and LinkedIn. Setup/permissions remain necessary. AI vendors are not customer connections.
- Review combines destination and static/motion filters, with a clear reset for empty results. Asset creation remains unified.
- Reviewed creative procedures: bounded reflection on corrected/approved examples, source-quote validation, explicit activation/replacement/retirement and matching task/channel recall through the shared business graph. See CREATIVE-PROCEDURES.md for boundaries.
- Operator-configured, exact-email, expiring and idempotent pilot credit allocations on authenticated login. No public credit grant and no change to provider-spend gates.

## Verification before deployment

- 1,689 tests across 83 suites passed against an isolated PostgreSQL database with all 59 migrations.
- 52 browser tests passed using real local private S3 transport and motion rendering; no cloud storage or paid provider calls.
- TypeScript and production build passed.
- New onboarding, review filtering and procedure activation/retirement flows have browser accessibility coverage. This is not a claim of exhaustive accessibility certification.

## Still gated

Live social approvals/accounts, missing provider credentials and delivery settings still require acceptance. The new reflection reasoning call has contract/mock tests, not live-provider creative-quality acceptance. Written visual-direction learning does not inspect rendered pixels or video. No claim of 100% product completion, automated agency quality or verified production backup recovery.
