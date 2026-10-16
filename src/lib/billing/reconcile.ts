import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { paymentAdapter, type PaymentAdapter } from "./contracts";
import { ingestVerifiedPayment } from "./payments";
const schema = z.object({ id: z.string().uuid(), eventId: z.string().regex(/^evt_[A-Za-z0-9]+$/).max(200), operatorId: z.string().min(3).max(100), evidence: z.string().min(12).max(2000), confirm: z.literal(true) }).strict();
// Operator-only. Lookup re-verifies Stripe's event; no hand-written amount or grant is accepted.
export async function reconcileBillingEvent(raw: unknown, adapter: PaymentAdapter | null = paymentAdapter()) {
  const input = schema.parse(raw);
  if (!adapter?.inspectEvent) throw new AppError(503, "Payment event lookup is not configured.");
  const event = await adapter.inspectEvent(input.eventId);
  if (!event || event.eventId !== input.eventId) throw new AppError(409, "No matching supported payment event was verified.");
  await ingestVerifiedPayment(event); // Digest rejects altered replay before any reset.
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(71403219)`;
    const record = await tx.billingEvent.findUniqueOrThrow({ where: { id: input.eventId } });
    const prior = await tx.billingReconciliation.findUnique({ where: { id: input.id } });
    if (prior) {
      if (prior.eventId !== input.eventId || prior.operatorId !== input.operatorId || prior.evidence !== input.evidence) throw new AppError(409, "Reconciliation replay changed its evidence.");
      return { eventId: record.id, status: record.status, reused: true };
    }
    if (record.status === "NEEDS_REVIEW" && !["PAYMENT_SCOPE_MISSING", "REFUND_PAYMENT_MISSING", "SUBSCRIPTION_MISSING"].includes(record.errorCode ?? "")) throw new AppError(409, "This event has unsupported or conflicting terms. Reconciliation cannot bypass its review gate.");
    if (await tx.billingReconciliation.count({ where: { eventId: record.id } }) >= 20) throw new AppError(409, "Operator retry allowance reached. Investigate the unresolved dependency.");
    await tx.billingReconciliation.create({ data: { id: input.id, eventId: input.eventId, operatorId: input.operatorId, evidence: input.evidence } });
    if (record.status !== "APPLIED") await tx.billingEvent.update({ where: { id: record.id }, data: { status: "PENDING", errorCode: null, attempts: 0, availableAt: new Date() } });
    return { eventId: record.id, status: record.status === "APPLIED" ? "APPLIED" : "PENDING", reused: false };
  });
}
