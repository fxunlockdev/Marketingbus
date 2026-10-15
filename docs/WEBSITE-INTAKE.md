# Evidence intake — implementation versus deployment

The brand screen supports UTF-8 TXT/Markdown files or pasted text (24 KB) and a queued single-page Firecrawl import. Sources are tenant-scoped, deduplicated within a business and explicitly proposed, not automatically confirmed facts. An exact-excerpt check records source/hash evidence. Users currently copy a reviewed fact into the brand form and reconfirm it; AI-generated brand/tone proposals and one-click application are **not** implemented.

## Low-cost bounds

- One explicitly submitted public HTTPS page, not an entire crawl.
- Seven-day successful-result cache per business/URL; simultaneous duplicate requests reuse the queue entry.
- Three new page requests per business in 24 hours; 30 active sources and a bounded 750 KB allowance, including reservations for in-flight pages.
- One global scrape job at a time, 30-second scrape timeout and 45-second transport timeout. No automatic retries.
- Markdown only. No Firecrawl AI extraction/branding/agents, model keys or paid proxy fallback.
- PDF, Word and video ingestion remain disabled until isolated parsers/quarantine and storage retention are implemented.

## Required self-hosted infrastructure (not yet provisioned)

The upstream current stack includes API/worker, Playwright, Redis, RabbitMQ and a NuQ PostgreSQL database. Default resource limits are not a verified minimum and not measured cost. A resource-limited pilot needs a pinned release, low concurrency, private dependencies, measured memory/CPU use and an agreed monthly ceiling. Do not represent self-hosting as free or promise it fits $10/month without measurement.

Use `WEBSITE_EXTRACTION_ENABLED=false` until deployment and network tests pass. `FIRECRAWL_SELF_HOSTED_URL` must be a private Railway URL (localhost permitted only outside production). `FIRECRAWL_EGRESS_RESTRICTED=true` is an operator attestation, **not** a network firewall: set it only after proving scraper/browser egress cannot reach private, loopback, link-local, metadata or customer-service addresses, including redirects, DNS rebinding and subresources. Application DNS checks are defense in depth, not a substitute for browser/network isolation. Do not expose an unauthenticated self-hosted Firecrawl endpoint publicly.

No Firecrawl resources or paid scraping calls were created by this release. Queue contracts were verified using injected responses. Actual web extraction cannot be called live-accepted yet.

Source removal deletes active source text; facts copied into brand snapshots and backups require their own retention policy. Imported page/document text is untrusted data, never authority for tools, spending or profile approval.

Primary references: [upstream source](https://github.com/firecrawl/firecrawl), [self-host instructions](https://docs.firecrawl.dev/contributing/self-host), [scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape). Check release licensing and preserve required notices before distribution.
