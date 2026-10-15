# Production workflow: gated copy pilot

This release implements a real database-backed copy workflow, not the complete media/publishing product. Two real OpenAI calls were verified on 14 October 2026 using an isolated local database and the production service/worker code. They do not establish hosted end-to-end acceptance. Test transports are injected only inside tests; there is no production mock mode.

## Authorization and cost

1. A member with OWNER, ADMIN or EDITOR access confirms a business profile and creates a planning outline.
2. For one static item, the user provides a direction and requests a quote. The application compiles the brand, explicit memories, Humanizer and relevant specialist references.
3. The router selects a configured creative-lane model for initial concepts or substantial revisions. Only copy-only revisions are eligible for a routine-lane model. This is explicit policy routing, not a trained quality predictor.
4. A ten-minute quote freezes the prompt, reference hashes, brand/version, route and uncached cost ceiling. There is no provider call at quote time.
5. Acceptance atomically reserves the wallet, authorizes supplier spend and creates one durable PostgreSQL job. Repeated acceptance returns the same job. Missing funds or invalid state rolls back everything.
6. The worker checks the authorization again, records SUBMITTING before the network call, and never blindly retries an ambiguous submission. Worker death after submission leaves the job for reconciliation.
7. Valid output is saved as READY; actual reported token usage is costed using the accepted rate card. Unused credits are released. Invalid/stale deliverables release customer credits while still recording known supplier cost.
8. Approval, rejection, feedback and manual copy edits make no provider calls. A copy edit creates a new version, removes its old calendar reservation and requires new approval.

One credit currently represents up to $0.01 of budgeted supplier cost. This is not proof of net profit. The $800 plan, 8,000 monthly credits, protected 20% revision allocation and payment grants are not commercially active. Routing uses conservative byte-based input bounds, output-token ceilings and 20% headroom. No cache savings are assumed. Daily spend admission counts full accepted ceilings, including unresolved prior-day jobs; this deliberately underutilizes a budget rather than treating uncertain calls as free. No automatic cheap-model→premium-model retry exists yet.

## Operator configuration

Keep `PAID_EXECUTION_ENABLED=false` until provider access, terms, exact model capabilities, price verification, worker health, credit funding and a live test-spend ceiling are approved. Do not paste secrets into prompts or commit them.

Server variables on both web and worker:

- `DATABASE_URL`: the same private PostgreSQL database.
- `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY`: server-side credentials.
- `REASONING_RATE_CARD_JSON`: an array of objects with `provider` (`openai` or `anthropic`), exact `model`, `lane` (`creative` or `routine`), positive `inputUsdPerMillion`, positive `outputUsdPerMillion`, and ISO UTC `verifiedUntil`.
- `DAILY_SUPPLIER_BUDGET_MICROS`: integer micro-USD daily ceiling; 1,000,000 means $1. Default 0 blocks execution.
- `TOTAL_SUPPLIER_BUDGET_MICROS`: lifetime supplier-authorization ceiling. Default 0 blocks execution. The current owner-approved test maximum is 6,000,000 ($6), OpenAI only. Daily pilot guard: 1,000,000 ($1). The separate SupplierAuthorization ledger does not cascade-delete with customer data, reset at midnight, or automatically replenish after failures/refunds. Both limits are checked under the same global transaction lock before a new authorization. This intentionally counts full ceilings, not just invoiced usage; increase only with explicit owner approval.
- `PAID_EXECUTION_ENABLED`: must explicitly be `true` to quote, accept or process paid work.

Prices must come from the actual account's current endpoint/rate card. Do not use synthetic rates from tests. Model capability/creative-lane eligibility must be evaluated by the operator; no brand-quality benchmark has been passed yet. Anthropic output is requested as JSON and validated after return; OpenAI uses strict structured output. There is no cross-provider cache.

Start a separate worker with `npm run worker`. It is now deployed as marketingbus-worker. Use the same runtime contract, rate-card JSON, provider availability, budget settings and private database as web. The process listens on PORT (8080 default) for `/health`; do not create a public domain. It writes a durable heartbeat after successful database/lease recovery. The web rejects quote/acceptance if no matching execution-enabled heartbeat is newer than 120 seconds. A paused worker can be operationally healthy without accepting paid work. One job is processed at a time, with a 90-second provider timeout. SIGTERM stops intake, removes its heartbeat and allows in-flight work to finish; uncertain submissions are reconciled, never automatically repeated. Keep runtime dependencies (`tsx`, Prisma client) installed. No Redis/GPU/per-agent services are required.

Wallets default to zero. There is deliberately no customer-accessible grant endpoint. Payment checkout, verified payment-event grants, refunds and a staff operations interface remain required. Do not seed production wallets with test balances.

## Reconciliation and limits

`NEEDS_RECONCILIATION` means provider billing/output may already exist. Hold credits and prevent another generation on that item. An operator must inspect the authorized quote, job identity, provider request records and invoice, then record a verified outcome. A privileged command is supplied: `npx tsx scripts/reconcile-production.ts --job <exact-job-id> --supplier-cost-micros <verified-integer> --evidence <invoice-or-request-reference-and-finding> --operator <staff-identity> --confirm`. Run only with authorized server/database access and independently verified evidence. This command releases customer credits, records supplier cost and closes the job as failed without pretending a missing deliverable succeeded. Replay cannot change an outcome. Above-ceiling costs require further investigation. An authenticated staff UI and direct provider reconciliation integrations remain future work. Never reset SUBMITTING to QUEUED to “fix” a timeout.

No provider credentials appear in stored requests, audit details or browser props. Quote prompts contain private business context and are scoped to that organization; implement retention/redaction policy before public launch. Requests use no provider tools, do not execute source-pack commands and have no publishing authority.

## Review and calendar

The model result is social copy, a visual direction and a deterministic HTML layout preview, not an image-model result or video. The separate 15 October Design studio can create approved PNG/SVG/JSON files from that copy and original approved brand assets; see [composition and social operations](SOCIAL-AND-COMPOSITION.md). Automatic checks validate structure, caption length, evidence references, unsupported lexical weekdays/dates/numbers/URLs/claim terms and a few explicit revision requests (shorter, no hashtags, exact opening). They do not establish semantic factual truth, legal compliance, typography fit or agency quality. The same grounding guard runs on manual edits, approval and scheduling; failed generated output releases customer credits while retaining supplier-cost accounting. Human review is required.

The compact harness uses deterministic bounded excerpts (3,200 characters for Humanizer; 1,800 for each other reference), retains full-source hashes and has version `2026-10-14.2-compact`. Smaller payload is not proof of equivalent creative quality. No cache savings are assumed. The 15 October source requires runtime `studio-v4-social-composition-teams`. Deploy matching web and worker releases; an older worker will fail admission even if its process is healthy.

The calendar is a month-filtered internal agenda, not a drag-and-drop calendar or posting scheduler. It saves an explicit UTC instant, display timezone and exact approved revision. No scheduled job sends content to any social network. New copy versions and brand edits revoke the old reservation.

## Verification

Run local-only database tests with matching `DATABASE_URL` and `TEST_DATABASE_URL`. Browser tests require the app running at `http://127.0.0.1:3000` and the same explicit local test DB for seeded creative review. Fixture credentials and supplier rates are synthetic; all model calls in the automated suite use injected in-memory responses.

## 14 October 2026 live verification

The manually authorized `scripts/live-copy-smoke.ts` test uses only a specifically named localhost database, an explicit confirmation marker, a one-shot fixture, at most two OpenAI calls, and a $0.35 aggregate authorization limit. It is never an automatic test or deployment hook. Initial generation used `gpt-4.1-2025-04-14`; a scoped copy revision used `gpt-4.1-mini-2025-04-14`. Standard rates verified against OpenAI documentation were $2/$8 and $0.40/$1.60 per million input/output tokens. Requests explicitly set `service_tier: default` and `store: false`; no cache discounts are assumed. Rate-card expiration: 21 October 2026 UTC.

Usage-derived cost: $0.036156 + $0.007303 = $0.043459; accepted conservative ceilings total $0.269242. This is token accounting, not an independently reconciled invoice. Initial $0.25 admission blocked the second request before submission; an explicit revision-only continuation raised the test cap to $0.35 within the owner's $6 authority. The first request was not repeated. The Railway lifetime cap is reduced to $5.65, retaining the $1 daily guard, so this separate test allowance cannot increase total authorization beyond $6.

Mechanical checks passed: real output, cheaper scoped revision, explicit preference retrieval, idempotent acceptance, reservation/settlement, exact-version approval/calendar, free manual editing that revokes approval/schedule, and rejection without regeneration. The actual copy rendered in a local production-build browser preview. Test credits/accounts are local only; hosted wallets were not funded. The preview session was revoked.

Creative acceptance FAILED: both drafts invented “This Saturday” despite the brand prohibiting invented dates. The revised headline welcomed solo beginners, but the caption did not open with that requested emphasis. Existing schema/evidence-reference checks cannot establish factual grounding. Final test version is rejected and unscheduled. Add grounded claim/date checks, targeted revision adherence evaluations and held-out creative review before enabling autopublishing or claiming agency-level quality.
