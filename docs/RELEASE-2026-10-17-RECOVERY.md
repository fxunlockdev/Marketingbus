# Database recovery rehearsal evidence

This operator/CI update adds a repeatable synthetic PostgreSQL backup-and-restore check. It does not change the application runtime, schema, dependencies or production execution flags. The deployed web and worker remain the verified `4e217d7` release, runtime `studio-v19-video-formats`.

## Implemented scope

- Explicit loopback configuration, matching local Docker context/port and fresh random source/target database names. No existing database overwrite, caller-supplied archive or production fallback.
- Current migrations, a synthetic two-tenant fixture, bounded custom-format archive, integrity verification and single-transaction restore.
- Exact schema and all-public-table row fingerprints, including empty tables and migration history. The fixture has 57 rows total, including 31 migration rows; this is not a production-sized dataset.
- Tenant foreign-key and scoped-read checks, credit/payment uniqueness, idempotent and cross-tenant settlement checks, refund debt and unchanged uncertain jobs/refunds.
- Retained-key decryption after changing the active key; missing-key and cross-tenant decryption rejection; pending email preservation without delivery.
- Cleanup restricted to the two databases successfully created by that run. No container, volume, customer record or existing test database is deleted.
- CI rehearsal step and a [production recovery runbook](DATABASE-RECOVERY.md) covering isolation, key/object recovery, revocations, reconciliation and explicit cutover approval.

## Local verification

The full regression suite passes 488 tests across 40 suites. Fifteen new unit cases cover configuration, remote-address/connection-option rejection, Docker endpoint/port checks, database/table identifiers, corrupt archives, subprocess environment isolation and schema/data mismatch detection. All 27 browser journeys pass; one private-storage journey remains skipped without local bucket credentials. Production build, type checking and the dependency audit pass with zero known vulnerabilities.

The actual local PostgreSQL 17.11 rehearsal passes: 52 table fingerprints, 57 synthetic rows and all 31 migrations. The final local run produced a 154,543-byte archive; backup took 91 ms, restore 157 ms and the overall measured work before cleanup 1,392 ms. These small-fixture timings are not production RPO/RTO. Both temporary databases were removed, and a read-only catalog check found no leftover rehearsal databases. No app/worker was started, no production data was used and no provider call was made.

## Delivery

Source commit `c76fcbe3b87661cdaa7ea28843c2addac66c7421` is pushed to `main`. [GitHub CI run 39012627932](https://github.com/fxunlockdev/Marketingbus/actions/runs/39012627932) passes 488 tests in 40 suites, the real isolated PostgreSQL restore, production build/type checking, 27 browser journeys and dependency audit. One private-storage journey remains skipped. Linux CI independently verifies the same 52 tables, 57 rows and 31 migrations, and reports both temporary databases removed. Its restore step took 279 ms on the synthetic fixture.

This is test/operator tooling; no application deployment is needed. The live application remains on the preceding verified release. Existing CI action-runtime and upcoming Ubuntu-runner migration notices remain non-failing warnings.

## Remaining acceptance

Production backup coverage and schedules, retained key access, actual isolated Railway restoration, private-object recovery, identity/queue quarantine tooling, external payment/provider reconciliation and measured production recovery objectives remain. A successful SQL restore alone cannot establish restored object access, current permissions or safe outbound execution.
