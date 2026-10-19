import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWebsite, scraperHeaders } from "../src/lib/knowledge/scraper-client";
import { sourceImportMessage } from "../src/lib/knowledge/import-errors";
vi.mock("../src/lib/providers/url-policy", async importOriginal => {
  const original = await importOriginal<typeof import("../src/lib/providers/url-policy")>();
  return { ...original, validatePublicDns: async (value: string) => original.publicUrl(value) };
});
const base = new URL("http://firecrawl.railway.internal:3002");
const source = "https://example.com/about";
const markdown = "Our ceramics are handmade in our own studio.";
const result = (changes = {}) => ({ success: true, data: { markdown, metadata: { statusCode: 200, sourceURL: source, url: source }, ...changes } });
const transport = (response: Response) => vi.fn(async () => response) as unknown as typeof fetch;
afterEach(() => vi.unstubAllEnvs());

describe("private scraper contract", () => {
  it("sends the configured key over a real local HTTP connection and only requests one markdown page", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "test-only-scraper-credential");
    const requests: { url?: string; auth?: string; body: unknown }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.writeHead(request.headers.authorization === "Bearer test-only-scraper-credential" ? 200 : 401, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result()));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (!address || typeof address === "string") throw Error("Missing fixture address");
      expect(await readWebsite(new URL(`http://127.0.0.1:${address.port}`), source, scraperHeaders())).toMatchObject({ markdown });
      expect(requests).toEqual([{ url: "/v2/scrape", auth: "Bearer test-only-scraper-credential", body: {
        url: source, formats: ["markdown"], onlyMainContent: true, timeout: 30000, maxAge: 604800000,
      } }]);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it.each([undefined, ""])("does not invent credentials for a private unauthenticated deployment (%#)", key => {
    vi.stubEnv("FIRECRAWL_API_KEY", key);
    expect(scraperHeaders()).toEqual({ "Content-Type": "application/json" });
  });
  it.each([" ", " key", "key\n", "key\r\nInjected: yes", "é", "a".repeat(4097)])("rejects malformed operator credentials without echoing them (%#)", key => {
    vi.stubEnv("FIRECRAWL_API_KEY", key);
    expect(() => scraperHeaders()).toThrow(sourceImportMessage("SCRAPER_AUTH_REQUIRED"));
  });
  it.each([[401, "SCRAPER_AUTH_REQUIRED"], [403, "SCRAPER_AUTH_REQUIRED"], [429, "SCRAPER_BUSY"], [408, "SCRAPER_TIMEOUT"], [504, "SCRAPER_TIMEOUT"], [500, "SCRAPER_UNAVAILABLE"]])("classifies HTTP %s without reading upstream secret bodies or retrying", async (status, code) => {
    const response = new Response("upstream-secret-never-display", { status: Number(status) });
    const fetcher = transport(response);
    await expect(readWebsite(base, source, {}, fetcher)).rejects.toMatchObject({ code, message: sourceImportMessage(String(code)) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(true);
  });
  it("rejects non-public input before making a request", async () => {
    const fetcher = vi.fn();
    await expect(readWebsite(base, "https://127.0.0.1", {}, fetcher)).rejects.toMatchObject({ code: "SOURCE_ADDRESS_RESTRICTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("forbids transport redirects so scraper credentials cannot be forwarded", async () => {
    const fetcher = vi.fn(async (_url, init) => { expect(init.redirect).toBe("error"); expect(init.signal).toBeInstanceOf(AbortSignal); return Response.json(result()); });
    await readWebsite(base, source, {}, fetcher);
  });
  it.each([
    ["https://127.0.0.1/private", "SOURCE_ADDRESS_RESTRICTED"],
    ["https://other.example/about", "SOURCE_REDIRECT_CHANGED"],
    ["http://example.com/about", "SOURCE_ADDRESS_RESTRICTED"],
  ])("rejects unsafe final page %s even when sourceURL still matches the request", async (url, code) => {
    await expect(readWebsite(base, source, {}, transport(Response.json(result({ metadata: { statusCode: 200, sourceURL: source, url } }))))).rejects.toMatchObject({ code });
  });
  it("does not infer a final URL from the submitted sourceURL", async () => {
    await expect(readWebsite(base, source, {}, transport(Response.json(result({ metadata: { statusCode: 200, sourceURL: source } }))))).rejects.toMatchObject({ code: "SOURCE_INVALID_RESULT" });
  });
  it("accepts a verified same-origin redirect and retains its final URL", async () => {
    const url = "https://example.com/about/";
    expect(await readWebsite(base, source, {}, transport(Response.json(result({ metadata: { statusCode: 200, sourceURL: source, url } }))))).toMatchObject({ metadata: { url } });
  });
  it("rejects inconsistent source attribution even when the final URL matches", async () => {
    await expect(readWebsite(base, source, {}, transport(Response.json(result({ metadata: { statusCode: 200, sourceURL: "https://other.example/about", url: source } }))))).rejects.toMatchObject({ code: "SOURCE_REDIRECT_CHANGED" });
  });
  it("rejects a failed target page despite a successful scraper HTTP response", async () => {
    await expect(readWebsite(base, source, {}, transport(Response.json(result({ metadata: { statusCode: 403, url: source } }))))).rejects.toMatchObject({ code: "SOURCE_PAGE_UNAVAILABLE" });
  });
  it.each(["<html>Not JSON</html>", JSON.stringify(result({ markdown: "" })), JSON.stringify(result({ markdown: "\u0000" + markdown })), JSON.stringify(result({ markdown: "\ufffd" + markdown }))])("rejects unusable evidence (%#)", async body => {
    await expect(readWebsite(base, source, {}, transport(new Response(body)))).rejects.toMatchObject({ code: "SOURCE_INVALID_RESULT" });
  });
  it("rejects malformed UTF-8 instead of silently substituting characters", async () => {
    const bytes = Buffer.concat([Buffer.from('{"success":true,"data":{"markdown":"'), Buffer.from([0xc3, 0x28]), Buffer.from(markdown + '","metadata":{"statusCode":200}}}')]);
    await expect(readWebsite(base, source, {}, transport(new Response(bytes)))).rejects.toMatchObject({ code: "SOURCE_INVALID_RESULT" });
  });
  it("enforces byte storage limits for multibyte text", async () => {
    await expect(readWebsite(base, source, {}, transport(Response.json(result({ markdown: "漢".repeat(30000) }))))).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
  });
  it("cancels oversized streams even when content length is omitted", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(250001)); }, cancel }));
    await expect(readWebsite(base, source, {}, transport(response))).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("refuses advertised oversized responses before reading", async () => {
    const cancel = vi.fn(); const response = new Response(new ReadableStream({ cancel }), { headers: { "Content-Length": "500001" } });
    await expect(readWebsite(base, source, {}, transport(response))).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["TimeoutError", "AbortError", "TypeError"])("redacts transport %s", async name => {
    const fetcher = vi.fn(async () => { const error = new Error("secret-credential"); error.name = name; throw error; });
    await expect(readWebsite(base, source, {}, fetcher)).rejects.toMatchObject({ code: name === "TypeError" ? "SCRAPER_UNAVAILABLE" : "SCRAPER_TIMEOUT" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["untrusted-secret-code", "__proto__", "toString"])("does not expose arbitrary stored errors (%s)", code => {
    expect(sourceImportMessage(code)).toBe(sourceImportMessage(null));
  });
});
