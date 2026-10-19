# Guided setup and provider decision

## Evidence and scope

Reference: 16 user-supplied Blaze screenshots dated 19 October 2026, covering welcome, website, extraction progress, identity/audience, strategy, campaign, channels, quantities, style, fonts, transformation, topics, assets, home and integrations. Public [Blaze getting-started guidance](https://help.blaze.ai/en/articles/9535151-getting-started-with-blaze) supports a website-led, editable brand kit. The separate [Copilot guide](https://help.blaze.ai/en/articles/11386914-how-to-create-a-brand-kit) is legacy-specific, not proof of current Autopilot internals.

[REA](https://github.com/morluto/rea), CLI 6.7.0, was used for bounded local static analysis of `components/brand-form.tsx` and `components/studio.tsx`. Evidence ID: `ev_8562a265eb83dd5a06536ba90129e28ec933f4dab67b45d613f19054e985dec8`. It is a development investigation tool, not a production dependency or a source of competitor backend code. The analysis was limited to those two files; supplied screenshots and official public documentation establish the competitor journey. No competitor account, private API or subscription was accessed or changed.

## Implemented journey

1. New accounts enter setup directly. Owners/admins choose their workspace and save name, industry and optional website. An idempotency key prevents duplicate creation after a lost response. Existing businesses retain their normal studio.
2. Website and document import plus evidence-backed suggestions use the real, existing source/analysis workflows. Imports require content rights; paid analysis needs a separate quote. No fake crawl progress or automatic fact approval. Website is prefilled; manual continuation works when extraction is unavailable.
3. Business facts, audience, goal, proof, tone and restrictions are reviewed. Empty facts are valid only in an unfinished draft, not a confirmed profile. Applying analysis to a draft can fill selected fields without requiring invented placeholders. The user reloads the saved setup after applying suggestions.
4. Strategy, business type, supported writing locale and actual initial destinations are selected. Instagram/Facebook/LinkedIn preferences do not imply connected accounts, provider approval or publication authorization.
5. Color, layout and image-treatment preferences are saved. Existing private asset upload/rights/approval runs inside setup. Original logos/products continue through deterministic composition; no unsupported fidelity guarantee.
6. Explicit final confirmation atomically saves the current brand snapshot and one zero-cost outline. This does not generate, schedule, publish, allocate credits, enable weekly automation or send email. Final confirmation is idempotent. The user enters Content plan, then the shared Asset studio and platform-aware review workflows.

Progress is stored on the business, not browser local storage. Saves require current setup revision and brand version; concurrent edits, evidence application and role removal cannot silently overwrite a draft. Each step saves when continuing, not on every keystroke. Reload intentionally discards unsaved edits. Existing profile editing can change creative preferences afterward and requires reconfirmation. The schema constrains legacy/active/completed state; health checks require the new columns. Retained drafts are subject to the existing three-business pilot allowance; abandoning a draft does not silently delete a business.

## Provider decision

| Work | Provider | Routing |
|---|---|---|
| Strategy, source-backed suggestions, social copy | OpenAI | Creative lane for initial concepts/substantial changes; routine lane only for focused copy revisions |
| Supporting image generation/revision | Gemini | Verified creative/revision rate cards; exact originals composed separately |
| Generated shots | Higgsfield | Registered adapter, verified account quote/rates, bounded shot budgets |
| Layout, resize, captions/assembly | Local deterministic rendering | No model call for an edit that can be done exactly |

Text routing excludes Anthropic, even if an old key/rate entry remains. Historical receipt schemas and accounting remain readable; no secret is deleted. No silent fallback after a potentially billed submission. Changing the text policy changes the configuration fingerprint and worker runtime, so old authorizations cannot silently run under a different configuration.

Keep the existing compact specialist excerpts and stable system instructions. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) depends on matching prefixes, model-specific terms and actual reuse; a cache hit is not guaranteed. No assumed discount is used to authorize spend, no padding to earn cache hits, and no claimed savings without measured receipts. New model/rate entries must account for any cache-write premium before activation. This release makes no model-name or price change and no paid verification call.

## Explicit remaining gaps against the screenshots

- Fully automatic website-to-visual-identity extraction, logo/photo harvesting and live Firecrawl deployment/egress acceptance. Current importer extracts bounded text, not a whole licensed media library.
- AI-recommended strategy/campaign themes grounded in reviewed evidence; current options are customer selections, not fabricated recommendations.
- Onboarding-integrated mixed-media quantities, pre-confirmation quote-backed estimates and generated first-week content. The separate Workflows screen now supports a saved static/video split and [approval-gated weekly media production](WEEKLY-MIXED-MEDIA.md); it does not silently activate generation during setup.
- Custom font catalog, photo-transformation controls, carousels, Stories and additional publishing destinations. Do not expose nonfunctional options as supported.
- End-to-end live provider/account acceptance, advanced media/learning work and the remaining capacity/operational gates in BUILD-STATUS.md.

This is a complete saved setup-to-outline workflow, not completion of the entire product or proof of 500–700-business production capacity.
