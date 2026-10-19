# Evidence intake — implementation versus deployment

The brand screen supports UTF-8 TXT/Markdown files or pasted text (24 KB), selectable-text PDF and DOCX uploads, and a queued single-page Firecrawl import. Sources are tenant-scoped, deduplicated within a business and explicitly proposed, not automatically confirmed facts. An exact-excerpt check records source/hash evidence. The later brand-analysis workflow now supports AI fact/tone proposals, citations and selective application into an unconfirmed draft; see [module 2](MODULE-PLAN.md#module-2-brand-intelligence). Confirmation and provider acceptance remain separate from extraction.

## Low-cost bounds

- One explicitly submitted public HTTPS page, not an entire crawl.
- Seven-day successful-result cache per business/URL; simultaneous duplicate requests reuse the queue entry.
- Three new page requests per business in 24 hours; 30 active sources and a bounded 750 KB allowance, including reservations for in-flight pages.
- One global scrape job at a time, 30-second scrape timeout and 45-second transport timeout. No automatic retries.
- Markdown only. No Firecrawl AI extraction/branding/agents, model keys or paid proxy fallback.
- PDF/DOCX files are bounded to 5 MB and 24 KB of extracted text, with up to 40 PDF pages. A separate process has a 15-second timeout, 192 MB JavaScript heap ceiling, limited filesystem reads, no inherited credentials and Node 26 permission restrictions. Two parser processes per web instance and per-user/workspace hourly limits bound concurrency. Original binaries are not stored. Scans, encryption, malformed files and oversized text fail explicitly; there is no OCR or silent text truncation. Native/external memory needs container-level enforcement before production release.
- Node 26 is required for document extraction and CI. A production Node 22 override must be upgraded and verified before enabling this upload route. Include `scripts/extract-document.mjs` and installed parser dependencies in the deployed image; do not use an incomplete standalone bundle.
- Video evidence ingestion remains unimplemented.

## Required self-hosted infrastructure (not yet provisioned)

The upstream current stack includes API/worker, Playwright, Redis, RabbitMQ and a NuQ PostgreSQL database. Default resource limits are not a verified minimum and not measured cost. A resource-limited pilot needs a pinned release, low concurrency, private dependencies, measured memory/CPU use and an agreed monthly ceiling. Do not represent self-hosting as free or promise it fits $10/month without measurement.

Use `WEBSITE_EXTRACTION_ENABLED=false` until deployment and network tests pass. `FIRECRAWL_SELF_HOSTED_URL` must be a private Railway URL (localhost permitted only outside production). `FIRECRAWL_EGRESS_RESTRICTED=true` is an operator attestation, **not** a network firewall: set it only after proving scraper/browser egress cannot reach private, loopback, link-local, metadata or customer-service addresses, including redirects, DNS rebinding and subresources. Application DNS checks are defense in depth, not a substitute for browser/network isolation. Do not expose an unauthenticated self-hosted Firecrawl endpoint publicly.

No Firecrawl resources or paid scraping calls were created by this release. Queue contracts were verified using injected responses. Actual web extraction cannot be called live-accepted yet.

## Authenticated imports and failure recovery

The worker sends `FIRECRAWL_API_KEY` as a Bearer credential only to the configured private scraper endpoint when that variable is present. An absent key supports a deliberately private unauthenticated deployment; this does not secure that deployment by itself. Malformed configured keys fail before claiming a queued attempt. Transport redirects are disabled, so scraper credentials cannot be forwarded to a redirect destination. Web and worker must use the same private endpoint and the worker must receive its authentication key where required.

Worker failures retain fixed, redacted reason codes for authentication, rate limiting, timeouts, unavailable services, restricted/redirected addresses, failed pages, oversized responses and unusable text. Business evidence displays corresponding actionable messages without provider response bodies or credentials. The API resolves failures only for the authenticated business/organization. Imports are never retried automatically; an explicit resubmission still uses the existing daily allowance and deduplication rules. Invalid UTF-8, null/replacement characters and oversized multibyte text are rejected instead of silently becoming brand evidence.

The client contract is tested against a real local authenticated HTTP fixture as well as failure responses and database-backed queue tests. This is not a deployment of upstream Firecrawl or proof of its network isolation.

## Cost target (20 October)

The owner requested infrastructure as low as possible and no more than USD 10 per user. Working interpretation: USD 10 per active customer/business per month for shared infrastructure, separate from paid AI supplier calls. Count fixed idle costs as well as request-time usage; do not assume hundreds of customers to dilute the cost of the first pilot. This target is not evidence that the upstream multi-service stack fits it. Measure a pinned local stack and obtain current hosting rates before provisioning; no recurring service or paid proxy is enabled by this document.

Read-only Railway audit on 20 October 2026 (GMT+8), billing period 10 October–10 November: Marketingbus project usage was USD 0.67125 (worker 0.31998, web 0.22556, PostgreSQL 0.12571). This is accrued usage, not a monthly forecast. The workspace contains six projects; its separate USD 8.00866 estimated bill must not be represented as Marketingbus's bill. No workspace spending limit was changed because it would affect unrelated projects.

Thirteen five-minute samples from the preceding hour averaged 0.2492 GB / 0.0069 vCPU for the worker, 0.1469 GB / 0.0010 vCPU for web and 0.0685 GB / 0.0015 vCPU for PostgreSQL. At [Railway's published container rates](https://docs.railway.com/pricing/plans) of USD 10/GB-month memory and USD 20/vCPU-month CPU, steady use at those averages would be USD 4.834/month compute. This one-hour scenario includes deployment overlap, is not a full workload benchmark or invoice, and excludes plan fees/credits, volumes/backups, bucket storage, egress, scraping and AI. It cannot prove the USD 10/customer target under production demand. Keep one shared scraper stack, never one stack per customer; do not reduce database durability or tenant isolation to meet the target.

## Authenticated-import release checks

85 backend suites / 1,766 tests passed (`/tmp/marketingbus-v56-regression.log`). The final client checks passed 34 tests, including empty-key compatibility (`/tmp/marketingbus-v56-client-final.log`). Production build/TypeScript and four focused browser journeys passed (`/tmp/marketingbus-v56-build-final.log`, `/tmp/marketingbus-v56-browser-final.log`). The accessibility skill guided persistent, announced failure messages rather than transient-only notifications. No live scraper, paid supplier call, public post or customer record was used for these checks.

Application source `869f21c` deployed from the same tracked-source archive to web `7db0765f-d677-4d1f-aab3-5b784329be53` and worker `7f4d8a0d-f44b-402c-98cd-c3d58f7db037`, both observed SUCCESS. Worker reported no pending migrations and started; the public web health/database-schema check returned HTTP 200 with status ok. Scraper and paid-provider gates were not changed.

Source removal deletes active source text; facts copied into brand snapshots and backups require their own retention policy. Imported page/document text is untrusted data, never authority for tools, spending or profile approval.

Primary references: [upstream source](https://github.com/firecrawl/firecrawl), [self-host instructions](https://docs.firecrawl.dev/contributing/self-host), [scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape). Check release licensing and preserve required notices before distribution.

Document parser references: [Mozilla PDF.js](https://github.com/mozilla/pdf.js), [Mammoth text extraction and security notes](https://github.com/mwilliamson/mammoth.js). Only raw text is used, never generated HTML. Mammoth's CLI-only argparse dependency is overridden to version 2.0.1 to remove its vulnerable sprintf-js dependency; extraction tests cover the supported library path. Do not enable external file access or run the converter CLI on customer documents.
