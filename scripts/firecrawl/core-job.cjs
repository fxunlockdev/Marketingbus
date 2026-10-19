const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

// One process per admitted scrape. No API harness, supplier keys or second queue.
process.once("message", async input => {
  const finish = message => {
    if (!process.send) process.exit(1);
    process.send(message, () => process.exit(0));
  };
  try {
    const root = process.env.FIRECRAWL_CORE_ROOT;
    if (!root || !process.env.PLAYWRIGHT_MICROSERVICE_TOKEN) throw Error("configuration");
    const { scrapeURL } = require(join(root, "dist/src/scraper/scrapeURL"));
    const { scrapeOptions } = require(join(root, "dist/src/controllers/v2/types"));
    const { CostTracking } = require(join(root, "dist/src/lib/cost-tracking"));
    const options = scrapeOptions.parse({ formats: ["markdown"], onlyMainContent: true, timeout: input.timeout,
      maxAge: 0, proxy: "basic", skipTlsVerification: false });
    const result = await scrapeURL(randomUUID(), input.url, options,
      { teamId: "marketingbus-private-intake", forceEngine: "playwright" }, new CostTracking());
    if (!result.success) throw Error("scrape failed");
    const document = result.document;
    if (typeof document?.markdown !== "string" || Buffer.byteLength(document.markdown) > 80000) throw Error("invalid result");
    if (typeof document.metadata?.url !== "string" || document.metadata.url.length > 2048
      || (document.metadata.title !== undefined && (typeof document.metadata.title !== "string" || document.metadata.title.length > 1000))) throw Error("invalid metadata");
    // Return only the fields the application consumes; never forward debug logs,
    // provider metadata, remote headers or internal errors across this boundary.
    finish({ success: true, data: { markdown: document.markdown, metadata: {
      url: document.metadata?.url, sourceURL: input.url, statusCode: document.metadata?.statusCode,
      title: document.metadata?.title,
    } } });
  } catch { finish({ success: false }); }
});
