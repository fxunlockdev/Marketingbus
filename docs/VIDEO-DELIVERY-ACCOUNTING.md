# Generated-video delivery and supplier reconciliation

This is a concrete workflow, not a fake provider adapter. Live Higgsfield calls remain disabled unless the operator explicitly enables the policy below. Fixture tests do not establish live account, model, CDN, renderer or output-quality acceptance.

## Three distinct amounts

1. **Accepted customer maximum:** the existing quote reserves `credits`, derived from the verified supplier ceiling. Acceptance does not submit a provider request.
2. **Provisional supplier expense:** the authenticated estimate for the exact parameters is signed and bound to the accepted operation. After completed output is obtained it is saved as `supplierEstimateMicros`, with `expenseBasis=ACCOUNT_QUOTE_V1`. It is never written to `supplierCostMicros` as if independently verified.
3. **Final supplier expense:** independent supplier invoice/ledger evidence is recorded by the privileged reconciliation procedure. `supplierCostMicros` and `supplierReconciledAt` remain null until that procedure completes. The estimate and evidence are retained for comparison.

The provider documents exact-parameter account estimates and automatic refunds for failed/moderated requests and canceled queued requests: [Higgsfield billing and retention](https://docs.higgsfield.ai/docs/concepts/billing-and-retention). The application deliberately treats these as a provisional accounting basis until independent reconciliation. No invoice endpoint is invented.

## Delivery sequence

Approved brand/copy/storyboard → customer maximum reservation → read-only exact estimate → recheck configuration, authority, context and lease → durable submission fence → one generation POST → signed receipt persisted → bounded read-only polling across restart → allowlisted public-DNS-only media transfer → private immutable quarantine → silent normalization → atomic usable-clip readiness and customer settlement → explicit human rights/fidelity/continuity review.

Only two fixed supporting-footage routes are implemented: `seedance-2.5-text` and `kling-3.0-standard-text`. They do not generate arbitrary customer prompts, reference-led product footage or audio. Route selection excludes incompatible model/duration/account/version/policy/expiry combinations before reservation.

Successful normalized footage settles `ceil(provisional USD micros / 10000)` existing platform credits, never above the accepted reservation. The unused reservation is released. Later supplier reconciliation does **not** reprice the customer, touch their wallet, remove their reviewed output or repeat generation. This preserves existing platform conversion; it is not proof that the proposed subscription achieves a particular net margin.

Failed/moderated/canceled provider results release customer credits and record an explicitly provisional zero supplier amount. Failure during private storage, normalization or current-context checks releases the customer reservation while retaining the supplier estimate. Ambiguous submission, invalid response or download failure remains uncertain; the hold stays for operator review and there is no automatic paid resubmission. Local downloads use only exact allowlisted hosts, checked public DNS, bounded bytes/time, no credentials and no redirects.

## Budget and invoice controls

- The lifetime authorization ceiling is never silently replenished.
- An unresolved provisional expense keeps its full authorization counted in the shared daily allowance, even after the clip is READY or FAILED and even across midnight.
- Final reconciliation counts on its reconciliation day. Actual overruns increase authorization consumption; they cannot disappear behind the old ceiling.
- The read-only operator queue report exposes `SUPPLIER_INVOICE_DUE` for terminal provisional jobs, without exposing prompts, tokens, receipts or invoice evidence.
- Reconciliation requires independent evidence and operator identity, is serialized, and rejects changed replays. It cannot run during normalization. Repeated identical reconciliation does not duplicate audits or credit entries.

```sh
npm run ops:queues -- --organization ORGANIZATION_ID
npx tsx scripts/reconcile-shot.ts --shot GENERATION_ID --supplier-cost-micros VERIFIED_FINAL_MICROS --evidence 'Independent invoice or ledger reference' --operator OPERATOR_ID
```

These are privileged operator commands, not public customer APIs. Do not run them against production merely to exercise tests. Do not treat an estimate as independent invoice evidence. A back-office reconciliation UI and automated supplier-ledger ingestion remain future work.

## Explicit activation (web and worker must match)

Keep `HIGGSFIELD_VIDEO_ENABLED=false` until the owner authorizes live testing and the operator verifies the account, exact models/prices, approved output hosts, private bucket and isolated encoder runtime. Credentials alone do not enable delivery.

Required server-only values:

- `HIGGSFIELD_API_KEY`: the complete API key copied from Higgsfield, pasted unchanged. Do not add a `Key ` prefix or manually split/assemble it. Leave `HIGGSFIELD_API_SECRET` empty. This is server-only and never entered in customer Connections. See the [official quick start](https://open.higgsfield.ai/quick-start).
- `HF_CREDENTIALS` and `HF_API_KEY` are supported aliases for the complete key; use one variable, not duplicate copies. Legacy installations can retain `HIGGSFIELD_API_KEY` (ID) plus `HIGGSFIELD_API_SECRET` (secret). Multiple formats must identify the same credential; conflicts fail closed. Changing format with the same pair preserves account and quote identity; rotation invalidates it.
- `HIGGSFIELD_EXPENSE_POLICY=account-quote-v1`: explicit provisional-delivery policy.
- `HIGGSFIELD_VERIFIED_UNTIL`: a future UTC timestamp no more than 90 days away.
- `HIGGSFIELD_OUTPUT_HOSTS_JSON`: exact verified public CDN hostnames. No wildcard, IP, private hostname or arbitrary URL.
- `VIDEO_RATE_CARD_JSON`: authenticated-account fingerprint, `provider=higgsfield`, `adapterVersion=higgsfield-account-quote-v1`, a supported model, fixed duration, verified total ceiling, expiry and `expensePolicy=account-quote-v1`. No sample rate is enabled by default.

The account fingerprint is SHA-256 of the exact UTF-8 JSON serialization `{keyId,secret}` for a legacy pair or `{apiKey}` for an opaque complete key, as constructed by the real transport; use operator-side tooling without printing credentials. It is an identity binding, not a billing account number. Configuration fingerprints additionally bind the enabled flag, policy, credentials, output-host list and verification expiry. Rotation invalidates old quotes and signed journals; reconcile in-flight jobs before rotation or expiry rather than resubmitting them.

Existing paid-execution, supplier-budget, motion-processing, matching-worker, storage and user-approval gates still apply. No application deployment implicitly changes them.

## Scope still outstanding

### SDK quick start

The pinned official `@higgsfield/client@0.2.6` and `dotenv` packages are installed. Local `.env.local` is already ignored by Git. Railway injects variables directly; no `.env.local` file needs to be deployed.

`npx tsx scripts/higgsfield-sdk-example.ts` validates credential syntax without making any network request. The optional `--run-paid-demo` flag explicitly sends the five-second, 720p, 16:9 Seedance request with audio. This standalone operator example spends supplier balance outside customer credit accounting; use the application's approved storyboard/quote flow for customer testing instead. Do not execute the paid example without budget approval. Failed/uncertain calls must be checked in the provider dashboard before another submission.

The installed SDK returns `status` and `video.url`, not `isCompleted` / `jobs[0].results.raw.url`. See the [official Seedance reference](https://open.higgsfield.ai/models/bytedance/seedance-2.5/text-to-video/api-reference) and installed V2 type declarations. The SDK example has automatic submission retries disabled. Production retains its direct HTTP estimate/submit/status transport: it uses the same authenticated API, but persists each request ID before polling and resumes through worker restarts. Replacing that lifecycle with a blocking `subscribe` would remove the current durable job controls. Native generated audio in the standalone example is not yet supported by the production silent-footage adapter.

The pinned SDK's paid demonstration requires the legacy paired format; it refuses an opaque key before sending a request. This limitation does not apply to the application's REST transport, which sends `Authorization: Key <complete-key>` unchanged. Do not manufacture a secret to satisfy the SDK example.

### Remaining verification

Live designated-account verification; production encoder isolation and bucket acceptance; reference-led revisions; voiceover/music; semantic continuity and creative-quality calibration; Instagram/media publication; mixed-media automation; enterprise production acceptance. This release does not certify the whole product complete or agency-level creative quality.
