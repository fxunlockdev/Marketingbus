import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { requestBillingRefund, lookupBillingRefund } from "../src/lib/billing/refunds";
import { readBilling } from "../src/lib/billing/payments";
import type { PaymentAdapter, RefundInput, RefundResult } from "../src/lib/billing/contracts";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("privileged refund single-submit and read-only recovery", () => {
  const orgs: string[] = [], users: string[] = [];
  beforeEach(() => vi.stubEnv("STRIPE_REFUNDS_ENABLED", "true"));
  afterAll(async () => { await db.billingRefundOperation.deleteMany({ where: { organizationId: { in: orgs } } }); await db.billingPayment.deleteMany({ where: { organizationId: { in: orgs } } }); await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } }); vi.unstubAllEnvs(); await db.$disconnect(); });
  async function setup() {
    const user = await db.user.create({ data: { name: "Refund fixture", email: `refund-${crypto.randomUUID()}@example.test`, passwordHash: "no-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "Refund fixture", memberships: { create: { userId: user.id, role: "OWNER" } }, wallet: { create: { available: 800 } } } }); orgs.push(org.id);
    const payment = await db.billingPayment.create({ data: { id: `pi_${crypto.randomUUID().replaceAll("-", "")}`, organizationId: org.id, amountMinor: 80000, currency: "usd", generalCredits: 800, revisionCredits: 0 } });
    const input = { id: crypto.randomUUID(), paymentId: payment.id, organizationId: org.id, amountMinor: 40000, operatorId: "fixture-operator", evidence: "Fixture support case and explicit refund authorization", confirm: true as const };
    const results = new Map<string, RefundResult>();
    const refund = vi.fn(async (i: RefundInput): Promise<RefundResult> => { const r = { id: `re_${i.id.replaceAll("-", "")}`, paymentId: i.paymentId, amountMinor: i.amountMinor, status: "succeeded" as const }; results.set(i.id, r); return r; });
    const findRefund = vi.fn(async (i: RefundInput) => results.get(i.id) ?? null);
    const adapter: PaymentAdapter = { verify: async () => null, checkout: async () => { throw Error("Unused"); }, portal: async () => { throw Error("Unused"); }, refund, findRefund };
    return { input, adapter, refund, findRefund, results, user };
  }
  it("submits once across concurrent requests and never adjusts credits from a response", async () => {
    const f = await setup(); await Promise.all([requestBillingRefund(f.input, f.adapter), requestBillingRefund(f.input, f.adapter)]);
    expect(f.refund).toHaveBeenCalledTimes(1);
    expect((await requestBillingRefund(f.input, f.adapter)).status).toBe("SUCCEEDED");
    expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: f.input.organizationId } })).available).toBe(800);
    expect(await db.creditEntry.count({ where: { organizationId: f.input.organizationId } })).toBe(0);
  });
  it("holds ambiguous outcomes, refuses resubmission and recovers by lookup only", async () => {
    const f = await setup(), ambiguous = { ...f.adapter, refund: async (i: RefundInput) => { await f.refund(i); throw Error("Acknowledgement lost"); } };
    await expect(requestBillingRefund(f.input, ambiguous)).rejects.toThrow("unknown");
    expect((await requestBillingRefund(f.input, ambiguous)).status).toBe("UNKNOWN");
    await expect(requestBillingRefund({ ...f.input, id: crypto.randomUUID() }, f.adapter)).rejects.toThrow("existing refund");
    expect((await lookupBillingRefund(f.input.id, f.adapter)).status).toBe("SUCCEEDED"); expect(f.refund).toHaveBeenCalledTimes(1); expect(f.findRefund).toHaveBeenCalledTimes(1);
  });
  it("keeps a missing provider result on hold instead of treating absence as failure", async () => {
    const f = await setup(); await expect(requestBillingRefund(f.input, { ...f.adapter, refund: async () => { throw Error("Timeout"); } })).rejects.toThrow("unknown");
    await expect(lookupBillingRefund(f.input.id, f.adapter)).rejects.toThrow("absence is not permission");
    expect((await db.billingRefundOperation.findUniqueOrThrow({ where: { id: f.input.id } })).status).toBe("UNKNOWN");
  });
  it("rejects changed replay, foreign scope, over-refunds and missing explicit confirmation", async () => {
    const f = await setup(), other = await setup();
    await expect(requestBillingRefund({ ...f.input, confirm: false }, f.adapter)).rejects.toThrow();
    await expect(requestBillingRefund({ ...f.input, organizationId: other.input.organizationId }, f.adapter)).rejects.toThrow("not found");
    await expect(requestBillingRefund({ ...f.input, amountMinor: 80001 }, f.adapter)).rejects.toThrow("remaining");
    await requestBillingRefund(f.input, f.adapter);
    await expect(requestBillingRefund({ ...f.input, amountMinor: 1 }, f.adapter)).rejects.toThrow("replay changed");
    await expect(requestBillingRefund({ ...f.input, id: crypto.randomUUID(), amountMinor: 40001 }, f.adapter)).rejects.toThrow("remaining");
  });
  it("rejects mismatched provider receipts without releasing the authorization", async () => {
    const f = await setup(); await expect(requestBillingRefund(f.input, { ...f.adapter, refund: async i => ({ ...await f.refund(i), amountMinor: 1 }) })).rejects.toThrow("unknown");
    expect((await db.billingRefundOperation.findUniqueOrThrow({ where: { id: f.input.id } })).status).toBe("UNKNOWN");
    await lookupBillingRefund(f.input.id, f.adapter);
    await expect(lookupBillingRefund(f.input.id, { ...f.adapter, findRefund: async i => ({ ...f.results.get(i.id)!, status: "failed" }) })).rejects.toThrow("terminal state");
  });
  it("exposes scoped status without operator evidence or money-movement actions", async () => {
    const f = await setup(); await requestBillingRefund(f.input, f.adapter);
    const scope = { organizationId: f.input.organizationId, actorId: f.user.id }, view = await readBilling(scope);
    expect(view.refunds).toHaveLength(1); expect(JSON.stringify(view.refunds)).not.toContain("support case"); expect(JSON.stringify(view.refunds)).not.toContain("operator"); expect(JSON.stringify(view.refunds)).not.toContain(f.input.paymentId);
    await db.membership.updateMany({ where: { organizationId: scope.organizationId }, data: { role: "VIEWER" } });
    expect((await readBilling(scope)).refunds).toEqual([]);
    vi.stubEnv("STRIPE_REFUNDS_ENABLED", "false"); await expect(requestBillingRefund(f.input, f.adapter)).rejects.toThrow("not enabled");
  });
});
