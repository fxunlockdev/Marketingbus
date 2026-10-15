# Image production and review

Design studio now has a locally tested supporting-artwork workflow. A confirmed brand and approved static copy lead to a quote, explicit credit authorization, one worker submission, private review and an editable composition. Human approval is required; generated imagery is not evidence of factual accuracy or agency-level quality. Video production is a separate unfinished module.

## Customer workflow

1. Confirm the business profile, approve static copy and optionally approve up to two style-reference images in the asset library.
2. In Design studio, choose the approved creative and request an artwork quote. Quotes expire after ten minutes and make no provider call.
3. Authorize the displayed ceiling. The transaction reserves credits and up to 5 MB of private storage, and checks the shared daily/lifetime supplier budgets. There can be only one unresolved image job per business. Quotes are limited to 24 per business per day and 100 versions per creative.
4. Refresh the image status. The worker submits once, normalizes the returned still image, verifies its immutable private storage object and settles credits using reported usage and the accepted conservative rate card.
5. Preview the image, inspect visual defects, misleading claims, unwanted text and brand suitability, then approve or reject. Rejection does not regenerate. Blocking comments and independent-review policies apply.
6. A specific revision request creates a new quote bound to the previous image and original style references. A cheaper verified revision lane can be used. Authorizing the revision revokes the previous visual approval; merely requesting a quote does not.
7. Use approved brand assets to create a new composition. The approved artwork is placed alongside original logo/product assets and exact approved copy. Approve the complete layout before PNG/SVG/JSON export or private saved export. Removing an input reference also blocks dependent exports.

The client cannot pick arbitrary providers, submit unrestricted prompts or approve output through the asset-library endpoint. AI credentials stay server-side. Connections remains publishing destinations only.

## Operator configuration

Keep paid execution disabled until live testing is separately authorized. Configure both web and worker with the same `GEMINI_API_KEY`, private storage, supplier budgets and `IMAGE_RATE_CARD_JSON`. This JSON array requires `model`, `lane` (`creative` or `revision`), `inputUsdPerMillion`, `outputUsdPerMillion`, `maxOutputTokens` and an ISO `verifiedUntil`. Use exact endpoint-supported models and independently verified rates; no model or price is enabled by default. `GEMINI_IMAGE_MODEL` alone does not authorize an unpriced model.

Use the highest applicable input/output modality rate, including image output and thinking. Usage accounting includes prompt, candidate and thought tokens and rejects inconsistent totals, tool usage or exceeded bounds. This is conservative usage-derived accounting, not invoice reconciliation. No cache discounts or commercial profit guarantees are assumed.

The transport uses Google's documented [generateContent image API](https://ai.google.dev/gemini-api/docs/generate-content/image-generation) and [usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata). It makes one fixed-host HTTPS request, rejects redirects, applies a 90-second timeout, caps the response at 8 MB and accepts one non-thought still image only. Images are decoded and normalized under the existing 5 MB/16-megapixel limit. It does not call search tools or external URLs supplied by the model. Live support for the operator's selected model remains an acceptance gate.

## Failure and retention behavior

- Cancellation before submission releases credits and the unused storage reservation. Worker leases fence cancelled or replaced workers.
- A timeout or unknown usage becomes `NEEDS_RECONCILIATION`. It is never automatically resubmitted. The customer hold remains until independently verified operator resolution.
- A known-cost invalid result, revoked access, changed copy or storage failure delivers nothing and releases customer credits. Known supplier expense is retained. Possible stored objects are quarantined and cleaned after seven days; quota remains reserved until deletion is confirmed.
- The operator command is `npx tsx scripts/reconcile-image.ts --image <id> --supplier-cost-micros <verified-expense> --evidence <independent-reference> --operator <staff-identity>`. Use authorized server access only. It closes an uncertain job without delivering an unverified image. Exact replay is safe; changed evidence/cost is rejected. Above-ceiling expenses require investigation.
- Generated images can be removed and restored through the asset library. Restoring never automatically re-approves them. Quarantined failed uploads cannot be restored as verified artwork. Existing private-export retention rules apply separately.

## Acceptance boundary

Automated tests inject provider results and storage. The browser journey stubs only its synthetic image-preview response while exercising real scoped review APIs; it is not a live Gemini or bucket test. Unit/database coverage includes cost/role checks, duplicate acceptance, revisions, input revocation, malformed output, storage uncertainty, lease recovery, operator reconciliation, export invalidation and tenant isolation. Browser tests check review controls, accessibility and mobile width.

Still required: live Gemini and real-bucket acceptance, stronger visual grounding and fidelity/adherence evaluation, production deployment, operator recovery screens and social media transfer. Do not label all seven product modules complete.
