import Stripe from "stripe";
import { z } from "zod";
import { AppError } from "../http";
import type { BillingOffer, PaymentAdapter, PaymentEvent, RefundInput, RefundResult } from "../billing/contracts";
import { billingTermsHash } from "../billing/terms";

// Snapshot contracts are pinned deliberately. The webhook destination must use
// this same API version; unsupported versions are never guessed or translated.
export const STRIPE_API_VERSION = "2024-06-20";
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`)).max(200);
const seconds = z.number().int().positive().max(4102444800);
const money = z.number().int().nonnegative().max(1000000);
const metadata = z.object({ app: z.literal("marketingbus"), checkout_id: z.string().min(1).max(200), organization_id: z.string().min(1).max(200), terms_hash: z.string().regex(/^[a-f0-9]{64}$/), price_id: id("price") });
const eventSchema = z.object({ id: id("evt"), object: z.literal("event"), api_version: z.literal(STRIPE_API_VERSION), type: z.string().max(120), created: seconds, livemode: z.boolean(), account: z.string().nullish(), context: z.string().nullish(), data: z.object({ object: z.record(z.string(), z.unknown()) }) });
const configSchema = z.object({ key: z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/), webhookSecret: z.string().startsWith("whsec_").min(16), accountId: id("acct"), mode: z.enum(["test", "live"]), origin: z.url(), portalConfiguration: id("bpc") });
export type StripeConfig = z.infer<typeof configSchema>;
type Transport = (url: string, init: RequestInit) => Promise<Response>;
type ObjectData = Record<string, unknown>;
const iso = (time: number) => new Date(time * 1000).toISOString();
function required(condition: unknown): asserts condition { if (!condition) throw new AppError(409, "Stripe payment evidence does not match the supported billing terms. Operator review is required."); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function configuredStripe(): PaymentAdapter | null {
  if (process.env.BILLING_EXECUTION_ENABLED !== "true") return null;
  try { return createStripeAdapter({ key: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET, accountId: process.env.STRIPE_ACCOUNT_ID, mode: process.env.STRIPE_MODE, origin: process.env.APP_ORIGIN, portalConfiguration: process.env.STRIPE_PORTAL_CONFIGURATION_ID }); }
  catch { return null; }
}
export function createStripeAdapter(raw: unknown, transport: Transport = fetch): PaymentAdapter {
  const config = configSchema.parse(raw), origin = new URL(config.origin), live = config.mode === "live";
  if (origin.origin !== config.origin || origin.username || origin.password || (origin.protocol !== "https:" && !(config.mode === "test" && origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) || !config.key.includes(`_${config.mode}_`)) throw Error("Invalid Stripe server configuration");
  const sdk = new Stripe(config.key, { maxNetworkRetries: 0 }); // Signature verification only; HTTP below is bounded.
  async function request(path: string, body?: URLSearchParams, key?: string): Promise<ObjectData> {
    const response = await transport(`https://api.stripe.com/v1/${path}`, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${config.key}`, "Stripe-Version": STRIPE_API_VERSION, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, body });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new AppError(502, "Stripe could not confirm the operation. No automatic retry was made."); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > 262144) { await reader.cancel(); throw new AppError(502, "Stripe response exceeded the safety limit."); } chunks.push(chunk.value); }
    try { return z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw new AppError(502, "Stripe returned an invalid response."); }
  }
  async function account() { const a = await request("account"); required(a.object === "account" && a.id === config.accountId); }
  const mode = (object: ObjectData) => required(object.livemode === live);
  const evidence = (m: z.infer<typeof metadata>) => ({ organizationId: m.organization_id, termsHash: m.terms_hash, priceId: m.price_id });
  const owned = (m: unknown) => typeof m === "object" && m !== null && "app" in m && m.app === "marketingbus";
  async function intent(paymentId: string, customerId: string, amount: number) {
    const pi = await request(`payment_intents/${id("pi").parse(paymentId)}`); mode(pi);
    required(pi.id === paymentId && pi.object === "payment_intent" && pi.status === "succeeded" && pi.currency === "usd" && pi.customer === customerId && pi.amount === amount && pi.amount_received === amount && !pi.on_behalf_of && !pi.transfer_data);
  }
  async function price(offer: BillingOffer) {
    const priceId = id("price").parse(offer.stripePriceId), p = await request(`prices/${priceId}`); mode(p);
    required(p.object === "price" && p.id === priceId && p.active === true && p.currency === offer.currency && p.unit_amount === offer.amountMinor && p.billing_scheme === "per_unit" && p.tax_behavior !== "inclusive" && !p.custom_unit_amount && !p.transform_quantity);
    if (offer.kind === "SUBSCRIPTION") { const r = z.object({ interval: z.literal("month"), interval_count: z.literal(1), usage_type: z.literal("licensed") }).parse(p.recurring); required(p.type === "recurring" && r); }
    else required(p.type === "one_time" && !p.recurring);
    return priceId;
  }
  function safeUrl(raw: unknown, host: string) {
    const url = new URL(z.string().parse(raw)); required(url.protocol === "https:" && url.hostname === host && !url.username && !url.password && !url.port); return url.href;
  }
  function refundResult(raw: unknown, input: RefundInput): RefundResult {
    const result = z.object({ id: id("re"), object: z.literal("refund"), payment_intent: id("pi"), amount: money.positive(), currency: z.literal("usd"), status: z.enum(["pending", "succeeded", "failed", "canceled", "requires_action"]), metadata: z.object({ app: z.literal("marketingbus"), refund_request: z.string() }) }).parse(raw);
    required(result.payment_intent === input.paymentId && result.amount === input.amountMinor && result.metadata.refund_request === input.id);
    return { id: result.id, paymentId: result.payment_intent, amountMinor: result.amount, status: result.status };
  }
  return {
    async refund(input) {
      id("pi").parse(input.paymentId); money.positive().parse(input.amountMinor); z.string().uuid().parse(input.id);
      await account();
      const pi = await request(`payment_intents/${input.paymentId}`); mode(pi);
      required(pi.id === input.paymentId && pi.status === "succeeded" && pi.currency === "usd" && money.parse(pi.amount_received) >= input.amountMinor);
      return refundResult(await request("refunds", new URLSearchParams({ payment_intent: input.paymentId, amount: String(input.amountMinor), "metadata[app]": "marketingbus", "metadata[refund_request]": input.id }), `marketingbus-refund-${input.id}`), input);
    },
    async findRefund(input) {
      id("pi").parse(input.paymentId); await account();
      let after = "";
      for (let page = 0; page < 3; page++) {
        const list = z.object({ has_more: z.boolean(), data: z.array(z.record(z.string(), z.unknown())).max(100) }).parse(await request(`refunds?payment_intent=${input.paymentId}&limit=100${after ? `&starting_after=${after}` : ""}`));
        const matches = list.data.filter(row => typeof row.metadata === "object" && row.metadata !== null && "refund_request" in row.metadata && row.metadata.refund_request === input.id);
        required(matches.length <= 1);
        if (matches[0]) return refundResult(matches[0], input);
        if (!list.has_more) return null;
        after = id("re").parse(list.data.at(-1)?.id);
      }
      throw new AppError(409, "Refund lookup exceeded its bounded history. Keep the operation on hold for operator review.");
    },
    async checkout(input) {
      await account(); const priceId = await price(input.offer);
      const m = { app: "marketingbus", checkout_id: input.id, organization_id: input.organizationId, terms_hash: billingTermsHash(input.offer), price_id: priceId };
      const body = new URLSearchParams({ mode: input.offer.kind === "SUBSCRIPTION" ? "subscription" : "payment", "line_items[0][price]": priceId, "line_items[0][quantity]": "1", "payment_method_types[0]": "card", client_reference_id: input.id, expires_at: String(Math.floor(input.expiresAt.getTime() / 1000)), success_url: `${origin.origin}/studio?billing=returned`, cancel_url: `${origin.origin}/studio?billing=cancelled`, allow_promotion_codes: "false", "automatic_tax[enabled]": "false" });
      if (input.offer.kind === "TOPUP") body.set("customer_creation", "always");
      for (const [key, value] of Object.entries(m)) { body.set(`metadata[${key}]`, value); body.set(`${input.offer.kind === "SUBSCRIPTION" ? "subscription_data" : "payment_intent_data"}[metadata][${key}]`, value); }
      const session = await request("checkout/sessions", body, `marketingbus-checkout-${input.id}`); mode(session);
      required(session.object === "checkout.session" && session.client_reference_id === input.id && session.mode === body.get("mode") && session.status === "open");
      return { sessionId: id("cs").parse(session.id), url: safeUrl(session.url, "checkout.stripe.com") };
    },
    async portal(customerId) {
      id("cus").parse(customerId); await account();
      const customer = await request(`customers/${customerId}`); mode(customer); required(customer.object === "customer" && customer.id === customerId && !customer.deleted);
      const settings = await request(`billing_portal/configurations/${config.portalConfiguration}`); mode(settings);
      const features = z.object({ subscription_update: z.object({ enabled: z.literal(false) }), subscription_cancel: z.object({ enabled: z.literal(true), mode: z.literal("at_period_end") }) }).parse(settings.features);
      required(settings.id === config.portalConfiguration && settings.active === true && features);
      const session = await request("billing_portal/sessions", new URLSearchParams({ customer: customerId, configuration: config.portalConfiguration, return_url: `${origin.origin}/studio?billing=returned` })); mode(session);
      required(session.object === "billing_portal.session" && session.customer === customerId && session.configuration === config.portalConfiguration);
      return { url: safeUrl(session.url, "billing.stripe.com") };
    },
    async verify(raw, headers) {
      if (raw.byteLength > 262144) throw new AppError(413, "Payment event too large.");
      let signed: z.infer<typeof eventSchema>;
      try {
        const signature = headers.get("stripe-signature") || "";
        if (signature.length > 4096) throw Error("Invalid signature");
        const verified = sdk.webhooks.constructEvent(Buffer.from(raw), signature, config.webhookSecret, 300);
        signed = eventSchema.parse(verified);
        const timestamps = signature.split(",").filter(v => v.startsWith("t="));
        if (timestamps.length !== 1 || Math.abs(Date.now() / 1000 - Number(timestamps[0].slice(2))) > 300) throw Error("Expired signature");
        if (signed.account || signed.context || signed.livemode !== live) throw Error("Wrong Stripe account context");
      } catch { throw new AppError(400, "Stripe webhook signature, mode or API version is invalid."); }
      await account();
      const event = eventSchema.parse(await request(`events/${signed.id}`));
      required(!event.account && !event.context && event.livemode === live && event.id === signed.id && event.type === signed.type && event.created === signed.created && canonical(event.data.object) === canonical(signed.data.object));
      return normalizeEvent(event);
    },
    async inspectEvent(eventId) {
      id("evt").parse(eventId); await account();
      const event = eventSchema.parse(await request(`events/${eventId}`));
      required(!event.account && !event.context && event.livemode === live && event.id === eventId);
      return normalizeEvent(event);
    },
  };
  async function normalizeEvent(event: z.infer<typeof eventSchema>): Promise<PaymentEvent | null> {
      const o = event.data.object, base = { eventId: event.id, occurredAt: iso(event.created) };
      const review = (reason: string): PaymentEvent => ({ ...base, kind: "REVIEW", objectId: z.string().min(1).max(200).parse(o.id), reason });
      if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
        if (!owned(o.metadata) || o.mode !== "payment" || o.payment_status !== "paid") return null; // Subscription credits come only from invoices.
        const m = metadata.parse(o.metadata), session = await request(`checkout/sessions/${id("cs").parse(o.id)}`); mode(session);
        required(o.livemode === live && session.id === o.id && session.mode === "payment" && session.status === "complete" && session.payment_status === "paid" && session.client_reference_id === m.checkout_id && canonical(session.metadata) === canonical(o.metadata) && o.client_reference_id === m.checkout_id && o.customer === session.customer && o.payment_intent === session.payment_intent && o.amount_total === session.amount_total && session.currency === "usd");
        const details = z.object({ amount_discount: money, amount_tax: money, amount_shipping: money }).parse(session.total_details);
        if (details.amount_discount || details.amount_tax || details.amount_shipping) return review("STRIPE_ADJUSTED_CHECKOUT");
        const lines = await request(`checkout/sessions/${id("cs").parse(o.id)}/line_items?limit=2`);
        const line = z.object({ has_more: z.literal(false), data: z.array(z.object({ quantity: z.literal(1), price: z.object({ id: id("price") }), amount_total: money, currency: z.literal("usd") })).length(1) }).parse(lines).data[0];
        required(line.price.id === m.price_id && line.amount_total === session.amount_total);
        const paymentId = id("pi").parse(session.payment_intent), customerId = id("cus").parse(session.customer), amountMinor = money.positive().parse(session.amount_total);
        await intent(paymentId, customerId, amountMinor);
        return { ...base, kind: "PAID", paymentId, customerId, checkoutId: m.checkout_id, subscriptionId: null, periodStart: null, periodEnd: null, amountMinor, currency: "usd", proof: evidence(m) };
      }
      if (event.type === "invoice.paid") {
        const details = z.object({ metadata: z.unknown() }).nullish().parse(o.subscription_details);
        if (!owned(details?.metadata)) return null;
        const m = metadata.parse(details!.metadata), invoice = await request(`invoices/${id("in").parse(o.id)}`); mode(invoice);
        required(o.livemode === live && invoice.id === o.id && invoice.object === "invoice" && invoice.status === "paid" && invoice.paid === true && !invoice.paid_out_of_band && o.paid === true && !o.paid_out_of_band && invoice.currency === "usd" && invoice.amount_paid === o.amount_paid && invoice.payment_intent === o.payment_intent && invoice.customer === o.customer && invoice.subscription === o.subscription && canonical(invoice.subscription_details) === canonical(o.subscription_details));
        if (!["subscription_create", "subscription_cycle"].includes(String(o.billing_reason)) || o.amount_paid !== o.total || o.amount_due !== o.total || o.starting_balance !== 0 || o.ending_balance !== 0 || o.amount_remaining !== 0 || (o.total_discount_amounts as unknown[])?.length || (o.total_tax_amounts as unknown[])?.length) return review("STRIPE_ADJUSTED_INVOICE");
        const lines = z.object({ has_more: z.literal(false), data: z.array(z.object({ type: z.literal("subscription"), subscription: id("sub"), quantity: z.literal(1), proration: z.literal(false), price: z.object({ id: id("price"), unit_amount: money, currency: z.literal("usd"), recurring: z.object({ interval: z.literal("month"), interval_count: z.literal(1) }) }), amount: money, period: z.object({ start: seconds, end: seconds }) })).length(1) }).parse(o.lines);
        const line = lines.data[0], customerId = id("cus").parse(o.customer), subscriptionId = id("sub").parse(o.subscription), paymentId = id("pi").parse(o.payment_intent), amountMinor = money.positive().parse(o.amount_paid);
        required(line.subscription === subscriptionId && line.price.id === m.price_id && line.price.unit_amount === amountMinor && line.amount === amountMinor && line.period.end > line.period.start);
        await intent(paymentId, customerId, amountMinor);
        return { ...base, kind: "PAID", paymentId, customerId, subscriptionId, checkoutId: o.billing_reason === "subscription_create" ? m.checkout_id : null, periodStart: iso(line.period.start), periodEnd: iso(line.period.end), amountMinor, currency: "usd", proof: evidence(m) };
      }
      if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
        if (!owned(o.metadata)) return null;
        const m = metadata.parse(o.metadata); mode(o);
        const status = z.enum(["active", "past_due", "unpaid", "paused", "incomplete", "incomplete_expired", "trialing", "canceled"]).parse(o.status);
        return { ...base, kind: "SUBSCRIPTION", subscriptionId: id("sub").parse(o.id), customerId: id("cus").parse(o.customer), status: status === "active" ? "ACTIVE" : ["canceled", "incomplete_expired"].includes(status) ? "CANCELLED" : "PAST_DUE", periodEnd: iso(seconds.parse(o.current_period_end)), proof: evidence(m) };
      }
      if (event.type === "charge.refunded") {
        mode(o); const charge = await request(`charges/${id("ch").parse(o.id)}`); mode(charge);
        required(charge.object === "charge" && charge.id === o.id && charge.payment_intent === o.payment_intent && charge.paid === true && charge.captured === true && charge.currency === "usd" && money.parse(charge.amount_refunded) >= money.parse(o.amount_refunded) && money.parse(o.amount_refunded) <= money.parse(charge.amount));
        return { ...base, kind: "REFUND", paymentId: id("pi").parse(o.payment_intent), cumulativeRefundedMinor: money.parse(o.amount_refunded) };
      }
      if (event.type.startsWith("charge.dispute.") || event.type.startsWith("credit_note.")) return review("STRIPE_FINANCIAL_REVIEW");
      return null;
  }
}
