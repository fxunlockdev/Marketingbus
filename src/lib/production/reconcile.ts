import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness } from "./service";
import { finishReservationInTransaction } from "../billing/wallet";
const inputSchema = z.object({ jobId: z.string().min(1), supplierCostMicros: z.number().int().nonnegative().max(80_000_000),
  evidence: z.string().trim().min(10).max(1000), operatorId: z.string().trim().min(3).max(100) }).strict();
// Privileged server-side operator procedure only. Never expose this as a customer API.
// This conservative resolution does not deliver unverified media: release customer credits,
// record the independently verified supplier expense and retain the audit trail.
export async function reconcileFailedJob(raw: unknown) {
  const input = inputSchema.parse(raw);
  const target = await db.job.findUnique({ where: { id: input.jobId } });
  if (!target?.quoteId || !target.reservationId) throw new AppError(404, "Authorized production job not found.");
  return db.$transaction(async tx => {
    const scope = { businessId: target.businessId, organizationId: target.organizationId, actorId: input.operatorId };
    await lockBusiness(tx, scope);
    const job = await tx.job.findUniqueOrThrow({ where: { id: target.id }, include: { quote: true } });
    if (job.status === "FAILED" && job.errorCode === "RECONCILED_NO_DELIVERABLE") {
      const old = job.result as { supplierCostMicros?: number; evidence?: string } | null;
      if (old?.supplierCostMicros === input.supplierCostMicros && old?.evidence === input.evidence) return { jobId: job.id, status: job.status };
      throw new AppError(409, "Reconciliation replay changed the recorded outcome.");
    }
    if (job.status !== "NEEDS_RECONCILIATION") throw new AppError(409, "Only an uncertain job can be reconciled.");
    if (input.supplierCostMicros > job.quote!.supplierCeilingMicros) throw new AppError(409, "Supplier expense exceeds authorization. Investigate the billing discrepancy before resolving.");
    await finishReservationInTransaction(tx, target.organizationId, target.reservationId!, 0);
    await tx.job.update({ where: { id: job.id }, data: { status: "FAILED", errorCode: "RECONCILED_NO_DELIVERABLE", leaseUntil: null,
      result: { supplierCostMicros: input.supplierCostMicros, creditsConsumed: 0, evidence: input.evidence, operatorId: input.operatorId } } });
    await tx.generationQuote.update({ where: { id: job.quote!.id }, data: { status: input.supplierCostMicros ? "COMPLETED" : "RELEASED" } });
    await tx.productionItem.update({ where: { id: job.quote!.itemId }, data: { status: "FAILED" } });
    await tx.auditEvent.create({ data: { ...scope, action: "PRODUCTION_RECONCILED", detail: "Operator verified the provider outcome. Customer credits released; supplier expense recorded. Regeneration still requires a new quote." } });
    return { jobId: job.id, status: "FAILED" };
  });
}
