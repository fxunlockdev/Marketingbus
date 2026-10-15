import { beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $queryRaw: query } }));
import { GET } from "../src/app/api/health/route";

describe("deployment readiness", () => {
  beforeEach(() => { query.mockReset(); });
  it("checks application tables before declaring readiness", async () => {
    query.mockResolvedValue([]);
    const result = await GET();
    expect(result.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(38);
    const sql = query.mock.calls.map(call => String(call[0])).join("\n");
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
});
