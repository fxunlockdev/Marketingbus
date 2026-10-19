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

The real upstream probe exposed an attribution distinction: `metadata.sourceURL` is the originally submitted address, while `metadata.url` is the scraping engine's final address. The application now requires and validates `metadata.url`, rejects cross-origin/downgraded/restricted final addresses, and also checks the original source attribution when supplied. Missing final-address evidence fails closed. This post-fetch check prevents accepting misattributed evidence; it is not a replacement for scraper-side network isolation.

## Cost target (20 October)

The owner requested infrastructure as low as possible and no more than USD 10 per user. Working interpretation: USD 10 per active customer/business per month for shared infrastructure, separate from paid AI supplier calls. Count fixed idle costs as well as request-time usage; do not assume hundreds of customers to dilute the cost of the first pilot. This target is not evidence that the upstream multi-service stack fits it. Measure a pinned local stack and obtain current hosting rates before provisioning; no recurring service or paid proxy is enabled by this document.

Read-only Railway audit on 20 October 2026 (GMT+8), billing period 10 October–10 November: Marketingbus project usage was USD 0.67125 (worker 0.31998, web 0.22556, PostgreSQL 0.12571). This is accrued usage, not a monthly forecast. The workspace contains six projects; its separate USD 8.00866 estimated bill must not be represented as Marketingbus's bill. No workspace spending limit was changed because it would affect unrelated projects.

Thirteen five-minute samples from the preceding hour averaged 0.2492 GB / 0.0069 vCPU for the worker, 0.1469 GB / 0.0010 vCPU for web and 0.0685 GB / 0.0015 vCPU for PostgreSQL. At [Railway's published container rates](https://docs.railway.com/pricing/plans) of USD 10/GB-month memory and USD 20/vCPU-month CPU, steady use at those averages would be USD 4.834/month compute. This one-hour scenario includes deployment overlap, is not a full workload benchmark or invoice, and excludes plan fees/credits, volumes/backups, bucket storage, egress, scraping and AI. It cannot prove the USD 10/customer target under production demand. Keep one shared scraper stack, never one stack per customer; do not reduce database durability or tenant isolation to meet the target.

### Local upstream probe — 20 October, not production acceptance

Built Firecrawl v2.11.0 at `ef12eb36b2f3382838dfe0a0c1a5add3d5df7fe5` on local arm64 Docker. Only optional build-cache mounts were removed from the temporary API Dockerfile because this Docker installation has no BuildKit/buildx. The upstream browser image uses Node 18 and resolves its npm dependencies at build time; it is a measurement artifact, **not an approved production image**. No upstream code or image was added to the product release.

The probe used one NuQ worker, one browser page, a 192 MiB per-process JavaScript heap ceiling, and separate disposable Redis, RabbitMQ and NuQ PostgreSQL services. PostgreSQL's command-line probe limits used 32 MiB shared buffers, 4 MiB WAL buffers, 80 MiB minimum/256 MiB maximum WAL, and a 512 MiB temporary data mount. No application database, model keys or customer data was shared. Only the API was bound to host loopback; dependency ports were not published.

The first API attempts exited because RabbitMQ encountered local Docker disk exhaustion during image building (`ENOSPC`, followed by `ECONNRESET`), not a demonstrated RAM failure. Removing only this build's verified unused intermediate images recovered about 4.9 GiB; the running application and unrelated containers were untouched. After recreating the disposable queue, the full upstream API became ready and a real `/v2/scrape` returned HTTP 200 with 1,342 bytes of Markdown in 831 ms. The application's actual `readWebsite` client subsequently accepted the real response and final URL. The browser component separately returned real page HTML and denied a loopback target. These checks **do not prove** redirect/subresource/DNS-rebinding isolation or adversarial-load safety.

Six samples over 36 seconds after startup/first request measured the following Docker working sets (not configured limits):

| Component | Mean GiB | Peak GiB | Mean vCPU |
| --- | ---: | ---: | ---: |
| API and worker harness | 1.2517 | 1.2940 | 0.1230 |
| Browser | 0.2151 | 0.2161 | 0.0017 |
| NuQ PostgreSQL | 0.0747 | 0.0762 | 0.0251 |
| Redis | 0.0057 | 0.0059 | 0.0091 |
| RabbitMQ | 0.1071 | 0.1123 | 0.0157 |

Total mean working set: **1.6543 GiB** for the scraper alone. This short local sample is not a Railway forecast, long-term idle benchmark or capacity test, but it contradicts treating the full always-on stack as negligible within a USD 10 first-customer infrastructure budget. Do not deploy that topology under the current ceiling on the assumption that caches remove idle cost. Next acceptance work is a verified on-demand or lower-footprint Firecrawl topology, including cold-start/timeout behavior, dependency health, public-only egress and realistic monthly usage. No paid scraper services were created or enabled.

Local evidence: `/tmp/marketingbus-firecrawl-build.log`, `/tmp/marketingbus-firecrawl-runtime-second.log`, `/tmp/marketingbus-firecrawl-scrape-probe.json`, `/tmp/marketingbus-firecrawl-resource-samples.jsonl`. These are local probe artifacts, not production monitoring.

All five temporary probe containers and both dedicated test networks were stopped/removed after measurement. The disposable queue/database data had no customer records and was intentionally discarded; source and final local images remain available for further optimization. Unrelated Docker resources and production services were not removed.

Do not assume enabling Railway Serverless on the existing multi-service topology solves the idle-cost problem. [Railway's documented sleep behavior](https://docs.railway.com/deployments/serverless) counts database/private-network traffic as activity, has a roughly 5–10 minute inactivity window, and can return a 502 on the first wake-up request. The upstream queue workers maintain dependency traffic. Any on-demand redesign therefore needs verified quiescence, cold-start recovery without duplicate scrapes, and preservation of Marketingbus's durable import queue; it is not a configuration-only acceptance claim.

Follow-up feasibility probe: the same pinned upstream source exposes `scrapeURL`, exercised by its own standalone tests. One bounded process successfully extracted the upstream test website using the fetch engine at 287,375,360 bytes RSS (about 274 MiB), and using the real Playwright engine with Redis at 284,184,576 bytes RSS (about 271 MiB). The latter needed no RabbitMQ, NuQ database or six-process API harness. This is a viable next optimization to investigate because Marketingbus already owns the durable queue; it is **not yet a deployed HTTP adapter or a monthly cost guarantee**. The initial no-Redis fetch probe completed but logged connection errors, so do not describe Redis as unnecessary. Browser and Redis working sets are additional to the per-process RSS.

Important upstream boundary: the pinned Playwright engine currently reports the submitted URL as its result URL (`engines/playwright/index.ts`, redirect-following TODO). Before activating that engine, the controlled browser/adapter must propagate the actual final browser URL and pass redirect/egress tests. The new application final-URL guard is necessary but cannot correct a supplier's inaccurate provenance on its own.

## Authenticated-import release checks

85 backend suites / 1,766 tests passed (`/tmp/marketingbus-v56-regression.log`). The final client checks passed 34 tests, including empty-key compatibility (`/tmp/marketingbus-v56-client-final.log`). Production build/TypeScript and four focused browser journeys passed (`/tmp/marketingbus-v56-build-final.log`, `/tmp/marketingbus-v56-browser-final.log`). The accessibility skill guided persistent, announced failure messages rather than transient-only notifications. No live scraper, paid supplier call, public post or customer record was used for these checks.

Application source `869f21c` deployed from the same tracked-source archive to web `7db0765f-d677-4d1f-aab3-5b784329be53` and worker `7f4d8a0d-f44b-402c-98cd-c3d58f7db037`, both observed SUCCESS. Worker reported no pending migrations and started; the public web health/database-schema check returned HTTP 200 with status ok. Scraper and paid-provider gates were not changed.

Final-address follow-up: all **1,771 tests / 85 suites**, production build and TypeScript pass locally (`/tmp/marketingbus-v57-regression.log`, `/tmp/marketingbus-v57-build.log`). New checks cover a matching submitted URL with a different/private/downgraded final URL, missing final URL, same-origin redirects, inconsistent attribution, and failed imports never saving third-party text as evidence. Existing source release `869f21c` and documentation release `e2c1626` also have successful independent GitHub checks. This follow-up's deployment must be observed separately; local success is not deployment success or complete-product acceptance.

Source removal deletes active source text; facts copied into brand snapshots and backups require their own retention policy. Imported page/document text is untrusted data, never authority for tools, spending or profile approval.

Primary references: [upstream source](https://github.com/firecrawl/firecrawl), [self-host instructions](https://docs.firecrawl.dev/contributing/self-host), [scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape). Check release licensing and preserve required notices before distribution.

Document parser references: [Mozilla PDF.js](https://github.com/mozilla/pdf.js), [Mammoth text extraction and security notes](https://github.com/mwilliamson/mammoth.js). Only raw text is used, never generated HTML. Mammoth's CLI-only argparse dependency is overridden to version 2.0.1 to remove its vulnerable sprintf-js dependency; extraction tests cover the supported library path. Do not enable external file access or run the converter CLI on customer documents.
