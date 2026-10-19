import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { manageBilling, readBilling, ingestVerifiedPayment, processOnePayment } from "../src/lib/billing/payments";
import { receivePaymentWebhook } from "../src/lib/billing/webhook";
import { reserveCredits, finishReservation } from "../src/lib/billing/wallet";
import { billingOffers, type BillingOffer, type PaymentAdapter, type PaymentEvent } from "../src/lib/billing/contracts";
import { billingTermsHash } from "../src/lib/billing/terms";
import { reconcileBillingEvent } from "../src/lib/billing/reconcile";
import { readCreditReport } from "../scripts/operations/credit-report";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local fixture database required");
suite("billing application boundary and credit accounting", () => {
  const orgs: string[] = [], users: string[] = [], events: string[] = [];
  const offer: BillingOffer = { id: "fixture", name: "Test monthly", kind: "SUBSCRIPTION", currency: "usd", amountMinor: 80000, generalCredits: 6400, revisionCredits: 1600 };
  const adapter: PaymentAdapter = { verify: vi.fn(async () => { throw Error("No real webhook accepted by fixture"); }), checkout: vi.fn(async input => ({ sessionId: `session_${input.id}`, url: `https://checkout.stripe.com/c/pay/${input.id}` })), portal: vi.fn(async () => ({ url: "https://billing.stripe.com/p/session/fixture" })) };
  afterAll(async () => {
    await db.billingReconciliation.deleteMany({ where: { eventId: { in: events } } });
    await db.billingEvent.deleteMany({ where: { id: { in: events } } });
    await db.billingPayment.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.billingSubscription.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup() {
    vi.stubEnv("BILLING_OFFERS_JSON", JSON.stringify([offer]));
    const user = await db.user.create({ data: { name: "Billing fixture", email: `${crypto.randomUUID()}@example.test`, passwordHash: "fixture" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "Billing fixture", wallet: { create: {} }, memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    return { organizationId: org.id, actorId: user.id };
  }
  async function paid(scope: Awaited<ReturnType<typeof setup>>, selected = offer) {
    const checkout = await db.billingCheckout.create({ data: { organizationId: scope.organizationId, actorId: scope.actorId, offer: selected, expiresAt: new Date(Date.now() + 3600000) } });
    const event: Extract<PaymentEvent, { kind: "PAID" }> = { kind: "PAID", eventId: crypto.randomUUID(), paymentId: crypto.randomUUID(), checkoutId: checkout.id, customerId: crypto.randomUUID(), subscriptionId: selected.kind === "SUBSCRIPTION" ? crypto.randomUUID() : null, amountMinor: selected.amountMinor, currency: "usd", occurredAt: "2026-10-15T10:00:00Z", periodStart: selected.kind === "SUBSCRIPTION" ? "2026-10-01T00:00:00Z" : null, periodEnd: selected.kind === "SUBSCRIPTION" ? "2026-11-01T00:00:00Z" : null };
    return event;
  }
  async function ingest(event: PaymentEvent) { events.push(event.eventId); await ingestVerifiedPayment(event); }
  async function apply(event: PaymentEvent) { await ingest(event); await processOnePayment(); return db.billingEvent.findUniqueOrThrow({ where: { id: event.eventId } }); }
  const wallet = (organizationId: string) => db.wallet.findUniqueOrThrow({ where: { organizationId } });
  it("fails closed without an adapter and checks membership before payment operations", async () => {
    const a = await setup(), b = await setup();
    await expect(manageBilling(a, { action: "checkout", offerId: offer.id })).rejects.toThrow("not activated");
    await expect(readBilling({ ...a, actorId: b.actorId })).rejects.toThrow("not found");
    await db.membership.updateMany({ where: { organizationId: a.organizationId }, data: { role: "EDITOR" } });
    expect((await readBilling(a)).canManage).toBe(false);
    await expect(manageBilling(a, { action: "checkout", offerId: offer.id }, adapter)).rejects.toThrow("administrators");
    expect((await wallet(a.organizationId)).available).toBe(0);
  });
  it("uses one frozen checkout across concurrent retries and rejects changed browser terms", async () => {
    const a = await setup();
    const urls = await Promise.all([manageBilling(a, { action: "checkout", offerId: offer.id }, adapter), manageBilling(a, { action: "checkout", offerId: offer.id }, adapter)]);
    expect(urls[0]).toEqual(urls[1]);
    expect(await db.billingCheckout.count({ where: { organizationId: a.organizationId } })).toBe(1);
    await expect(manageBilling(a, { action: "checkout", offerId: offer.id, amountMinor: 1 }, adapter)).rejects.toThrow();
    vi.stubEnv("BILLING_OFFERS_JSON", JSON.stringify([{ ...offer, amountMinor: 90000 }]));
    await expect(manageBilling(a, { action: "checkout", offerId: offer.id }, adapter)).rejects.toThrow("still open");
  });
  it("retains the same idempotency key after ambiguous checkout responses", async () => {
    const a = await setup(), fail = { ...adapter, checkout: vi.fn(async () => { throw Error("timeout"); }) };
    await expect(manageBilling(a, { action: "checkout", offerId: offer.id }, fail)).rejects.toThrow("same checkout");
    const prior = await db.billingCheckout.findFirstOrThrow({ where: { organizationId: a.organizationId } });
    expect(prior.status).toBe("UNKNOWN");
    const result = await manageBilling(a, { action: "checkout", offerId: offer.id }, adapter);
    expect(result.url).toContain(prior.id);
  });
  it("rejects unsafe provider redirects without granting credits", async () => {
    const a = await setup();
    await expect(manageBilling(a, { action: "checkout", offerId: offer.id }, { ...adapter, checkout: async () => ({ sessionId: "bad", url: "https://checkout.stripe.com.attacker.example/" }) })).rejects.toThrow("could not be confirmed");
    expect((await wallet(a.organizationId)).available).toBe(0);
  });
  it("grants exactly once under event and worker replay, preserving protected revisions", async () => {
    const a = await setup(), event = await paid(a); await Promise.all([ingest(event), ingest(event)]);
    await Promise.all([processOnePayment(), processOnePayment()]);
    await apply({ ...event, eventId: crypto.randomUUID() });
    expect(await wallet(a.organizationId)).toMatchObject({ available: 6400, revisionAvailable: 1600 });
    await expect(ingestVerifiedPayment({ ...event, amountMinor: 1 })).rejects.toThrow("replay changed");
    await expect(reserveCredits(a.organizationId, "over", 6401)).rejects.toThrow("Insufficient");
    const revision = await reserveCredits(a.organizationId, "revision", 1800, true);
    expect(revision.revisionCredits).toBe(1600);
    await finishReservation(a.organizationId, revision.id, 1500);
    expect(await wallet(a.organizationId)).toMatchObject({ available: 6400, revisionAvailable: 100, held: 0 });
  });
  it("rejects paid-event term mismatches without any partial subscription or credit writes", async () => {
    const a = await setup(), event = await paid(a);
    expect((await apply({ ...event, amountMinor: 1 })).status).toBe("NEEDS_REVIEW");
    expect((await wallet(a.organizationId)).available).toBe(0);
    expect(await db.billingSubscription.count({ where: { organizationId: a.organizationId } })).toBe(0);
  });
  it("grants renewals once per paid period, not through a monthly timer", async () => {
    const a = await setup(), event = await paid(a); await apply(event);
    const renewal = { ...event, eventId: crypto.randomUUID(), paymentId: crypto.randomUUID(), checkoutId: null, periodStart: "2026-11-01T00:00:00Z", periodEnd: "2026-12-01T00:00:00Z", occurredAt: "2026-11-01T01:00:00Z" };
    expect((await apply(renewal)).status).toBe("APPLIED");
    expect((await apply({ ...renewal, eventId: crypto.randomUUID(), paymentId: crypto.randomUUID() })).status).toBe("NEEDS_REVIEW");
    expect(await wallet(a.organizationId)).toMatchObject({ available: 12800, revisionAvailable: 3200 });
    await expect(manageBilling(a, { action: "checkout", offerId: offer.id }, adapter)).rejects.toThrow("existing subscription");
  });
  it("applies cumulative partial refunds once and resolves held-credit debt on release", async () => {
    const a = await setup(), event = await paid(a); await apply(event);
    const hold = await reserveCredits(a.organizationId, "held", 6000);
    const refund: PaymentEvent = { kind: "REFUND", eventId: crypto.randomUUID(), paymentId: event.paymentId, cumulativeRefundedMinor: 40000, occurredAt: "2026-10-16T10:00:00Z" };
    await apply(refund); await apply({ ...refund, eventId: crypto.randomUUID() });
    expect(await wallet(a.organizationId)).toMatchObject({ available: 0, debt: 2800, revisionAvailable: 800, held: 6000 });
    expect((await readCreditReport(db, a.organizationId)).needsAttention).toBe(false);
    await expect(reserveCredits(a.organizationId, "blocked", 1, true)).rejects.toThrow("refund adjustment");
    await finishReservation(a.organizationId, hold.id, 1000);
    expect(await wallet(a.organizationId)).toMatchObject({ available: 2200, debt: 0, held: 0 });
    await apply({ ...refund, eventId: crypto.randomUUID(), cumulativeRefundedMinor: 100 });
    expect((await wallet(a.organizationId)).available).toBe(2200);
    await apply({ ...refund, eventId: crypto.randomUUID(), cumulativeRefundedMinor: 80000 });
    expect(await wallet(a.organizationId)).toMatchObject({ available: 0, debt: 1000, revisionAvailable: 0 });
    expect((await readCreditReport(db, a.organizationId)).needsAttention).toBe(false);
    await apply(await paid(a, { ...offer, kind: "TOPUP", amountMinor: 20000, generalCredits: 2000, revisionCredits: 0 }));
    expect(await wallet(a.organizationId)).toMatchObject({ available: 1000, debt: 0, revisionAvailable: 0 });
    expect((await readCreditReport(db, a.organizationId)).needsAttention).toBe(false);
  });
  it("retains out-of-order refunds and applies them after their payment arrives", async () => {
    const a = await setup(), event = await paid(a);
    const refund: PaymentEvent = { kind: "REFUND", eventId: crypto.randomUUID(), paymentId: event.paymentId, cumulativeRefundedMinor: event.amountMinor, occurredAt: "2026-10-16T10:00:00Z" };
    expect((await apply(refund)).status).toBe("WAITING");
    await apply(event);
    await db.billingEvent.update({ where: { id: refund.eventId }, data: { availableAt: new Date(0) } }); await processOnePayment();
    expect(await wallet(a.organizationId)).toMatchObject({ available: 0, revisionAvailable: 0, debt: 0 });
  });
  it("cannot move subscriptions across tenants or regress newer subscription state", async () => {
    const a = await setup(), b = await setup(), event = await paid(a); await apply(event);
    await apply({ kind: "SUBSCRIPTION", eventId: crypto.randomUUID(), subscriptionId: event.subscriptionId!, customerId: event.customerId, status: "CANCELLED", periodEnd: event.periodEnd!, occurredAt: "2026-10-20T00:00:00Z" });
    await apply({ kind: "SUBSCRIPTION", eventId: crypto.randomUUID(), subscriptionId: event.subscriptionId!, customerId: event.customerId, status: "ACTIVE", periodEnd: event.periodEnd!, occurredAt: "2026-10-16T00:00:00Z" });
    expect((await db.billingSubscription.findUniqueOrThrow({ where: { id: event.subscriptionId! } })).status).toBe("CANCELLED");
    const foreign = await paid(b);
    expect((await apply({ ...foreign, subscriptionId: event.subscriptionId })).status).toBe("NEEDS_REVIEW");
    expect((await wallet(b.organizationId)).available).toBe(0);
    await expect(manageBilling(b, { action: "portal", subscriptionId: event.subscriptionId }, adapter)).rejects.toThrow("not found");
  });
  it("supports top-ups without creating subscriptions and rejects duplicate catalog IDs", async () => {
    const a = await setup(), event = await paid(a, { ...offer, kind: "TOPUP", amountMinor: 10000, generalCredits: 1000, revisionCredits: 0 }); await apply(event);
    expect((await wallet(a.organizationId)).available).toBe(1000);
    expect(await db.billingSubscription.count({ where: { organizationId: a.organizationId } })).toBe(0);
    vi.stubEnv("BILLING_OFFERS_JSON", JSON.stringify([offer, offer])); expect(() => billingOffers()).toThrow("Duplicate");
  });
  it("binds Stripe grants to the frozen workspace, price and credit terms", async () => {
    const a = await setup(), terms = { ...offer, stripePriceId: "price_fixture" }, event = await paid(a, terms);
    expect((await apply(event)).errorCode).toBe("PAYMENT_BINDING_MISSING");
    const proof = { organizationId: a.organizationId, termsHash: billingTermsHash(terms), priceId: "price_fixture" };
    for (const change of [{ organizationId: "another-workspace" }, { termsHash: "a".repeat(64) }, { priceId: "price_other" }]) expect((await apply({ ...event, eventId: crypto.randomUUID(), proof: { ...proof, ...change } })).errorCode).toBe("PAYMENT_BINDING_MISMATCH");
    expect((await wallet(a.organizationId)).available).toBe(0);
    expect((await apply({ ...event, eventId: crypto.randomUUID(), proof })).status).toBe("APPLIED");
    expect((await wallet(a.organizationId)).available).toBe(6400);
  });
  it("does not resurrect cancelled subscriptions with same-second status or delayed payment", async () => {
    const a = await setup(), event = await paid(a); await apply(event);
    await apply({ kind: "SUBSCRIPTION", eventId: crypto.randomUUID(), subscriptionId: event.subscriptionId!, customerId: event.customerId, status: "CANCELLED", periodEnd: event.periodEnd!, occurredAt: event.occurredAt });
    await apply({ ...event, eventId: crypto.randomUUID(), checkoutId: null, paymentId: crypto.randomUUID(), periodStart: "2026-11-01T00:00:00Z", periodEnd: "2026-12-01T00:00:00Z", occurredAt: "2026-11-01T00:00:00Z" });
    expect((await db.billingSubscription.findUniqueOrThrow({ where: { id: event.subscriptionId! } })).status).toBe("CANCELLED");
  });
  it("rechecks billing authority after an external checkout call before releasing its URL", async () => {
    const a = await setup();
    await expect(manageBilling(a, { action: "checkout", offerId: offer.id }, { ...adapter, checkout: async input => { await db.membership.updateMany({ where: { organizationId: a.organizationId }, data: { role: "VIEWER" } }); return adapter.checkout(input); } })).rejects.toThrow("could not be confirmed");
    expect((await readBilling(a)).checkouts).toEqual([]); expect((await readBilling(a)).refunds).toEqual([]);
    expect((await wallet(a.organizationId)).available).toBe(0);
  });
  it("retains unsupported financial events for review without altering credits", async () => {
    const a = await setup(); expect((await apply({ kind: "REVIEW", eventId: crypto.randomUUID(), objectId: "in_fixture", reason: "STRIPE_ADJUSTED_INVOICE", occurredAt: new Date().toISOString() })).status).toBe("NEEDS_REVIEW");
    expect((await wallet(a.organizationId)).available).toBe(0);
    expect(await receivePaymentWebhook(new Request("https://app.example/", { method: "POST", body: "ignored" }), { ...adapter, verify: async () => null })).toEqual({ accepted: true, ignored: true });
  });
  it("rechecks authoritative events and audits dependency retries without duplicate grants", async () => {
    const a = await setup(), event = { ...await paid(a), eventId: `evt_${crypto.randomUUID().replaceAll("-", "")}` }; events.push(event.eventId);
    const input = { id: crypto.randomUUID(), eventId: event.eventId, operatorId: "test-operator", evidence: "Verified missing webhook and Stripe event in support case", confirm: true };
    const provider = { ...adapter, inspectEvent: vi.fn(async () => event) };
    expect((await reconcileBillingEvent(input, provider)).status).toBe("PENDING"); await processOnePayment();
    expect((await reconcileBillingEvent(input, provider)).status).toBe("APPLIED");
    expect(await db.billingReconciliation.count({ where: { eventId: event.eventId } })).toBe(1);
    expect((await wallet(a.organizationId)).available).toBe(6400);
    await expect(reconcileBillingEvent({ ...input, evidence: "Changed operator evidence after retry" }, provider)).rejects.toThrow("replay changed");
    await expect(reconcileBillingEvent({ ...input, id: crypto.randomUUID() }, { ...provider, inspectEvent: async () => ({ ...event, amountMinor: 1 }) })).rejects.toThrow("replay changed");
  });
  it("does not let operator recovery override unsupported payment terms", async () => {
    const event: PaymentEvent = { kind: "REVIEW", eventId: `evt_${crypto.randomUUID().replaceAll("-", "")}`, objectId: "in_review", reason: "STRIPE_ADJUSTED_INVOICE", occurredAt: new Date().toISOString() }; await apply(event);
    const input = { id: crypto.randomUUID(), eventId: event.eventId, operatorId: "test-operator", evidence: "Verified invoice requires commercial policy review", confirm: true };
    await expect(reconcileBillingEvent(input, { ...adapter, inspectEvent: async () => event })).rejects.toThrow("cannot bypass");
    expect(await db.billingReconciliation.count({ where: { eventId: event.eventId } })).toBe(0);
    await expect(reconcileBillingEvent(input, { ...adapter, inspectEvent: async () => null })).rejects.toThrow("No matching");
  });
  it("requires signature verification over exact bytes and bounds webhook bodies", async () => {
    const a = await setup(), event = await paid(a), body = ' { "original": true } ';
    const verify = vi.fn(async (raw: Uint8Array, headers: Headers) => { expect(Buffer.from(raw).toString()).toBe(body); expect(headers.get("signature")).toBe("fixture"); return event; }); events.push(event.eventId);
    await receivePaymentWebhook(new Request("https://app.example/api/billing/webhook", { method: "POST", headers: { signature: "fixture" }, body }), { ...adapter, verify });
    expect((await wallet(a.organizationId)).available).toBe(0); // durable inbox is not a grant
    await processOnePayment(); expect((await wallet(a.organizationId)).available).toBe(6400);
    await expect(receivePaymentWebhook(new Request("https://app.example/", { method: "POST", body: "x".repeat(262145) }), { ...adapter, verify })).rejects.toThrow("too large");
    expect(verify).toHaveBeenCalledTimes(1);
    const reject = vi.fn(async () => { throw Error("Invalid signature"); });
    await expect(receivePaymentWebhook(new Request("https://app.example/", { method: "POST", body }), { ...adapter, verify: reject })).rejects.toThrow("Invalid signature");
  });
  it("refuses real checkout before contacting Stripe when no matching billing worker is healthy", async () => {
    const a = await setup();
    for (const [key, value] of Object.entries({ BILLING_EXECUTION_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture_not_real", STRIPE_ACCOUNT_ID: "acct_workerFixture", STRIPE_MODE: "test", STRIPE_PORTAL_CONFIGURATION_ID: "bpc_fixture", APP_ORIGIN: "https://studio.example" })) vi.stubEnv(key, value);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    try { await expect(manageBilling(a, { action: "checkout", offerId: offer.id })).rejects.toThrow("Billing worker is not ready"); expect(network).not.toHaveBeenCalled(); }
    finally { network.mockRestore(); }
  });
});
