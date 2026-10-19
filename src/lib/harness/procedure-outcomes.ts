import type { Prisma } from "@prisma/client";
import type { Scope } from "../production/service";
import { graphSnapshot } from "./knowledge-graph";
import { hashProcedure, procedureEvidence } from "./procedure-evidence";

type Proposal = { id: string; hypothesis: string; evidence: unknown; createdAt: Date; brandVersion: number };
type Outcome = "approved" | "changesRequested" | "rejected" | "awaitingReview" | "replacedOrUnavailable";
export type ProcedureOutcomes = Record<Outcome, number> & { delivered: number; distinctCreatives: number };
const empty = (): ProcedureOutcomes => ({ delivered: 0, distinctCreatives: 0, approved: 0, changesRequested: 0, rejected: 0, awaitingReview: 0, replacedOrUnavailable: 0 });
type Observation = { id: string; itemId: string; channel: string; brandVersion: number; task: "copy" | "image" | "video"; snapshot: unknown; createdAt: Date; outcome: Outcome };

/** Retained delivered outputs only. A prompt exposure is not compliance or causal improvement.
 * The caller must authorize membership before invoking this tenant-scoped projection.
 * No raw captions, prompts, feedback, account identifiers or media URLs are returned.
 */
export async function procedureOutcomes(tx: Prisma.TransactionClient, scope: Scope, proposals: Proposal[], now = new Date()) {
  const totals = Object.fromEntries(proposals.map(p => [p.id, empty()]));
  const since = new Date(now.getTime() - 90 * 86400000), limit = 200;
  if (!proposals.length) return { totals, since: since.toISOString(), sampled: false };
  const [copy, images, videos] = await Promise.all([
    tx.creativeRevision.findMany({ where: { organizationId: scope.organizationId, item: { plan: { businessId: scope.businessId, organizationId: scope.organizationId } }, createdAt: { gte: since, lte: now }, provenance: { path: ["kind"], equals: "AI_COPY" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: { id: true, itemId: true, createdAt: true, status: true, approvedBy: true, approvedAt: true, provenance: true, item: { select: { channel: true, plan: { select: { brandVersion: true } } } } } }),
    tx.imageGeneration.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, createdAt: { gte: since, lte: now }, providerResponseId: { not: null }, status: { in: ["READY", "APPROVED", "REJECTED", "SUPERSEDED"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: { id: true, itemId: true, createdAt: true, brandVersion: true, knowledgeContext: true, status: true, approvedBy: true, item: { select: { channel: true } }, output: { select: { status: true, approvedForGeneration: true } } } }),
    tx.videoGeneration.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, createdAt: { gte: since, lte: now }, providerJobId: { not: null }, status: "READY", settledAt: { not: null } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: { id: true, itemId: true, createdAt: true, brandVersion: true, knowledgeContext: true, output: { select: { status: true, approvedBy: true, purgeAfter: true } } } }),
  ]);
  // Video jobs have a scoped business relationship but no item relation in the schema.
  const videoItems = await tx.productionItem.findMany({ where: { id: { in: videos.slice(0, limit).map(v => v.itemId) }, organizationId: scope.organizationId, plan: { businessId: scope.businessId, organizationId: scope.organizationId } }, select: { id: true, channel: true } });
  const observations: Observation[] = [];
  for (const r of copy.slice(0, limit)) {
    const provenance = r.provenance as Record<string, unknown> | null;
    if (!provenance || typeof provenance.providerResponseId !== "string" || !provenance.providerResponseId) continue;
    observations.push({ id: r.id, itemId: r.itemId, channel: r.item.channel, brandVersion: r.item.plan.brandVersion, task: "copy", snapshot: provenance.knowledgeContext, createdAt: r.createdAt,
      outcome: r.status === "APPROVED" && !!r.approvedBy && !!r.approvedAt && r.approvedAt >= r.createdAt && r.approvedAt <= now ? "approved" : r.status === "CHANGES_REQUESTED" ? "changesRequested" : r.status === "REJECTED" ? "rejected" : r.status === "READY" ? "awaitingReview" : "replacedOrUnavailable" });
  }
  for (const r of images.slice(0, limit)) observations.push({ id: r.id, itemId: r.itemId, channel: r.item.channel, brandVersion: r.brandVersion, task: "image", snapshot: r.knowledgeContext, createdAt: r.createdAt,
    outcome: r.output?.status !== "READY" ? "replacedOrUnavailable" : r.status === "APPROVED" && r.approvedBy && r.output.approvedForGeneration ? "approved" : r.status === "REJECTED" ? "rejected" : r.status === "READY" ? "awaitingReview" : "replacedOrUnavailable" });
  for (const r of videos.slice(0, limit)) {
    const item = videoItems.find(i => i.id === r.itemId); if (!item) continue;
    observations.push({ id: r.id, itemId: r.itemId, channel: item.channel, brandVersion: r.brandVersion, task: "video", snapshot: r.knowledgeContext, createdAt: r.createdAt,
      outcome: !r.output || r.output.purgeAfter <= now ? "replacedOrUnavailable" : r.output.status === "APPROVED" && r.output.approvedBy ? "approved" : r.output.status === "REJECTED" ? "rejected" : r.output.status === "READY" ? "awaitingReview" : "replacedOrUnavailable" });
  }
  for (const p of proposals) {
    const evidence = procedureEvidence.safeParse(p.evidence); if (!evidence.success) continue;
    const c = evidence.data.candidate, evidenceId = `evidence:${p.id}:${hashProcedure(p.evidence)}`, items = new Set<string>();
    for (const o of observations) {
      if (o.createdAt < p.createdAt || o.brandVersion !== p.brandVersion || o.task !== c.task || o.channel !== c.channel || evidence.data.sources.some(s => s.itemId === o.itemId)) continue;
      const parsed = graphSnapshot.safeParse(o.snapshot); if (!parsed.success) continue;
      const { fingerprint, ...body } = parsed.data;
      if (hashProcedure(body) !== fingerprint || body.businessId !== scope.businessId || body.organizationId !== scope.organizationId || body.brandVersion !== o.brandVersion || body.task !== o.task || body.channel !== o.channel) continue;
      const root = `business:${scope.businessId}:${o.brandVersion}`;
      const matching = body.nodes.filter(n => n.kind === "skill" && n.text === p.hypothesis).some(n => body.edges.some(e => e.from === root && e.to === n.id && e.relation === "USES_SKILL") && body.edges.some(e => e.from === n.id && e.to === evidenceId && e.relation === "SUPPORTED_BY") && body.nodes.some(e => e.id === evidenceId && e.kind === "evidence"));
      if (!matching) continue;
      totals[p.id].delivered++; totals[p.id][o.outcome]++; items.add(o.itemId);
    }
    totals[p.id].distinctCreatives = items.size;
  }
  return { totals, since: since.toISOString(), sampled: [copy, images, videos].some(rows => rows.length > limit) };
}
