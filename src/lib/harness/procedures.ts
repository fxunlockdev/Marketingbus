import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, type Scope } from "../production/service";
import { assertBrandEditor } from "../knowledge/analysis";
import { assertExecutionEnabled, configurationHash, selectRoute, routeSchema } from "../production/router";
import { assertWorkerReady } from "../production/readiness";
import { authorizeSupplier } from "../production/budget";
import { reserveCreditsInTransaction, finishReservationInTransaction } from "../billing/wallet";
import { procedureOutcomes } from "./procedure-outcomes";
import { currentProcedureEpisodes, episodeRefs, hashProcedure, procedureChannel, procedureEpisodes, procedureEvidence, procedurePrompt, procedureSchema, procedureSystem, validProcedure } from "./procedure-evidence";

export const reflectionConfigurationHash = () => hashProcedure({ rates: configurationHash(), system: procedureSystem, schema: procedureSchema, version: 1 });
const actions = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), channel: procedureChannel }).strict(),
  z.object({ action: z.enum(["accept", "cancel"]), analysisId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("activate"), proposalId: z.string().min(1), reviewedEvidence: z.literal(true), replaceCurrent: z.literal(true) }).strict(),
  z.object({ action: z.literal("retire"), proposalId: z.string().min(1) }).strict(),
]);
export async function readProcedures(scope: Scope) {
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope);
    const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
    if (!member) throw new AppError(403, "Workspace access required.");
    const episodes = await procedureEpisodes(tx, scope, business.version);
    const rows = await tx.learningProposal.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, status: { startsWith: "PROCEDURE_" } }, orderBy: { createdAt: "desc" }, take: 30 });
    const jobs = await tx.brandAnalysis.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, purpose: "SKILL_REFLECTION" }, orderBy: { createdAt: "desc" }, take: 10 });
    const memories = await tx.memory.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, kind: "REVIEWED_PROCEDURE" } });
    const outcomes = await procedureOutcomes(tx, scope, rows);
    return { canEdit: ["OWNER", "ADMIN", "EDITOR"].includes(member.role),
      outcomeWindow: { since: outcomes.since, sampled: outcomes.sampled },
      available: procedureChannel.options.map(channel => ({ channel, count: episodes.filter(e => e.channel === channel).length })),
      reflections: jobs.map(j => ({ id: j.id, status: j.status, credits: j.credits, expiresAt: j.expiresAt, errorCode: j.errorCode })),
      procedures: await Promise.all(rows.map(async r => {
        const parsed = procedureEvidence.safeParse(r.evidence);
        const retained = r.status !== "PROCEDURE_ACTIVE" || memories.some(m => m.id === r.memoryId && m.text === r.hypothesis);
        return { id: r.id, status: r.status, instruction: r.hypothesis, candidate: parsed.success ? parsed.data.candidate : null, outcomes: outcomes.totals[r.id],
          valid: retained && !!business.confirmedAt && r.brandVersion === business.version && await validProcedure(tx, scope, business.version, r.evidence, r.hypothesis) };
      })) };
  });
}
export async function manageProcedures(scope: Scope, raw: unknown) {
  const input = actions.parse(raw);
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    if (!business.confirmedAt) throw new AppError(409, "Confirm the business before reflecting on its corrections.");
    const audit = (action: string, detail: string) => tx.auditEvent.create({ data: { ...scope, action, detail } });
    if (input.action === "quote") {
      assertExecutionEnabled(); await assertWorkerReady(tx);
      if (await tx.brandAnalysis.count({ where: { businessId: scope.businessId, status: { in: ["QUEUED", "RUNNING", "SUBMITTING", "NEEDS_RECONCILIATION"] } } })) throw new AppError(409, "Resolve the current analysis before requesting reflection.");
      if (await tx.brandAnalysis.count({ where: { businessId: scope.businessId, purpose: "SKILL_REFLECTION", createdAt: { gt: new Date(Date.now() - 86400000) } } }) >= 4) throw new AppError(429, "Reflection is limited to four quotes per business each day.");
      const episodes = (await procedureEpisodes(tx, scope, business.version)).filter(e => e.channel === input.channel).slice(0, 8);
      while (episodes.length > 2 && Buffer.byteLength(JSON.stringify(episodes)) > 24000) episodes.pop();
      if (episodes.length < 2) throw new AppError(409, "Reflection needs two different corrected and subsequently approved creatives on this destination.");
      const refs = episodeRefs(episodes), prompt = procedurePrompt(episodes);
      await currentProcedureEpisodes(tx, scope, business.version, refs);
      const route = selectRoute("initial", Buffer.byteLength(procedureSystem + prompt + JSON.stringify(procedureSchema)));
      await tx.brandAnalysis.updateMany({ where: { businessId: scope.businessId, purpose: "SKILL_REFLECTION", status: "OFFERED" }, data: { status: "CANCELLED" } });
      const row = await tx.brandAnalysis.create({ data: { ...scope, purpose: "SKILL_REFLECTION", brandVersion: business.version, sources: refs, route,
        configurationHash: reflectionConfigurationHash(), credits: route.credits, supplierCeilingMicros: route.supplierCeilingMicros, expiresAt: new Date(Date.now() + 600000) } });
      await audit("PROCEDURE_REFLECTION_QUOTED", "Bounded correction evidence selected. No provider call, charge or activation.");
      return { ok: true, analysisId: row.id };
    }
    if (input.action === "accept" || input.action === "cancel") {
      const row = await tx.brandAnalysis.findFirst({ where: { id: input.analysisId, ...{ businessId: scope.businessId, organizationId: scope.organizationId }, purpose: "SKILL_REFLECTION" } });
      if (!row) throw new AppError(404, "Reflection not found.");
      if (input.action === "cancel") {
        if (row.status === "CANCELLED") return { ok: true };
        if (!["OFFERED", "QUEUED", "RUNNING"].includes(row.status)) throw new AppError(409, "Submission already started; uncertain outcomes need operator reconciliation.");
        if (row.reservationId) await finishReservationInTransaction(tx, scope.organizationId, row.reservationId, 0);
        await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: "CANCELLED", leaseUntil: null } });
        await audit("PROCEDURE_REFLECTION_CANCELLED", "Cancelled before provider submission; credits released."); return { ok: true };
      }
      if (row.acceptedAt) return { ok: true };
      assertExecutionEnabled(); await assertWorkerReady(tx);
      if (row.status !== "OFFERED" || row.expiresAt.getTime() <= Date.now() || row.brandVersion !== business.version || row.configurationHash !== reflectionConfigurationHash()) throw new AppError(409, "Reflection quote expired or the business changed.");
      await currentProcedureEpisodes(tx, scope, business.version, row.sources); routeSchema.parse(row.route);
      // Another browser may have accepted a different analysis since this quote.
      if (await tx.brandAnalysis.count({ where: { businessId: scope.businessId, status: { in: ["QUEUED", "RUNNING", "SUBMITTING", "NEEDS_RECONCILIATION"] } } })) throw new AppError(409, "Resolve the current analysis first.");
      await authorizeSupplier(tx, row.id, row.supplierCeilingMicros);
      const hold = await reserveCreditsInTransaction(tx, scope.organizationId, row.id, row.credits);
      await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: "QUEUED", acceptedAt: new Date(), reservationId: hold.id, actorId: scope.actorId } });
      await audit("PROCEDURE_REFLECTION_AUTHORIZED", `At most ${row.credits} credits authorized for one reflection, not recurring calls.`); return { ok: true };
    }
    if (!("proposalId" in input)) throw new AppError(400, "Choose a procedure action.");
    const row = await tx.learningProposal.findFirst({ where: { id: input.proposalId, businessId: scope.businessId, organizationId: scope.organizationId, status: { startsWith: "PROCEDURE_" } } });
    if (!row) throw new AppError(404, "Procedure not found.");
    if (input.action === "activate") {
      if (row.status !== "PROCEDURE_PROPOSED" || row.brandVersion !== business.version || !await validProcedure(tx, scope, business.version, row.evidence, row.hypothesis)) throw new AppError(409, "Procedure evidence changed or expired.");
      const candidate = procedureEvidence.parse(row.evidence).candidate;
      const active = await tx.learningProposal.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, status: "PROCEDURE_ACTIVE" } });
      // One procedure per task/destination. Explicit replacement avoids contradictory active versions.
      const previous = active.filter(p => { const e = procedureEvidence.safeParse(p.evidence); return e.success && e.data.candidate.task === candidate.task && e.data.candidate.channel === candidate.channel; });
      await tx.memory.deleteMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, kind: "REVIEWED_PROCEDURE", id: { in: previous.flatMap(p => p.memoryId ? [p.memoryId] : []) } } });
      await tx.learningProposal.updateMany({ where: { id: { in: previous.map(p => p.id) } }, data: { status: "PROCEDURE_RETIRED", memoryId: null } });
      if (await tx.memory.count({ where: { businessId: scope.businessId } }) >= 100) throw new AppError(409, "Remove unused preferences first.");
      const memory = await tx.memory.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, kind: "REVIEWED_PROCEDURE", text: row.hypothesis } });
      await tx.learningProposal.update({ where: { id: row.id }, data: { status: "PROCEDURE_ACTIVE", memoryId: memory.id } });
    } else {
      if (row.memoryId) await tx.memory.deleteMany({ where: { id: row.memoryId, businessId: scope.businessId, organizationId: scope.organizationId, kind: "REVIEWED_PROCEDURE" } });
      await tx.learningProposal.update({ where: { id: row.id }, data: { status: "PROCEDURE_RETIRED", memoryId: null } });
    }
    await tx.generationQuote.updateMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, status: "OFFERED" }, data: { status: "SUPERSEDED" } });
    await audit(input.action === "activate" ? "PROCEDURE_ACTIVATED" : "PROCEDURE_RETIRED", `${row.id}: explicit human decision; future matching task context changes. Existing creatives unchanged.`);
    return { ok: true };
  });
}
