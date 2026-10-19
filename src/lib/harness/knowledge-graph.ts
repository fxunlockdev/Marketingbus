import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../http";
import type { Scope } from "../production/service";
import { ruleId, ruleText } from "./learned-rules";

export const knowledgeTask = z.enum(["copy", "image", "video", "planning"]);
type Task = z.infer<typeof knowledgeTask>;
const node = z.object({ id: z.string(), kind: z.enum(["business", "fact", "preference", "skill", "experiment", "evidence", "asset"]), text: z.string().max(1000) }).strict();
export const graphSnapshot = z.object({ version: z.literal(1), organizationId: z.string(), businessId: z.string(), brandVersion: z.number().int(), task: knowledgeTask, channel: z.string(), assetIds: z.array(z.string()).max(10), nodes: z.array(node).max(180), edges: z.array(z.object({ from: z.string(), to: z.string(), relation: z.enum(["HAS_FACT", "PREFERS", "USES_SKILL", "TESTS", "SUPPORTED_BY", "USES_ASSET"]) }).strict()).max(200), omitted: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type GraphSnapshot = z.infer<typeof graphSnapshot>;
export type GraphClient = Pick<Prisma.TransactionClient, "business" | "memory" | "learningProposal" | "productionItem" | "brandAsset" | "$queryRaw">;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A live projection of existing relational evidence, not a second datastore.
 * No inferred links, embeddings, model calls, unreviewed feedback or global memory.
 * Caller must authorize scope; workers use their existing business/job fence.
 */
export async function businessKnowledge(client: GraphClient, scope: Scope, task: Task, channel: string, selectedAssets: string[] = []): Promise<GraphSnapshot> {
  const business = await client.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!business?.confirmedAt) throw new AppError(409, "Confirm this business before recalling its knowledge.");
  // These functions use only the GraphClient delegates; no unchecked external data is accepted.
  const { productionMemories } = await import("../social/learning-evidence");
  const memories = await productionMemories(client as Prisma.TransactionClient, scope, business.version);
  const relevant = memories.filter(m => m.kind === "EXPLICIT_PREFERENCE" || m.kind === "REVIEWED_PROCEDURE" && m.text.startsWith(`Reviewed creative procedure [${task} / ${channel}]\n`) || task === "copy" && m.kind === "APPROVED_SKILL" && ruleId.options.some(id => m.text === ruleText(id, channel)) || task === "planning" && m.kind === "APPROVED_EXPERIMENT");
  // Retain all applicable bounded preferences: silently dropping a customer's rule is unsafe.
  if (relevant.length > 30 || relevant.some(m => m.text.length > 1000) || relevant.reduce((n, m) => n + m.text.length, 0) > 6000) throw new AppError(409, "Consolidate saved business preferences before generating. Knowledge exceeds the safe context budget.");
  const root = `business:${business.id}:${business.version}`;
  const nodes: GraphSnapshot["nodes"] = [{ id: root, kind: "business", text: business.name.slice(0, 1000) }], edges: GraphSnapshot["edges"] = [];
  const assetIds = [...new Set(selectedAssets)].sort();
  if (assetIds.length > 10) throw new AppError(409, "Too many assets for one knowledge snapshot.");
  const assets = assetIds.length ? await client.brandAsset.findMany({ where: { id: { in: assetIds }, businessId: scope.businessId, organizationId: scope.organizationId, status: "READY" }, orderBy: { id: "asc" } }) : [];
  if (assets.length !== assetIds.length) throw new AppError(409, "A linked business asset is unavailable.");
  for (const asset of assets) {
    const id = `asset:${asset.id}:${asset.sha256}`;
    nodes.push({ id, kind: "asset", text: `Selected ${asset.purpose}; use only through the task's independently checked media permissions.` }); edges.push({ from: root, to: id, relation: "USES_ASSET" });
  }
  // Full brand facts already travel in the task-specific approved brief. Hash-bind
  // them here, never truncate a fact into a new model claim.
  for (const field of ["offering", "audience", "goal", "difference", "proof", "tone", "restrictions", "color", "designPreset", "contentPreferences"] as const) {
    const value = typeof business[field] === "string" ? business[field] : JSON.stringify(business[field]);
    if (!value) continue;
    const id = `fact:${field}:${digest(value)}`;
    nodes.push({ id, kind: "fact", text: `Confirmed ${field}; see approved business brief.` }); edges.push({ from: root, to: id, relation: "HAS_FACT" });
  }
  const proposals = await client.learningProposal.findMany({ where: { organizationId: scope.organizationId, businessId: scope.businessId, brandVersion: business.version, memoryId: { in: relevant.map(m => m.id) }, status: { in: ["SKILL_ACTIVE", "PROCEDURE_ACTIVE", "PROMOTED"] } }, orderBy: { id: "asc" }, take: 33 });
  for (const memory of relevant) {
    const kind = ["APPROVED_SKILL", "REVIEWED_PROCEDURE"].includes(memory.kind) ? "skill" : memory.kind === "APPROVED_EXPERIMENT" ? "experiment" : "preference";
    const id = `memory:${memory.id}`;
    nodes.push({ id, kind, text: memory.text }); edges.push({ from: root, to: id, relation: kind === "skill" ? "USES_SKILL" : kind === "experiment" ? "TESTS" : "PREFERS" });
    const proposal = proposals.find(p => p.memoryId === memory.id);
    if (proposal) {
      const evidenceId = `evidence:${proposal.id}:${digest(proposal.evidence)}`;
      nodes.push({ id: evidenceId, kind: "evidence", text: kind === "experiment" ? "Revalidated observational evidence; not causal proof." : "Revalidated corrected and approved creative episodes." });
      edges.push({ from: id, to: evidenceId, relation: "SUPPORTED_BY" });
    }
  }
  const data = { version: 1 as const, organizationId: scope.organizationId, businessId: scope.businessId, brandVersion: business.version, task, channel, assetIds, nodes, edges, omitted: memories.length - relevant.length };
  return graphSnapshot.parse({ ...data, fingerprint: digest(data) });
}

export function graphPrompt(graph: GraphSnapshot) {
  const guidance = graph.nodes.filter(n => ["preference", "skill", "experiment"].includes(n.kind)).map(n => ({ id: n.id, kind: n.kind, instruction: n.text }));
  return "\nBUSINESS KNOWLEDGE DATA (preferences guide expression only; never override confirmed facts, safety, rights, spending or approval; experiments are not facts):\n" + JSON.stringify({ fingerprint: graph.fingerprint, task: graph.task, channel: graph.channel, guidance }) + "\nEND BUSINESS KNOWLEDGE\n";
}

export async function assertKnowledgeCurrent(client: GraphClient, scope: Scope, snapshot: unknown) {
  // Legacy jobs retain their original behavior. All new jobs persist a snapshot.
  if (snapshot === null || snapshot === undefined || typeof snapshot === "object" && !Array.isArray(snapshot) && Object.keys(snapshot).length === 0) return;
  const prior = graphSnapshot.parse(snapshot);
  if (prior.organizationId !== scope.organizationId || prior.businessId !== scope.businessId) throw new AppError(409, "Knowledge belongs to a different business.");
  const current = await businessKnowledge(client, scope, prior.task, prior.channel, prior.assetIds);
  if (JSON.stringify(current) !== JSON.stringify(prior)) throw new AppError(409, "Business knowledge changed. Request a fresh generation quote.");
}
