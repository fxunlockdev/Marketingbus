import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, type Scope } from "../production/service";
import { creativeSchema } from "../production/content";
import { followsRule, requestedRules, ruleText, learnedRule } from "./learned-rules";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const DAY = 86400000;
const evidenceSchema = z.object({ kind: z.literal("FEEDBACK_SKILL_V1"), rule: learnedRule,
  episodes: z.array(z.object({ beforeId: z.string(), afterId: z.string(), itemId: z.string(), fingerprint: z.string() }).strict()).min(2).max(10),
}).strict();
type Episode = z.infer<typeof evidenceSchema>["episodes"][number];
async function episodes(tx: Prisma.TransactionClient, scope: Scope, brandVersion: number) {
  const now = Date.now();
  const items = await tx.productionItem.findMany({ where: { organizationId: scope.organizationId, plan: { businessId: scope.businessId, brandVersion }, revisions: { some: { status: "APPROVED" } } }, orderBy: { id: "desc" }, take: 100,
    include: { revisions: { orderBy: { version: "desc" }, take: 8 } } });
  const groups = new Map<string, { rule: z.infer<typeof learnedRule>; episodes: Episode[] }>();
  for (const item of items) {
    const after = item.revisions[0], current = creativeSchema.safeParse(after?.content);
    if (!after || after.status !== "APPROVED" || !current.success || !after.approvedAt || after.approvedAt.getTime() > now || now - after.approvedAt.getTime() > 90 * DAY) continue;
    const before = item.revisions.find(r => r.version < after.version && r.feedback.trim());
    const original = creativeSchema.safeParse(before?.content);
    if (!before || !original.success) continue;
    for (const id of requestedRules(before.feedback)) {
      const rule = learnedRule.safeParse({ id, channel: item.channel });
      if (!rule.success || followsRule(id, original.data) || !followsRule(id, current.data)) continue;
      const key = `${item.channel}:${id}`, group = groups.get(key) ?? { rule: rule.data, episodes: [] };
      if (group.episodes.length < 10) group.episodes.push({ itemId: item.id, beforeId: before.id, afterId: after.id,
        fingerprint: hash({ feedback: before.feedback, before: original.data, after: current.data, approvedAt: after.approvedAt.toISOString() }) });
      groups.set(key, group);
    }
  }
  return [...groups.values()].filter(g => g.episodes.length >= 2).map(g => ({ kind: "FEEDBACK_SKILL_V1" as const, ...g }));
}
function matchesSkill(sources: Awaited<ReturnType<typeof episodes>>, evidence: unknown, hypothesis: string) {
  const parsed = evidenceSchema.safeParse(evidence);
  if (!parsed.success || hypothesis !== ruleText(parsed.data.rule.id, parsed.data.rule.channel)) return false;
  const source = sources.find(g => g.rule.id === parsed.data.rule.id && g.rule.channel === parsed.data.rule.channel);
  return !!source && new Set(parsed.data.episodes.map(e => e.itemId)).size === parsed.data.episodes.length && parsed.data.episodes.every(e => source.episodes.some(s => s.itemId === e.itemId && s.beforeId === e.beforeId && s.afterId === e.afterId && s.fingerprint === e.fingerprint));
}
export async function validSkill(tx: Prisma.TransactionClient, scope: Scope, brandVersion: number, evidence: unknown, hypothesis: string) {
  const parsed = evidenceSchema.safeParse(evidence);
  if (!parsed.success || hypothesis !== ruleText(parsed.data.rule.id, parsed.data.rule.channel)) return false;
  return matchesSkill(await episodes(tx, scope, brandVersion), evidence, hypothesis);
}
export async function validSkillMemories(tx: Prisma.TransactionClient, scope: Scope, brandVersion: number, memories: { id: string; text: string; kind: string }[]) {
  const rows = await tx.learningProposal.findMany({ where: { ...{ businessId: scope.businessId, organizationId: scope.organizationId }, brandVersion, status: "SKILL_ACTIVE", memoryId: { in: memories.filter(m => m.kind === "APPROVED_SKILL").map(m => m.id) } }, take: 21 });
  const valid = new Set<string>();
  if (!rows.length || rows.length > 20) return valid;
  // Request-local only: each recall re-reads scoped source evidence. Do not cache
  // this across quotes, approval changes, brands, businesses or worker fences.
  const sources = await episodes(tx, scope, brandVersion);
  for (const row of rows) if (memories.some(m => m.kind === "APPROVED_SKILL" && m.id === row.memoryId && m.text === row.hypothesis) && matchesSkill(sources, row.evidence, row.hypothesis)) valid.add(row.memoryId!);
  return valid;
}
async function access(tx: Prisma.TransactionClient, scope: Scope, write: boolean) {
  const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member || write && !["OWNER", "ADMIN", "EDITOR"].includes(member.role)) throw new AppError(403, "Your workspace role cannot manage learned skills.");
  return member;
}
export async function readLearnedSkills(scope: Scope) {
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope), member = await access(tx, scope, false);
    const rows = await tx.learningProposal.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, status: { startsWith: "SKILL_" } }, orderBy: { createdAt: "desc" }, take: 50 });
    const activeIds = rows.flatMap(r => r.status === "SKILL_ACTIVE" && r.memoryId ? [r.memoryId] : []);
    const retainedMemories = activeIds.length ? await tx.memory.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, kind: "APPROVED_SKILL", id: { in: activeIds } }, select: { id: true, text: true }, take: 50 }) : [];
    const sources = business.confirmedAt && rows.some(r => r.brandVersion === business.version) ? await episodes(tx, scope, business.version) : [];
    return { canEdit: ["OWNER", "ADMIN", "EDITOR"].includes(member.role), skills: rows.map(row => {
      const evidence = evidenceSchema.safeParse(row.evidence);
      const retained = row.status !== "SKILL_ACTIVE" || retainedMemories.some(m => m.id === row.memoryId && m.text === row.hypothesis);
      const valid = retained && row.brandVersion === business.version && !!business.confirmedAt && matchesSkill(sources, row.evidence, row.hypothesis);
      return { id: row.id, instruction: row.hypothesis, status: row.status, valid, channel: evidence.success ? evidence.data.rule.channel : "Unknown", examples: evidence.success ? evidence.data.episodes.length : 0, createdAt: row.createdAt };
    }) };
  });
}
export async function manageLearnedSkills(scope: Scope, raw: unknown) {
  const input = z.discriminatedUnion("action", [z.object({ action: z.literal("reflect-skills") }).strict(), z.object({ action: z.enum(["activate-skill", "retire-skill"]), proposalId: z.string().min(1) }).strict()]).parse(raw);
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope); await access(tx, scope, true);
    if (!business.confirmedAt) throw new AppError(409, "Confirm the brand before managing learned skills.");
    if (input.action === "reflect-skills") return reflectLearnedSkills(tx, scope, business.version);
    const row = await tx.learningProposal.findFirst({ where: { id: input.proposalId, businessId: scope.businessId, organizationId: scope.organizationId, status: { startsWith: "SKILL_" } } });
    if (!row) throw new AppError(404, "Skill not found.");
    if (input.action === "activate-skill") {
      if (row.status !== "SKILL_PROPOSED" || row.brandVersion !== business.version || !await validSkill(tx, scope, business.version, row.evidence, row.hypothesis)) throw new AppError(409, "The skill examples changed or expired. Review current corrections again.");
      const previous = await tx.learningProposal.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, hypothesis: row.hypothesis, status: "SKILL_ACTIVE" } });
      await tx.memory.deleteMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, kind: "APPROVED_SKILL", id: { in: previous.flatMap(p => p.memoryId ? [p.memoryId] : []) } } });
      await tx.learningProposal.updateMany({ where: { id: { in: previous.map(p => p.id) } }, data: { status: "SKILL_RETIRED", memoryId: null } });
      // Count after reclaiming only this rule's scoped skill memory. A failure
      // rolls back retirement/deletion; explicit preferences are never evicted.
      if (await tx.memory.count({ where: { businessId: scope.businessId } }) >= 100) throw new AppError(409, "Remove an unused preference first.");
      const memory = await tx.memory.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, kind: "APPROVED_SKILL", text: row.hypothesis } });
      await tx.learningProposal.update({ where: { id: row.id }, data: { status: "SKILL_ACTIVE", memoryId: memory.id } });
    } else {
      if (row.memoryId) await tx.memory.deleteMany({ where: { id: row.memoryId, businessId: scope.businessId, organizationId: scope.organizationId, kind: "APPROVED_SKILL" } });
      await tx.learningProposal.update({ where: { id: row.id }, data: { status: "SKILL_RETIRED", memoryId: null } });
    }
    await tx.generationQuote.updateMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, status: "OFFERED" }, data: { status: "SUPERSEDED" } });
    await tx.auditEvent.create({ data: { ...scope, action: input.action === "activate-skill" ? "SKILL_ACTIVATED" : "SKILL_RETIRED", detail: `${row.id}: explicit decision; future copy context changes. Existing posts and source skill packs unchanged.` } });
    return { ok: true };
  });
}
// Called while holding the same business lock as creative approval. No model calls.
export async function reflectLearnedSkills(tx: Prisma.TransactionClient, scope: Scope, brandVersion: number) {
      const sources = await episodes(tx, scope, brandVersion);
      const stale = await tx.learningProposal.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, status: { in: ["SKILL_ACTIVE", "SKILL_PROPOSED"] } }, take: 20 });
      for (const row of stale) if (row.brandVersion !== brandVersion || !matchesSkill(sources, row.evidence, row.hypothesis)) {
        if (row.memoryId) await tx.memory.deleteMany({ where: { id: row.memoryId, businessId: scope.businessId, organizationId: scope.organizationId, kind: "APPROVED_SKILL" } });
        await tx.learningProposal.update({ where: { id: row.id }, data: { status: "SKILL_EXPIRED", memoryId: null } });
      }
      let created = 0;
      for (const evidence of sources) {
        const hypothesis = ruleText(evidence.rule.id, evidence.rule.channel);
        const prior = await tx.learningProposal.findFirst({ where: { businessId: scope.businessId, organizationId: scope.organizationId, brandVersion, hypothesis, status: { startsWith: "SKILL_" } }, orderBy: { createdAt: "desc" } });
        // Same-scenario consolidation. Retirement is sticky until the user creates new evidence.
        if (prior && (matchesSkill(sources, prior.evidence, prior.hypothesis) || hash(prior.evidence) === hash(evidence))) continue;
        if (await tx.learningProposal.count({ where: { businessId: scope.businessId, status: { in: ["SKILL_PROPOSED", "SKILL_ACTIVE"] } } }) >= 20) break;
        await tx.learningProposal.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, brandVersion, hypothesis, evidence, status: "SKILL_PROPOSED" } }); created++;
      }
      await tx.auditEvent.create({ data: { ...scope, action: "SKILLS_REFLECTED", detail: `${created} bounded feedback skill proposals. No model call or automatic activation.` } });
      return { ok: true, created };
}
