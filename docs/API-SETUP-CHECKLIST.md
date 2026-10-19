# Operator API and activation checklist

Last configuration audit: 20 October 2026. OpenAI, Gemini and Higgsfield credentials are configured on web and worker; worker references the web service and resolved equality was verified without displaying secrets. The owner's two pending key additions were applied. Reasoning-rate-card and storage configuration already existed. Image/video rate cards, Meta/LinkedIn, Resend, Stripe and private Firecrawl configuration were still absent. Deployment and real provider acceptance are separate checks; presence is not proof of valid credentials. Add secrets privately in Railway, never in chat, browser code or GitHub.

## You configure these once for the platform

Latest requested pilot policy: **OpenAI + Higgsfield active, Gemini optional, one application-owned knowledge layer**. OpenAI handles strategy, briefs, all social copy (including LinkedIn), and future semantic reflection. GPT-6 Astra can direct the approved static concept; GPT Image 2.5 renders its supporting artwork. Higgsfield handles generated footage. Exact logos, typography, resizing and assembly remain deterministic application work. Do not enable Claude or a second copy provider merely because its adapter exists. A provider-specific LinkedIn route should require a blinded brand/factual-quality evaluation that demonstrates an advantage. Higgsfield image generation is not implemented by the current footage adapter.

Retain approved assets and revise only the changed component. A caption change must not regenerate an image; a single-shot revision must not regenerate every shot. Qualified lower-cost models may handle routine copy edits, but new concepts and media need their own verified quality/rate policy. No silent paid fallback and no promise that selecting three vendors guarantees agency-level output or net profit.

| Capability | Private server configuration | Acceptance before enabling |
|---|---|---|
| OpenAI reasoning/copy | `OPENAI_API_KEY`, `REASONING_RATE_CARD_JSON`; default `REASONING_PROVIDERS_JSON=["openai"]` | Exact supported model IDs, current creative/routine rates, matching worker; real grounded draft and revision |
| Optional Claude reasoning/copy | `ANTHROPIC_API_KEY`, verified Anthropic entries in `REASONING_RATE_CARD_JSON`, explicitly allow `anthropic` in `REASONING_PROVIDERS_JSON` | Same scoped harness, evidence and credit controls as OpenAI. Live Claude acceptance is still required; adding a key alone does not route work |
| OpenAI brand images/static ads (preferred) | `OPENAI_API_KEY`, `IMAGE_PROVIDER=openai`, `IMAGE_RATE_CARD_JSON` with a supported `gpt-image-2.5-sunburst`/`flare` model, explicit high-or-better quality and verified text/image/output rates | Native 2048×2048 artwork, reference-led edit, private output, exact-logo composition, export, measured usage and account access. See OPENAI-IMAGES.md. GPT-6 is the director, not the image model ID |
| Optional Gemini images | `GEMINI_API_KEY`, `IMAGE_PROVIDER=gemini`, `IMAGE_RATE_CARD_JSON` | Separate explicitly selected route, not automatic fallback. Real reference-led generation and revision, private output, exact-logo composition, export; current model/rate verification |
| Higgsfield footage | `HIGGSFIELD_API_KEY` containing the complete copied API key unchanged, `VIDEO_RATE_CARD_JSON`, `HIGGSFIELD_EXPENSE_POLICY`, `HIGGSFIELD_VERIFIED_UNTIL`, `HIGGSFIELD_OUTPUT_HOSTS_JSON` | Set privately on both web and worker; leave `HIGGSFIELD_API_SECRET` empty for a complete key. No manual splitting or assembly is required. Account/model access, quote/expense policy, allowed output hosts, completed download/normalization and per-shot revision. See VIDEO-DELIVERY-ACCOUNTING.md |
| Website extraction | Deployed private Firecrawl plus `FIRECRAWL_SELF_HOSTED_URL`; `FIRECRAWL_API_KEY` if required by that deployment | Verified public-web-only scraper egress, bounded one-page intake, cache/reuse, error and deletion checks. Self-hosting still has infrastructure costs; this deployment is not yet available |
| Email | `RESEND_API_KEY`, verified `RESEND_FROM_EMAIL`, `EMAIL_DAILY_LIMIT` | Designated recipient receives actual invite, verification and recovery mail; test expiry and one-time use |
| Instagram / Facebook | `META_APP_ID`, `META_APP_SECRET`, current `META_API_VERSION`, `META_API_VERIFIED_UNTIL` | Approved permissions/access, OAuth callback, designated Page/linked professional account; explicit test-post approval; verify receipt and native metrics |
| LinkedIn company Pages | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, supported `LINKEDIN_API_VERSION`, `LINKEDIN_API_VERIFIED_UNTIL` | Approved organization permissions, company selection, designated-account post/upload/read-back and metrics tests |
| Stripe billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ACCOUNT_ID`, `STRIPE_PORTAL_CONFIGURATION_ID`, server-owned `BILLING_OFFERS_JSON`, `STRIPE_MODE` | UAE merchant setup; test-mode checkout, renewal, duplicate webhook, top-up, cancellation and refund lifecycle. Live commercial/tax policies remain an operator decision |

Use the exact schemas in `.env.example` and the relevant module operations documents; do not guess model prices, account IDs or provider versions. AI keys belong to the operator, not customer Connections. Claude and Gemini are not required for the latest OpenAI + Higgsfield pilot policy. AutoHarness itself does not provide an API key or free model access.

The business knowledge graph uses the existing PostgreSQL database. There is **no Graphiti key, graph database or additional service to add**. It recalls approved knowledge into copy/image/video requests and retains task-specific evidence. v53 adds opt-in, credit-quoted reflection over corrected and approved work, with source checks and explicit human activation. Written visual-direction lessons are not pixel/video evaluation, and live-provider reflection acceptance remains outstanding. See CREATIVE-PROCEDURES.md and BUSINESS-KNOWLEDGE.md.

## Non-API requirements

- Shared PostgreSQL connection, fixed public HTTPS `APP_ORIGIN`, matching web/worker release and settings.
- A private Railway S3-compatible bucket: `ASSET_S3_ENDPOINT`, `ASSET_S3_BUCKET`, `ASSET_S3_REGION`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY`. No AWS subscription is required for Railway storage. Verify private upload/download/delete; variable presence is insufficient.
- `SECRET_ENCRYPTION_KEYS_JSON` and `SECRET_ENCRYPTION_ACTIVE_KEY`: operator-managed 32-byte encryption keys. Preserve keys already used by stored secrets; do not blindly replace them.
- FFmpeg/FFprobe paths, reviewed media-worker isolation, `MOTION_RENDER_DAILY_LIMIT`; independent `MOTION_RENDERING_ENABLED` and `AUDIO_PROCESSING_ENABLED` gates. Current audio support is licensed instrumental upload, not generated voice-over.
- `DAILY_SUPPLIER_BUDGET_MICROS` and `TOTAL_SUPPLIER_BUDGET_MICROS`, plus an authorized customer credit balance. The platform never invents a new-account balance. Existing testing approvals do not authorize unlimited spend or a new recurring budget.
- Actual backup/restore acceptance, operator monitoring/alerts and incident ownership. Synthetic restore tests do not verify production recovery.

## Enable one capability at a time

Keep the respective gates off until acceptance: `PAID_EXECUTION_ENABLED`, `HIGGSFIELD_VIDEO_ENABLED`, `WEBSITE_EXTRACTION_ENABLED`, `EMAIL_DELIVERY_ENABLED`, `BILLING_EXECUTION_ENABLED`, `SOCIAL_EXECUTION_ENABLED`, `SOCIAL_DATA_ENABLED` and provider-specific connection/publishing/image/reel/video/metrics gates in `.env.example`. Do not bulk-enable the file. Rate-card or policy changes require matching web/worker configuration and renewed quotes. Uncertain charged requests remain held for reconciliation; no automatic model fallback.

Configure registered callbacks as `APP_ORIGIN/api/social/linkedin/callback`, `APP_ORIGIN/api/social/facebook/callback`, `APP_ORIGIN/api/social/instagram/callback` for the selected routes. Stripe's endpoint is `APP_ORIGIN/api/billing/webhook`; use the exact event/version contract in `BILLING.md`, not an arbitrary account default.

## Each customer supplies only their business context and authorization

1. Create their own account/workspace and complete business onboarding; confirm imported facts, audience, tone and design preferences.
2. Upload assets they have permission to use and approve their permitted roles.
3. Connect their own supported publishing destinations through OAuth. They never supply your OpenAI/Gemini/Higgsfield keys.
4. Review the plan, credit quote and drafts; approve exact versions, select destination/schedule, and explicitly enable any recurring generation policy.
5. Inspect real post receipts and available metrics. Missing metrics remain unavailable, not invented zeroes. Review learned rules before activating them.

Current pilot publishing targets are Facebook, Instagram and LinkedIn company Pages. X/YouTube and every tool contained in the supplied packs are not implemented merely because references mention them. Adding credentials cannot complete missing adapters or the general AutoHarness learning layer; see SUPPLIED-TOOLS-AUDIT.md.
