import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $queryRaw: query } }));
import { GET } from "../src/app/api/health/route";

describe("deployment readiness", () => {
  beforeEach(() => { query.mockReset(); vi.stubEnv("RECOVERY_QUARANTINE", undefined); });
  afterEach(() => vi.unstubAllEnvs());
  it("does not inspect the database while quarantined, even when called directly", async () => {
    vi.stubEnv("RECOVERY_QUARANTINE", "true");
    expect((await GET()).status).toBe(503);
    expect(query).not.toHaveBeenCalled();
  });
  it("checks application tables before declaring readiness", async () => {
    query.mockResolvedValue([]);
    const result = await GET();
    expect(result.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(47);
    const sql = query.mock.calls.map(call => String(call[0])).join("\n");
    expect(sql).toContain("requireMfa");
    expect(sql).toContain("setupDetails");
    expect(sql).toContain("knowledgeContext");
    expect(sql).toContain("revisionRequests");
    expect(sql).toContain("WeeklyVideoShot");
    expect(sql).toContain("videosAfterApproval");
    expect(sql).toContain("videoLeaseUntil");
    for (const column of ["imagesAfterApproval", "mediaStatus", "mediaLeaseUntil", "nextMediaAt", "imageStatus", "imageGenerationId"]) expect(sql).toContain(column);
    expect(sql).toContain("metricsInvalidatedAt");
    expect(sql).toContain("metricsRequestedAt");
    expect(sql).toContain("authorizationVersion");
    for (const column of ["mediaTransferVersion", "mediaExternalId", "mediaUploaded"]) expect(sql).toContain(column);
    expect(sql).toContain("creativeBrief"); expect(sql).toContain("revisionOfId");
    expect(sql).toContain("reconciliationAttempts"); expect(sql).toContain("nextReconciliationAt");
    expect(sql).toContain("VideoGeneration"); expect(sql).toContain("providerJobKey"); expect(sql).toContain("settledAt");
    for (const table of ["IdentityToken", "EmailOutbox", "KnowledgeSource", "SocialConnection", "SocialPublication", "MetricSnapshot", "LearningProposal", "StaticComposition", "TeamInvitation", "TeamEvent"]) expect(sql).toContain(table);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  });
  it("fails closed when the initial schema is missing", async () => {
    query.mockRejectedValue(new Error("User table missing"));
    const result = await GET();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ status: "unavailable" });
  });
  it("fails closed when only part of the schema exists", async () => {
    query.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("RateLimit table missing"));
    expect((await GET()).status).toBe(503);
  });
  it("refuses readiness when the weekly pause migration is missing", async () => {
    query.mockImplementation(async (sql: TemplateStringsArray) => {
      if (String(sql).includes('"pauseReason"')) throw new Error("column missing: private database detail");
      return [];
    });
    const result = await GET();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ status: "unavailable" });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  });
  it("stops at every failed schema probe without reading records or exposing diagnostics", async () => {
    query.mockResolvedValue([]);
    await GET();
    const probes = query.mock.calls.map(call => String(call[0]));
    for (const sql of probes) expect(sql).toMatch(/^SELECT .+ FROM "[A-Za-z]+" LIMIT 0$/);
    for (let index = 0; index < probes.length; index++) {
      query.mockReset();
      let calls = 0;
      query.mockImplementation(async () => {
        if (calls++ === index) throw new Error("private database detail");
        return [];
      });
      const result = await GET();
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ status: "unavailable" });
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(query).toHaveBeenCalledTimes(index + 1);
    }
  });
});
