import { afterEach, expect, it, vi } from "vitest";
import { verifyScraper } from "../src/lib/knowledge/scraper-preflight";
afterEach(() => vi.unstubAllEnvs());
function setup() {
  vi.stubEnv("WEBSITE_SCRAPER", "crawl4ai");
  vi.stubEnv("WEBSITE_EXTRACTION_ENABLED", "true");
  vi.stubEnv("CRAWL4AI_SELF_HOSTED_URL", "http://scraper.railway.internal:11235");
  vi.stubEnv("CRAWL4AI_EGRESS_RESTRICTED", "true");
  vi.stubEnv("CRAWL4AI_API_TOKEN", "fixture-only-token");
  const transport = vi.fn<typeof fetch>(async (_url, init) => new Response(null, { status: init?.method === "GET" ? 200 : !(init?.headers as Record<string, string>)?.Authorization ? 401 : 502 }));
  const read = vi.fn(async () => ({ markdown: "Example public website text.", metadata: { url: "https://example.com/", statusCode: 200 } }));
  return { transport, read };
}
it("verifies public reading, service auth, egress, TLS and recovery without DB or model calls", async () => {
  const f = setup();
  expect(await verifyScraper(f.transport, f.read)).toEqual({ publicRead: true, authentication: true, privateAddressBlocked: true, invalidTlsBlocked: true, recovery: true });
  expect(f.read).toHaveBeenCalledTimes(2); expect(f.transport).toHaveBeenCalledTimes(4);
  expect(f.transport.mock.calls[2][1]?.body).toBe(JSON.stringify({ urls: ["https://127.0.0.1/"] }));
});
it.each([0, 1, 2, 3])("refuses readiness if probe %s does not enforce the expected boundary", async index => {
  const f = setup(), original = f.transport.getMockImplementation()!;
  let calls = 0;
  f.transport.mockImplementation(async (...args) => calls++ === index ? new Response(null, { status: 418 }) : original(...args));
  await expect(verifyScraper(f.transport, f.read)).rejects.toThrow();
});
it("does not proceed to recovery after a failed public read", async () => {
  const f = setup(); f.read.mockRejectedValue(Error("offline"));
  await expect(verifyScraper(f.transport, f.read)).rejects.toThrow("offline");
  expect(f.transport).toHaveBeenCalledTimes(2);
});
