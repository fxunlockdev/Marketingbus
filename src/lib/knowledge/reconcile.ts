import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness } from "../production/service";
import { finishReservationInTransaction } from "../billing/wallet";
const inputSchema = z.object({ analysisId: z.string().min(1), supplierCostMicros: z.number().int().nonnegative().max(80000000), evidence: z.string().trim().min(10).max(1000), operatorId: z.string().trim().min(3).max(100) }).strict();
// Server-side operator procedure only, never a customer endpoint or automatic retry.
export async function reconcileBrandAnalysis(raw: unknown) {
  const input = inputSchema.parse(raw), target = await db.brandAnalysis.findUnique({ where: { id: input.analysisId } });
  if (!target?.reservationId) throw new AppError(404, "Authorized analysis not found.");
  return db.$transaction(async tx => {
    const scope = { businessId: target.businessId, organizationId: target.organizationId, actorId: input.operatorId };
    await lockBusiness(tx, scope);
    const row = await tx.brandAnalysis.findUniqueOrThrow({ where: { id: target.id } });
    if (row.status === "FAILED" && row.errorCode === "RECONCILED_NO_DELIVERABLE") {
      if (row.supplierCostMicros === input.supplierCostMicros && (row.usage as { evidence?: string })?.evidence === input.evidence) return { ok: true };
      throw new AppError(409, "Reconciliation replay changed the recorded outcome.");
    }
    if (row.status !== "NEEDS_RECONCILIATION") throw new AppError(409, "Only an uncertain analysis can be reconciled.");
    if (input.supplierCostMicros > row.supplierCeilingMicros) throw new AppError(409, "Supplier expense exceeds authorization; investigate before resolving.");
    await finishReservationInTransaction(tx, scope.organizationId, row.reservationId!, 0);
    await tx.brandAnalysis.update({ where: { id: row.id }, data: { status: "FAILED", leaseUntil: null, errorCode: "RECONCILED_NO_DELIVERABLE", supplierCostMicros: input.supplierCostMicros, usage: { evidence: input.evidence, operatorId: input.operatorId } } });
    await tx.auditEvent.create({ data: { ...scope, action: "BRAND_ANALYSIS_RECONCILED", detail: "Operator verified supplier expense and released customer credits. No unverified proposals were delivered; another attempt requires a new quote." } });
    return { ok: true };
  });
}
