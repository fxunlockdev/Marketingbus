import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness } from "../production/service";
import { finishReservationInTransaction } from "../billing/wallet";
import { generationScope } from "./generation-context";
// Privileged procedure only. Verify final supplier expense independently, including overruns.
// Never delivers uncertain output, reprices delivered customer work or calls the supplier.
export async function reconcileShotGeneration(raw: unknown) {
  const input = z.object({ generationId: z.string().min(1), supplierCostMicros: z.number().int().min(0).max(1000000000), evidence: z.string().trim().min(10).max(1000), operatorId: z.string().trim().min(3).max(100) }).strict().parse(raw);
  const target = await db.videoGeneration.findUnique({ where: { id: input.generationId } });
  if (!target?.reservationId) throw new AppError(404, "Authorized generated-shot job not found.");
  return db.$transaction(async tx => {
    const scope = { ...generationScope(target), actorId: input.operatorId }; await lockBusiness(tx, scope);
    const row = await tx.videoGeneration.findUniqueOrThrow({ where: { id: target.id } });
    if (row.supplierReconciledAt || row.status === "FAILED" && row.errorCode === "RECONCILED_NO_DELIVERABLE") {
      const previous = row.receipt as { evidence?: string; operatorId?: string };
      if (row.supplierCostMicros === input.supplierCostMicros && previous.evidence === input.evidence && previous.operatorId === input.operatorId) return { ok: true };
      throw new AppError(409, "Reconciliation replay changed.");
    }
    const provisional = row.expenseBasis === "ACCOUNT_QUOTE_V1" && row.supplierEstimateMicros !== null && row.supplierCostMicros === null && ["READY", "FAILED"].includes(row.status);
    if (!provisional && row.status !== "NEEDS_RECONCILIATION") throw new AppError(409, "Only uncertain supplier jobs or completed provisional expense can be reconciled.");
    // Actual overspend must reduce future capacity rather than disappear behind a quote ceiling.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403218)::text`;
    await tx.supplierAuthorization.update({ where: { key: row.id }, data: { ceilingMicros: Math.max(row.supplierCeilingMicros, input.supplierCostMicros) } });
    const now = new Date();
    const receipt = { ...(row.receipt && typeof row.receipt === "object" && !Array.isArray(row.receipt) ? row.receipt : {}), evidence: input.evidence, operatorId: input.operatorId, reconciledAt: now.toISOString() };
    if (provisional) {
      // The delivered price and customer reservation are immutable. Reconciliation
      // is supplier accounting only, including real losses above the authorization.
      await tx.videoGeneration.update({ where: { id: row.id }, data: { supplierCostMicros: input.supplierCostMicros, supplierReconciledAt: now, receipt } });
      await tx.auditEvent.create({ data: { ...scope, action: "SHOT_EXPENSE_RECONCILED", detail: "Final supplier expense verified against independent evidence. Provisional estimate, delivered output and customer credit settlement preserved; no customer repricing or provider request." } });
      return { ok: true };
    }
    await finishReservationInTransaction(tx, row.organizationId, row.reservationId!, 0);
    await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "FAILED", errorCode: "RECONCILED_NO_DELIVERABLE", supplierCostMicros: input.supplierCostMicros, supplierReconciledAt: now, settledAt: now, leaseUntil: null, nextPollAt: null, receipt } });
    await tx.videoClip.updateMany({ where: { generationId: row.id }, data: { status: "FAILED", approvedBy: null, leaseUntil: null, purgeAfter: new Date(Date.now() + 7 * 86400000) } });
    await tx.auditEvent.create({ data: { ...scope, action: "SHOT_RECONCILED", detail: "Operator verified final expense; customer hold released. No uncertain footage delivered or supplier resubmission authorized." } });
    return { ok: true };
  });
}
