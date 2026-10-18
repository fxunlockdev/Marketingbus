# Higgsfield low-level transport

The concrete network layer is implemented in `src/lib/providers/higgsfield.ts`, with a durable job bridge in `src/lib/video/higgsfield-adapter.ts`. It is **not yet registered as a production ShotAdapter** because final expense cannot yet be independently verified. Adding keys does not activate it. It has no tenant-controlled endpoint or fixture registration. No authenticated or paid Higgsfield call was made during implementation.

## Request and price binding

Two code-owned aliases map to documented text-to-video endpoints: `seedance-2.5-text` and `kling-3.0-standard-text`. Both use silent, portrait, single-shot parameters. Seedance selects 720p MP4; Kling output still needs actual metadata/normalization validation. Only integral supported durations up to the current eight-second clip limit are accepted. Arbitrary models, URLs, webhooks, reference parameters and audio settings cannot be supplied through these request objects.

An estimate uses exactly the later generation parameters. USD decimal strings are converted to integer micro-USD without floating-point rounding, with the existing $80 per-shot maximum. The returned estimate is HMAC-bound to the operation, endpoint/body hash, credential fingerprint, amount, provider credits and timestamp. Generation rejects altered, stale, future, mismatched or over-ceiling estimates before its HTTP call. The submitted idempotency key is the stable local operation ID. The low-level client performs exactly one submission attempt and never invents a replacement key or retry.

The acceptance receipt binds the provider UUID and exact official status URL to the operation, model alias, request hash, credential fingerprint and estimated amount. Its HMAC prevents altered receipts from being polled as if they were the original request. Polling checks the exact returned UUID. No model/account/final-price fields are fabricated from undocumented response fields. Queued/in-progress, failed, moderated, canceled and completed states remain distinct.

**Every result still has `expense: unverified`.** A successful generation, price estimate, or documented automatic refund is not independently reconciled final expense. This low-level layer never settles a wallet, marks a production job delivered, approves footage or promotes learning.

## HTTP and download boundaries

API requests use the fixed Higgsfield HTTPS origin, server-only authorization, no redirects/retries/cookies/cache, a 15-second request/body deadline, 64 KB received-body limit and checked JSON/length. Incomplete body reads are canceled on abort. Errors exclude raw responses, prompts, URLs and credentials.

Completed video is downloaded only from exact operator-verified hostnames. There is no permissive default CDN list. The Node HTTPS transport validates public DNS answers **inside socket lookup**, rejects mixed/private/reserved addresses, verifies TLS, uses a fresh connection and never forwards provider authorization or cookies. It refuses redirects and compressed responses, limits time to 20 seconds and received bytes to 20 MB, checks declared lengths where present, and accepts only MP4/octet-stream responses followed by an MP4 signature check. This is not a substitute for the existing H.264 decoder/normalizer, quarantine or human rights/continuity review.

The configured verification deadline must be current and at most 90 days away. Credentials and signed receipts remain server-side. Changing credentials invalidates old receipt signatures; the job bridge holds those jobs for reconciliation rather than silently polling under a new identity.

## Durable job bridge

The worker performs an optional read-only estimate before entering `SUBMITTING`. It checks current execution, lease, configuration, role, brand, copy, storyboard and reserved output before that estimate and again afterward. An over-ceiling estimate or changed approval fails before generation and releases the customer hold; a stale worker cannot mutate a replacement lease.

The signed estimate is persisted at the submission fence. The accepted signed journal is saved with the provider ID under the same lease, then supplied to read-only polling after a process restart. The bridge verifies its operation, prompt/parameter hash, model, credential identity, provider UUID, signature and ceiling. Missing/changed journals or credentials stop safely. Ambiguous submission acknowledgements remain uncertain and are never automatically resubmitted.

The bridge explicitly returns terminal `unverified` outcomes while expense remains unknown. The worker persists that terminal state, signed journal and estimate in `NEEDS_RECONCILIATION`, retains the hold and does not ingest media. It does not waste a CDN download for footage that cannot enter normalization. The existing privileged final-expense reconciliation releases customer credits without delivering uncertain output, and now retains original provider evidence. Customer status projections exclude all journals, estimates and provider credentials.

## Remaining integration work

1. Connect independently verified final expense evidence to successful media retrieval, quarantine and normalization. Do not relabel the estimate as actual supplier expense to bypass this gate. Current reconciliation deliberately does not deliver footage.
2. Register the complete adapter behind explicit operator settings only after that gate is implemented; retain the existing single-submit, current-context and normalized-output protections.
3. Verify actual account model access, exact rates, response/output hosts, private storage and decoder packaging, using a separately authorized live budget. Finish reference-led revisions, audio and semantic continuity evaluation separately.

The network client and socket/DNS policies are tested with injected HTTP/media responses, plus an actual Node HTTPS request that rejects a private DNS answer before connection. No real provider-generated footage or quality improvement is claimed. Provider references and schema caveats are recorded in [integration notes](HIGGSFIELD-INTEGRATION-NOTES.md).
