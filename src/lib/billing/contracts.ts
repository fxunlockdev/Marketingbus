import { z } from "zod";
import { configuredStripe } from "../providers/stripe";
export const offerSchema = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(120), kind: z.enum(["SUBSCRIPTION", "TOPUP"]), currency: z.literal("usd"), amountMinor: z.number().int().min(100).max(1000000), generalCredits: z.number().int().min(0).max(100000), revisionCredits: z.number().int().min(0).max(100000), stripePriceId: z.string().regex(/^price_[A-Za-z0-9]+$/).max(200).optional() }).strict().refine(o => o.generalCredits + o.revisionCredits > 0, "Offer must contain credits.");
export type BillingOffer = z.infer<typeof offerSchema>;
export function billingOffers() { return z.array(offerSchema).max(20).refine(offers => new Set(offers.map(o => o.id)).size === offers.length, "Duplicate billing offer IDs.").parse(JSON.parse(process.env.BILLING_OFFERS_JSON || "[]")); }
const ref = z.string().min(1).max(200);
const proof = z.object({ organizationId: ref, termsHash: z.string().regex(/^[a-f0-9]{64}$/), priceId: ref }).strict();
export const paymentEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PAID"), eventId: ref, paymentId: ref, customerId: ref, checkoutId: ref.nullable(), subscriptionId: ref.nullable(), periodStart: z.iso.datetime().nullable(), periodEnd: z.iso.datetime().nullable(), occurredAt: z.iso.datetime(), amountMinor: z.number().int().positive().max(1000000), currency: z.literal("usd"), proof: proof.optional() }).strict(),
  z.object({ kind: z.literal("REFUND"), eventId: ref, paymentId: ref, cumulativeRefundedMinor: z.number().int().nonnegative().max(1000000), occurredAt: z.iso.datetime() }).strict(),
  z.object({ kind: z.literal("SUBSCRIPTION"), eventId: ref, subscriptionId: ref, customerId: ref, status: z.enum(["ACTIVE", "PAST_DUE", "CANCELLED"]), periodEnd: z.iso.datetime(), occurredAt: z.iso.datetime(), proof: proof.optional() }).strict(),
  z.object({ kind: z.literal("REVIEW"), eventId: ref, objectId: ref, reason: z.string().regex(/^[A-Z_]+$/).max(100), occurredAt: z.iso.datetime() }).strict(),
]);
export type PaymentEvent = z.infer<typeof paymentEvent>;
export type RefundInput = { id: string; paymentId: string; amountMinor: number };
export type RefundResult = { id: string; paymentId: string; amountMinor: number; status: "pending" | "succeeded" | "failed" | "canceled" | "requires_action" };
export interface PaymentAdapter {
  // Validate signature, timestamp, provider account/livemode and authoritative payment state.
  // A checkout return URL or browser payload NEVER constitutes verified payment evidence.
  verify(raw: Uint8Array, headers: Headers): Promise<PaymentEvent | null>;
  // Provider MUST use input.id as its idempotency key; amount/credits come from frozen server terms.
  checkout(input: { id: string; organizationId: string; offer: BillingOffer; expiresAt: Date }): Promise<{ sessionId: string; url: string }>;
  portal(customerId: string): Promise<{ url: string }>;
  refund?(input: RefundInput): Promise<RefundResult>;
  findRefund?(input: RefundInput): Promise<RefundResult | null>;
  inspectEvent?(eventId: string): Promise<PaymentEvent | null>;
}
export function paymentAdapter(): PaymentAdapter | null { return configuredStripe(); }
