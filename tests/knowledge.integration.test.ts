import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { listSources, manageSource, selfHostedScraperBase } from "../src/lib/knowledge/service";
import { runOneSourceJob } from "../src/lib/knowledge/worker";
vi.mock("../src/lib/providers/url-policy", async importOriginal => ({ ...await importOriginal<object>(), validatePublicDns: async (url: string) => new URL(url) }));
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("source ingestion boundaries", () => {
  const ids: string[] = [], users: string[] = [];
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db.organization.deleteMany({ where: { id: { in: ids } } }); await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect(); });
  async function setup() {
    const org = await db.organization.create({ data: { name: "SOURCE FIXTURE" } }); ids.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Source fixture" } });
    const user = await db.user.create({ data: { email: `source-${crypto.randomUUID()}@example.test`, name: "Source fixture", passwordHash: "not-a-login", memberships: { create: { organizationId: org.id, role: "OWNER" } } } }); users.push(user.id);
    return { organizationId: org.id, businessId: business.id, actorId: user.id };
  }
  const input = { action: "document", title: "Brand facts", text: "Solo beginners are welcome at our pottery workshops.", rightsConfirmed: true };
  it("deduplicates documents only within a business and does not silently approve facts", async () => {
    const a = await setup(), b = await setup();
    const x = await manageSource(a, input), y = await manageSource(a, input), z = await manageSource(b, input);
    expect(y).toMatchObject({ cached: true, sourceId: x.sourceId }); expect(z.sourceId).not.toBe(x.sourceId);
    expect((await db.business.findUniqueOrThrow({ where: { id: a.businessId } })).proof).toBe("");
    await expect(manageSource(b, { action: "evidence", sourceId: x.sourceId, quote: input.text })).rejects.toThrow("not found");
    await expect(manageSource(a, { action: "evidence", sourceId: x.sourceId, quote: "Invented evidence is not approved." })).rejects.toThrow("exact excerpt");
    expect(await manageSource(a, { action: "evidence", sourceId: x.sourceId, quote: input.text })).toMatchObject({ evidence: { quote: input.text } });
    await manageSource(a, { action: "delete", sourceId: x.sourceId });
    expect(await db.knowledgeSource.count({ where: { businessId: a.businessId } })).toBe(0);
  });
  it("rejects missing permission, invalid UTF-8 and oversized bytes", async () => {
    const a = await setup();
    for (const change of [{ rightsConfirmed: false }, { text: "\u0000" + input.text }, { text: "漢".repeat(10000) }]) await expect(manageSource(a, { ...input, ...change })).rejects.toThrow();
  });
  function enable() { vi.stubEnv("WEBSITE_EXTRACTION_ENABLED", "true"); vi.stubEnv("FIRECRAWL_SELF_HOSTED_URL", "http://firecrawl.railway.internal:3002"); vi.stubEnv("FIRECRAWL_EGRESS_RESTRICTED", "true"); }
  it.each(["VIEWER", "REMOVED"])("does not scrape after the requesting member becomes %s", async role => {
    enable(); const scope = await setup();
    const created = await manageSource(scope, { action: "website", url: "https://example.com", rightsConfirmed: true });
    const where = { organizationId: scope.organizationId, userId: scope.actorId };
    if (role === "REMOVED") await db.membership.deleteMany({ where });
    else await db.membership.updateMany({ where, data: { role } });
    const transport = vi.fn();
    await runOneSourceJob(transport); await runOneSourceJob(transport);
    expect(transport).not.toHaveBeenCalled();
    expect(await db.job.findUniqueOrThrow({ where: { key: `source:${created.sourceId}` } })).toMatchObject({ status: "FAILED", errorCode: "SOURCE_AUTHORITY_CHANGED", attempts: 1 });
    expect(await db.knowledgeSource.findUniqueOrThrow({ where: { id: created.sourceId } })).toMatchObject({ status: "FAILED", body: "", retrievedAt: null });
  });
  it("discards fetched content if the requesting member loses permission during the request", async () => {
    enable(); const scope = await setup(), url = "https://example.com/";
    const created = await manageSource(scope, { action: "website", url, rightsConfirmed: true });
    const transport = vi.fn(async () => {
      await db.membership.updateMany({ where: { organizationId: scope.organizationId, userId: scope.actorId }, data: { role: "VIEWER" } });
      return Response.json({ success: true, data: { markdown: input.text, metadata: { statusCode: 200, sourceURL: url, url } } });
    });
    await runOneSourceJob(transport); await runOneSourceJob(transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await db.knowledgeSource.findUniqueOrThrow({ where: { id: created.sourceId } })).toMatchObject({ status: "FAILED", body: "", retrievedAt: null });
    expect((await listSources({ businessId: scope.businessId, organizationId: scope.organizationId }))[0].failureMessage).toContain("permission");
  });
  it("rejects a changed queued URL before calling the scraper", async () => {
    enable(); const scope = await setup();
    const created = await manageSource(scope, { action: "website", url: "https://example.com", rightsConfirmed: true });
    await db.job.update({ where: { key: `source:${created.sourceId}` }, data: { payload: { sourceId: created.sourceId, url: "https://other.example/" } } });
    const transport = vi.fn();
    await runOneSourceJob(transport);
    expect(transport).not.toHaveBeenCalled();
    expect(await db.job.findUniqueOrThrow({ where: { key: `source:${created.sourceId}` } })).toMatchObject({ status: "FAILED", errorCode: "SOURCE_CONTEXT_CHANGED" });
    expect((await db.knowledgeSource.findUniqueOrThrow({ where: { id: created.sourceId } })).body).toBe("");
  });
  it.each(["url", "author", "lease"])("withholds fetched evidence after a mid-request %s change", async change => {
    enable(); const scope = await setup(), url = "https://example.com/";
    const created = await manageSource(scope, { action: "website", url, rightsConfirmed: true });
    const transport = vi.fn(async () => {
      if (change === "url") await db.knowledgeSource.update({ where: { id: created.sourceId }, data: { sourceUrl: "https://other.example/" } });
      if (change === "author") await db.knowledgeSource.update({ where: { id: created.sourceId }, data: { createdBy: "different-author" } });
      if (change === "lease") await db.job.update({ where: { key: `source:${created.sourceId}` }, data: { leaseUntil: new Date(0) } });
      return Response.json({ success: true, data: { markdown: input.text, metadata: { statusCode: 200, sourceURL: url, url } } });
    });
    await runOneSourceJob(transport); await runOneSourceJob(transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await db.knowledgeSource.findUniqueOrThrow({ where: { id: created.sourceId } })).toMatchObject({ status: "FAILED", body: "", retrievedAt: null });
    expect(await db.job.findUniqueOrThrow({ where: { key: `source:${created.sourceId}` } })).toMatchObject({ status: "FAILED", attempts: 1 });
  });
  it("cannot fetch or fail another tenant's source through a swapped payload", async () => {
    enable(); const a = await setup(), b = await setup();
    const one = await manageSource(a, { action: "website", url: "https://example.com/", rightsConfirmed: true });
    const two = await manageSource(b, input);
    const before = await db.knowledgeSource.findUniqueOrThrow({ where: { id: two.sourceId } });
    await db.job.update({ where: { key: `source:${one.sourceId}` }, data: { payload: { sourceId: two.sourceId, url: "https://example.com/" } } });
    const transport = vi.fn(); await runOneSourceJob(transport);
    expect(transport).not.toHaveBeenCalled();
    expect(await db.knowledgeSource.findUniqueOrThrow({ where: { id: two.sourceId } })).toEqual(before);
    expect(await db.knowledgeSource.findUniqueOrThrow({ where: { id: one.sourceId } })).toMatchObject({ status: "FAILED", body: "" });
    expect(await db.job.findUniqueOrThrow({ where: { key: `source:${one.sourceId}` } })).toMatchObject({ status: "FAILED" });
  });
  it("does not overwrite already retained evidence during stale-job recovery", async () => {
    enable(); const scope = await setup();
    const created = await manageSource(scope, { action: "website", url: "https://example.com/", rightsConfirmed: true });
    await db.job.update({ where: { key: `source:${created.sourceId}` }, data: { status: "RUNNING", leaseUntil: new Date(0) } });
    const retained = await db.knowledgeSource.update({ where: { id: created.sourceId }, data: { status: "PROPOSED", body: input.text, retrievedAt: new Date() } });
    const transport = vi.fn(); await runOneSourceJob(transport);
    expect(transport).not.toHaveBeenCalled();
    expect(await db.knowledgeSource.findUniqueOrThrow({ where: { id: created.sourceId } })).toEqual(retained);
    expect(await db.job.findUniqueOrThrow({ where: { key: `source:${created.sourceId}` } })).toMatchObject({ status: "FAILED", errorCode: "IMPORT_INTERRUPTED" });
  });
  it("fails closed unless private configuration and isolation are explicitly enabled", () => {
    vi.stubEnv("WEBSITE_EXTRACTION_ENABLED", "false"); expect(() => selfHostedScraperBase()).toThrow("not configured");
    enable(); vi.stubEnv("FIRECRAWL_EGRESS_RESTRICTED", "false"); expect(() => selfHostedScraperBase()).toThrow("isolation");
    vi.stubEnv("FIRECRAWL_EGRESS_RESTRICTED", "true"); vi.stubEnv("FIRECRAWL_SELF_HOSTED_URL", "https://api.firecrawl.dev"); expect(() => selfHostedScraperBase()).toThrow("private");
  });
  it("queues once, requests markdown only and reuses results without another fetch", async () => {
    enable(); const scope = await setup(); const request = { action: "website", url: "https://example.com/about", rightsConfirmed: true };
    const first = await manageSource(scope, request); expect(await manageSource(scope, request)).toMatchObject({ sourceId: first.sourceId, cached: true });
    const transport = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ formats: ["markdown"], maxAge: 604800000 });
      return Response.json({ success: true, data: { markdown: input.text, metadata: { statusCode: 200, sourceURL: request.url, url: request.url, title: "About" } } });
    }) as unknown as typeof fetch;
    await runOneSourceJob(transport); await runOneSourceJob(transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await manageSource(scope, request)).toMatchObject({ cached: true });
    expect((await db.knowledgeSource.findUniqueOrThrow({ where: { id: first.sourceId } })).status).toBe("PROPOSED");
  });
  it("preserves queued work when operator credentials are malformed", async () => {
    enable(); const scope = await setup();
    const created = await manageSource(scope, { action: "website", url: "https://example.com", rightsConfirmed: true });
    vi.stubEnv("FIRECRAWL_API_KEY", "unsafe\ncredential");
    const fetcher = vi.fn(); await expect(runOneSourceJob(fetcher)).rejects.toThrow("scraper connection");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await db.job.findUnique({ where: { key: `source:${created.sourceId}` } })).toMatchObject({ status: "QUEUED", attempts: 0 });
    // Remove only this unsubmitted fixture job so the next test's global queue is independent.
    await db.job.delete({ where: { key: `source:${created.sourceId}` } });
  });
  it("records actionable redacted failures without retrying or crossing tenant boundaries", async () => {
    enable(); vi.stubEnv("FIRECRAWL_API_KEY", "private-test-key"); const scope = await setup(), other = await setup();
    const created = await manageSource(scope, { action: "website", url: "https://example.com", rightsConfirmed: true });
    const fetcher = vi.fn(async (_url, init) => { expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-test-key"); return new Response("private-test-key", { status: 401 }); });
    await runOneSourceJob(fetcher); await runOneSourceJob(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await db.job.findUnique({ where: { key: `source:${created.sourceId}` } })).toMatchObject({ status: "FAILED", attempts: 1, errorCode: "SCRAPER_AUTH_REQUIRED" });
    const sources = await listSources({ businessId: scope.businessId, organizationId: scope.organizationId });
    expect(sources[0]).toMatchObject({ status: "FAILED", body: "", failureMessage: expect.stringContaining("administrator") });
    expect(JSON.stringify(sources)).not.toContain("private-test-key");
    expect(await listSources({ businessId: scope.businessId, organizationId: other.organizationId })).toEqual([]);
  });
  it("never stores redirected third-party content as business evidence", async () => {
    enable(); const scope = await setup(); const url = "https://example.com";
    const created = await manageSource(scope, { action: "website", url, rightsConfirmed: true });
    const fetcher = vi.fn(async () => Response.json({ success: true, data: { markdown: input.text,
      metadata: { statusCode: 200, sourceURL: url, url: "https://other.example/" } } }));
    await runOneSourceJob(fetcher); await runOneSourceJob(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await db.job.findUnique({ where: { key: `source:${created.sourceId}` } })).toMatchObject({ status: "FAILED", errorCode: "SOURCE_REDIRECT_CHANGED", attempts: 1 });
    expect(await db.knowledgeSource.findUniqueOrThrow({ where: { id: created.sourceId } })).toMatchObject({ status: "FAILED", body: "", retrievedAt: null });
    expect((await db.business.findUniqueOrThrow({ where: { id: scope.businessId } })).proof).toBe("");
  });
});
