import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { procedureOutcomes } from "../src/lib/harness/procedure-outcomes";
import { graphSnapshot } from "../src/lib/harness/knowledge-graph";
import { hashProcedure, procedureText } from "../src/lib/harness/procedure-evidence";

const scope = { organizationId: "org", businessId: "business", actorId: "reviewer" };
const now = new Date("2026-10-20T12:00:00Z");
function fixture(task: "copy" | "image" | "video" = "copy") {
  const candidate = { channel: "LinkedIn", task, scenario: "Presenting design work", instruction: "Use a concrete opening detail.", limitation: "Only confirmed business facts.", reviewCheck: "Check the opening for specificity.", examples: ["a", "b"].map(id => ({ id, feedbackQuote: "Be specific", approvedQuote: "Consider the details" })) };
  const evidence = { kind: "CREATIVE_PROCEDURE_V1", analysisId: "analysis", candidate, sources: ["a", "b"].map(id => ({ id, beforeId: `before-${id}`, itemId: `source-${id}`, fingerprint: "a".repeat(64) })) };
  const p = { id: "proposal", hypothesis: procedureText(candidate as Parameters<typeof procedureText>[0]), evidence, createdAt: new Date("2026-10-19T12:00:00Z"), brandVersion: 1 };
  const root = "business:business:1", memory = "memory:lesson", eid = `evidence:${p.id}:${hashProcedure(evidence)}`;
  const body = { version: 1, organizationId: scope.organizationId, businessId: scope.businessId, brandVersion: 1, task, channel: "LinkedIn", assetIds: [], nodes: [{ id: root, kind: "business", text: "Design practice" }, { id: memory, kind: "skill", text: p.hypothesis }, { id: eid, kind: "evidence", text: "Reviewed corrections" }], edges: [{ from: root, to: memory, relation: "USES_SKILL" }, { from: memory, to: eid, relation: "SUPPORTED_BY" }], omitted: 0 };
  const snapshot = graphSnapshot.parse({ ...body, fingerprint: hashProcedure(body) });
  const common = { id: "delivered", itemId: "new-item", createdAt: new Date("2026-10-20T10:00:00Z"), status: "READY", approvedBy: null, approvedAt: null, brandVersion: 1, knowledgeContext: snapshot, provenance: { kind: "AI_COPY", providerResponseId: "receipt", knowledgeContext: snapshot }, item: { channel: "LinkedIn", plan: { brandVersion: 1 } }, output: { status: "READY", approvedForGeneration: false, approvedBy: null, purgeAfter: new Date("2026-11-01") } };
  const tx = { creativeRevision: { findMany: vi.fn().mockResolvedValue(task === "copy" ? [common] : []) }, imageGeneration: { findMany: vi.fn().mockResolvedValue(task === "image" ? [common] : []) }, videoGeneration: { findMany: vi.fn().mockResolvedValue(task === "video" ? [common] : []) }, productionItem: { findMany: vi.fn().mockResolvedValue([{ id: "new-item", channel: "LinkedIn" }]) } };
  const run = () => procedureOutcomes(tx as unknown as Prisma.TransactionClient, scope, [p], now);
  return { p, snapshot, common, tx, run };
}

describe("evidence-linked procedure outcomes", () => {
  it.each(["copy", "image", "video"] as const)("counts only delivered %s outputs linked to exact lesson evidence", async task => {
    const f = fixture(task), result = await f.run();
    expect(result.totals.proposal).toEqual({ delivered: 1, distinctCreatives: 1, approved: 0, changesRequested: 0, rejected: 0, awaitingReview: 1, replacedOrUnavailable: 0 });
    expect(JSON.stringify(result)).not.toContain("Design practice");
    expect(f.tx.creativeRevision.findMany.mock.calls[0][0]).toMatchObject({ where: { organizationId: "org", item: { plan: { businessId: "business", organizationId: "org" } }, provenance: { path: ["kind"], equals: "AI_COPY" }, createdAt: { lte: now } }, take: 201 });
    expect(f.tx.imageGeneration.findMany.mock.calls[0][0]).toMatchObject({ where: { businessId: "business", organizationId: "org", providerResponseId: { not: null } } });
    expect(f.tx.videoGeneration.findMany.mock.calls[0][0]).toMatchObject({ where: { businessId: "business", organizationId: "org", status: "READY", settledAt: { not: null }, providerJobId: { not: null } } });
  });
  it("counts current review states, not approval history, and distinct creatives separately", async () => {
    const f = fixture();
    f.tx.creativeRevision.findMany.mockResolvedValue(["APPROVED", "CHANGES_REQUESTED", "REJECTED", "READY", "SUPERSEDED"].map((status, i) => ({ ...f.common, id: `revision-${i}`, status, approvedBy: "reviewer", approvedAt: now })));
    expect((await f.run()).totals.proposal).toEqual({ delivered: 5, distinctCreatives: 1, approved: 1, changesRequested: 1, rejected: 1, awaitingReview: 1, replacedOrUnavailable: 1 });
  });
  it.each(["image", "video"] as const)("requires retained approved %s output, not just a generation status", async task => {
    const f = fixture(task);
    Object.assign(f.common, { status: task === "image" ? "APPROVED" : "READY", approvedBy: "reviewer" });
    Object.assign(f.common.output, { status: task === "image" ? "READY" : "APPROVED", approvedForGeneration: true, approvedBy: "reviewer" });
    expect((await f.run()).totals.proposal.approved).toBe(1);
    Object.assign(f.common.output, task === "image" ? { status: "DELETED" } : { purgeAfter: now });
    expect((await f.run()).totals.proposal.replacedOrUnavailable).toBe(1);
  });
  it.each(["organizationId", "businessId", "brandVersion", "task", "channel"] as const)("rejects a correctly hashed but wrong %s context", async field => {
    const f = fixture(); Object.assign(f.snapshot, { [field]: field === "brandVersion" ? 2 : field === "task" ? "image" : "other" });
    const { fingerprint: _, ...body } = f.snapshot; f.snapshot.fingerprint = hashProcedure(body);
    expect((await f.run()).totals.proposal.delivered).toBe(0);
  });
  it.each(["hash", "evidence", "instruction", "link", "source", "older", "receipt"])("excludes %s mismatch or non-independent work", async kind => {
    const f = fixture();
    if (kind === "hash") f.snapshot.fingerprint = "0".repeat(64);
    if (kind === "evidence") f.snapshot.nodes[2].id = "wrong-evidence";
    if (kind === "instruction") f.snapshot.nodes[1].text = "A different lesson";
    if (kind === "link") f.snapshot.edges = [];
    if (kind === "source") f.common.itemId = "source-a";
    if (kind === "older") f.common.createdAt = new Date("2026-10-18");
    if (kind === "receipt") f.common.provenance.providerResponseId = "";
    if (["evidence", "instruction", "link"].includes(kind)) { const { fingerprint: _, ...body } = f.snapshot; f.snapshot.fingerprint = hashProcedure(body); }
    expect((await f.run()).totals.proposal.delivered).toBe(0);
  });
  it("bounds reads and labels the latest-output sample", async () => {
    const f = fixture(); f.tx.creativeRevision.findMany.mockResolvedValue(Array.from({ length: 201 }, (_, i) => ({ ...f.common, id: `revision-${i}` })));
    const result = await f.run(); expect(result.sampled).toBe(true); expect(result.totals.proposal.delivered).toBe(200);
  });
  it("does not query output history when there are no proposals", async () => {
    const f = fixture(); expect((await procedureOutcomes(f.tx as unknown as Prisma.TransactionClient, scope, [], now)).totals).toEqual({}); expect(f.tx.creativeRevision.findMany).not.toHaveBeenCalled();
  });
});
