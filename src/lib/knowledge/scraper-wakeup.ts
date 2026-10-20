import { SourceImportError } from "./import-errors";

// Wake a sleeping private service before submitting a crawl. Only the harmless
// health GET is retried; the actual crawl is still submitted exactly once.
export async function wakeScraper(base: URL, transport: typeof fetch = fetch, pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await transport(new URL("health", base), { method: "GET", redirect: "error", signal: AbortSignal.timeout(10000) });
      await response.body?.cancel();
      if (response.status === 200) return;
      if (![502, 503, 504].includes(response.status)) throw new SourceImportError("SCRAPER_UNAVAILABLE");
    } catch (error) { if (error instanceof SourceImportError) throw error; }
    if (attempt < 2) await pause(1000);
  }
  throw new SourceImportError("SCRAPER_UNAVAILABLE");
}
