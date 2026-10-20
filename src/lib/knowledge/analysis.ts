import type { Prisma, BrandAnalysis } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { brandInput, draftBrandInput } from "../brand";
import { lockBusiness, type Scope } from "../production/service";
import { authorizeSupplier } from "../production/budget";
import { assertWorkerReady } from "../production/readiness";
import { assertExecutionEnabled, configurationHash, routeSchema, selectRoute } from "../production/router";
import { reserveCreditsInTransaction, finishReservationInTransaction } from "../billing/wallet";
import { analysisPrompt, analysisSystem, sourceRefs, suggestionField, suggestionsSchema, suggestionsJsonSchema, validateSuggestions } from "./grounding";
import { replaceBrandProfile } from "./profile";
import { ANALYSIS_EVIDENCE_VERSION, boundedAnalysisEvidence } from "./analysis-evidence";

const actions = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), sourceIds: z.array(z.string().min(1)).min(1).max(3) }).strict(),
  z.object({ action: z.literal("prepare"), sourceIds: z.array(z.string().min(1)).min(1).max(3), requestId: z.uuid(), maxCredits: z.literal(20) }).strict(),
  z.object({ action: z.literal("accept"), analysisId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("cancel"), analysisId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("reject"), analysisId: z.string().min(1), field: suggestionField }).strict(),
  z.object({ action: z.literal("apply"), analysisId: z.string().min(1), fields: z.array(suggestionField).min(1).max(7), version: z.number().int().positive() }).strict(),
]);
export function analysisConfigurationHash() {
  return createHash("sha256").update(JSON.stringify({ rates: configurationHash(), system: analysisSystem, schema: suggestionsJsonSchema, promptVersion: "brand-evidence-v3-field-validation", evidenceVersion: ANALYSIS_EVIDENCE_VERSION })).digest("hex");
}
export async function assertBrandEditor(tx: Prisma.TransactionClient, scope: Scope) {
  const members = await tx.$queryRaw<{ role: string }[]>`SELECT role FROM "Membership" WHERE "organizationId"=${scope.organizationId} AND "userId"=${scope.actorId} FOR SHARE`;
  if (!members[0] || !["OWNER", "ADMIN", "EDITOR"].includes(members[0].role)) throw new AppError(403, "Workspace editing access required.");
}
export async function analysisEvidence(tx: Prisma.TransactionClient, row: BrandAnalysis) {
  const refs = sourceRefs.parse(row.sources);
  const sources = await tx.knowledgeSource.findMany({ where: { businessId: row.businessId, organizationId: row.organizationId, id: { in: refs.map(s => s.id) }, status: "PROPOSED" }, orderBy: { id: "asc" } });
  if (sources.length !== refs.length || sources.some(s => createHash("sha256").update(s.body).digest("hex") !== s.sha256 || !refs.some(r => r.id === s.id && r.sha256 === s.sha256))) throw new AppError(409, "The source evidence changed or was removed. Request fresh analysis.");
  return boundedAnalysisEvidence(sources.map(({ id, sha256, body, title }) => ({ id, sha256, body, title })));
}
export async function readBrandAnalyses(scope: Scope) {
  const member = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member) throw new AppError(404, "Workspace not found.");
  const business = await db.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!business) throw new AppError(404, "Business not found.");
  const rows = await db.brandAnalysis.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, purpose: "BRAND" }, orderBy: { createdAt: "desc" }, take: 20 });
  const current = Object.fromEntries(suggestionField.options.map(key => [key, business[key]]));
  return { current, version: business.version, canEdit: ["OWNER", "ADMIN", "EDITOR"].includes(member.role), analyses: rows.map(row => ({
    id: row.id, status: row.status, credits: row.credits, expiresAt: row.expiresAt, brandVersion: row.brandVersion,
    createdAt: row.createdAt, rejectedFields: row.rejectedFields, appliedFields: row.appliedFields,
    suggestions: row.suggestions ? suggestionsSchema.parse({ suggestions: row.suggestions }).suggestions : [],
    errorCode: row.errorCode,
  })) };
}
export async function manageBrandAnalysis(scope: Scope, raw: unknown) {
  const input = actions.parse(raw);
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope);
    await assertBrandEditor(tx, scope);
    const audit = (action: string, detail: string) => tx.auditEvent.create({ data: { ...scope, action, detail } });
    if (input.action === "quote" || input.action === "prepare") {
      // A saved setup request is a single authorization, including across reloads,
      // retries and concurrent tabs. Never create another paid attempt for it.
      const preparedId = input.action === "prepare" ? createHash("sha256").update(JSON.stringify(["setup-autofill-v1", scope.organizationId, scope.businessId, input.requestId])).digest("hex") : undefined;
      if (preparedId && input.action === "prepare") {
        const prior = await tx.brandAnalysis.findUnique({ where: { id: preparedId } });
        if (prior) return { ok: true, analysisId: prior.id };
        const details = business.setupDetails as { autofill?: { requestId?: string; maxCredits?: number } };
        if (business.setupStep === null || business.setupStep >= 6 || details?.autofill?.requestId !== input.requestId || details.autofill?.maxCredits !== input.maxCredits)
          throw new AppError(409, "Review your setup before preparing your details.");
      }
      assertExecutionEnabled(); await assertWorkerReady(tx);
      if (new Set(input.sourceIds).size !== input.sourceIds.length) throw new AppError(400, "Select each source once.");
      if (await tx.brandAnalysis.count({ where: { businessId: scope.businessId, status: { in: ["QUEUED", "RUNNING", "SUBMITTING", "NEEDS_RECONCILIATION"] } } })) throw new AppError(409, "Resolve the current analysis before requesting another.");
      if (await tx.brandAnalysis.count({ where: { businessId: scope.businessId, createdAt: { gt: new Date(Date.now() - 86400000) } } }) >= 12) throw new AppError(429, "Brand analysis is limited to twelve quotes per business per day.");
      const sources = await tx.knowledgeSource.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, id: { in: input.sourceIds }, status: "PROPOSED" }, orderBy: { id: "asc" } });
      if (sources.length !== input.sourceIds.length) throw new AppError(404, "One or more reviewed sources are unavailable.");
      if (sources.some(s => createHash("sha256").update(s.body).digest("hex") !== s.sha256)) throw new AppError(409, "The source evidence changed. Import it again before analysis.");
      const evidence = boundedAnalysisEvidence(sources.map(({ id, sha256, body, title }) => ({ id, sha256, body, title })));
      const refs = sourceRefs.parse(evidence.map(({ id, sha256 }) => ({ id, sha256 })));
      const prompt = analysisPrompt(business, evidence);
      const route = selectRoute("initial", Buffer.byteLength(analysisSystem + prompt + JSON.stringify(suggestionsJsonSchema)));
      if (input.action === "prepare" && route.credits > input.maxCredits) throw new AppError(409, "Preparing these details would exceed the agreed credits. No credits were spent.");
      await tx.brandAnalysis.updateMany({ where: { businessId: scope.businessId, purpose: "BRAND", status: "OFFERED" }, data: { status: "CANCELLED" } });
      const row = await tx.brandAnalysis.create({ data: { ...(preparedId ? { id: preparedId } : {}), ...scope, brandVersion: business.version, sources: refs, route,
        configurationHash: analysisConfigurationHash(), credits: route.credits, supplierCeilingMicros: route.supplierCeilingMicros,
        expiresAt: new Date(Date.now() + 600000) } });
      await audit("BRAND_ANALYSIS_QUOTED", "Evidence-bound analysis quoted. No provider call or credit reservation.");
      if (input.action === "prepare") {
        await authorizeSupplier(tx, row.id, row.supplierCeilingMicros);
        const hold = await reserveCreditsInTransaction(tx, scope.organizationId, row.id, row.credits);
        await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: "QUEUED", acceptedAt: new Date(), reservationId: hold.id } });
        await audit("SETUP_AUTOFILL_AUTHORIZED", `Setup review authorized up to ${input.maxCredits} credits; reserved ${row.credits}. Suggestions remain drafts; no confirmation or publication.`);
      }
      return { ok: true, analysisId: row.id };
    }
    const row = await tx.brandAnalysis.findFirst({ where: { id: input.analysisId, businessId: scope.businessId, organizationId: scope.organizationId, purpose: "BRAND" } });
    if (!row) throw new AppError(404, "Analysis not found.");
    if (input.action === "cancel") {
      if (["CANCELLED", "STALE"].includes(row.status)) return { ok: true };
      if (!["OFFERED", "QUEUED", "RUNNING"].includes(row.status)) throw new AppError(409, "Submission already started or completed. An uncertain outcome needs operator reconciliation, not another call.");
      if (row.reservationId) await finishReservationInTransaction(tx, scope.organizationId, row.reservationId, 0);
      await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: "CANCELLED", leaseUntil: null } });
      await audit("BRAND_ANALYSIS_CANCELLED", "Cancelled before submission; held credits released.");
      return { ok: true };
    }
    if (input.action === "accept") {
      if (row.acceptedAt) return { ok: true, analysisId: row.id };
      assertExecutionEnabled(); await assertWorkerReady(tx);
      if (row.status !== "OFFERED" || row.expiresAt.getTime() <= Date.now() || row.configurationHash !== analysisConfigurationHash() || row.brandVersion !== business.version) throw new AppError(409, "This quote expired or the brand changed. Request fresh analysis.");
      await analysisEvidence(tx, row); routeSchema.parse(row.route);
      await authorizeSupplier(tx, row.id, row.supplierCeilingMicros);
      const hold = await reserveCreditsInTransaction(tx, scope.organizationId, row.id, row.credits);
      await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: "QUEUED", acceptedAt: new Date(), reservationId: hold.id, actorId: scope.actorId } });
      await audit("BRAND_ANALYSIS_AUTHORIZED", `Reserved at most ${row.credits} credits for source analysis only. No automatic brand confirmation or publication.`);
      return { ok: true, analysisId: row.id };
    }
    if (input.action === "apply" && row.status === "APPLIED") {
      if ([...new Set(input.fields)].sort().join() !== [...row.appliedFields].sort().join()) throw new AppError(409, "This analysis was already applied with a different selection.");
      return { ok: true };
    }
    if (row.status !== "READY" || business.version !== row.brandVersion) throw new AppError(409, "This analysis is no longer current. Refresh and request fresh analysis.");
    const sources = await analysisEvidence(tx, row);
    const suggestions = validateSuggestions({ suggestions: row.suggestions }, sources);
    if (input.action === "reject") {
      if (!suggestions.some(s => s.field === input.field)) throw new AppError(404, "Suggestion not found.");
      await tx.brandAnalysis.update({ where: { id: row.id }, data: { rejectedFields: [...new Set([...row.rejectedFields, input.field])] } });
      await audit("BRAND_SUGGESTION_REJECTED", `Rejected proposed ${input.field}; no regeneration or charge.`);
      return { ok: true };
    }
    if (business.version !== input.version) throw new AppError(409, "This profile changed. Refresh before applying.");
    if (new Set(input.fields).size !== input.fields.length || input.fields.some(f => row.rejectedFields.includes(f) || !suggestions.some(s => s.field === f))) throw new AppError(409, "Select only current, unrejected suggestions.");
    const profile = Object.fromEntries(Object.keys(brandInput.shape).map(key => [key, business[key as keyof typeof business]]));
    for (const item of suggestions.filter(s => input.fields.includes(s.field))) profile[item.field] = item.value;
    await replaceBrandProfile(tx, scope, business.setupStep !== null && business.setupStep < 6 ? draftBrandInput.parse(profile) : brandInput.parse(profile));
    await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: "APPLIED", appliedFields: input.fields } });
    await audit("BRAND_SUGGESTIONS_APPLIED", `Selected fields (${input.fields.join(", ")}) applied to draft version ${business.version + 1}. Human confirmation required; existing production plans invalidated.`);
    return { ok: true };
  });
}
