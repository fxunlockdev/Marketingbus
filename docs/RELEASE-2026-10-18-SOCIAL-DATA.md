# Social authorization and account-data release — 18 October 2026

## Scope

- Facebook Page and linked Instagram professional authorization/discovery, alongside the existing LinkedIn company adapter.
- Gated read-only profile/recent-post imports for all three; optional LinkedIn lifetime organic company statistics, never inferred conversion or per-post metrics.
- Saved-data view, refresh/removal, explicit confirmation/focus recovery, null metrics, safe text/links, bounded pagination and independent platform gates.
- Tenant/session/role/MFA checks, one-use callbacks, encrypted credentials, persisted refresh lease/cooldown, late-result invalidation and 30-day retention.
- Additive migration `20261018030000_meta_social_data`; runtime `studio-v24-social-account-data`.

## Local evidence

- 669 tests across 48 unit/database suites passed; no skipped database suites. Includes Meta exchange/debug/account verification, both real adapter flows through PostgreSQL selection, all-three data transports and concurrency/access-change failure cases.
- 31 browser journeys passed; one private-object-storage journey skipped because no test bucket is configured. New journey verifies saved-data reads, safe caption rendering, null versus zero, viewer/cross-business/anonymous/CSRF denial, removal/focus, automated accessibility and mobile width. Screenshot inspected locally.
- Production build, TypeScript and dependency audit passed; zero known dependency vulnerabilities at the check time. This is not a penetration test.
- Isolated synthetic database restore passed: 35 migrations, 52 tables, 62 rows, schema/row fingerprints and key/tenant/accounting checks. New fixtures cover the Meta authentication mode and account-data fields. No production backup or object recovery was performed.
- No paid AI calls, social posts, real platform grants, emails or payments. HTTP fixtures are injected into the actual transports and cannot be enabled through production configuration.

## Delivery

Verified source: `bc6a54cd14faa81d20c1955dbe4ed0a565ff750b` (feature commit `5e42506` plus an explicit expiry-versus-background-retention wording clarification). Source is pushed to main. [Final GitHub CI run 39106015886](https://github.com/fxunlockdev/Marketingbus/actions/runs/39106015886) passed in 3m53s: 669 tests/48 suites, 31 browser journeys with one explicit private-storage skip, the 35-migration/52-table/62-row restore rehearsal, build and audit. The initial feature run `39105854072` also passed. The final wording change passed a fresh local build and focused browser journey. CI still reports non-blocking action-runtime/ubuntu-latest migration warnings, which belong to a separately verified toolchain-hardening change.

Both services were uploaded from a fresh tracked-source archive of that exact final commit, excluding local credentials, dependencies and test artifacts. The worker was released first; its logs confirm migration 35 applied successfully before web deployment.

| Service | Exact deployment | Observed result |
|---|---|---|
| Worker | `99e7a2d9-241a-4e75-8dd0-7025731528d2` | SUCCESS |
| Web | `365d91ff-973f-4916-b893-956042e2bc81` | SUCCESS |

Hosted smoke checks after web SUCCESS: health 200/no-store with `status: ok`; signed-out studio 307 to login; anonymous connections and account-data reads 401/no-store; Facebook, Instagram and LinkedIn callback errors 303 to the fixed `/social-connect?failed=1` recovery page, with no-store/no-referrer and empty bodies. No production fixture account was created. Web logs confirm 35 migrations and no pending migration.

No application credentials, execution switches, spending limits or customer policy were changed. New flags remain absent/disabled by default; deployment does not establish live consent, working provider data or authenticated production acceptance.

## Remaining boundary

All three require approved app configuration, account-owner consent and designated live acceptance. Meta's Facebook Login route and current token/field/permission shapes must be checked in the chosen app; outbound/inbound credential-query redaction remains a live-enablement gate. Connection and data switches remain disabled by default. See [operator setup and acceptance](SOCIAL-ACCOUNT-DATA.md).

This release does not implement publishing/media transfer, token renewal/revocation webhooks, per-publication analytics ingestion or the full learning loop. X/YouTube remain planned. The broader product still has unfinished Higgsfield/audio, mixed-media automation, advanced creative evaluation and production-assurance work documented in [the module plan](MODULE-PLAN.md).
