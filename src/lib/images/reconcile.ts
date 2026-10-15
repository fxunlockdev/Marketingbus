import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness } from "../production/service";
import { finishReservationInTransaction } from "../billing/wallet";
// Privileged operator procedure, not a customer API. Resolve uncertain expense; never resubmit.
export async function reconcileImage(raw: unknown) {
  const input = z.object({ generationId: z.string().min(1), supplierCostMicros: z.number().int().nonnegative().max(80000000), evidence: z.string().trim().min(10).max(1000), operatorId: z.string().trim().min(3).max(100) }).strict().parse(raw);
  const target = await db.imageGeneration.findUnique({ where: { id: input.generationId } });
  if (!target?.reservationId) throw new AppError(404, "Authorized image job not found.");
  return db.$transaction(async tx => {
    const scope = { businessId: target.businessId, organizationId: target.organizationId, actorId: input.operatorId };
    await lockBusiness(tx, scope);
    const row = await tx.imageGeneration.findUniqueOrThrow({ where: { id: target.id } });
    if (row.status === "FAILED" && row.errorCode === "RECONCILED_NO_DELIVERABLE") {
      if (row.supplierCostMicros === input.supplierCostMicros && (row.usage as { evidence?: string })?.evidence === input.evidence) return { ok: true };
      throw new AppError(409, "Reconciliation replay changed.");
    }
    if (row.status !== "NEEDS_RECONCILIATION" || input.supplierCostMicros > row.supplierCeilingMicros) throw new AppError(409, "Verify an uncertain job and expense within authorization before resolving.");
    await finishReservationInTransaction(tx, scope.organizationId, row.reservationId!, 0);
    await tx.brandAsset.updateMany({ where: { generationId: row.id }, data: { status: "ARCHIVED", archivedFromStatus: "FAILED", archivedAt: new Date(), purgeAfter: new Date(Date.now() + 7 * 86400000), approvedForGeneration: false } });
    await tx.imageGeneration.update({ where: { id: row.id }, data: { status: "FAILED", errorCode: "RECONCILED_NO_DELIVERABLE", leaseUntil: null, supplierCostMicros: input.supplierCostMicros, usage: { evidence: input.evidence, operatorId: input.operatorId } } });
    await tx.auditEvent.create({ data: { ...scope, action: "IMAGE_RECONCILED", detail: "Operator verified expense; customer hold released. No uncertain media delivered and no automatic regeneration." } });
    return { ok: true };
  });
}
