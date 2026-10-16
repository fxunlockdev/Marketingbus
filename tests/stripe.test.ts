import { afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { createStripeAdapter, configuredStripe, STRIPE_API_VERSION } from "../src/lib/providers/stripe";
import { billingTermsHash } from "../src/lib/billing/terms";
import type { BillingOffer } from "../src/lib/billing/contracts";
const config = { key: "sk_test_fixture", webhookSecret: "whsec_fixture_secret_not_real", accountId: "acct_fixture", mode: "test", origin: "https://studio.example", portalConfiguration: "bpc_fixture" };
const sdk = new Stripe(config.key);
const offer: BillingOffer = { id: "monthly", name: "Monthly", kind: "SUBSCRIPTION", currency: "usd", amountMinor: 80000, generalCredits: 6400, revisionCredits: 1600, stripePriceId: "price_monthly" };
type Data = Record<string, unknown>;
function fixture(kind: "SUBSCRIPTION" | "TOPUP" = "SUBSCRIPTION") {
  const terms = { ...offer, kind }, m = { app: "marketingbus", checkout_id: "checkoutFixture", organization_id: "orgFixture", terms_hash: billingTermsHash(terms), price_id: "price_monthly" };
  const price = { id: "price_monthly", object: "price", active: true, livemode: false, currency: "usd", unit_amount: 80000, billing_scheme: "per_unit", tax_behavior: "exclusive", type: kind === "SUBSCRIPTION" ? "recurring" : "one_time", recurring: kind === "SUBSCRIPTION" ? { interval: "month", interval_count: 1, usage_type: "licensed" } : null };
  const pi = { id: "pi_paid", object: "payment_intent", livemode: false, status: "succeeded", customer: "cus_fixture", currency: "usd", amount: 80000, amount_received: 80000, metadata: m };
  const session = { id: "cs_test_fixture", object: "checkout.session", livemode: false, mode: kind === "SUBSCRIPTION" ? "subscription" : "payment", client_reference_id: "checkoutFixture", metadata: m, status: "complete", payment_status: "paid", customer: "cus_fixture", payment_intent: "pi_paid", currency: "usd", amount_total: 80000, total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 } };
  const line = { type: "subscription", subscription: "sub_fixture", quantity: 1, proration: false, price, amount: 80000, period: { start: 1790812800, end: 1793491200 } };
  const invoice = { id: "in_fixture", object: "invoice", livemode: false, subscription_details: { metadata: m }, subscription: "sub_fixture", customer: "cus_fixture", payment_intent: "pi_paid", status: "paid", paid: true, paid_out_of_band: false, currency: "usd", billing_reason: "subscription_create", amount_paid: 80000, amount_due: 80000, amount_remaining: 0, total: 80000, starting_balance: 0, ending_balance: 0, total_discount_amounts: [], total_tax_amounts: [], lines: { has_more: false, data: [line] } };
  const charge = { id: "ch_fixture", object: "charge", livemode: false, payment_intent: "pi_paid", paid: true, captured: true, currency: "usd", amount: 80000, amount_refunded: 40000 };
  const objects = new Map<string, Data>([["account", { id: config.accountId, object: "account" }], ["prices/price_monthly", price], ["payment_intents/pi_paid", pi], ["invoices/in_fixture", invoice], ["charges/ch_fixture", charge], ["checkout/sessions/cs_test_fixture", session], ["checkout/sessions/cs_test_fixture/line_items?limit=2", { has_more: false, data: [{ quantity: 1, price, amount_total: 80000, currency: "usd" }] }], ["customers/cus_fixture", { id: "cus_fixture", object: "customer", livemode: false }], ["billing_portal/configurations/bpc_fixture", { id: "bpc_fixture", livemode: false, active: true, features: { subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: "at_period_end" } } }]]);
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/^https:\/\/api\.stripe\.com\/v1\//); expect(init.redirect).toBe("error"); expect(init.signal).toBeDefined();
    expect(new Headers(init.headers).get("Stripe-Version")).toBe(STRIPE_API_VERSION);
    const path = url.slice("https://api.stripe.com/v1/".length);
    if (!objects.has(path)) throw Error(`Unexpected fixture request ${path}`);
    return Response.json(objects.get(path));
  });
  const adapter = createStripeAdapter(config, transport);
  function signed(type: string, object: Data, patch: Data = {}, timestamp = Math.floor(Date.now() / 1000)) {
    const event = { id: "evt_fixture", object: "event", api_version: STRIPE_API_VERSION, type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object }, ...patch };
    objects.set("events/evt_fixture", structuredClone(event));
    const body = JSON.stringify(event), signature = sdk.webhooks.generateTestHeaderString({ payload: body, secret: config.webhookSecret, timestamp });
    return { raw: Buffer.from(body), headers: new Headers({ "stripe-signature": signature }) };
  }
  const verify = (type: string, object: Data, patch: Data = {}) => { const s = signed(type, object, patch); return adapter.verify(s.raw, s.headers); };
  return { adapter, transport, objects, signed, verify, terms, m, price, pi, session, invoice, line, charge };
}
afterEach(() => vi.unstubAllEnvs());
describe("Stripe transport with actual signature verification and injected HTTP", () => {
  it("stays disabled for absent, malformed or mismatched server configuration", () => {
    vi.stubEnv("BILLING_EXECUTION_ENABLED", "false"); expect(configuredStripe()).toBeNull();
    vi.stubEnv("BILLING_EXECUTION_ENABLED", "true"); expect(configuredStripe()).toBeNull();
    for (const patch of [{ origin: "http://public.example" }, { mode: "live" }, { origin: "https://studio.example/path" }, { origin: "https://a:b@studio.example" }]) expect(() => createStripeAdapter({ ...config, ...patch })).toThrow();
  });
  it.each(["SUBSCRIPTION", "TOPUP"] as const)("creates a frozen %s checkout with stable idempotency and no browser-supplied terms", async kind => {
    const f = fixture(kind); f.objects.set("checkout/sessions", { ...f.session, status: "open", url: "https://checkout.stripe.com/c/pay/fixture" });
    const input = { id: "checkoutFixture", organizationId: "orgFixture", offer: f.terms, expiresAt: new Date(Date.now() + 3600000) };
    await f.adapter.checkout(input); await f.adapter.checkout(input);
    const calls = f.transport.mock.calls.filter(([url]) => url.endsWith("/checkout/sessions")); expect(calls).toHaveLength(2);
    const a = calls[0][1], b = calls[1][1], body = a.body as URLSearchParams;
    expect(new Headers(a.headers).get("Idempotency-Key")).toBe(new Headers(b.headers).get("Idempotency-Key"));
    expect(body.toString()).toBe((b.body as URLSearchParams).toString());
    expect(body.get("line_items[0][price]")).toBe("price_monthly"); expect(body.has("line_items[0][price_data][unit_amount]")).toBe(false);
    expect(body.get("metadata[terms_hash]")).toBe(billingTermsHash(f.terms)); expect(body.get("automatic_tax[enabled]")).toBe("false");
    expect(body.get("success_url")).toBe("https://studio.example/studio?billing=returned");
    expect(body.get("customer_creation")).toBe(kind === "TOPUP" ? "always" : null);
  });
  it.each(["account", "amount", "interval", "currency", "mode", "inactive"])("rejects %s mismatches before creating checkout", async reason => {
    const f = fixture();
    if (reason === "account") f.objects.set("account", { id: "acct_wrong", object: "account" });
    else f.objects.set("prices/price_monthly", { ...f.price, ...({ amount: { unit_amount: 1 }, interval: { recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } }, currency: { currency: "eur" }, mode: { livemode: true }, inactive: { active: false } }[reason]) });
    await expect(f.adapter.checkout({ id: "checkoutFixture", organizationId: "orgFixture", offer, expiresAt: new Date(Date.now() + 3600000) })).rejects.toThrow();
    expect(f.transport.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
  it("rejects tampering, expired/future signatures, connected accounts, mode and API drift before network access", async () => {
    const f = fixture(), now = Math.floor(Date.now() / 1000);
    for (const patch of [{ livemode: true }, { account: "acct_other" }, { context: "acct_other" }, { api_version: "2025-03-31.basil" }]) { const s = f.signed("invoice.paid", f.invoice, patch); await expect(f.adapter.verify(s.raw, s.headers)).rejects.toThrow("invalid"); }
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    try {
      for (const timestamp of [now - 301, now + 301]) { const s = f.signed("invoice.paid", f.invoice, {}, timestamp); await expect(f.adapter.verify(s.raw, s.headers)).rejects.toThrow("invalid"); }
    } finally { clock.mockRestore(); }
    const s = f.signed("invoice.paid", f.invoice); await expect(f.adapter.verify(Buffer.concat([s.raw, Buffer.from(" ")]), s.headers)).rejects.toThrow("invalid");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("independently retrieves immutable event evidence and rejects a substituted event snapshot", async () => {
    const f = fixture(), s = f.signed("invoice.paid", f.invoice);
    f.objects.set("events/evt_fixture", { ...f.objects.get("events/evt_fixture"), data: { object: { ...f.invoice, amount_paid: 1 } } });
    await expect(f.adapter.verify(s.raw, s.headers)).rejects.toThrow("evidence");
  });
  it("normalizes paid monthly invoices from the subscription line period, with exact frozen proof", async () => {
    const f = fixture(), event = await f.verify("invoice.paid", f.invoice);
    expect(event).toMatchObject({ kind: "PAID", paymentId: "pi_paid", checkoutId: "checkoutFixture", subscriptionId: "sub_fixture", amountMinor: 80000, periodStart: new Date(f.line.period.start * 1000).toISOString(), periodEnd: new Date(f.line.period.end * 1000).toISOString(), proof: { organizationId: "orgFixture", termsHash: billingTermsHash(offer), priceId: "price_monthly" } });
    f.invoice.billing_reason = "subscription_cycle";
    expect(await f.verify("invoice.paid", f.invoice)).toMatchObject({ checkoutId: null });
  });
  it("does not mint subscription credits from checkout completion or unowned invoices", async () => {
    const f = fixture(); expect(await f.verify("checkout.session.completed", f.session)).toBeNull();
    expect(await f.verify("invoice.paid", { ...f.invoice, subscription_details: { metadata: {} } })).toBeNull();
  });
  it("verifies a paid top-up through checkout, price line and actual payment intent", async () => {
    const f = fixture("TOPUP"); expect(await f.verify("checkout.session.completed", f.session)).toMatchObject({ kind: "PAID", paymentId: "pi_paid", subscriptionId: null, periodStart: null, amountMinor: 80000 });
    f.pi.status = "processing"; await expect(f.verify("checkout.session.completed", f.session)).rejects.toThrow("evidence");
  });
  it("retains altered commercial terms for review instead of granting credits", async () => {
    const f = fixture(); f.invoice.total_discount_amounts = [{ amount: 100 }] as never[];
    expect(await f.verify("invoice.paid", f.invoice)).toMatchObject({ kind: "REVIEW", reason: "STRIPE_ADJUSTED_INVOICE" });
    const t = fixture("TOPUP"); t.session.total_details.amount_tax = 100;
    expect(await t.verify("checkout.session.completed", t.session)).toMatchObject({ kind: "REVIEW", reason: "STRIPE_ADJUSTED_CHECKOUT" });
  });
  it("rejects manual payment, prorations and wrong payment customer", async () => {
    for (const reason of ["manual", "proration", "customer"]) { const f = fixture(); if (reason === "manual") f.invoice.paid_out_of_band = true; if (reason === "proration") f.line.proration = true; if (reason === "customer") f.pi.customer = "cus_other"; await expect(f.verify("invoice.paid", f.invoice)).rejects.toThrow(); }
  });
  it("maps cumulative refunds from verified charge evidence without asking Stripe for another refund", async () => {
    const f = fixture(); expect(await f.verify("charge.refunded", f.charge)).toMatchObject({ kind: "REFUND", paymentId: "pi_paid", cumulativeRefundedMinor: 40000 });
    const signed = f.signed("charge.refunded", { ...f.charge, amount_refunded: 80000 }); await expect(f.adapter.verify(signed.raw, signed.headers)).rejects.toThrow("evidence");
    expect(f.transport.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
  it.each(["active", "past_due", "canceled"])("normalizes subscription %s without granting credits", async status => {
    const f = fixture(); expect(await f.verify("customer.subscription.updated", { id: "sub_fixture", object: "subscription", livemode: false, metadata: f.m, customer: "cus_fixture", status, current_period_end: f.line.period.end })).toMatchObject({ kind: "SUBSCRIPTION", status: status === "active" ? "ACTIVE" : status === "canceled" ? "CANCELLED" : "PAST_DUE" });
  });
  it("limits portal to verified customer/account and cancellation-only subscription settings", async () => {
    const f = fixture(); f.objects.set("billing_portal/sessions", { object: "billing_portal.session", livemode: false, customer: "cus_fixture", configuration: config.portalConfiguration, url: "https://billing.stripe.com/p/session/fixture" });
    expect(await f.adapter.portal("cus_fixture")).toEqual({ url: "https://billing.stripe.com/p/session/fixture" });
    f.objects.set("billing_portal/configurations/bpc_fixture", { ...f.objects.get("billing_portal/configurations/bpc_fixture"), features: { subscription_update: { enabled: true }, subscription_cancel: { enabled: true, mode: "at_period_end" } } });
    await expect(f.adapter.portal("cus_fixture")).rejects.toThrow();
  });
  it("bounds responses and makes no automatic retries on errors", async () => {
    const transport = vi.fn(async () => new Response("x".repeat(262145)));
    await expect(createStripeAdapter(config, transport).portal("cus_fixture")).rejects.toThrow("safety limit"); expect(transport).toHaveBeenCalledTimes(1);
    const failed = vi.fn(async () => Response.json({ error: { message: "private detail" } }, { status: 429 }));
    await expect(createStripeAdapter(config, failed).portal("cus_fixture")).rejects.toThrow("No automatic retry"); expect(failed).toHaveBeenCalledTimes(1);
  });
  it("submits an operator refund with stable metadata and finds it by read-only lookup", async () => {
    const f = fixture(), input = { id: crypto.randomUUID(), paymentId: "pi_paid", amountMinor: 10000 };
    const result = { id: "re_fixture", object: "refund", payment_intent: "pi_paid", amount: 10000, currency: "usd", status: "pending", metadata: { app: "marketingbus", refund_request: input.id } };
    f.objects.set("refunds", result); f.objects.set("refunds?payment_intent=pi_paid&limit=100", { has_more: false, data: [result] });
    expect(await f.adapter.refund!(input)).toMatchObject({ id: "re_fixture", status: "pending", amountMinor: 10000 });
    const post = f.transport.mock.calls.find(([url]) => url.endsWith("/refunds"))![1];
    expect(new Headers(post.headers).get("Idempotency-Key")).toBe(`marketingbus-refund-${input.id}`);
    expect((post.body as URLSearchParams).get("metadata[refund_request]")).toBe(input.id);
    const count = f.transport.mock.calls.filter(([, init]) => init.method === "POST").length;
    expect(await f.adapter.findRefund!(input)).toMatchObject({ id: "re_fixture" });
    expect(f.transport.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(count);
    f.objects.set("refunds?payment_intent=pi_paid&limit=100", { has_more: false, data: [] }); expect(await f.adapter.findRefund!(input)).toBeNull();
  });
  it("operator event lookup uses the same verification and normalization, without forging signatures", async () => {
    const f = fixture(); f.signed("invoice.paid", f.invoice);
    expect(await f.adapter.inspectEvent!("evt_fixture")).toMatchObject({ kind: "PAID", proof: { termsHash: billingTermsHash(offer) } });
    await expect(f.adapter.inspectEvent!("../account")).rejects.toThrow();
    expect(f.transport.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
});
