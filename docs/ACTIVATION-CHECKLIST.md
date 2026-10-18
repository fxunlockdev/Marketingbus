# Marketingbus activation checklist

Updated 18 October 2026. This is a setup and acceptance checklist, not a declaration that the complete product is finished. Credentials cannot fill missing implementation. The current module-by-module boundary is in [MODULE-PLAN.md](MODULE-PLAN.md).

## What the owner needs to provide

Do not send secrets in chat, screenshots, source files or the customer Connections screen. Add them privately in Railway. Use separate test and production credentials. Connections is for publishing destinations only; AI, scraping, storage, email and billing are operator-managed.

| Area | Owner supplies or authorizes | Implementation/operator responsibility |
| --- | --- | --- |
| Business acceptance | One test business; website; approved facts; owned/licensed logos, product photos and reference work; reviewer | Confirm brand evidence before generation, test revisions and permissions, retain provenance. Do not invent dates, offers, claims or visual product details. |
| AI copy | Existing OpenAI credential; optional Anthropic credential | Verify actual available model IDs, capabilities, current rates and matching worker configuration. Do not replace the existing key unnecessarily. |
| Images | Gemini API credential with access to the selected image model | Verify the implemented Gemini transport, exact rate card, reference permissions, private storage, generation/revision/export and measured costs with an authorized live test. |
| Generated video | Higgsfield API key ID and secret; account/model access and API balance; authorized test budget | Transport, journal, provisional delivery, normalization and independent invoice reconciliation are implemented. Verify live account/model/rates, output hosts, private storage and isolated encoder before explicitly activating delivery. Keys alone do not enable it. |
| Social | Meta and LinkedIn developer applications; required approved permissions; exact test Page URLs; an administrator willing to complete OAuth; consent for a clearly labelled test post | Register exact callbacks, validate selected ownership, test connection/data/publishing separately, and enable only accepted lanes. Personal accounts and arbitrary social networks are not automatically supported. |
| Email | Resend API key, verified sending domain/DNS access, sending address and designated test recipient | Configure event-driven invitations, address verification and recovery; verify actual inbox delivery and failures. No bulk marketing email is implied. |
| Billing | UAE business Stripe account in test mode first; monthly/top-up offers and credit allowances; refund/commercial policies | Configure existing checkout/webhook/portal transport and verify payment, renewal, cancellation, replay and refund lifecycle. Tax, disputes and unsupported adjustments need policy and further implementation before public paid launch. |
| Infrastructure | A numeric monthly Railway ceiling, including scraper, database, worker and storage; alert recipient | Reuse existing resources; measure costs, isolate the scraper, configure private bucket and renderer, test backups/restore and alert routing. No Amazon AWS account is required for a Railway S3-compatible bucket. |
| Live verification | A new explicit total budget for Gemini/Higgsfield/other paid calls; designated accounts and posting consent | Keep a usage ledger and stop at the approved total. The earlier $5–$6 authorization was OpenAI-only; it is not fresh permission for other providers or another $6. |
| Audio | Choose uploaded/licensed audio first, or approve a specific voice/music provider and budget | Implement audio processing, rights/voice consent, sync, captions and final audio/video review. Audio is not finished by adding a Higgsfield key. |

## Private Railway variables

The authoritative list is [`.env.example`](../.env.example). Key names below are not secret values. Do not set every execution switch to true. Stage settings first, then activate one accepted workflow at a time.

- Existing core: `DATABASE_URL`, exact HTTPS `APP_ORIGIN`, `PILOT_INVITE_CODE`, `SECRET_ENCRYPTION_KEYS_JSON`, `SECRET_ENCRYPTION_ACTIVE_KEY`. Keep encryption keys consistent across web/worker; retain older keys while any stored data uses them. Do not rotate them by simply overwriting the old value.
- Copy: `OPENAI_API_KEY`; optionally `ANTHROPIC_API_KEY`; verified `REASONING_RATE_CARD_JSON`. Model aliases alone do not establish price or readiness.
- Images: `GEMINI_API_KEY`, verified `IMAGE_RATE_CARD_JSON`. `GEMINI_IMAGE_MODEL` alone does not activate production.
- Generated video: `HIGGSFIELD_API_KEY` holds the **key ID**, `HIGGSFIELD_API_SECRET` holds the secret. Explicit `HIGGSFIELD_VIDEO_ENABLED`, `HIGGSFIELD_EXPENSE_POLICY=account-quote-v1`, `HIGGSFIELD_VERIFIED_UNTIL`, `HIGGSFIELD_OUTPUT_HOSTS_JSON` and matching `VIDEO_RATE_CARD_JSON` are required. Remain disabled until live acceptance. See [delivery/accounting configuration](VIDEO-DELIVERY-ACCOUNTING.md).
- Supplier limits: `DAILY_SUPPLIER_BUDGET_MICROS`, `TOTAL_SUPPLIER_BUDGET_MICROS`, then `PAID_EXECUTION_ENABLED` only after acceptance. One million micro-USD equals $1. Do not reset cumulative authorization to disguise spend.
- Private media: `ASSET_S3_ENDPOINT`, `ASSET_S3_BUCKET`, `ASSET_S3_REGION`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY`, consistent on web and worker. We verify actual private immutable write/read/delete behavior, not merely that variable names exist.
- Local motion rendering: installed/pinned `FFMPEG_PATH`, `FFPROBE_PATH`, finite `MOTION_RENDER_DAILY_LIMIT`, then `MOTION_RENDERING_ENABLED`. Rendering is not free: it consumes worker CPU/memory and storage.
- Email: `RESEND_API_KEY`, plain-address `RESEND_FROM_EMAIL`, finite `EMAIL_DAILY_LIMIT`, then `EMAIL_DELIVERY_ENABLED` after test-recipient delivery acceptance. Keys on the web service alone do not configure the worker.
- Scraper: `FIRECRAWL_SELF_HOSTED_URL`, instance authentication where configured, `FIRECRAWL_EGRESS_RESTRICTED`, `WEBSITE_EXTRACTION_ENABLED`. The egress flag is an attestation after network tests, not a firewall. Do not set it just to bypass the gate.
- Meta: `META_APP_ID`, `META_APP_SECRET`, verified `META_API_VERSION` and `META_API_VERIFIED_UNTIL`; separate `FACEBOOK_CONNECTIONS_ENABLED`, `INSTAGRAM_CONNECTIONS_ENABLED`, `FACEBOOK_PUBLISHING_ENABLED`.
- LinkedIn: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, verified `LINKEDIN_API_VERSION` and `LINKEDIN_API_VERIFIED_UNTIL`; separate `LINKEDIN_CONNECTIONS_ENABLED`, `LINKEDIN_PUBLISHING_ENABLED`.
- Account reads: `SOCIAL_DATA_ENABLED`. This permits explicit bounded refresh; it does not enable publishing.
- Publication worker: `SOCIAL_EXECUTION_ENABLED`. Registered publishers support LinkedIn company and Facebook Page **text-only** posts. Configure credentials and provider publishing switches consistently on web and worker. Instagram publishing, Facebook per-post metrics and image/video transfer still need implementation and acceptance. See [Facebook publishing](FACEBOOK-PUBLISHING.md).
- Billing: `STRIPE_MODE=test`, `STRIPE_ACCOUNT_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION_ID`, approved `BILLING_OFFERS_JSON`; separately gated `BILLING_EXECUTION_ENABLED` and operator-only `STRIPE_REFUNDS_ENABLED`. Follow [billing operations](BILLING.md); do not activate live charges for testing.

## Social application setup

Current production origin: `https://marketingbus-web-production.up.railway.app`. If the domain changes, update application origin and registered callbacks together and re-verify them.

Register these exact callbacks in the corresponding application:

```text
https://marketingbus-web-production.up.railway.app/api/social/facebook/callback
https://marketingbus-web-production.up.railway.app/api/social/instagram/callback
https://marketingbus-web-production.up.railway.app/api/social/linkedin/callback
```

Meta uses the Facebook Login route for Facebook Pages and Page-linked Instagram professional accounts. Select a Page and its linked professional account for acceptance. Use authorized app-role test users before applicable public access review. Provide the required business/application verification, privacy and deletion information in the developer dashboard. The dashboard and granted permissions, not being a new application, determine access. See [Meta/account-data operations](SOCIAL-ACCOUNT-DATA.md).

LinkedIn uses company-page administrator access, not personal profile posting. Obtain the applicable Community Management access and verify the requested `r_organization_admin`, `w_organization_social` and `r_organization_social` grants. Verify reporting permissions against the actual application: the share-statistics documentation also names `rw_organization_admin`, while organization-role documentation describes reporting with `r_organization_admin`. Do not invent a grant, silently widen scopes, or promise reporting acceptance without the test. If additional approved scope is required, implement/test the scope change and reconnect. See [LinkedIn publishing](LINKEDIN-PUBLISHING.md).

Customers then use Connections → choose destination → authorize on the provider → explicitly choose their Page. They do not supply their Facebook/LinkedIn password or your application secret to Marketingbus.

## Low-cost website intake

Self-hosting does not mean zero infrastructure expense. The implemented admission policy is one public HTTPS page per request, seven-day successful cache per business/URL, three new requests per business/day, one global scrape at a time, bounded text and no automatic retry or paid proxy fallback. This is not an unrestricted website crawl and does not promise every page/logo/product will be extracted.

We still need to deploy and measure the self-hosted stack with private dependencies and enforce public-web-only browser egress, including redirects and subresources. An agreed monthly ceiling is needed before adding those resources. Saving approved evidence avoids routine re-scraping on every creative generation. See [website intake](WEBSITE-INTAKE.md).

## Acceptance sequence — what “working” must prove

1. Create two separate test businesses; prove tenant/role separation, invitation, verification, recovery and required MFA.
2. Import website/documents/assets; review evidence; confirm brand and design defaults. Reject unsupported claims, unsafe uploads and cross-business assets.
3. Generate copy, revise against explicit feedback, approve; generate/revise supporting imagery; compose original logos/products; export and verify costs against actual usage.
4. Produce and review a storyboard, generated footage, licensed audio and final export. Current silent motion/upload workflows do not satisfy the unfinished generated-video/audio requirement.
5. Authorize a designated destination, schedule one approved item, revoke/change approval before submission, then test a valid publication. Require a verified platform ID; test timeout recovery without duplicate posting and actual account disconnect/expiry.
6. Ingest actual per-post data with missing values kept unknown. Compare only compatible mature observations; human review precedes memory promotion. A successful metric fetch does not prove the model has improved or that agency-level quality has been achieved.
7. In Stripe test mode, complete checkout, renewal, replay, cancellation, top-up and refund; verify ledger balances and revision allowances. Real charges are a separate commercial go-live decision.
8. Run mixed-media weekly orchestration only after its remaining implementation is complete; enforce cost caps and approvals. Exercise restoration, retained encryption keys, private-object recovery, alerts, access denials, realistic load and manual accessibility checks before broader launch.

## Still our engineering work — not a task for you to solve with keys

- Instagram publishing, immutable image/video transfer and Facebook/Instagram per-post metrics; token renewal/revocation handling and richer reconciliation operations. Facebook and LinkedIn text publishers are implemented but not live-accepted.
- Reference-led video revisions, licensed audio/voiceover, continuity evaluation and back-office/automated supplier reconciliation. Silent supporting-footage delivery with provisional accounting is implemented but remains inactive pending production renderer/storage checks and live provider acceptance.
- Mixed-media weekly automation and stronger measured quality/learning evaluation. No automatic training on another tenant's brand or private feedback.
- Stronger semantic fact/visual checks, production isolation and operational alerts; realistic load/chaos and independent security/manual accessibility acceptance; production database/object recovery.
- Billing commercial/tax/dispute handling, operator settlement experience and actual Stripe lifecycle acceptance.

The $800/month plan's $500–$600 **net** profit target and top-1% agency-quality target remain unproven. Validate provider costs, failed jobs, revisions, infrastructure, support, acquisition and staffing against real usage; do not set an unlimited allowance or promise those outcomes from this checklist.

## Provider references checked 18 October 2026

- [Higgsfield key ID and secret](https://docs.higgsfield.ai/docs/authentication)
- [Higgsfield account-specific estimate and output retention](https://docs.higgsfield.ai/docs/concepts/billing-and-retention): estimate with exact model parameters; archive usable output privately rather than relying on temporary supplier retention. An estimate is not a final reconciled expense ledger.
- [Higgsfield request status contract](https://docs.higgsfield.ai/docs/api-reference/requests/get-request-status): asynchronous status and output fields do not implement our missing transport or accounting validation.
- [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-07)
- [LinkedIn organic share statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics?view=li-lms-2026-07)
