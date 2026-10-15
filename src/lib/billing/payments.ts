import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { addCreditsInTransaction } from "./wallet";
import { billingOffers, offerSchema, paymentEvent, paymentAdapter, type PaymentAdapter, type PaymentEvent } from "./contracts";

type Scope = { organizationId: string; actorId: string };
async function membership(tx: Prisma.TransactionClient, scope: Scope, write = false) {
  const member = await tx.membership.findFirst({ where: { organizationId: scope.organizationId, userId: scope.actorId } });
  if (!member) throw new AppError(404, "Workspace not found.");
  if (write && !["OWNER", "ADMIN"].includes(member.role)) throw new AppError(403, "Only workspace owners and administrators can manage billing.");
  return member;
}
export async function readBilling(scope: Scope) {
  return db.$transaction(async tx => {
    const member = await membership(tx, scope);
    const canManage = ["OWNER", "ADMIN"].includes(member.role);
    return {
      canManage, enabled: !!paymentAdapter(), offers: canManage ? billingOffers() : [],
      wallet: await tx.wallet.findUnique({ where: { organizationId: scope.organizationId }, select: { available: true, revisionAvailable: true, held: true, debt: true, revisionDebt: true } }),
      subscriptions: canManage ? await tx.billingSubscription.findMany({ where: { organizationId: scope.organizationId }, select: { id: true, offer: true, status: true, currentPeriodEnd: true }, orderBy: { currentPeriodEnd: "desc" }, take: 20 }) : [],
      payments: canManage ? await tx.billingPayment.findMany({ where: { organizationId: scope.organizationId }, select: { id: true, amountMinor: true, currency: true, generalCredits: true, revisionCredits: true, refundedMinor: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 50 }) : [],
      entries: await tx.creditEntry.findMany({ where: { organizationId: scope.organizationId }, select: { id: true, kind: true, amount: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 50 }),
    };
  });
}
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("checkout"), offerId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("portal"), subscriptionId: z.string().min(1).max(200) }).strict(),
]);
function redirectUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !["checkout.stripe.com", "billing.stripe.com"].includes(url.hostname)) throw new AppError(502, "Payment provider returned an invalid destination.");
  return url.href;
}
// Adapter injection is internal/test-only, never chosen by an HTTP caller.
export async function manageBilling(scope: Scope, raw: unknown, adapter: PaymentAdapter | null = paymentAdapter()) {
  const action = actionSchema.parse(raw);
  await db.$transaction(tx => membership(tx, scope, true));
  if (!adapter) throw new AppError(503, "Payments are not activated. No charge was made.");
  if (action.action === "portal") {
    const sub = await db.billingSubscription.findFirst({ where: { id: action.subscriptionId, organizationId: scope.organizationId } });
    if (!sub) throw new AppError(404, "Subscription not found.");
    return { url: redirectUrl((await adapter.portal(sub.customerId)).url) };
  }
  const offer = billingOffers().find(o => o.id === action.offerId);
  if (!offer) throw new AppError(404, "Offer is not available.");
  const checkout = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${scope.organizationId} FOR UPDATE`;
    await membership(tx, scope, true);
    if (offer.kind === "SUBSCRIPTION" && await tx.billingSubscription.count({ where: { organizationId: scope.organizationId, status: { not: "CANCELLED" } } })) throw new AppError(409, "Manage the existing subscription before starting another.");
    const prior = await tx.billingCheckout.findFirst({ where: { organizationId: scope.organizationId, status: { in: ["CREATED", "READY", "UNKNOWN"] }, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
    if (prior) {
      if (JSON.stringify(offerSchema.parse(prior.offer)) !== JSON.stringify(offer)) throw new AppError(409, "An existing checkout is still open. Finish it or wait for it to expire.");
      return prior;
    }
    return tx.billingCheckout.create({ data: { organizationId: scope.organizationId, actorId: scope.actorId, offer, expiresAt: new Date(Date.now() + 3600000) } });
  });
  if (checkout.url && checkout.status === "READY") return { url: redirectUrl(checkout.url) };
  try {
    const result = await adapter.checkout({ id: checkout.id, organizationId: scope.organizationId, offer: offerSchema.parse(checkout.offer), expiresAt: checkout.expiresAt });
    const url = redirectUrl(result.url);
    await db.billingCheckout.updateMany({ where: { id: checkout.id, status: { in: ["CREATED", "UNKNOWN", "READY"] } }, data: { status: "READY", providerSessionId: result.sessionId, url } });
    return { url };
  } catch {
    await db.billingCheckout.updateMany({ where: { id: checkout.id, status: "CREATED" }, data: { status: "UNKNOWN" } });
    throw new AppError(502, "Checkout could not be confirmed. Retry uses the same checkout; do not start a second payment.");
  }
}

// Only the signature-verifying adapter may feed this durable inbox. No public normalized-event route.
export async function ingestVerifiedPayment(raw: PaymentEvent) {
  const event = paymentEvent.parse(raw), payload = JSON.stringify(event), digest = createHash("sha256").update(payload).digest("hex");
  // Prisma's empty-update upsert can become a read-then-insert race; use database ON CONFLICT.
  await db.billingEvent.createMany({ data: [{ id: event.eventId, payload: event, digest }], skipDuplicates: true });
  const record = await db.billingEvent.findUniqueOrThrow({ where: { id: event.eventId } });
  if (record.digest !== digest) throw new AppError(409, "Payment event replay changed its contents.");
  return { accepted: true };
}
class PendingDependency extends Error {}
class ReviewRequired extends Error {}
function requirePayment(condition: unknown, reason: string): asserts condition { if (!condition) throw new ReviewRequired(reason); }
async function applyEvent(tx: Prisma.TransactionClient, event: PaymentEvent) {
  if (event.kind === "PAID") {
    const previous = await tx.billingPayment.findUnique({ where: { id: event.paymentId } });
    if (previous) {
      requirePayment(previous.amountMinor === event.amountMinor && previous.currency === event.currency && previous.subscriptionId === event.subscriptionId && previous.checkoutId === event.checkoutId && previous.periodStart?.toISOString() === (event.periodStart ? new Date(event.periodStart).toISOString() : undefined), "PAYMENT_REPLAY_CHANGED");
      return;
    }
    const checkout = event.checkoutId ? await tx.billingCheckout.findUnique({ where: { id: event.checkoutId } }) : null;
    const subscription = event.subscriptionId ? await tx.billingSubscription.findUnique({ where: { id: event.subscriptionId } }) : null;
    if (!checkout && !subscription) throw new PendingDependency("PAYMENT_SCOPE_MISSING");
    requirePayment(!event.checkoutId || checkout, "UNKNOWN_CHECKOUT");
    const organizationId = checkout?.organizationId ?? subscription!.organizationId;
    const offer = offerSchema.parse(checkout?.offer ?? subscription!.offer);
    requirePayment(event.amountMinor === offer.amountMinor && event.currency === offer.currency, "PAYMENT_TERMS_MISMATCH");
    if (checkout) requirePayment(checkout.status !== "PAID", "CHECKOUT_ALREADY_PAID");
    if (subscription) requirePayment(subscription.organizationId === organizationId && subscription.customerId === event.customerId && JSON.stringify(offerSchema.parse(subscription.offer)) === JSON.stringify(offer), "SUBSCRIPTION_SCOPE_MISMATCH");
    if (offer.kind === "SUBSCRIPTION") {
      requirePayment(event.subscriptionId && event.periodStart && event.periodEnd && new Date(event.periodEnd) > new Date(event.periodStart), "SUBSCRIPTION_PERIOD_MISSING");
      requirePayment(!await tx.billingPayment.count({ where: { subscriptionId: event.subscriptionId, periodStart: new Date(event.periodStart) } }), "SUBSCRIPTION_PERIOD_ALREADY_GRANTED");
      if (!subscription) await tx.billingSubscription.create({ data: { id: event.subscriptionId, organizationId, customerId: event.customerId, offer, status: "ACTIVE", currentPeriodEnd: new Date(event.periodEnd), updatedThrough: new Date(event.occurredAt) } });
      else if (new Date(event.occurredAt) > subscription.updatedThrough) await tx.billingSubscription.update({ where: { id: subscription.id }, data: { status: "ACTIVE", currentPeriodEnd: new Date(event.periodEnd), updatedThrough: new Date(event.occurredAt) } });
    } else requirePayment(!event.subscriptionId && !event.periodStart && !event.periodEnd, "TOPUP_HAS_SUBSCRIPTION_PERIOD");
    await tx.$queryRaw`SELECT "organizationId" FROM "Wallet" WHERE "organizationId" = ${organizationId} FOR UPDATE`;
    await addCreditsInTransaction(tx, organizationId, offer.generalCredits, offer.revisionCredits);
    await tx.billingPayment.create({ data: { id: event.paymentId, organizationId, checkoutId: event.checkoutId, subscriptionId: event.subscriptionId, periodStart: event.periodStart ? new Date(event.periodStart) : null, amountMinor: event.amountMinor, currency: event.currency, generalCredits: offer.generalCredits, revisionCredits: offer.revisionCredits } });
    await tx.creditEntry.create({ data: { organizationId, key: `payment:${event.paymentId}`, kind: "PAYMENT_GRANT", amount: offer.generalCredits + offer.revisionCredits } });
    if (checkout) await tx.billingCheckout.update({ where: { id: checkout.id }, data: { status: "PAID" } });
    return;
  }
  if (event.kind === "REFUND") {
    const payment = await tx.billingPayment.findUnique({ where: { id: event.paymentId } });
    if (!payment) throw new PendingDependency("REFUND_PAYMENT_MISSING");
    requirePayment(event.cumulativeRefundedMinor <= payment.amountMinor, "REFUND_EXCEEDS_PAYMENT");
    if (event.cumulativeRefundedMinor <= payment.refundedMinor) return;
    const general = Math.floor(payment.generalCredits * event.cumulativeRefundedMinor / payment.amountMinor), revision = Math.floor(payment.revisionCredits * event.cumulativeRefundedMinor / payment.amountMinor);
    const reclaimGeneral = general - payment.reclaimedGeneral, reclaimRevision = revision - payment.reclaimedRevision;
    await tx.$queryRaw`SELECT "organizationId" FROM "Wallet" WHERE "organizationId" = ${payment.organizationId} FOR UPDATE`;
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { organizationId: payment.organizationId } });
    const available = Math.min(wallet.available, reclaimGeneral), revisionAvailable = Math.min(wallet.revisionAvailable, reclaimRevision);
    await tx.wallet.update({ where: { organizationId: payment.organizationId }, data: { available: { decrement: available }, revisionAvailable: { decrement: revisionAvailable }, debt: { increment: reclaimGeneral - available }, revisionDebt: { increment: reclaimRevision - revisionAvailable } } });
    await tx.billingPayment.update({ where: { id: payment.id }, data: { refundedMinor: event.cumulativeRefundedMinor, reclaimedGeneral: general, reclaimedRevision: revision } });
    await tx.creditEntry.create({ data: { organizationId: payment.organizationId, key: `refund:${event.paymentId}:${event.cumulativeRefundedMinor}`, kind: "REFUND_RECLAIM", amount: reclaimGeneral + reclaimRevision } });
    return;
  }
  const sub = await tx.billingSubscription.findUnique({ where: { id: event.subscriptionId } });
  if (!sub) throw new PendingDependency("SUBSCRIPTION_MISSING");
  requirePayment(sub.customerId === event.customerId, "SUBSCRIPTION_CUSTOMER_MISMATCH");
  if (new Date(event.occurredAt) <= sub.updatedThrough) return;
  await tx.billingSubscription.update({ where: { id: sub.id }, data: { status: event.status, currentPeriodEnd: new Date(event.periodEnd), updatedThrough: new Date(event.occurredAt) } });
}

export async function processOnePayment() {
  // Small, network-free transaction. Global ordering prevents concurrent refund/renewal races.
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(71403219)`;
    const record = await tx.billingEvent.findFirst({ where: { status: { in: ["PENDING", "WAITING"] }, availableAt: { lte: new Date() } }, orderBy: { createdAt: "asc" } });
    if (!record) return false;
    // A savepoint ensures rejected events never leave partial credit/subscription changes.
    await tx.$executeRawUnsafe("SAVEPOINT payment_apply");
    try {
      await applyEvent(tx, paymentEvent.parse(record.payload));
      await tx.billingEvent.update({ where: { id: record.id }, data: { status: "APPLIED", errorCode: null, attempts: { increment: 1 } } });
    } catch (error) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT payment_apply");
      if (!(error instanceof PendingDependency) && !(error instanceof ReviewRequired) && !(error instanceof z.ZodError)) throw error;
      const waiting = error instanceof PendingDependency && record.attempts < 23;
      await tx.billingEvent.update({ where: { id: record.id }, data: { status: waiting ? "WAITING" : "NEEDS_REVIEW", errorCode: error instanceof z.ZodError ? "INVALID_EVENT_TERMS" : error.message, attempts: { increment: 1 }, availableAt: new Date(Date.now() + 3600000) } });
    }
    return true;
  });
}
