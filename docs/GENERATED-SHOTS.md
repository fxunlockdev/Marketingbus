# Generated shot operations

The generated-shot lifecycle produces supporting footage from an approved, saved, empty storyboard scene. A concrete [Higgsfield network client and durable job bridge](HIGGSFIELD-TRANSPORT.md) now supports explicit, disabled-by-default registration and [provisional account-quote delivery](VIDEO-DELIVERY-ACCOUNTING.md), with independent final-expense reconciliation. Adding credentials alone does not enable generation. Live provider and production-renderer/storage acceptance remain required. Uploaded footage and app-owned motion rendering remain available as separate workflows.

## Customer workflow

1. Confirm the business, approve the source copy, then save and approve the exact storyboard and scene. Scenes already containing an image or clip cannot use this initial-generation lane.
2. Optionally describe lighting, framing, camera movement and mood (at most 1,000 characters), then request a quote. The server builds the prompt from the confirmed business and approved scene; customer direction is untrusted styling data, not a replacement system prompt or evidence for claims. Quotes expire after ten minutes and make no supplier call or credit reservation.
3. Confirm rights and accept the credit ceiling. Admission atomically reserves customer credits, supplier budget, private storage capacity and normalization capacity. Repeated acceptance does not create another job.
4. The worker can obtain a read-only estimate, recheck current authority, then persist it at the submission fence. It submits once and records the supplier job and signed journal. Status checks are read-only, with persisted backoff, at most twenty polls and a one-hour polling window. An ambiguous submission is never automatically resubmitted.
5. A successful, bound receipt enters private MP4 quarantine. Source bytes must satisfy size/signature checks and immutable storage read-back. Credits remain held while the existing clip worker normalizes the footage.
6. Only usable normalized media settles customer credits. The clip still needs explicit human rights, accuracy and continuity review before it can be attached to a new storyboard version, rendered and approved for export.

The source storyboard, brand and latest approved copy remain provenance requirements after generation. Withdrawing source approval blocks reuse and delivery. An approved source storyboard may be superseded when the reviewed clip is attached to a new version; that does not erase its provenance. This does not provide reference-led video editing or generated voiceover. Reviewed uploaded instrumental music is available separately in the motion assembly workflow.

## Direction and feedback-driven new takes

Select a retained, completed generated take for the same business, creative, approved-copy revision, brand version and scene. The current storyboard must be saved and approved. Its scene may be empty or use exactly that source clip; an unrelated asset or uploaded clip is never silently replaced. Rejected footage can inspire a new take from an empty approved scene, but still cannot be used as approved footage.

Provide 10–1,000 characters explaining the change. The original direction and chronological feedback are frozen in a strict versioned brief, with a same-tenant parent relationship and at most four feedback steps per chain. The worker sends this text with the current confirmed business/scene; it does **not** send previous video, images, object keys or media URLs. This is a fresh text-guided generation, not an exact edit, visual-reference conditioning or a promise to preserve subjects/pixels. Feedback is not evidence for new factual claims.

Each new take receives its own expiring quote, explicit rights/credit authorization, one supplier submission, normalization and independent footage review. Ordinary production credits apply; the copy-revision allowance is not consumed. Existing supplier ceilings, 24 daily quotes, five retained media files and six daily admissions still apply. Old output, review and rendering records remain unchanged. The user must deliberately select the reviewed replacement and approve the new storyboard/render.

The immediate source's retention and approval context are rechecked at authorization, submission and delivery. Removal or revoked source approval prevents unfinished delivery and follows the existing no-resend/accounting rules. After delivery, the new take is independent media with its own source storyboard/copy/brand provenance; deleting the previous clip does not retract the delivered take, because no previous media was reused. Direction/feedback history remains part of the job audit record after clip retention cleanup; it is not erased by deleting a clip.

Malformed/stale history, foreign creative references and injected client-owned lineage are rejected. Customer history shows only direction/feedback and safe status fields, never the supplier prompt, secret configuration or receipt. Legacy jobs retain the exact empty metadata default. The additive `20261018230000_shot_direction` migration and `studio-v34-shot-direction` runtime are required; see BUILD-STATUS.md for deployment evidence.

## Operator configuration

`VIDEO_RATE_CARD_JSON` is an array with at most 24 strict entries: `provider`, `accountId`, `adapterVersion`, `model`, `durationMs`, `ceilingMicros`, `verifiedUntil` and optional `expensePolicy` (defaults to `final`). Duration is 1–8 seconds in quarter-second increments at the contract level; concrete adapters further restrict supported values. A rate describes the all-in maximum expense for one silent generation at the adapter's fixed output configuration. An expired, unsupported or unmatched rate cannot be selected. Among eligible registered adapters, the server selects the lowest total verified ceiling that covers the scene duration, not the cheapest per-second headline.

The current internal conversion is one credit per 10,000 micro-USD of supplier expense, rounded up. This is an accounting conversion, not a validated subscription margin or a promise of $500–$600 net profit. Quote ceilings and realized supplier costs are retained separately. Customer settlement cannot exceed its reservation.

Paid execution, matching worker runtime/configuration, private asset storage, motion rendering and a positive daily normalization allowance must all be ready before acceptance. The current runtime and actual deployment status are recorded in BUILD-STATUS.md. Shared daily and lifetime supplier limits include generated video; unresolved older provisional invoices and jobs settled or reconciled today continue to consume daily capacity. Cancellation and unusable output release customer holds without replenishing lifetime supplier authorization. Reconciled overruns increase recorded authorization so they reduce future capacity.

The existing retention limits also apply: five retained clips per business, six uploaded/generated clips per day, source and normalized output limited to 20 MB each, thirty-day retention and seven-day deletion grace for failed private media. Quote creation is limited to 24 per business per day. These are conservative pilot bounds, not proven capacity limits.

## Provider adapter requirements

Implement `ShotAdapter` with server-only authenticated HTTP, a pinned model/output schema, bounded response bodies, abortable requests and allowlisted media downloads. Never follow arbitrary customer URLs or forward supplier credentials to storage/CDN requests. Return independently verified request, account, job and model binding plus final expense. Two internal authorizations cannot share a provider job ID within the same provider/account.

The contracts do not translate arbitrary provider responses into trusted receipts. Verify the actual account's endpoint, credential form, model parameters, price/usage evidence, terminal statuses, cancellation behavior and output URL policy. A success response is not a financial receipt. The explicit account-quote policy stores provisional expense separately and never invents a final invoice from a displayed starting price.

Production keys, rate values and paid test authorization remain operator-managed. Test adapters are injected into local tests only; there is no HTTP endpoint for registering a fake provider or marking a job complete.

## Recovery

Before submission, cancellation releases the customer hold. A crashed pre-submit worker can safely requeue. After submission, unknown expense moves to `NEEDS_RECONCILIATION`, retains the hold and blocks another active shot for that business. Interrupted read-only polling may resume within its existing allowance. Known-cost failures or unusable normalized footage release customer credits while preserving supplier expense and cleaning private bytes.

An operator must independently verify final expense before using the privileged command below. It never submits again or delivers uncertain media. For completed provisional jobs it preserves output and customer settlement; for uncertain undelivered jobs it releases the hold without delivery. Identical reconciliation is idempotent; changed replay evidence is rejected.

```sh
npx tsx scripts/reconcile-shot.ts --shot '<generation-id>' --supplier-cost-micros '<verified-expense>' --evidence '<supplier-ledger-reference>' --operator '<operator-id>'
```

Run against the intended environment only. Do not include credentials or raw signed media URLs in the evidence. There is no customer-facing reconciliation override. A full operator console and automated supplier settlement comparison remain unfinished.

## Verification scope

The database suite exercises authorization rollback, tenant/role isolation, concurrent acceptance and submission, duplicate supplier jobs, stale approvals, malformed receipts, overruns, polling bounds, raw/normalized storage failures, interrupted leases, expiry, cleanup eligibility, cross-day budgets and operator reconciliation. The browser journey checks safe status projections, disabled unconfigured generation, cancellation, retained uncertain holds, mobile width and automated accessibility. Supplier and storage responses in these new tests are fixtures, not live video-provider acceptance. Existing encoder tests separately exercise actual local FFmpeg output.
