import { z } from "zod";
import { validatePublicDns } from "../providers/url-policy";
import { SourceImportError } from "./import-errors";
import { websiteScraper, type WebsiteScraper } from "./scraper-config";

const resultSchema = z.object({ success: z.literal(true), data: z.object({
  markdown: z.string().trim().min(20).max(80000).refine(value => !/[\u0000\uFFFD]/.test(value)),
  metadata: z.object({ statusCode: z.number().int(), url: z.string(), sourceURL: z.string().optional(), title: z.string().max(1000).optional() }),
}) });

const crawlResultSchema = z.object({ success: z.literal(true), results: z.array(z.object({
  success: z.literal(true), url: z.string(), redirected_url: z.string().min(1),
  status_code: z.number().int(), redirected_status_code: z.number().int().nullish(),
  markdown: z.union([z.string(), z.object({ raw_markdown: z.string() })]),
  metadata: z.object({ title: z.string().max(1000).nullish() }).nullish(),
})).length(1) });

export function scraperHeaders(provider = websiteScraper()): Record<string, string> {
  const key = provider === "crawl4ai" ? process.env.CRAWL4AI_API_TOKEN : process.env.FIRECRAWL_API_KEY;
  // Crawl4AI exposes more than a crawl endpoint. Require its server-side authentication.
  if (provider === "crawl4ai" && !key) throw new SourceImportError("SCRAPER_AUTH_REQUIRED");
  if (key !== undefined && key !== "" && (!key.trim() || key !== key.trim() || !/^[\x21-\x7e]{1,4096}$/.test(key))) {
    throw new SourceImportError("SCRAPER_AUTH_REQUIRED");
  }
  return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

async function publicAddress(value: string) {
  try { return await validatePublicDns(value); }
  catch { throw new SourceImportError("SOURCE_ADDRESS_RESTRICTED"); }
}

export async function readWebsite(base: URL, input: string, headers: Record<string, string>, transport: typeof fetch = fetch, provider: WebsiteScraper = websiteScraper()) {
  const url = await publicAddress(input);
  try {
    // Never send model keys, extraction/branding requests, crawl actions or paid proxy fallbacks.
    const response = await transport(new URL(provider === "crawl4ai" ? "crawl" : "v2/scrape", base), {
      method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(45000),
      body: JSON.stringify(provider === "crawl4ai" ? {
        urls: [url.href],
        browser_config: { type: "BrowserConfig", params: { headless: true, text_mode: true, light_mode: true, accept_downloads: false, verbose: false } },
        crawler_config: { type: "CrawlerRunConfig", params: {
          cache_mode: "bypass", page_timeout: 30000, wait_until: "domcontentloaded", check_robots_txt: true,
          excluded_tags: ["nav", "footer", "header"], process_iframes: false, scan_full_page: false,
          screenshot: false, pdf: false, stream: false, max_retries: 0, verbose: false,
        } },
      } : { url: url.href, formats: ["markdown"], onlyMainContent: true, timeout: 30000, maxAge: 604800000 }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceImportError(response.status === 401 || response.status === 403 ? "SCRAPER_AUTH_REQUIRED"
        : response.status === 429 ? "SCRAPER_BUSY" : response.status === 408 || response.status === 504 ? "SCRAPER_TIMEOUT" : "SCRAPER_UNAVAILABLE");
    }
    if (Number(response.headers.get("content-length")) > 500000) {
      await response.body?.cancel(); throw new SourceImportError("SOURCE_TOO_LARGE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SourceImportError("SOURCE_INVALID_RESULT");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > 500000) throw new SourceImportError("SOURCE_TOO_LARGE");
        chunks.push(part.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new SourceImportError("SOURCE_INVALID_RESULT"); }
    if (provider === "crawl4ai") {
      const crawl = crawlResultSchema.safeParse(raw);
      if (!crawl.success) throw new SourceImportError("SOURCE_INVALID_RESULT");
      const page = crawl.data.results[0];
      if (page.url !== url.href) throw new SourceImportError("SOURCE_REDIRECT_CHANGED");
      raw = { success: true, data: {
        markdown: typeof page.markdown === "string" ? page.markdown : page.markdown.raw_markdown,
        metadata: { statusCode: page.redirected_status_code ?? page.status_code, sourceURL: page.url,
          url: page.redirected_url, title: page.metadata?.title ?? undefined },
      } };
    }
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) throw new SourceImportError("SOURCE_INVALID_RESULT");
    const { data } = parsed.data;
    if (Buffer.byteLength(data.markdown) > 80000) throw new SourceImportError("SOURCE_TOO_LARGE");
    if (data.metadata.statusCode < 200 || data.metadata.statusCode >= 300) throw new SourceImportError("SOURCE_PAGE_UNAVAILABLE");
    // Firecrawl sourceURL is the submitted URL; metadata.url is the engine's
    // actual final URL. Require it instead of inferring that no redirect occurred.
    const finalUrl = await publicAddress(data.metadata.url);
    if (finalUrl.origin !== url.origin) throw new SourceImportError("SOURCE_REDIRECT_CHANGED");
    if (data.metadata.sourceURL && (await publicAddress(data.metadata.sourceURL)).origin !== url.origin) {
      throw new SourceImportError("SOURCE_REDIRECT_CHANGED");
    }
    return data;
  } catch (error) {
    if (error instanceof SourceImportError) throw error;
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new SourceImportError("SCRAPER_TIMEOUT");
    throw new SourceImportError("SCRAPER_UNAVAILABLE");
  }
}
