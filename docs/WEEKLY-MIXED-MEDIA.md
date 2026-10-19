# Approval-gated mixed-media weeks

## Customer journey

Workflows saves a total number of planned creatives and the number of those that should be video concepts. Existing policies migrate with a null mix: their previous platform defaults and skipped non-static copy remain unchanged until an administrator explicitly saves quantities. Video production remains disabled. Planning-only mode makes no provider requests. Explicit draft mode creates static and video copy through the existing OpenAI route, grounded specialist harness, wallet and supplier admission. Image production is separately selected.

Video production requires an explicit owner/admin opt-in, including confirmation of rights to approved source materials. The shared weekly credit ceiling covers cumulative copy, image and generated-shot authorizations; it is not a fixed price, final charge or refundable balance. Existing generation, storage, daily CPU and retained-media limits apply independently. No production limits or execution flags are raised.

1. The video copy job completes. A person approves the current copy.
2. The weekly lane creates one editable draft storyboard using approved original logos and product/reference assets when available. Opening/closing captions use approved copy where it fits; long text is not truncated into a new claim. Every scene needs human review.
3. After exact scene/storyboard approval, empty scenes can receive one initial footage authorization each. Existing images/clips are not silently replaced. The durable provider worker submits, polls, verifies, normalizes and settles each job. No automatic paid revision or retry of an uncertain submission.
4. A person views and approves every generated take. The lane attaches the approved takes to a new draft storyboard. Changed scene approvals are invalidated.
5. A person approves the assembled scenes/storyboard. The lane requests one bounded local render. Original-asset-only storyboards can reach this step without a generated-shot provider call.
6. A person watches and approves the final video before export/download. Publishing remains a separate explicit authorization. No additional social capability or automatic publication is implied.

Pre-existing manual storyboards are preserved. Edits to a weekly storyboard before the first generated-shot authorization follow the current version; edits after paid authorization stop automatic hand-offs instead of reinterpreting paid work. Changed copy/source approvals must pass exact-context checks. Retained work can continue manually in Asset studio.

## Persistence and failure boundaries

Migration 52 adds explicit video policy/counts, independent cycle lease/readiness time, task stage/storyboard/render references and a unique per-task/per-scene generation journal. SQL checks reject inconsistent counts and invalid stage/pointer combinations. No credentials are stored here.

One bounded transition is selected per tick. Review waits yield for five minutes. A two-minute lease fences mutation; business locks and fresh role/brand/copy/UTC-week/policy checks are repeated inside quote, acceptance, storyboard and render transactions. Offers are linked atomically; manually accepting a weekly offer cannot bypass its ceiling. Credit authorization shares the supplier-admission/wallet transaction. Accepted requests do not increment authorization twice.

Stopping or reconfiguring cancels only unaccepted offers and future transitions. Accepted work, holds and cumulative authorizations are preserved. Reconfiguration cannot create another cycle in the same UTC week. Expired weeks stop instead of silently catching up. Failure/uncertainty needs explicit recovery, not automatic regeneration. Run inspection separates footage holds, actual scene-job statuses and final-render status from hand-off stages; prompts, tokens and private object paths stay private.

## Verification and boundaries

Integration coverage includes policy/SQL validation, quantities, concurrent selection, approval waits, combined budget rollback, cancellation races, authorizer/brand/week/policy drift, manual preservation, changed paid storyboards, uncertain outcomes and cross-tenant denial. A genuine local H.264 source passes through an injected provider response, actual normalization, human clip approval, automatic assembly, renewed scene approval, actual rendering and final watch approval before download. No real provider charge occurs.

Browser coverage checks saved quantities, explicit keyboard consent, disabled explanations, reload, plan-mode reset, mobile width and automated accessibility. Synthetic restoration checks consent, stages/leases, cumulative budget and scene linkage; it is not production database/object recovery.

This is not automatic first-week generation during onboarding, AI-recommended campaign strategy, voiceover generation, reference-conditioned video, semantic continuity certification, all social formats, measured learning or whole-product production acceptance. Live provider/account acceptance, actual disaster recovery, capacity/load verification and remaining feature gaps stay open.
