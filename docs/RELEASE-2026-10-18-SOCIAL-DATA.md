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

Source commit, CI and exact worker/web deployment evidence are recorded after verification. Upload alone is not deployment success. No application credentials, execution switches, spending limits or customer policy will be changed by this release.

## Remaining boundary

All three require approved app configuration, account-owner consent and designated live acceptance. Meta's Facebook Login route and current token/field/permission shapes must be checked in the chosen app; outbound/inbound credential-query redaction remains a live-enablement gate. Connection and data switches remain disabled by default. See [operator setup and acceptance](SOCIAL-ACCOUNT-DATA.md).

This release does not implement publishing/media transfer, token renewal/revocation webhooks, per-publication analytics ingestion or the full learning loop. X/YouTube remain planned. The broader product still has unfinished Higgsfield/audio, mixed-media automation, advanced creative evaluation and production-assurance work documented in [the module plan](MODULE-PLAN.md).
