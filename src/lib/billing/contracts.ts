import { z } from "zod";
export const offerSchema = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(120), kind: z.enum(["SUBSCRIPTION", "TOPUP"]), currency: z.literal("usd"), amountMinor: z.number().int().min(100).max(1000000), generalCredits: z.number().int().min(0).max(100000), revisionCredits: z.number().int().min(0).max(100000) }).strict().refine(o => o.generalCredits + o.revisionCredits > 0, "Offer must contain credits.");
export type BillingOffer = z.infer<typeof offerSchema>;
export function billingOffers() { return z.array(offerSchema).max(20).refine(offers => new Set(offers.map(o => o.id)).size === offers.length, "Duplicate billing offer IDs.").parse(JSON.parse(process.env.BILLING_OFFERS_JSON || "[]")); }
const ref = z.string().min(1).max(200);
export const paymentEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PAID"), eventId: ref, paymentId: ref, customerId: ref, checkoutId: ref.nullable(), subscriptionId: ref.nullable(), periodStart: z.iso.datetime().nullable(), periodEnd: z.iso.datetime().nullable(), occurredAt: z.iso.datetime(), amountMinor: z.number().int().positive().max(1000000), currency: z.literal("usd") }).strict(),
  z.object({ kind: z.literal("REFUND"), eventId: ref, paymentId: ref, cumulativeRefundedMinor: z.number().int().nonnegative().max(1000000), occurredAt: z.iso.datetime() }).strict(),
  z.object({ kind: z.literal("SUBSCRIPTION"), eventId: ref, subscriptionId: ref, customerId: ref, status: z.enum(["ACTIVE", "PAST_DUE", "CANCELLED"]), periodEnd: z.iso.datetime(), occurredAt: z.iso.datetime() }).strict(),
]);
export type PaymentEvent = z.infer<typeof paymentEvent>;
export interface PaymentAdapter {
  // Validate signature, timestamp, provider account/livemode and authoritative payment state.
  // A checkout return URL or browser payload NEVER constitutes verified payment evidence.
  verify(raw: Uint8Array, headers: Headers): Promise<PaymentEvent>;
  // Provider MUST use input.id as its idempotency key; amount/credits come from frozen server terms.
  checkout(input: { id: string; organizationId: string; offer: BillingOffer; expiresAt: Date }): Promise<{ sessionId: string; url: string }>;
  portal(customerId: string): Promise<{ url: string }>;
}
export function paymentAdapter(): PaymentAdapter | null { return null; }
