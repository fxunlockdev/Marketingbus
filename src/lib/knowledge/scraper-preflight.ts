import { scraperBase, websiteScraper } from "./scraper-config";
import { readWebsite, scraperHeaders } from "./scraper-client";
import { wakeScraper } from "./scraper-wakeup";

// Deployment acceptance only. No database, model calls, user data or result text
// is involved. Failure keeps the new worker unready; the old release can serve.
export async function verifyScraper(
  transport: typeof fetch = fetch,
  read: typeof readWebsite = readWebsite,
) {
  if (websiteScraper() !== "crawl4ai") throw Error("Scraper preflight requires Crawl4AI");
  const base = scraperBase("crawl4ai"), headers = scraperHeaders("crawl4ai");
  const probe = async (path: string, options: RequestInit, expected: number) => {
    const response = await transport(new URL(path, base), { ...options, redirect: "error", signal: AbortSignal.timeout(45000) });
    await response.body?.cancel();
    if (response.status !== expected) throw Error("Scraper acceptance failed");
  };
  await wakeScraper(base, transport);
  await probe("crawl", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: ["https://example.com/"] }) }, 401);
  const first = await read(base, "https://example.com/", headers, transport, "crawl4ai");
  if (first.markdown.length < 20) throw Error("Scraper returned no text");
  // These requests must reach the scraper, not just the app's URL validator.
  for (const url of ["https://127.0.0.1/", "https://expired.badssl.com/"]) {
    await probe("crawl", { method: "POST", headers, body: JSON.stringify({ urls: [url] }) }, 502);
  }
  const recovered = await read(base, "https://example.com/", headers, transport, "crawl4ai");
  if (recovered.markdown.length < 20) throw Error("Scraper recovery failed");
  return { publicRead: true, authentication: true, privateAddressBlocked: true, invalidTlsBlocked: true, recovery: true };
}
