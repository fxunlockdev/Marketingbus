import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness } from "../production/service";
import { finishReservationInTransaction } from "../billing/wallet";
import { generationScope } from "./generation-context";
// Privileged procedure only. Verify final supplier expense independently, including overruns.
// Never delivers uncertain output or grants permission to call the supplier again.
export async function reconcileShotGeneration(raw: unknown) {
  const input = z.object({ generationId: z.string().min(1), supplierCostMicros: z.number().int().min(0).max(1000000000), evidence: z.string().trim().min(10).max(1000), operatorId: z.string().trim().min(3).max(100) }).strict().parse(raw);
  const target = await db.videoGeneration.findUnique({ where: { id: input.generationId } });
  if (!target?.reservationId) throw new AppError(404, "Authorized generated-shot job not found.");
  return db.$transaction(async tx => {
    const scope = { ...generationScope(target), actorId: input.operatorId }; await lockBusiness(tx, scope);
    const row = await tx.videoGeneration.findUniqueOrThrow({ where: { id: target.id } });
    if (row.status === "FAILED" && row.errorCode === "RECONCILED_NO_DELIVERABLE") {
      const previous = row.receipt as { evidence?: string; operatorId?: string };
      if (row.supplierCostMicros === input.supplierCostMicros && previous.evidence === input.evidence && previous.operatorId === input.operatorId) return { ok: true };
      throw new AppError(409, "Reconciliation replay changed.");
    }
    if (row.status !== "NEEDS_RECONCILIATION") throw new AppError(409, "Only uncertain supplier jobs can be reconciled.");
    // Actual overspend must reduce future capacity rather than disappear behind a quote ceiling.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403218)::text`;
    await tx.supplierAuthorization.update({ where: { key: row.id }, data: { ceilingMicros: Math.max(row.supplierCeilingMicros, input.supplierCostMicros) } });
    await finishReservationInTransaction(tx, row.organizationId, row.reservationId!, 0);
    await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "FAILED", errorCode: "RECONCILED_NO_DELIVERABLE", supplierCostMicros: input.supplierCostMicros, settledAt: new Date(), leaseUntil: null, nextPollAt: null, receipt: { ...(row.receipt && typeof row.receipt === "object" && !Array.isArray(row.receipt) ? row.receipt : {}), evidence: input.evidence, operatorId: input.operatorId, reconciledAt: new Date().toISOString() } } });
    await tx.videoClip.updateMany({ where: { generationId: row.id }, data: { status: "FAILED", approvedBy: null, leaseUntil: null, purgeAfter: new Date(Date.now() + 7 * 86400000) } });
    await tx.auditEvent.create({ data: { ...scope, action: "SHOT_RECONCILED", detail: "Operator verified final expense; customer hold released. No uncertain footage delivered or supplier resubmission authorized." } });
    return { ok: true };
  });
}
