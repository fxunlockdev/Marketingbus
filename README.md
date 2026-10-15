# Marketingbus

Private-pilot foundation for a business-specific creative production platform. Next.js, TypeScript, Prisma/PostgreSQL; Railway deployment configuration. No Supabase dependency.

## Run locally

Requires Node 22+, npm and PostgreSQL 17. Copy `.env.example` into a private `.env` and use your local database connection. The example credentials are local development only. With Docker Compose installed, `docker compose up -d` starts a loopback-only development database.

```sh
npm ci
npm run db:generate
npm run db:migrate
npm run build
npm start
```

Create an account at `/login`, then a business. No provider keys or payment are needed for the foundation workflow. APP_ORIGIN must match the actual origin; hosted sessions require HTTPS.

Hosted registration additionally requires `PILOT_INVITE_CODE`, a randomly generated secret of at least 24 characters (32 random bytes recommended). Missing or invalid codes fail closed. Retrieve the configured value privately from the web service's Railway Variables panel. Do not put it in source control or public documentation. This shared pilot gate is not a replacement for per-user invitations, email verification or MFA. Rotate it to stop new registrations using the old code; existing accounts are unaffected.

## Implemented in source

The feature-by-feature acceptance ledger is [BUILD-STATUS.md](docs/BUILD-STATUS.md). The 15 October changes below are locally verified, not yet deployed. This is not a completed or enterprise-certified product.

- Database-backed registration, login, logout and hashed opaque sessions.
- Organization/business-scoped queries, role checks and composite ownership constraints.
- Multi-step brand setup, profile versioning/confirmation and three design presets.
- Profile gap recommendations, clearly labeled as deterministic checks.
- Profile-based planning outlines, not claimed to be AI output.
- Explicit per-business preference memory with removal.
- Real audit events, provider readiness and actual zero-by-default wallets.
- Atomic quote acceptance, credit reservation and durable PostgreSQL job creation, with concurrency tests.
- Versioned specialist harness, Humanizer reference and scoped brief validation.
- Policy-based OpenAI/Claude routing for copy, verified-rate-card gates, strict output validation and bounded supplier budgets.
- Copy production worker with frozen brand/skill context, exact versions, reported-usage settlement and no blind retry after uncertain submissions.
- Review inbox, approval/rejection, scoped feedback, free manual copy edits and an exact-version internal calendar agenda.
- Privileged failed-job reconciliation procedure with verified cost evidence and idempotent credit release.
- Bounded, cached, single-page Firecrawl intake queue and TXT/Markdown evidence ingestion; self-hosted infrastructure remains unprovisioned.
- Deployed, health-checked Railway worker; durable heartbeats and matching-config admission checks.
- Lifetime supplier authorization ceiling, independent of daily resets and customer-record deletion.
- Private brand-image library: PNG/JPEG/WebP validation, metadata-stripped normalization, rights attestation, quotas, deduplication and authenticated downloads.
- Approved asset selection, archive/restore and worker-driven deletion after a seven-day recovery window.
- Editable versioned static compositions using original approved logos/products, independent visual approval, four canvas sizes and PNG/SVG/JSON exports. This is deterministic composition, not Gemini image generation.
- Social publication state machine, encrypted account-token storage, safe retries, uncertain-write reconciliation and metric ingestion. Only injected test adapters are exercised; no live social adapter/OAuth is installed.
- Per-account performance summaries and evidence-based experiment proposals with explicit human promotion/reversion into brand memory. No causal or autonomous-training claims.
- Workspace member/admin screens, hashed single-use email-bound invitations, role controls, audit events and last-owner protection.
- Email verification/recovery and Resend outbox; authenticator MFA, one-use recovery codes and session revocation. Actual email sending requires configuration and live acceptance.

## Not yet shipped

Gemini image production, Higgsfield video/storyboard/motion/audio workflows, AI evidence-backed brand suggestions, PDF/DOCX ingestion, semantic fact/creative evaluations, social OAuth and real publishing/insights adapters, immutable media delivery to social platforms, recurring weekly planning/paid autopilot, richer approval separation/comments, production backup-restoration drills, alert delivery, sustained load testing and independent security/accessibility review. Stripe checkout/subscriptions/top-ups/refunds are explicitly deferred by the owner. Missing keys are not the only remaining work.

See [production operations](docs/PRODUCTION-OPERATIONS.md) for the authorization flow and paid-execution gates, and [private assets](docs/PRIVATE-ASSETS.md) for storage boundaries. The separate Railway worker is deployed. OpenAI-only pilot configuration now has a key reference and verified expiring prices; ordinary wallets still default to zero. Do not treat this as public-launch readiness.

## Verification

```sh
npm run typecheck
npm test
# Use a dedicated local test database, never production:
DATABASE_URL=<test-url> TEST_DATABASE_URL=<same-test-url> npm test
# Start the app locally before running; requires installed Chrome:
npm run test:e2e
npm audit
```

Integration tests create and clean up their own wallet organizations. Browser tests create labeled example.test accounts in the development database. Do not run tests against production. The browser suite saves desktop/mobile screenshots outside the repository in the task outputs folder.

## Railway

Use the supplied project, one web service, one PostgreSQL service, one worker and one private bucket. Reference the private database, set APP_ORIGIN to the generated HTTPS domain, and leave paid execution disabled. Web settings: build `npm run build`, pre-deploy `npm run db:migrate`, start `npm start`, health `/api/health`. Worker settings: build `npm run db:generate`, pre-deploy `npm run db:migrate`, start `npm run worker`, health `/health`, PORT=8080; no public domain. Health checks verify application schema/worker database progress, not just open ports. Legacy `railway.toml` is not used. This remains a pilot, not a public paid launch. Add backup restoration, email recovery, independent security review and provider invoice tests before release approval.

GitHub write permission was verified on 15 October 2026. Repository publication and successful CI must be checked separately from local verification; neither implies a production deployment.

## Source notices

See `resources/REUSE.md` and `resources/licenses/`. OpenMontage code is excluded pending the licensing decision. Raw reference skill commands are not executable capabilities. Earlier numerical price assumptions need recalibration against the actual provider accounts.
