import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { readWebsite, scraperHeaders } from "../src/lib/knowledge/scraper-client";
import { scraperBase, websiteScraper } from "../src/lib/knowledge/scraper-config";
vi.mock("../src/lib/providers/url-policy", async importOriginal => {
  const original = await importOriginal<typeof import("../src/lib/providers/url-policy")>();
  return { ...original, validatePublicDns: async (value: string) => original.publicUrl(value) };
});
const source = "https://example.com/about", base = new URL("http://crawl4ai.railway.internal:11235");
const markdown = "We create thoughtful interiors for busy families.";
const result = (changes = {}) => ({ success: true, results: [{
  success: true, url: source, redirected_url: source, status_code: 200, redirected_status_code: 200,
  markdown: { raw_markdown: markdown }, metadata: { title: "Our studio" }, ...changes,
}] });
afterEach(() => vi.unstubAllEnvs());
it("uses the v0.9.5 single-page contract over HTTP without models, hooks, deep crawls or retries", async () => {
  const requests: { url?: string; body: unknown; auth?: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()), auth: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result()));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    vi.stubEnv("WEBSITE_SCRAPER", "crawl4ai"); vi.stubEnv("CRAWL4AI_API_TOKEN", "synthetic-token");
    vi.stubEnv("FIRECRAWL_API_KEY", "not-for-this-service");
    const address = server.address(); if (!address || typeof address === "string") throw Error("Missing fixture");
    expect(await readWebsite(new URL(`http://127.0.0.1:${address.port}`), source, scraperHeaders())).toEqual({
      markdown, metadata: { statusCode: 200, sourceURL: source, url: source, title: "Our studio" },
    });
    expect(requests).toEqual([{ url: "/crawl", auth: "Bearer synthetic-token", body: {
      urls: [source],
      browser_config: { type: "BrowserConfig", params: { headless: true, text_mode: true, light_mode: true, accept_downloads: false, verbose: false } },
      crawler_config: { type: "CrawlerRunConfig", params: {
        cache_mode: "bypass", page_timeout: 30000, wait_until: "domcontentloaded", check_robots_txt: true,
        excluded_tags: ["nav", "footer", "header"], process_iframes: false, scan_full_page: false,
        screenshot: false, pdf: false, stream: false, max_retries: 0, verbose: false,
      } },
    } }]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it.each([
  { redirected_url: undefined }, { redirected_url: null }, { markdown: "" }, { success: false },
  { markdown: "\0" + markdown }, { status_code: "200" },
])("rejects malformed or failed Crawl4AI evidence (%#)", async changes => {
  const transport = vi.fn(async () => Response.json(result(changes)));
  await expect(readWebsite(base, source, {}, transport, "crawl4ai")).rejects.toMatchObject({ code: "SOURCE_INVALID_RESULT" });
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each([
  [{ redirected_url: "https://127.0.0.1/private" }, "SOURCE_ADDRESS_RESTRICTED"],
  [{ redirected_url: "https://another.example" }, "SOURCE_REDIRECT_CHANGED"],
  [{ url: "https://another.example" }, "SOURCE_REDIRECT_CHANGED"],
  [{ redirected_status_code: 403 }, "SOURCE_PAGE_UNAVAILABLE"],
  [{ markdown: "漢".repeat(30000) }, "SOURCE_TOO_LARGE"],
])("preserves final-page attribution, status and size checks (%#)", async (changes, code) => {
  await expect(readWebsite(base, source, {}, async () => Response.json(result(changes)), "crawl4ai")).rejects.toMatchObject({ code });
});
it("rejects extra results rather than choosing an arbitrary page", async () => {
  const response = result(); response.results.push(response.results[0]);
  await expect(readWebsite(base, source, {}, async () => Response.json(response), "crawl4ai")).rejects.toMatchObject({ code: "SOURCE_INVALID_RESULT" });
});
it.each([undefined, "", " token", "token\n", "é"])("requires a valid dedicated Crawl4AI token (%#)", value => {
  vi.stubEnv("CRAWL4AI_API_TOKEN", value); vi.stubEnv("FIRECRAWL_API_KEY", "cannot-fallback");
  expect(() => scraperHeaders("crawl4ai")).toThrow();
});
it("requires explicit selection, private hosting and provider-specific verified isolation", () => {
  vi.stubEnv("WEBSITE_SCRAPER", "crawl4ai"); vi.stubEnv("WEBSITE_EXTRACTION_ENABLED", "true");
  vi.stubEnv("CRAWL4AI_SELF_HOSTED_URL", base.href); vi.stubEnv("FIRECRAWL_EGRESS_RESTRICTED", "true");
  vi.stubEnv("CRAWL4AI_EGRESS_RESTRICTED", "false");
  expect(() => scraperBase()).toThrow("isolation");
  vi.stubEnv("CRAWL4AI_EGRESS_RESTRICTED", "true"); expect(scraperBase()).toEqual(base);
  vi.stubEnv("CRAWL4AI_SELF_HOSTED_URL", "https://api.crawl4ai.com"); expect(() => scraperBase()).toThrow("private");
  vi.stubEnv("WEBSITE_SCRAPER", "unknown"); expect(() => websiteScraper()).toThrow();
});
it("redacts upstream failures and does not retry another scraper", async () => {
  const transport = vi.fn(async () => new Response("private diagnostic", { status: 401 }));
  await expect(readWebsite(base, source, {}, transport, "crawl4ai")).rejects.toMatchObject({ code: "SCRAPER_AUTH_REQUIRED" });
  expect(transport).toHaveBeenCalledTimes(1);
});
