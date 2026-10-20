import { createHash } from "node:crypto";
import { db } from "../db";
import { AppError } from "../http";
import type { Scope } from "../production/service";
import { analysisEvidence, manageBrandAnalysis } from "../knowledge/analysis";
import { validateSuggestions } from "../knowledge/grounding";
import { setupDetails } from "./simple";

export function setupAutofillId(scope: Pick<Scope, "organizationId" | "businessId">, requestId: string) {
  return createHash("sha256").update(JSON.stringify(["setup-autofill-v1", scope.organizationId, scope.businessId, requestId])).digest("hex");
}
async function context(scope: Scope) {
  const member = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  const business = await db.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!member || !business) throw new AppError(404, "Business not found.");
  return { business, consent: setupDetails.parse(business.setupDetails).autofill };
}
export async function readSetupAutofill(scope: Scope) {
  const { business, consent } = await context(scope);
  if (!consent) return { status: "NOT_STARTED", suggestions: [] };
  const row = await db.brandAnalysis.findFirst({ where: { id: setupAutofillId(scope, consent.requestId), businessId: scope.businessId, organizationId: scope.organizationId, purpose: "BRAND" } });
  if (!row) return { status: "WAITING", suggestions: [] };
  if (row.brandVersion !== business.version) return { status: "STALE", suggestions: [] };
  if (row.status !== "READY") return { status: row.status, suggestions: [] };
  // Do not return stale suggestions after evidence removal or modification.
  try {
    return await db.$transaction(async tx => {
      const sources = await analysisEvidence(tx, row);
      return { status: "READY", suggestions: validateSuggestions({ suggestions: row.suggestions }, sources).filter(s => !row.rejectedFields.includes(s.field)) };
    });
  } catch { return { status: "STALE", suggestions: [] }; }
}
export async function prepareSetupAutofill(scope: Scope) {
  const { business, consent } = await context(scope);
  if (!consent) throw new AppError(409, "Choose Review my brand to prepare your details.");
  const existing = await db.brandAnalysis.findFirst({ where: { id: setupAutofillId(scope, consent.requestId), businessId: scope.businessId, organizationId: scope.organizationId } });
  if (existing) return readSetupAutofill(scope);
  const sources = await db.knowledgeSource.findMany({ where: {
    businessId: scope.businessId, organizationId: scope.organizationId,
    OR: [{ sourceUrl: business.website }, { sourceUrl: "" }],
  }, orderBy: { createdAt: "desc" }, take: 30 });
  const website = sources.find(s => s.sourceUrl === business.website);
  const documents = sources.filter(s => !s.sourceUrl && s.status === "PROPOSED");
  const selected = [...(website?.status === "PROPOSED" ? [website] : []), ...documents].slice(0, 3);
  if (!selected.length) return { status: website && ["QUEUED", "FETCHING"].includes(website.status) ? "WAITING" : "IMPORT_REQUIRED", suggestions: [] };
  await manageBrandAnalysis(scope, { action: "prepare", ...consent, sourceIds: selected.map(s => s.id) });
  return readSetupAutofill(scope);
}
