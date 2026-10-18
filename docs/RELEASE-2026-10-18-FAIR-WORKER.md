# Fair worker and Facebook publishing — combined release

Runtime `studio-v27-fair-worker`. Includes Facebook source commit `5eaa8626fe5bfd10db78c29c3c095aa02b5bf9b0` (independently passed [CI 39111034206](https://github.com/fxunlockdev/Marketingbus/actions/runs/39111034206)) and subsequent worker scheduling hardening. No new migrations; the schema remains at 36 migrations.

The worker now gives every enabled workflow one sequential attempt per cycle, isolates workflow failures, refreshes readiness between long operations and stops starting work after shutdown. Existing flags, approvals, reservations, budgets and uncertain-write safeguards remain inside each worker. Facebook text publication is explicitly gated and still needs designated-account acceptance. See [scheduling](WORKER-SCHEDULING.md) and [Facebook publishing](FACEBOOK-PUBLISHING.md).

## Verification

- Local regression: 780 tests across 52 unit/database suites pass. Includes 13 scheduler tests and one actual child-process startup/HTTP-health/readiness/shutdown test without supplier credentials.
- Local browser regression: 32 journeys pass, one private-storage journey skipped. No additional UI changes in the scheduler portion.
- Production build, type checking and dependency audit pass; zero known vulnerabilities.
- The unchanged schema passed this run's isolated synthetic restore: 36 migrations, 52 tables, 68 rows. CI repeats the rehearsal for the exact combined source. No production/object restore was performed.
- Exact combined source `bdf2748333f04c81279ddd4403cbed05f501f526` passed [CI 39112033546](https://github.com/fxunlockdev/Marketingbus/actions/runs/39112033546), including the full suites, build, synthetic restore and audit. The CI watcher briefly failed while fetching annotations; an independent run-status read confirmed the exact SHA completed successfully. No rerun or bypass was needed.

## Deployment verification

Both services were uploaded from a fresh tracked-file archive of that exact CI-passed commit, excluding local credentials and generated test artifacts. Worker deployment `661222d8-c471-4fc1-9c7a-2d779a2f3684` reported SUCCESS before web deployment `a34c31d1-52c0-44ce-8f54-c9c8ca872776`, which also reported SUCCESS. Logs confirm 36 migrations, none pending, and successful worker/web startup. A bounded worker-error log check returned only the existing npm configuration warning.

Hosted `/api/health` returns 200/no-store and `status: ok`; signed-out `/studio` returns 307 to `/login`; anonymous connections, account-data and social reads return 401/no-store. Facebook, Instagram and LinkedIn denial callbacks return 303 to fixed relative `/social-connect?failed=1`, no-store/no-referrer, with empty bodies. The first smoke assertion incorrectly expected an absolute redirect; it was corrected to the existing safe relative contract and all checks then passed. These checks do not establish authenticated live-provider acceptance.

## Remaining boundaries

This is reliability hardening, not full queue process isolation, load/chaos assurance or a finished product. No provider flags, credentials, spending limits or infrastructure resources were changed. No paid AI/media call, live publication, email, charge or refund was performed. See the [completion plan](MODULE-PLAN.md), [activation checklist](ACTIVATION-CHECKLIST.md) and [Higgsfield contract research](HIGGSFIELD-INTEGRATION-NOTES.md) for the next engineering and acceptance gates.
