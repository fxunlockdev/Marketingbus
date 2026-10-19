import { Prisma } from "@prisma/client";
import { db } from "../db";
import { lockBusiness } from "../production/service";
import { actualCostMicros, assertExecutionEnabled, keyFor, routeSchema } from "../production/router";
import { reason } from "../providers/reasoning";
import { finishReservationInTransaction } from "../billing/wallet";
import { analysisEvidence, analysisConfigurationHash, assertBrandEditor } from "./analysis";
import { analysisPrompt, analysisSystem, suggestionsJsonSchema, validateSuggestions, type Suggestions } from "./grounding";

export async function runOneBrandAnalysis(reasoner: typeof reason = reason) {
  const claimed = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "BrandAnalysis" WHERE status='QUEUED' AND purpose='BRAND' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows[0]) return null;
    return tx.brandAnalysis.update({ where: { id: rows[0].id }, data: { status: "RUNNING", leaseUntil: new Date(Date.now() + 150000) } });
  });
  if (!claimed) return false;
  const scope = { businessId: claimed.businessId, organizationId: claimed.organizationId, actorId: claimed.actorId };
  let submitted = false;
  try {
    const request = await db.$transaction(async tx => {
      const business = await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
      const row = await tx.brandAnalysis.findUniqueOrThrow({ where: { id: claimed.id } });
      assertExecutionEnabled();
      if (row.status !== "RUNNING" || !row.leaseUntil || row.leaseUntil.getTime() !== claimed.leaseUntil?.getTime() || row.leaseUntil.getTime() <= Date.now() || row.brandVersion !== business.version || row.configurationHash !== analysisConfigurationHash()) throw Error("Analysis preflight changed");
      const sources = await analysisEvidence(tx, row), route = routeSchema.parse(row.route), key = keyFor(route.model.provider);
      if (!key || new Date(route.model.verifiedUntil).getTime() <= Date.now()) throw Error("Provider configuration expired");
      await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: "SUBMITTING", submittedAt: new Date() } });
      return { sources, route, key, prompt: analysisPrompt(business, sources) };
    });
    submitted = true;
    const result = await reasoner(request.route.model.provider, { system: analysisSystem, input: request.prompt, model: request.route.model.model, maxOutputTokens: request.route.maxOutputTokens, jsonSchema: suggestionsJsonSchema }, request.key);
    const micros = actualCostMicros(request.route, result.usage);
    let suggestions: Suggestions | null = null;
    try { suggestions = validateSuggestions(JSON.parse(result.text), request.sources); } catch { /* Do not deliver ungrounded output. */ }
    await db.$transaction(async tx => {
      const business = await lockBusiness(tx, scope);
      const row = await tx.brandAnalysis.findUniqueOrThrow({ where: { id: claimed.id } });
      if (row.status !== "SUBMITTING") throw Error("Submission requires reconciliation");
      let fresh = row.brandVersion === business.version;
      try { await analysisEvidence(tx, row); await assertBrandEditor(tx, scope); } catch { fresh = false; }
      const changes = suggestions?.filter(s => business[s.field] !== s.value) ?? null;
      const deliver = fresh && changes !== null;
      const consumed = deliver && changes!.length ? Math.max(1, Math.ceil(micros / 10000)) : 0;
      await finishReservationInTransaction(tx, scope.organizationId, row.reservationId!, consumed);
      await tx.brandAnalysis.update({ where: { id: row.id }, data: {
        status: deliver ? "READY" : fresh ? "FAILED" : "STALE", leaseUntil: null,
        suggestions: deliver ? changes! : Prisma.DbNull, supplierCostMicros: micros,
        providerResponseId: result.id, usage: result.usage as Prisma.InputJsonValue,
        errorCode: deliver ? null : fresh ? "GROUNDING_CHECK_FAILED" : "BRAND_OR_SOURCE_CHANGED",
      } });
      await tx.auditEvent.create({ data: { ...scope, action: deliver ? "BRAND_ANALYSIS_READY" : "BRAND_ANALYSIS_FAILED", detail: deliver ? `Source-linked proposals ready for human review. ${consumed} credits consumed; unused hold released.` : "No eligible proposals delivered. Customer credits released; supplier cost recorded." } });
    });
  } catch {
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope);
      const row = await tx.brandAnalysis.findUniqueOrThrow({ where: { id: claimed.id } });
      if (!["RUNNING", "SUBMITTING", "NEEDS_RECONCILIATION"].includes(row.status)) return;
      if (!submitted && row.leaseUntil?.getTime() !== claimed.leaseUntil?.getTime()) return;
      const ambiguous = submitted || row.status !== "RUNNING";
      if (!ambiguous && row.reservationId) await finishReservationInTransaction(tx, scope.organizationId, row.reservationId, 0);
      await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: ambiguous ? "NEEDS_RECONCILIATION" : "FAILED", leaseUntil: null, errorCode: ambiguous ? "PROVIDER_OUTCOME_UNKNOWN" : "PREFLIGHT_FAILED" } });
      await tx.auditEvent.create({ data: { ...scope, action: "BRAND_ANALYSIS_STOPPED", detail: ambiguous ? "Provider outcome uncertain. Hold retained for operator reconciliation; no automatic retry." : "Stopped before submission; customer hold released." } });
    });
  }
  return true;
}

export async function recoverBrandAnalysisLeases() {
  const rows = await db.brandAnalysis.findMany({ where: { status: { in: ["RUNNING", "SUBMITTING"] }, leaseUntil: { lt: new Date() } }, take: 50 });
  for (const row of rows) await db.$transaction(async tx => {
    await lockBusiness(tx, { businessId: row.businessId, organizationId: row.organizationId, actorId: row.actorId });
    await tx.brandAnalysis.updateMany({ where: { id: row.id, status: row.status, leaseUntil: { lt: new Date() } }, data: {
      status: row.status === "RUNNING" ? "QUEUED" : "NEEDS_RECONCILIATION", leaseUntil: null,
      errorCode: row.status === "RUNNING" ? null : "LEASE_EXPIRED_AFTER_SUBMISSION",
    } });
  });
}
