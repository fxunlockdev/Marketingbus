# OpenAI brand images and static ads

The user's latest instruction replaces Gemini as the preferred static-image provider, not the brand knowledge or specialist workflow. GPT-6 Astra is a reasoning/directing model: it supports image input and image-generation tool use, but its native output is text. GPT Image renders artwork. Current official contracts were checked on 19 October 2026: [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [image generation](https://developers.openai.com/api/docs/guides/image-generation), [image edits](https://developers.openai.com/api/reference/resources/images/methods/edit).

## Application-owned workflow

Confirmed business → shared copy specialist/Brand Engine/Humanizer → approved concept and visual direction → separately authorized image quote → OpenAI artwork → human fidelity review → editable exact-logo/product/text composition → placement export → exact-version approval and optional publishing.

`brand-engine-design.md` comes from the user-provided Brand Engine pack. Static direction and image prompts select bounded excerpts and retain the full source hash. This does not execute local-file instructions, blindly follow the pack's model aliases, fabricate proof, authorize additional variants or override spending. Original logos/products remain exact composition assets, not redrawn image references. Source references are explicitly style-only, and the previous artwork is passed for a revision. Brand Engine's full strategy/board/carousel system is not claimed complete.

The existing reasoning rate card can select `gpt-6-astra` in its creative lane once operator rates/account access are verified. Routine copy revisions retain a separately qualified lower-cost lane. Rendering uses the direct Images API after concept approval, avoiding a second unbounded director/tool turn. This is not a claim that the deployed reasoning card already selects GPT-6.

## Transport and accounting

- One fixed `https://api.openai.com/v1/images/generations` request, or multipart `images/edits` when references exist. No user-supplied endpoint, persistent file upload, redirected credentials, provider fallback or retry after uncertain submission.
- Supported image IDs: GPT Image 2.5 Sunburst/Flare and their documented 2026-09-08 snapshots. `gpt-6-astra` is rejected as an image-model ID.
- One 2048×2048 WebP, explicit `high`, `xhigh` or `max` quality. Decoded dimensions must match; no upscaling a smaller response and calling it 2K. Current platform composition exports retain their existing sizes.
- At most three authorized reference images; unchanged approval, tenant, rights, immutable-byte, credit and three-revision checks. Stable hashed actor/workspace safety identifier, no personal email sent as the identifier.
- A 150-second bounded request and 8 MB response envelope. Require a real `x-request-id`, valid usage, exactly one decodable image and private storage read-back before delivery.
- OpenAI text input, image input and output usage are accounted separately. The quote uses conservative input/output ceilings. Direct Images API has no prompt-cache discount; do not sell hypothetical cache savings. `maxOutputTokens` is an accounting envelope, not an Images API token-limit parameter; out-of-envelope/unknown usage is held for operator reconciliation.
- Supplier expense and customer charging remain distinct. Known unusable output releases the customer hold and records known expense; ambiguous billed calls retain their hold and never automatically resubmit.

## Activation and live acceptance

Set matching web/worker `IMAGE_PROVIDER=openai`, `OPENAI_API_KEY` and the verified `IMAGE_RATE_CARD_JSON`. Use `inputUsdPerMillion` for image-input rate, `textInputUsdPerMillion` for text-input rate, `outputUsdPerMillion`, explicit quality, `maxOutputTokens` and `verifiedUntil`. Prices and quality/output ceilings must be verified for the chosen model and native 2K size. No rate card or live execution setting was changed by this code release.

Before customer activation, verify actual account access, one brand-led image, one targeted reference edit, exact-logo export and supplier-billing reconciliation within an explicitly remaining testing budget. Mock-provider tests prove application behavior, not real creative quality or provider availability. Existing whole-product live acceptance and general semantic/visual learning gaps remain.
