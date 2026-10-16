import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { paymentAdapter, type PaymentAdapter, type RefundResult } from "./contracts";
const inputSchema = z.object({ id: z.string().uuid(), paymentId: z.string().regex(/^pi_[A-Za-z0-9]+$/).max(200), organizationId: z.string().min(1).max(200), amountMinor: z.number().int().positive().max(1000000), operatorId: z.string().min(3).max(100), evidence: z.string().min(12).max(2000), confirm: z.literal(true) }).strict();
const view = { id: true, status: true, amountMinor: true, providerRefundId: true, createdAt: true } as const;
// Privileged server procedure only, intentionally not exposed to tenant HTTP APIs.
export async function requestBillingRefund(raw: unknown, adapter: PaymentAdapter | null = paymentAdapter()) {
  const input = inputSchema.parse(raw);
  if (process.env.STRIPE_REFUNDS_ENABLED !== "true" || !adapter?.refund) throw new AppError(503, "Operator refunds are not enabled.");
  const claim = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "BillingPayment" WHERE id = ${input.paymentId} FOR UPDATE`;
    const payment = await tx.billingPayment.findFirst({ where: { id: input.paymentId, organizationId: input.organizationId } });
    if (!payment) throw new AppError(404, "Verified payment not found in this workspace.");
    const prior = await tx.billingRefundOperation.findUnique({ where: { id: input.id }, select: { ...view, paymentId: true, organizationId: true, operatorId: true, evidence: true } });
    if (prior) {
      if (prior.paymentId !== input.paymentId || prior.organizationId !== input.organizationId || prior.amountMinor !== input.amountMinor || prior.operatorId !== input.operatorId || prior.evidence !== input.evidence) throw new AppError(409, "Refund operation replay changed its terms.");
      return { row: prior, submit: false };
    }
    // Unknown and in-flight outcomes block further requests, including after a crash.
    if (await tx.billingRefundOperation.count({ where: { paymentId: input.paymentId, status: { in: ["SUBMITTING", "UNKNOWN", "PENDING", "REQUIRES_ACTION"] } } })) throw new AppError(409, "Resolve the existing refund outcome before requesting another refund.");
    const completed = await tx.billingRefundOperation.aggregate({ where: { paymentId: input.paymentId, status: "SUCCEEDED" }, _sum: { amountMinor: true } });
    // Conservative until webhook accounting catches up: never assume successful refunds are absent.
    const used = Math.max(payment.refundedMinor, completed._sum.amountMinor ?? 0);
    if (used + input.amountMinor > payment.amountMinor) throw new AppError(409, "Refund exceeds the verified remaining payment amount.");
    const row = await tx.billingRefundOperation.create({ data: { id: input.id, paymentId: input.paymentId, organizationId: input.organizationId, amountMinor: input.amountMinor, operatorId: input.operatorId, evidence: input.evidence }, select: view });
    return { row, submit: true };
  });
  if (!claim.submit) return { ...claim.row, reused: true };
  try { return await recordResult(input.id, await adapter.refund(input)); }
  catch {
    await db.billingRefundOperation.updateMany({ where: { id: input.id, status: "SUBMITTING" }, data: { status: "UNKNOWN" } });
    throw new AppError(502, "Refund outcome is unknown. Do not submit another refund. Use the read-only lookup with this operation ID.");
  }
}
async function recordResult(operationId: string, result: RefundResult) {
  const parsed = z.object({ id: z.string().regex(/^re_[A-Za-z0-9]+$/).max(200), paymentId: z.string(), amountMinor: z.number().int().positive(), status: z.enum(["pending", "succeeded", "failed", "canceled", "requires_action"]) }).strict().parse(result);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "BillingRefundOperation" WHERE id = ${operationId} FOR UPDATE`;
    const row = await tx.billingRefundOperation.findUniqueOrThrow({ where: { id: operationId } });
    if (row.paymentId !== parsed.paymentId || row.amountMinor !== parsed.amountMinor || row.providerRefundId && row.providerRefundId !== parsed.id) throw new AppError(409, "Refund lookup does not match the authorized operation.");
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(row.status)) {
      if (row.status !== parsed.status.toUpperCase()) throw new AppError(409, "Refund terminal state changed. Operator review is required.");
      return { id: row.id, status: row.status, amountMinor: row.amountMinor, providerRefundId: row.providerRefundId, createdAt: row.createdAt };
    }
    return tx.billingRefundOperation.update({ where: { id: row.id }, data: { status: parsed.status.toUpperCase(), providerRefundId: parsed.id }, select: view });
  });
}
export async function lookupBillingRefund(id: string, adapter: PaymentAdapter | null = paymentAdapter()) {
  z.string().uuid().parse(id);
  if (!adapter?.findRefund) throw new AppError(503, "Refund lookup is not configured.");
  const row = await db.billingRefundOperation.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Refund operation not found.");
  const result = await adapter.findRefund(row);
  if (!result) throw new AppError(409, "No matching refund was verified. The operation remains on hold; absence is not permission to resubmit.");
  // Only verified payment webhooks adjust credit accounting, never this response.
  return recordResult(id, result);
}
