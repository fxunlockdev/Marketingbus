import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserTarget, createBrowserService } from "../scripts/firecrawl/browser-service.mjs";

const token = "local-browser-fixture-credential-12345";
const proxyPassword = "local-fixture-credential-only-12345";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fakeBrowser() {
  const frame = {};
  const page = { goto: vi.fn(async () => ({ status: () => 200 })), waitForLoadState: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.com/final"), mainFrame: () => frame, content: vi.fn(async () => "<html>Business evidence</html>") };
  const context = { route: vi.fn(async () => {}), routeWebSocket: vi.fn(async () => {}), on: vi.fn(), newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  const launch = vi.fn(async () => browser);
  return { browser, context, page, launch };
}
async function fixture(launch = fakeBrowser().launch) {
  const server = createBrowserService({ token, proxyPassword, proxyServer: "http://private-proxy:8899", launch });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); cleanups.push(() => server.shutdown());
  const address = server.address(); if (!address || typeof address === "string") throw Error("Missing address");
  const url = `http://127.0.0.1:${address.port}/scrape`;
  return { server, url, post: (input: unknown) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) }) };
}
describe("isolated on-demand scraper browser", () => {
  it.each(["http://example.com", "https://example.com:8080", "https://user:password@example.com", "https://127.0.0.1", "https://db.railway.internal", "file:///etc/passwd", "data:text/html,example"])("rejects %s before launching", input => {
    expect(() => browserTarget(input)).toThrow();
  });
  it("requires private browser and proxy authentication", () => {
    expect(() => createBrowserService({ token: "", proxyPassword, proxyServer: "http://proxy:8899", launch: vi.fn() })).toThrow();
    expect(() => createBrowserService({ token, proxyPassword: "", proxyServer: "http://proxy:8899", launch: vi.fn() })).toThrow();
  });
  it("does not launch Chromium at startup or for unauthorized requests", async () => {
    const { launch } = fakeBrowser(); const { url } = await fixture(launch);
    const response = await fetch(url, { method: "POST", body: "{}" });
    expect(response.status).toBe(401); expect(launch).not.toHaveBeenCalled();
  });
  it("checks authenticated readiness without starting an idle browser", async () => {
    const { launch } = fakeBrowser(); const { url } = await fixture(launch);
    const response = await fetch(new URL("/health", url), { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "ready", busy: false });
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([null, {}, { url: "https://127.0.0.1" }, { url: "https://example.com", timeout: 0 }, { url: "https://example.com", timeout: 30001 },
    { url: "https://example.com", skip_tls_verification: true }, { url: "https://example.com", headers: { Authorization: "secret" } },
    { url: "https://example.com", actions: ["click"] }, { url: "https://example.com", wait_after_load: 60000 }])("rejects invalid or expanded scrape requests (%#)", async input => {
    const { launch } = fakeBrowser(); const { post } = await fixture(launch);
    expect((await post(input)).status).toBe(400); expect(launch).not.toHaveBeenCalled();
  });
  it("rejects oversized request bodies before launching", async () => {
    const { launch } = fakeBrowser(); const { post } = await fixture(launch);
    expect((await post({ url: "x".repeat(5000) })).status).toBe(400); expect(launch).not.toHaveBeenCalled();
  });
  it("returns real final-address provenance and closes browser resources after each job", async () => {
    const fake = fakeBrowser(); const { post } = await fixture(fake.launch);
    const response = await post({ url: "https://example.com", timeout: 1000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: "https://example.com/final", pageStatusCode: 200, content: "<html>Business evidence</html>" });
    expect(fake.launch).toHaveBeenCalledWith(expect.objectContaining({ proxy: { server: "http://private-proxy:8899/", username: "scraper", password: proxyPassword } }));
    expect(fake.browser.newContext).toHaveBeenCalledWith({ serviceWorkers: "block", acceptDownloads: false, ignoreHTTPSErrors: false });
    await vi.waitFor(() => expect(fake.browser.close).toHaveBeenCalled()); expect(fake.context.close).toHaveBeenCalled();
  });
  it.each(["https://other.example/page", "http://example.com/page", "https://127.0.0.1/page"])("refuses unsafe final address %s", async final => {
    const fake = fakeBrowser(); fake.page.url.mockReturnValue(final); const { post } = await fixture(fake.launch);
    const response = await post({ url: "https://example.com" }); expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Page unavailable" });
  });
  it("does not return oversized page content", async () => {
    const fake = fakeBrowser(); fake.page.content.mockResolvedValue("a".repeat(2 * 1024 * 1024 + 1)); const { post } = await fixture(fake.launch);
    expect((await post({ url: "https://example.com" })).status).toBe(413);
  });
  it("redacts browser errors and releases the single-job slot", async () => {
    const fake = fakeBrowser(); fake.page.goto.mockRejectedValueOnce(Error("sensitive transport details")); const { post } = await fixture(fake.launch);
    const failed = await post({ url: "https://example.com" }); expect(await failed.json()).toEqual({ error: "Page unavailable" });
    expect((await post({ url: "https://example.com" })).status).toBe(200);
  });
  it("blocks private/non-HTTPS resources, mutation requests and unused media", async () => {
    const fake = fakeBrowser(); const { post } = await fixture(fake.launch);
    await post({ url: "https://example.com" });
    const route = fake.context.route.mock.calls[0] as unknown as [string, (route: unknown) => Promise<void>];
    for (const [url, method, resourceType] of [["https://127.0.0.1", "GET", "document"], ["http://example.com", "GET", "script"],
      ["https://example.com", "POST", "xhr"], ["https://example.com/photo.png", "GET", "image"]]) {
      const request = { url: () => url, method: () => method, resourceType: () => resourceType, isNavigationRequest: () => false };
      const item = { request: () => request, continue: vi.fn(), abort: vi.fn(async () => {}) };
      await route[1](item); expect(item.abort).toHaveBeenCalled(); expect(item.continue).not.toHaveBeenCalled();
    }
  });
  it("rejects a second job while the first browser is launching", async () => {
    const fake = fakeBrowser(); let release!: () => void;
    fake.launch.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return fake.browser; });
    const { post } = await fixture(fake.launch); const first = post({ url: "https://example.com" });
    await vi.waitFor(() => expect(fake.launch).toHaveBeenCalled());
    expect((await post({ url: "https://example.com" })).status).toBe(503);
    release(); expect((await first).status).toBe(200); expect(fake.launch).toHaveBeenCalledTimes(1);
  });
  it("finishes browser cleanup before reporting success or accepting the next job", async () => {
    const fake = fakeBrowser(); let finish!: () => void;
    fake.context.close.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const { post } = await fixture(fake.launch); let responded = false;
    const first = post({ url: "https://example.com" }).then(response => { responded = true; return response; });
    await vi.waitFor(() => expect(fake.context.close).toHaveBeenCalled());
    expect(responded).toBe(false); expect((await post({ url: "https://example.com" })).status).toBe(503);
    finish(); expect((await first).status).toBe(200);
    expect((await post({ url: "https://example.com" })).status).toBe(200);
  });
  it("terminates an overlong browser job and returns a redacted timeout", async () => {
    const fake = fakeBrowser(); let reject!: (error: Error) => void;
    fake.page.goto.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    fake.browser.close.mockImplementation(async () => { reject?.(Error("internal browser details")); });
    const { post } = await fixture(fake.launch);
    const response = await post({ url: "https://example.com", timeout: 1000 });
    expect(response.status).toBe(504); expect(await response.json()).toEqual({ error: "Browser timed out" });
    expect(fake.browser.close).toHaveBeenCalled();
  });
});
