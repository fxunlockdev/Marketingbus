import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coreEnvironment, createCoreGateway, runCoreJob } from "../scripts/firecrawl/core-gateway.mjs";
import { readWebsite } from "../src/lib/knowledge/scraper-client";
vi.mock("../src/lib/providers/url-policy", async importOriginal => {
  const original = await importOriginal<typeof import("../src/lib/providers/url-policy")>();
  return { ...original, validatePublicDns: async (input: string) => original.publicUrl(input) };
});
const token = "local-private-gateway-fixture-credential";
const config = { coreRoot: process.cwd(), browserUrl: "http://browser:3003/scrape", browserToken: "local-private-browser-fixture-credential", redisUrl: "redis://redis:6379" };
const environment = coreEnvironment(config);
const input = { url: "https://example.com/", formats: ["markdown"], onlyMainContent: true, timeout: 30000, maxAge: 604800000 };
const data = { markdown: "Our company makes ceramics using local clay in our studio.", metadata: { url: input.url, sourceURL: input.url, statusCode: 200, title: "Our studio" } };
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
async function fixture(run: () => Promise<unknown> = vi.fn(async () => ({ success: true, data }))) {
  const server = createCoreGateway({ token, environment, run });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); cleanups.push(() => server.shutdown());
  const address = server.address(); if (!address || typeof address === "string") throw Error("Missing address");
  const url = `http://127.0.0.1:${address.port}/v2/scrape`;
  return { url, post: (body: unknown) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }) };
}
describe("private standalone Firecrawl gateway", () => {
  it("builds a fixed environment without inherited application or supplier secrets", () => {
    vi.stubEnv("OPENAI_API_KEY", "must-not-inherit"); vi.stubEnv("DATABASE_URL", "must-not-inherit"); vi.stubEnv("NODE_OPTIONS", "must-not-inherit");
    expect(coreEnvironment(config)).not.toHaveProperty("OPENAI_API_KEY"); expect(coreEnvironment(config)).not.toHaveProperty("DATABASE_URL");
    expect(coreEnvironment(config)).not.toHaveProperty("NODE_OPTIONS"); expect(coreEnvironment(config)).toHaveProperty("ALLOW_LOCAL_WEBHOOKS", "false");
  });
  it.each([{ browserUrl: "https://external.example/scrape" }, { browserUrl: "http://browser:3003/" }, { redisUrl: "redis://external.example:6379" }, { browserToken: "short" }])("rejects unsafe operator configuration (%#)", patch => {
    expect(() => coreEnvironment({ ...config, ...patch })).toThrow();
  });
  it("requires auth without starting any extraction", async () => {
    const run = vi.fn(); const { url } = await fixture(run);
    expect((await fetch(url, { method: "POST" })).status).toBe(401); expect(run).not.toHaveBeenCalled();
  });
  it.each([{}, { ...input, url: "https://127.0.0.1" }, { ...input, formats: ["extract"] }, { ...input, onlyMainContent: false },
    { ...input, timeout: 60000 }, { ...input, actions: ["click"] }, { ...input, maxAge: -1 }])("rejects invalid or expanded customer work (%#)", async body => {
    const run = vi.fn(); const { post } = await fixture(run);
    expect((await post(body)).status).toBe(400); expect(run).not.toHaveBeenCalled();
  });
  it("exposes only bounded markdown and verified final-address metadata", async () => {
    const run = vi.fn(async () => ({ success: true, data: { ...data, debug: "never return", metadata: { ...data.metadata, headers: { secret: "never return" } } }, extra: "never return" }));
    const { post } = await fixture(run); const response = await post(input);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true, data });
    expect(run).toHaveBeenCalledWith({ url: input.url, timeout: 30000 }, { environment });
  });
  it("is accepted by the application's actual website client over HTTP", async () => {
    const { url } = await fixture();
    expect(await readWebsite(new URL("/", url), input.url, { "Content-Type": "application/json", Authorization: `Bearer ${token}` })).toEqual(data);
  });
  it("the application recognizes gateway authentication and extraction failures", async () => {
    const { url } = await fixture(vi.fn().mockRejectedValue(Error("private detail")));
    await expect(readWebsite(new URL("/", url), input.url, { "Content-Type": "application/json" })).rejects.toMatchObject({ code: "SCRAPER_AUTH_REQUIRED" });
    await expect(readWebsite(new URL("/", url), input.url, { "Content-Type": "application/json", Authorization: `Bearer ${token}` })).rejects.toMatchObject({ code: "SCRAPER_UNAVAILABLE" });
  });
  it.each([{ ...data, metadata: { ...data.metadata, url: "https://other.example/" } }, { ...data, metadata: { ...data.metadata, url: undefined } },
    { ...data, metadata: { ...data.metadata, sourceURL: "https://other.example/" } }, { ...data, metadata: { ...data.metadata, statusCode: 403 } },
    { ...data, markdown: "x".repeat(80001) }, { ...data, markdown: "\u0000" + data.markdown }])("does not accept invalid child evidence (%#)", async result => {
    const { post } = await fixture(vi.fn(async () => ({ success: true, data: result })));
    const response = await post(input); expect(response.status).toBe(502); expect(await response.json()).toEqual({ success: false });
  });
  it("redacts engine errors and reports timeouts without retrying", async () => {
    const run = vi.fn().mockRejectedValueOnce(Error("secret engine error")).mockRejectedValueOnce(Error("timeout")); const { post } = await fixture(run);
    const response = await post(input); expect(response.status).toBe(502); expect(await response.json()).toEqual({ success: false });
    expect((await post(input)).status).toBe(504); expect(run).toHaveBeenCalledTimes(2);
  });
  it("does not create a parallel child while one job is active", async () => {
    let release!: () => void;
    const run = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { success: true, data }; });
    const { post } = await fixture(run); const first = post(input);
    await vi.waitFor(() => expect(run).toHaveBeenCalled()); expect((await post(input)).status).toBe(503);
    release(); expect((await first).status).toBe(200); expect(run).toHaveBeenCalledTimes(1);
  });
  it("runs a real bounded child with only the allowlisted environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "must-not-inherit"); vi.stubEnv("DATABASE_URL", "must-not-inherit");
    const result = await runCoreJob({ url: input.url }, { environment, entry: fileURLToPath(new URL("./fixtures/scraper-core-child.cjs", import.meta.url)) }) as { environment: string[] };
    expect(result.environment).not.toContain("OPENAI_API_KEY"); expect(result.environment).not.toContain("DATABASE_URL");
    expect(result.environment).toContain("PLAYWRIGHT_MICROSERVICE_TOKEN");
  });
  it.each(["duplicate", "oversized", "failed"])("fails closed for a child that returns %s", async url => {
    await expect(runCoreJob({ url }, { environment, entry: fileURLToPath(new URL("./fixtures/scraper-core-child.cjs", import.meta.url)) })).rejects.toThrow("engine unavailable");
  });
  it("kills a real stalled child at the job deadline", async () => {
    await expect(runCoreJob({ url: "hang" }, { environment, entry: fileURLToPath(new URL("./fixtures/scraper-core-child.cjs", import.meta.url)), deadlineMs: 100 })).rejects.toThrow("timeout");
  });
  it("the actual wrapper selects only bounded basic-proxy scraping with TLS verification", async () => {
    const environment = coreEnvironment({ ...config, coreRoot: fileURLToPath(new URL("./fixtures/firecrawl-core/", import.meta.url)) });
    const result = await runCoreJob({ url: input.url, timeout: 1000 }, { environment });
    expect(result).toEqual({ success: true, data: { markdown: "The actual child wrapper enforced the bounded, certificate-verified browser profile.",
      metadata: { url: input.url, sourceURL: input.url, statusCode: 200, title: "Private fixture" } } });
  });
});
