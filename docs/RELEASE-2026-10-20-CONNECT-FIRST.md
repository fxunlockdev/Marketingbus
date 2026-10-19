# Connect before brand setup

## Behavior

- Connections now offers a workspace/name form for a durable unconfirmed business draft. No website or complete brand profile is needed to begin OAuth. The same draft resumes onboarding; it is not a separate customer record.
- Owner/admin authorization, tenant scoping, three-business pilot allowance and idempotency apply to draft creation. OAuth retains session binding, permission checks and encrypted temporary grants. Creating a draft never authorizes generation or publishing.
- One non-disconnected account per platform per business is enforced under the business lock and by a PostgreSQL partial unique index. Expired/reconnect-required accounts retain their slot. Renewing the same account is allowed. Switching accounts requires explicit disconnection; historical publications retain their original connection IDs.
- The migration never deletes duplicate grants. If pre-existing duplicate live destinations exist, deployment fails safely until an operator resolves the accounts with their owner.
- Normal guided setup requires a public HTTPS website in the UI and server. Connection-only drafts may omit it until setup resumes. Saving the initial website with explicit import consent requests the existing bounded Firecrawl import. Recent sources are reused by the source service; scraping does not automatically approve facts or invoke paid brand analysis.
- A missing/failed scraper produces a visible error without losing the saved draft. Retry remains explicit in Business evidence. No fake extraction is displayed. Legacy non-guided brand API compatibility is unchanged.

## Acceptance boundary

Local tests use synthetic OAuth adapters, not real social accounts. Provider credentials/permissions, live consent and publishing acceptance remain separate. Firecrawl is not configured in production at this release's start. New UI controls follow the accessibility skill's native labels, required fields, keyboard access and announced errors.

## Verification

- Full local PostgreSQL/backend/media regression: 84 suites / 1,730 tests passed, with explicit FFmpeg/FFprobe paths (`/tmp/marketingbus-v55-regression.log`).
- Production build including TypeScript passed (`/tmp/marketingbus-v55-build-final.log`).
- Nine focused browser tests passed against the final build: new-account catalogue, connect-first/resume, mandatory website, unavailable scraper, keyboard/accessibility, connection lifecycle, full guided setup and tenant boundaries (`/tmp/marketingbus-v55-browser-final.log`).
- Migration 60 applied successfully to both isolated local test databases. Direct duplicate inserts are rejected; concurrent verified grants leave one slot occupied. Existing metric-context tampering tests use a historical disconnected account and retain their rejection assertions.
- No paid provider generation, real social posting, email delivery or billing transaction was performed.
- Full browser acceptance: 53 tests passed against an isolated PostgreSQL database, including real local private-S3/media transfer and FFmpeg checks (`/tmp/marketingbus-v55-all-browser.log`). Synthetic storage resources were cleaned up by the fixture.

## Production receipt

- Source: `c0fecbed0017e0cf0b19d8f171bf6083b44be1d0`; both services uploaded from the same tracked-source archive.
- Web deployment `5c8aa115-95c4-4bf3-8d5f-541b28d78fc4`: SUCCESS.
- Worker deployment `14bf7537-a779-4cc6-8fc1-d8906e06acc8`: SUCCESS.
- Migration 60 applied successfully in production; the other service reported no pending migrations. Web and worker startup logs are present, and the public `/api/health` returned HTTP 200 with `{"status":"ok"}` after deployment. This checks database/schema availability, not every external integration or worker capability.
- The earlier 00:48:55 GMT+8 SIGTERM belongs to removed worker deployment `91e5390c-f007-403c-98a7-e945886e5b4e`. Replacement `bbd66938-6aa5-42b0-be89-5d522399bb64` started at 00:48:42, before the old container stopped. Database EOF/reset entries coincide with the handover; subsequent checkpoint LOG entries are routine database activity. These entries alone do not demonstrate repeated worker crashes.
