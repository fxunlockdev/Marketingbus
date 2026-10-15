# Evidence intake — implementation versus deployment

The brand screen supports UTF-8 TXT/Markdown files or pasted text (24 KB), selectable-text PDF and DOCX uploads, and a queued single-page Firecrawl import. Sources are tenant-scoped, deduplicated within a business and explicitly proposed, not automatically confirmed facts. An exact-excerpt check records source/hash evidence. Users currently copy a reviewed fact into the brand form and reconfirm it; AI-generated brand/tone proposals and one-click application are **not** implemented.

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

Source removal deletes active source text; facts copied into brand snapshots and backups require their own retention policy. Imported page/document text is untrusted data, never authority for tools, spending or profile approval.

Primary references: [upstream source](https://github.com/firecrawl/firecrawl), [self-host instructions](https://docs.firecrawl.dev/contributing/self-host), [scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape). Check release licensing and preserve required notices before distribution.

Document parser references: [Mozilla PDF.js](https://github.com/mozilla/pdf.js), [Mammoth text extraction and security notes](https://github.com/mwilliamson/mammoth.js). Only raw text is used, never generated HTML. Mammoth's CLI-only argparse dependency is overridden to version 2.0.1 to remove its vulnerable sprintf-js dependency; extraction tests cover the supported library path. Do not enable external file access or run the converter CLI on customer documents.
