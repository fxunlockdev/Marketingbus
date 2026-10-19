# Lower-footprint Firecrawl deployment components

These are **local-tested components, not an enabled production scraper**. Marketingbus retains its durable job queue, per-business cache, import consent and evidence review. The intended path uses the pinned Firecrawl standalone Markdown engine instead of a second six-process API/queue harness. It must still be wired and accepted end to end before changing the application extraction gate.

## Network boundaries

`public-egress-proxy.mjs` is the only component that needs internet access. It accepts authenticated CONNECT requests to public HTTPS port 443 only. It validates every resolved address, rejects mixed private/public answers, and connects directly to a validated numeric address without a second DNS lookup. It does not cache DNS answers. It caps concurrency, connection duration and aggregate bytes; it does not log URLs, credentials or response bodies.

`browser-service.mjs` must run on a network with **no direct internet access and no application/database peers**. It reaches only the private egress proxy; its caller is the isolated scraper worker. A proxy flag alone is not network isolation. The browser has no customer sessions, AI keys, application credentials or shared profile directory. The service opens Chromium only for an admitted job and closes it before returning the response. Health checks do not start Chromium. It denies downloads, WebSockets, mutation requests, non-HTTPS addresses and unused image/media/font requests. Cross-origin main-frame navigation is rejected; same-origin redirects retain the final URL. JSON requests are limited to 4 KB, page HTML to 2 MiB and each job to 30 seconds. There is one job at a time and no internal queue or automatic retry.

This deployment profile is for website text evidence, **not website asset downloads or arbitrary browser automation**. It does not replace the product's separate approved-asset pipeline. Sites requiring cross-origin redirects, non-HTTPS resources, POST-based rendering or unavailable browser features can fail explicitly; never quietly invent evidence.

## Private configuration

Proxy: `SCRAPER_PROXY_PASSWORD` (24–256 printable characters), `SCRAPER_PROXY_HOST` (defaults to loopback), `SCRAPER_PROXY_PORT` (defaults to 8899). The browser authenticates as username `scraper` using that password. Never publish this service as an open proxy.

Browser: `SCRAPER_BROWSER_TOKEN` (a different private credential), `SCRAPER_PROXY_URL` (private HTTP proxy endpoint), `SCRAPER_PROXY_PASSWORD`, `SCRAPER_BROWSER_HOST` (defaults to loopback), and `SCRAPER_BROWSER_PORT` (defaults to 3003). `POST /scrape` and `GET /health` require `Authorization: Bearer <SCRAPER_BROWSER_TOKEN>`. The worker should only send `{url, timeout}`; compatibility fields `wait_after_load: 0`, empty `headers`, and `skip_tls_verification: false` are accepted, not arbitrary actions. A successful response includes `content`, `pageStatusCode`, `contentType` and actual `url`.

Run the proxy with Node and `ipaddr.js` 2.3.0. Run the browser with Node, `ipaddr.js` and Playwright plus its matching Chromium executable. Product tests currently use the existing dependency lockfile. A reproducible, security-reviewed standalone container recipe is still required; do not use the old upstream Node 18 measurement image for production.

## Verified local evidence (20 October 2026)

- Real proxy socket tests cover authentication, invalid/restricted destinations, mixed DNS answers, DNS rebinding between requests, numeric-IP dialing, resolver timeouts, concurrency, absolute deadlines and byte bounds.
- Browser HTTP tests cover auth, idle readiness, URL/request restrictions, final-URL checks, resource rules, cleanup-before-response, single-flight execution, timeouts and safe errors. Mock-browser checks are not a substitute for browser/network tests.
- The real browser adapter loaded `https://firecrawl-test-site.vercel.app/` through the new proxy on a Docker **internal-only** network: page status 200, 12,194 bytes of HTML, actual final URL retained, 1,069 ms in the recorded run. Private loopback/proxy targets returned 400 without page text. Direct TCP from that browser container to public `1.1.1.1:443` failed with `ENETUNREACH`.
- An after-job snapshot measured 19.13 MiB for the proxy and 84.71 MiB for the browser service, both at 0% CPU in that sample. This excludes the standalone Firecrawl engine, Redis, app, storage and hosting overhead; it is **not a monthly bill or peak-load guarantee**.
- The upstream browser's own DNS preflight failed on the isolated network. This controlled adapter deliberately delegates external DNS to the proxy instead. No private-address exception was added to the proxy to make the test pass.
- The final live proxy/browser checks were repeated with product `ipaddr.js` 2.3.0 copied into both disposable probe containers and verified there. Public extraction still succeeded; loopback, metadata and private-proxy targets were rejected, and direct public TCP remained blocked. The browser base image is nevertheless the old pinned upstream measurement image, not the final supported production runtime. Re-run acceptance using the final image and locked dependencies.

## Remaining activation requirements

1. Connect the standalone Firecrawl engine to the authenticated browser contract; preserve `response.url` rather than the upstream Playwright engine's submitted-URL placeholder.
2. Add a private, authenticated `/v2/scrape` gateway with isolated bounded child execution, safe errors and no inherited application/provider secrets. Prove the actual Marketingbus worker accepts its real Markdown and failure responses.
3. Pin and build supported-runtime images with required upstream notices; retain Redis only where measured/required and avoid RabbitMQ/NuQ duplication.
4. Reproduce network isolation in the actual hosting environment, including malicious redirects, subresources, DNS rebinding, cold starts, shutdown/recovery and concurrent clients. Keep `FIRECRAWL_EGRESS_RESTRICTED` and extraction activation off until these pass.
5. Measure the complete topology at realistic first-customer demand against the USD 10/customer/month infrastructure target. No paid service creation or production enablement is implied by these scripts.
