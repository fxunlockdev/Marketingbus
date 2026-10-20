import { Prisma } from "@prisma/client";
import { db } from "../db";
import { lockBusiness } from "../production/service";
import { actualCostMicros, assertExecutionEnabled, keyFor, routeSchema } from "../production/router";
import { reason } from "../providers/reasoning";
import { finishReservationInTransaction } from "../billing/wallet";
import { assertBrandEditor } from "../knowledge/analysis";
import { ownedAnalysisClaim } from "../knowledge/analysis-claim";
import { reflectionConfigurationHash } from "./procedures";
import { currentProcedureEpisodes, episodeRefs, hashProcedure, procedureEvidence, procedurePrompt, procedureSchema, procedureSystem, procedureText, validateProcedures, type ProcedureCandidate } from "./procedure-evidence";

// Uses the existing analysis lifecycle for supplier accounting, recovery,
// deletion fences and operator reconciliation; purpose prevents cross-routing.
export async function runOneProcedureReflection(reasoner: typeof reason = reason) {
  const claimed = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "BrandAnalysis" WHERE status='QUEUED' AND purpose='SKILL_REFLECTION' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    return rows[0] ? tx.brandAnalysis.update({ where: { id: rows[0].id }, data: { status: "RUNNING", leaseUntil: new Date(Date.now() + 150000) } }) : null;
  });
  if (!claimed) return false;
  const scope = { businessId: claimed.businessId, organizationId: claimed.organizationId, actorId: claimed.actorId };
  let submitted = false;
  try {
    const request = await db.$transaction(async tx => {
      const business = await lockBusiness(tx, scope); await assertBrandEditor(tx, scope); assertExecutionEnabled();
      const row = await ownedAnalysisClaim(tx, claimed, "SKILL_REFLECTION", ["RUNNING"], true);
      if (!row || !business.confirmedAt || row.brandVersion !== business.version || row.configurationHash !== reflectionConfigurationHash()) throw Error("Reflection preflight changed");
      const episodes = await currentProcedureEpisodes(tx, scope, business.version, row.sources), route = routeSchema.parse(row.route), key = keyFor(route.model.provider);
      if (!key || new Date(route.model.verifiedUntil).getTime() <= Date.now()) throw Error("Provider unavailable");
      await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: "SUBMITTING", submittedAt: new Date() } });
      return { episodes, route, key };
    });
    submitted = true;
    const result = await reasoner(request.route.model.provider, { system: procedureSystem, input: procedurePrompt(request.episodes), model: request.route.model.model, maxOutputTokens: request.route.maxOutputTokens, jsonSchema: procedureSchema }, request.key);
    const micros = actualCostMicros(request.route, result.usage);
    let proposals: ProcedureCandidate[] | null = null;
    try { proposals = validateProcedures(JSON.parse(result.text), request.episodes); } catch { /* No delivery from malformed or fabricated evidence. */ }
    await db.$transaction(async tx => {
      const business = await lockBusiness(tx, scope), row = await ownedAnalysisClaim(tx, claimed, "SKILL_REFLECTION", ["SUBMITTING"], true);
      if (!row) throw Error("Reflection outcome needs reconciliation");
      let fresh = !!business.confirmedAt && row.brandVersion === business.version;
      try { await assertBrandEditor(tx, scope); await currentProcedureEpisodes(tx, scope, business.version, row.sources); } catch { fresh = false; }
      let created = 0;
      if (fresh && proposals) {
        const prior = await tx.learningProposal.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, brandVersion: business.version, status: { startsWith: "PROCEDURE_" } }, take: 101 });
        if (prior.length > 100) throw Error("Consolidate procedure history before another reflection");
        for (const candidate of proposals) {
          const sources = episodeRefs(request.episodes.filter(e => candidate.examples.some(example => example.id === e.id)));
          // Retirement remains sticky for the same candidate and same evidence.
          if (prior.some(p => { const e = procedureEvidence.safeParse(p.evidence); return e.success && hashProcedure({ candidate: e.data.candidate, sources: e.data.sources }) === hashProcedure({ candidate, sources }); })) continue;
          await tx.learningProposal.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, brandVersion: business.version, hypothesis: procedureText(candidate), status: "PROCEDURE_PROPOSED", evidence: { kind: "CREATIVE_PROCEDURE_V1", analysisId: row.id, candidate, sources } } }); created++;
        }
      }
      const deliver = fresh && proposals !== null, consumed = deliver && created ? Math.max(1, Math.ceil(micros / 10000)) : 0;
      await finishReservationInTransaction(tx, scope.organizationId, row.reservationId!, consumed);
      await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: deliver ? "READY" : fresh ? "FAILED" : "STALE", leaseUntil: null, suggestions: deliver ? { created } : Prisma.DbNull,
        supplierCostMicros: micros, providerResponseId: result.id, usage: result.usage as Prisma.InputJsonValue, errorCode: deliver ? null : fresh ? "PROCEDURE_EVIDENCE_FAILED" : "CORRECTION_OR_ACCESS_CHANGED" } });
      await tx.auditEvent.create({ data: { ...scope, action: deliver ? "PROCEDURE_REFLECTION_READY" : "PROCEDURE_REFLECTION_FAILED", detail: `${created} unactivated proposals; ${consumed} credits consumed. Supplier expense recorded. Exact references verified; semantic judgment requires human review.` } });
    });
  } catch {
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope);
      const row = await ownedAnalysisClaim(tx, claimed, "SKILL_REFLECTION", ["RUNNING", "SUBMITTING"], false);
      if (!row) return; // Preserve recovery/replacement decisions and their holds.
      const ambiguous = submitted || row.status !== "RUNNING";
      if (!ambiguous && row.reservationId) await finishReservationInTransaction(tx, scope.organizationId, row.reservationId, 0);
      await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: ambiguous ? "NEEDS_RECONCILIATION" : "FAILED", leaseUntil: null, errorCode: ambiguous ? "PROVIDER_OUTCOME_UNKNOWN" : "PREFLIGHT_FAILED" } });
    });
  }
  return true;
}
