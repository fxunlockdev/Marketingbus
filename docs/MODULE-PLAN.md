# Marketingbus module completion plan

The target is a working multi-tenant marketing product, with only explicitly identified provider integration and acceptance steps remaining. That target has not been reached. This checklist separates internal implementation from credentials, platform approvals, deployment and live verification. A screen or adapter interface alone does not complete a module.

## Completion rules

Every module needs scoped persistence, role checks, usable screens, failure/recovery behavior, cost bounds where applicable, database tests, browser tests and deployment verification. Fixture transports must never be registered as production providers. Customer Connections contains publishing destinations only; AI providers are operator-managed.

Local source changes are not production deployment. Third-party account approval and creative quality cannot be guaranteed by code or a test count. No further paid AI calls are authorized by this plan.

## Module 1 Billing and credits

Implemented locally: server-owned offer catalog; owner/admin checkout and portal actions; frozen checkout terms and stable retry identifiers; bounded raw-body webhook intake behind a signature-verifying adapter; durable payment inbox; one grant per payment and subscription period; top-ups; cumulative refund accounting; protected revision balances; refund debt; shared workspace balances; payment and credit history screens; worker processing; migration-aware health checks.

Verification covers concurrent duplicate events, changed replay payloads, unsafe redirects, cross-workspace access, renewal duplication, partial and out-of-order refunds, held-credit settlement and bounded webhook bodies. Browser checks cover actual empty balances, fail-closed payments, accessibility and mobile width.

Remaining: implement and verify the Stripe adapter, authoritative account/livemode/signature validation, monthly-price mapping, checkout/cancellation and portal behavior, provider refund initiation and operator review/reconciliation tooling. Test discounts, taxes, disputes and provider-specific event ordering before release. Commercial terms and margin acceptance remain separate. Credits currently carry forward; there is no expiration scheduler or invented initial balance.

## Module 2 Brand intelligence

Implemented locally: tenant-scoped TXT/Markdown evidence; cached, bounded website import queue; selectable-text PDF and DOCX upload with separate-process extraction; permission-limited Node 26 runtime; 5 MB input, 40 PDF pages, 24 KB extracted text, 15-second limit and two parsers per web process; import rate limits; deduplication, review and deletion. Original binaries are not retained. Extraction does not approve facts or follow embedded instructions.

Also implemented locally: source/version-linked AI analysis quotes; explicit credit authorization; a single-submit worker; validated exact-excerpt fact proposals and separately labelled inferred tone; current/proposed comparison with citations; selective apply and rejection; stale-brand and deleted-source invalidation; cancellation before submission; measured supplier settlement and operator reconciliation of uncertain outcomes. Brand and copy share atomic daily and lifetime supplier limits. Applying suggestions creates an unconfirmed draft and invalidates dependent plans and schedules. Source deletion redacts stored proposals; copied profile facts and backups remain separate. Provider responses are injected only in tests.

Remaining: semantic copy/visual factual checks beyond exact-excerpt matching; broader adversarial grounding evaluations; cross-source contradiction classification; production provider acceptance. Exact quotations do not establish source truth and inferred tone still requires review. Scanned PDFs/OCR are not supported. Production needs verified Node 26 packaging and parser resource isolation; process permissions and heap limits are not a substitute for OS/container resource enforcement. Deploy and measure self-hosted Firecrawl separately before enabling website intake.

## Module 3 Image production

Existing foundation: original approved brand assets, editable composition, four canvas sizes and PNG/SVG/JSON exports.

Added locally: persistent private PNG exports tied to an approved composition, copy and brand version. The manifest binds original asset hashes, layout/copy hashes, placement and renderer version. Save/reuse/download/remove/recover controls use tenant and current-role checks. Storage uses a conditional immutable write and hash-verified read-back; ambiguous writes are checked without another upload. Pre-storage failures can retry under a new lease. Downloads are rejected after layout/copy/brand changes, asset permission revocation, expiration or tampering. Two concurrent renders per web process bound rendering load. Export quota is reserved before rendering (5 MB each; 50 MB or 50 active exports per business). Files expire after 30 days; removal revokes access immediately and schedules physical deletion after seven days. Cleanup retains private tombstones and quota after failures, with bounded retries. Previously downloaded copies and backups are separate.

Added locally: Gemini REST image transport and a complete supporting-artwork job path: approved-copy eligibility, frozen style references, quotes, explicit authorization, shared supplier caps, protected revision credits, private storage reservation, single submission, byte normalization and hash verification, human approval/rejection, parent-image revisions and composition/export linkage. Original logos/products are composed exactly, never sent for generative redrawing. The cheaper verified revision lane is eligible only for parent-bound changes. Current reference permissions are checked again before final export. A revision preserves the original style-reference permission chain. Review-policy changes revoke visual approval.

Failures before submission release credits; unknown supplier outcomes retain the hold for operator reconciliation without another call. Known-cost but invalid/stale output releases customer credits and records supplier expense. Ambiguous stored media remains private and is queued for seven-day cleanup. An approval replay does not invalidate a previously approved composition. See [image operations](IMAGE-PRODUCTION.md).

Remaining internal work: automated semantic visual-claim checks, calibrated fidelity/revision-adherence evaluation, professional typography and social media-transfer linkage. The current acceptance gate is explicit human visual review, not automated fidelity certification. Live Gemini capabilities/prices, real bucket behavior and output quality remain unverified. No paid Gemini calls were made.

## Module 4 Video and motion

Implemented locally: versioned storyboard screens; original-asset references; per-shot review with unchanged-review retention; separate whole-storyboard and finished-video approval; silent 720 × 1280 H.264 motion cards; hold/fade scenes; six-shot/30-second limits; private immutable storage; MP4/VTT/JSON export; global and per-business CPU admission limits; worker readiness; no automatic rerender after ambiguous outcomes; read-only storage recovery; scoped revisions and retention cleanup. Independent-review policies and changed brand/copy/asset permissions invalidate delivery. Actual local encoding and browser playback are tested. See [motion operations](VIDEO-PRODUCTION.md).

Added and deployed: explicit reuse of approved generated artwork from the same business, without new generation charges. Batched checks retain source copy/plan/brand approval, reference hashes/permissions and latest-image authorization. Rejection, changed copy, blocking comments, revoked references and newer authorized images block encoding and delivery. Changes during encoding prevent storage. The editor labels generated artwork and unavailable selections; logos remain original. Ten new database cases and a browser selection/revocation/repair journey cover this path. Both services run `studio-v10-motion-artwork`; no migration was added.

Remaining internal work: generated/uploaded clip quarantine; quote and settlement per generated shot; supplier jobs and reconciliation; licensed audio/voiceover; semantic continuity/fidelity evaluation; mixed-media assembly and platform exports. The current path is silent app-owned motion rendering, not a Higgsfield or Hyperframes runtime integration. Production binary/container packaging and real bucket acceptance remain. Higgsfield endpoints and model/rate verification are external integration steps, not substitutes for the unfinished workflow.

## Module 5 Social publishing and analytics

Existing foundation: encrypted token records, exact-revision publishing queue, retries/reconciliation contracts, nullable metric snapshots and customer analytics views.

Required internal work: OAuth start/callback/state and supported PKCE; scope validation; refresh/revocation handling; platform adapters and media transfer; immutable post payloads; operator reconciliation; metric-definition mappings and attribution windows. Test replayed callbacks, cross-workspace account binding, expired tokens, ambiguous publish results, duplicate webhooks and missing metrics. Meta/LinkedIn access approvals and designated live accounts remain external gates. Do not claim a post was published without a verified platform receipt.

## Module 6 Learning and bounded automation

Existing foundation: explicit memory, observational learning proposals with human promotion/revert, independent approval controls and blocking comments, weekly policy/cycles, one cycle per business/week, a frozen brand version and atomic weekly copy budget authorization.

Added and deployed: scoped plan history with stable ten-plan pagination, bounded detail reads and only the latest plan loaded initially. Selected plans carry across review, design, video and the calendar; the calendar is explicitly a selected-plan agenda. Earlier current-brand plans retain normal edit/review controls. Superseded, unconfirmed-brand and viewer copy is read-only and shown without today's design palette. Opening history creates no jobs or credit holds. History displays the latest saved copy, not every revision or historical media snapshot.

Required internal work: mixed image/video planning, cancellation/reconciliation experience, cohort/holdout evaluation, promotion thresholds and measured creative outcomes. Test brand/role changes, period boundaries, duplicate ticks, budget exhaustion, worker restarts and evidence invalidation. Autopilot must not silently approve or publish work or bypass the supplier ceiling.

## Module 7 Production readiness

Implemented locally: invitation-aware registration, in-page existing-account sign-in and explicit acceptance. New users receive only the invited workspace role and no new wallet or credits. The one-use emailed token verifies the exact new address; it cannot overwrite an existing account or bypass MFA. Revocation, expiry and inviter authority are checked transactionally. Tokens remain in page memory after the URL fragment is removed. Reloading requires reopening the original email link.

Required internal work and verification: organization MFA policy; recovery and key-rotation procedures; billing/provider reconciliation operations; alerts and dead-letter visibility; backup and restore rehearsal with data assertions; realistic load/chaos tests; manual keyboard/screen-reader review; independent security review. Prove hosted business onboarding through approval/export without fabricating provider outcomes.

## Current release boundary

Web release `ec4e1ca` is deployed successfully with plan history; the unchanged worker remains at `ac9c00e`. No migration or runtime contract changed. Local and GitHub CI run `38768304268` pass 254 tests across 32 suites, 19 browser journeys, build and audit; one storage case is skipped. Hosted health and unauthenticated history denial pass. This closes basic historical plan navigation, not mixed-media automation or measured learning.

### Previous artwork release

Release `ac9c00e` is deployed on web and worker with all migrations through `20261015210000_motion_storyboards`. Both current deployments reported success. The runtime is `studio-v10-motion-artwork`, public web health returns 200 and unauthenticated video access returns 401. GitHub CI run `38756304205` passed 248 tests across 31 suites, 18 browser journeys, the production build and dependency audit; one private-storage browser case remains skipped. See [release evidence](RELEASE-2026-10-15-MODULES.md). Billing, document, brand-review, saved-export, image-production and motion-storyboard work must not be described as completion of all seven modules. Next complete generated-shot and mixed-media production, then social adapters, measured automation and release assurance, while closing the remaining brand/image quality checks.

Verification on 15 October 2026 covers invited registration, actual FFmpeg encoding, approved-artwork provenance, storyboard/worker lifecycle, bounded storage transport, image generation, grounded brand analysis, shared cost limits and private exports. Browser journeys cover invitation signup/sign-in/revocation, artwork selection/revocation/repair, storyboard revisions, real encoded playback and final review, image controls, brand review, tenant isolation, billing, documents, onboarding, copy/calendar, identity/MFA and composition/analytics/team protections. Browser video media uses a test-only response with real encoder bytes; provider/storage responses are injected only in tests. These checks do not constitute a security review, full load test or live provider acceptance.

The original local Docker disk filled during verification. A separate temporary, memory-backed PostgreSQL container (`marketingbus-brand-tests`, localhost port 55439) was used without deleting unrelated Docker data. Its data is disposable and disappears when the container is stopped; it is not production storage. Paid AI, email, website and social execution remain disabled on the local preview server.

## Brand analysis operator recovery

An uncertain provider submission is never automatically retried. Verify the provider's actual expense independently, then use `scripts/reconcile-brand-analysis.ts` with `--analysis`, `--supplier-cost-micros`, `--evidence` and `--operator`. The procedure accepts only uncertain jobs, rejects expenses above authorization, releases customer credits and records supplier expense without delivering unverified suggestions. Repeated identical resolution is safe; changed replay evidence is rejected. This is a privileged server procedure, not a customer API. A full operator administration screen remains a release dependency.
