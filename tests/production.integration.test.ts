import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { actOnProduction, type Scope } from "../src/lib/production/service";
import { runOneJob as processJob, recoverExpiredLeases } from "../src/lib/production/worker";
import { reconcileFailedJob } from "../src/lib/production/reconcile";
import { heartbeat, HEARTBEAT_TTL_MS } from "../src/lib/production/readiness";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Production tests require an explicitly local database.");
const creative = { headline: "Room for your life", caption: "Considered architecture for the way you live. Book a consultation.", cta: "Meet the studio", visualDirection: "Editorial type, generous space, approved brand accent.", rationale: "Make the service tangible without unsupported performance claims.", evidenceUsed: [] };
const fixtureReasoner = async () => ({ id: "fixture-response", text: JSON.stringify(creative), usage: { input_tokens: 100, output_tokens: 100 } });
suite("production authorization, review and worker integration", () => {
  const organizations: string[] = [];
  const workerId = `test-worker-${crypto.randomUUID()}`;
  async function runOneJob(reasoner?: Parameters<typeof processJob>[0]) {
    // Prisma assigns host timestamps; Docker Postgres can lag by milliseconds.
    // Make this suite's fixture jobs explicitly due, without changing production scheduling.
    await db.job.updateMany({ where: { organizationId: { in: organizations }, status: "QUEUED", kind: "STATIC_COPY" }, data: { availableAt: new Date(0) } });
    return processJob(reasoner);
  }
  beforeAll(async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-no-network"); vi.stubEnv("PAID_EXECUTION_ENABLED", "true"); vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "50000000");
    vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000");
    vi.stubEnv("REASONING_RATE_CARD_JSON", JSON.stringify([
      { provider: "openai", model: "FIXTURE-CREATIVE", lane: "creative", inputUsdPerMillion: 2, outputUsdPerMillion: 8, verifiedUntil: "2099-01-01T00:00:00Z" },
      { provider: "openai", model: "FIXTURE-ROUTINE", lane: "routine", inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4, verifiedUntil: "2099-01-01T00:00:00Z" },
    ]));
    await heartbeat(workerId);
  });
  afterAll(async () => {
    const quotes = await db.generationQuote.findMany({ where: { organizationId: { in: organizations } }, select: { id: true } });
    await db.supplierAuthorization.deleteMany({ where: { key: { in: quotes.map(q => q.id) } } });
    await db.workerHeartbeat.deleteMany({ where: { id: workerId } });
    if (organizations.length) await db.organization.deleteMany({ where: { id: { in: organizations } } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup(credits = 500) {
    await heartbeat(workerId);
    const org = await db.organization.create({ data: { name: "PRODUCTION TEST ONLY", wallet: { create: { available: credits } } } }); organizations.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Fixture Studio", offering: "Considered architecture services", audience: "Homeowners", goal: "Book consultations", confirmedAt: new Date() } });
    const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Fixture plan", creditCeiling: 100, items: { create: { title: "Show the offering", channel: "Instagram", format: "static", brief: {} } } }, include: { items: true } });
    return { scope: { organizationId: org.id, businessId: business.id, actorId: "test-user" } satisfies Scope, itemId: plan.items[0].id };
  }
  it("rejects stale, paused and mismatched workers without reserving customer credits", async () => {
    const { scope, itemId } = await setup();
    await db.workerHeartbeat.update({ where: { id: workerId }, data: { lastSeenAt: new Date(Date.now() - HEARTBEAT_TTL_MS - 1000) } });
    await expect(quote(scope, itemId)).rejects.toThrow("worker is not ready");
    await heartbeat(workerId);
    const q = await quote(scope, itemId);
    await db.workerHeartbeat.update({ where: { id: workerId }, data: { configurationHash: "wrong" } });
    await expect(actOnProduction(scope, { action: "accept", quoteId: q.id })).rejects.toThrow("worker is not ready");
    await heartbeat(workerId);
    await db.workerHeartbeat.update({ where: { id: workerId }, data: { executionEnabled: false } });
    await expect(quote(scope, itemId)).rejects.toThrow("worker is not ready");
    expect(await db.reservation.count({ where: { organizationId: scope.organizationId } })).toBe(0);
    await heartbeat(workerId);
  });
  it("enforces a lifetime budget independently of the daily limit", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1");
    await heartbeat(workerId);
    try {
      await expect(actOnProduction(scope, { action: "accept", quoteId: q.id })).rejects.toThrow("total supplier-spend budget");
      expect(await db.reservation.count({ where: { organizationId: scope.organizationId } })).toBe(0);
    } finally { vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000"); await heartbeat(workerId); }
  });
  async function quote(scope: Scope, itemId: string, mode = "initial") {
    const result = await actOnProduction(scope, { action: "quote", itemId, mode, direction: "Show the value of a considered design consultation." });
    if (!("quote" in result) || !result.quote) throw Error("Quote missing");
    return result.quote;
  }
  it("prevents simultaneous tenants from exceeding the total authorization", async () => {
    const a = await setup(), b = await setup(); const qa = await quote(a.scope, a.itemId), qb = await quote(b.scope, b.itemId);
    const spent = await db.supplierAuthorization.aggregate({ _sum: { ceilingMicros: true } });
    const rows = await db.generationQuote.findMany({ where: { id: { in: [qa.id, qb.id] } } });
    vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", String((spent._sum.ceilingMicros || 0) + Math.max(...rows.map(r => r.supplierCeilingMicros))));
    await heartbeat(workerId);
    try {
      const results = await Promise.allSettled([actOnProduction(a.scope, { action: "accept", quoteId: qa.id }), actOnProduction(b.scope, { action: "accept", quoteId: qb.id })]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
      // Finish only this test's queued item before the next fixture claims work.
      await runOneJob(fixtureReasoner);
    } finally { vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000"); await heartbeat(workerId); }
  });
  it("does not replenish lifetime authorization when customer records are deleted", async () => {
    const ctx = await setup(); const q = await quote(ctx.scope, ctx.itemId);
    await actOnProduction(ctx.scope, { action: "accept", quoteId: q.id });
    await db.organization.delete({ where: { id: ctx.scope.organizationId } });
    try { expect(await db.supplierAuthorization.findUnique({ where: { key: q.id } })).not.toBeNull(); }
    finally { await db.supplierAuthorization.delete({ where: { key: q.id } }); }
  });
  async function ready() {
    const ctx = await setup(); const q = await quote(ctx.scope, ctx.itemId);
    await actOnProduction(ctx.scope, { action: "accept", quoteId: q.id });
    await runOneJob(fixtureReasoner);
    return ctx;
  }
  it("rejects a quote after a preference change without reserving credits", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    await db.memory.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, kind: "PREFERENCE", text: "Use a calmer tone" } });
    await expect(actOnProduction(scope, { action: "accept", quoteId: q.id })).rejects.toThrow("preferences");
    expect(await db.reservation.count({ where: { organizationId: scope.organizationId } })).toBe(0);
  });
  it("does not submit accepted work after preferences change; releases the reservation", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    await actOnProduction(scope, { action: "accept", quoteId: q.id });
    await db.memory.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, kind: "PREFERENCE", text: "Use a calmer tone" } });
    const call = vi.fn(fixtureReasoner); await runOneJob(call); expect(call).not.toHaveBeenCalled();
    expect(await db.wallet.findUnique({ where: { organizationId: scope.organizationId } })).toMatchObject({ held: 0, available: 500 });
  });
  it("withholds stale-preference output after submission without charging the customer", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    await actOnProduction(scope, { action: "accept", quoteId: q.id });
    await runOneJob(async () => {
      await db.memory.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, kind: "PREFERENCE", text: "Use a calmer tone" } });
      return fixtureReasoner();
    });
    expect(await db.creativeRevision.count({ where: { itemId } })).toBe(0);
    expect(await db.wallet.findUnique({ where: { organizationId: scope.organizationId } })).toMatchObject({ held: 0, available: 500 });
    expect(await db.job.findFirst({ where: { organizationId: scope.organizationId } })).toMatchObject({ status: "FAILED", result: { creditsConsumed: 0 } });
  });
  it("quotes without spending, then accepts once under concurrent clicks and settles unused credits", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).held).toBe(0);
    const results = await Promise.all([actOnProduction(scope, { action: "accept", quoteId: q.id }), actOnProduction(scope, { action: "accept", quoteId: q.id })]);
    expect(results[0]).toEqual(results[1]);
    expect(await db.job.count({ where: { organizationId: scope.organizationId } })).toBe(1);
    const call = vi.fn(fixtureReasoner);
    await Promise.all([runOneJob(call), runOneJob(call)]); expect(call).toHaveBeenCalledTimes(1);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } });
    expect(wallet.held).toBe(0); expect(wallet.available).toBe(499);
    expect(await db.creativeRevision.count({ where: { itemId, status: "READY" } })).toBe(1);
  });
  it("rolls back job creation and reservations on insufficient balance", async () => {
    const { scope, itemId } = await setup(0); const q = await quote(scope, itemId);
    await expect(actOnProduction(scope, { action: "accept", quoteId: q.id })).rejects.toThrow("Insufficient");
    expect(await db.job.count({ where: { organizationId: scope.organizationId } })).toBe(0);
    expect(await db.reservation.count({ where: { organizationId: scope.organizationId } })).toBe(0);
  });
  it("denies cross-tenant quote acceptance and item actions", async () => {
    const a = await setup(), b = await setup(); const q = await quote(a.scope, a.itemId);
    await expect(actOnProduction(b.scope, { action: "accept", quoteId: q.id })).rejects.toThrow("not found");
    await expect(actOnProduction(b.scope, { action: "approve", itemId: a.itemId, version: 1 })).rejects.toThrow("not found");
  });
  it("requires exact-version approval; manual edits are free and revoke the calendar", async () => {
    const { scope, itemId } = await ready();
    const schedule = { action: "schedule", itemId, version: 1, scheduledFor: new Date(Date.now() + 3600_000).toISOString(), timezone: "Asia/Kolkata" };
    await expect(actOnProduction(scope, schedule)).rejects.toThrow("Approve");
    await expect(actOnProduction(scope, { action: "approve", itemId, version: 2 })).rejects.toThrow("no longer current");
    await actOnProduction(scope, { action: "approve", itemId, version: 1 });
    await actOnProduction(scope, schedule);
    expect(await db.calendarEntry.count({ where: { itemId } })).toBe(1);
    await actOnProduction(scope, { action: "edit", itemId, version: 1, headline: "A home for everyday life", caption: creative.caption, cta: creative.cta });
    expect(await db.calendarEntry.count({ where: { itemId } })).toBe(0);
    expect((await db.creativeRevision.findFirstOrThrow({ where: { itemId, version: 2 } })).status).toBe("READY");
    expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).available).toBe(499);
    await expect(actOnProduction(scope, schedule)).rejects.toThrow("no longer current");
  });
  it("feedback does not regenerate; explicit memory is scoped; copy revision preserves direction", async () => {
    const { scope, itemId } = await ready();
    await actOnProduction(scope, { action: "revise", itemId, version: 1, feedback: "Use shorter sentences.", remember: true });
    expect(await db.job.count({ where: { organizationId: scope.organizationId } })).toBe(1);
    expect(await db.memory.count({ where: { businessId: scope.businessId } })).toBe(1);
    const q = await quote(scope, itemId, "copy"); expect(q.model).toBe("FIXTURE-ROUTINE");
    await actOnProduction(scope, { action: "accept", quoteId: q.id });
    await runOneJob(async () => ({ ...await fixtureReasoner(), text: JSON.stringify({ ...creative, headline: "New headline", caption: "Considered homes. Book a consultation.", visualDirection: "A different visual that must not escape scope" }) }));
    const rev = await db.creativeRevision.findFirstOrThrow({ where: { itemId, version: 2 } });
    expect(rev.content).toMatchObject({ headline: "New headline", visualDirection: creative.visualDirection });
  });
  it("rejection never spends or automatically retries", async () => {
    const { scope, itemId } = await ready();
    await actOnProduction(scope, { action: "reject", itemId, version: 1 });
    expect(await db.job.count({ where: { organizationId: scope.organizationId } })).toBe(1);
    await expect(quote(scope, itemId, "concept")).rejects.toThrow("request changes");
  });
  it("stale or expired quotes cannot be accepted", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    await db.generationQuote.update({ where: { id: q.id }, data: { expiresAt: new Date(0) } });
    await expect(actOnProduction(scope, { action: "accept", quoteId: q.id })).rejects.toThrow("expired");
    const fresh = await quote(scope, itemId);
    await db.business.update({ where: { id: scope.businessId }, data: { version: 2, confirmedAt: null } });
    await expect(actOnProduction(scope, { action: "accept", quoteId: fresh.id })).rejects.toThrow("brand or creative changed");
  });
  it("ambiguous provider failure retains the hold and never sends a duplicate", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    await actOnProduction(scope, { action: "accept", quoteId: q.id });
    const call = vi.fn(async () => { throw Error("Simulated network timeout after submission"); });
    await runOneJob(call); await runOneJob(call); expect(call).toHaveBeenCalledTimes(1);
    expect((await db.job.findFirstOrThrow({ where: { organizationId: scope.organizationId } })).status).toBe("NEEDS_RECONCILIATION");
    expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).held).toBe(q.credits);
    await expect(quote(scope, itemId)).rejects.toThrow("unresolved");
    const job = await db.job.findFirstOrThrow({ where: { organizationId: scope.organizationId } });
    const resolution = { jobId: job.id, supplierCostMicros: 1000, evidence: "FIXTURE invoice confirms one billed request with no retained output", operatorId: "fixture-operator" };
    await reconcileFailedJob(resolution); await reconcileFailedJob(resolution);
    expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).held).toBe(0);
    await expect(reconcileFailedJob({ ...resolution, supplierCostMicros: 0 })).rejects.toThrow("replay changed");
  });
  it("invalid output releases customer credits but records incurred supplier cost", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    await actOnProduction(scope, { action: "accept", quoteId: q.id });
    await runOneJob(async () => ({ ...await fixtureReasoner(), text: "not JSON" }));
    const job = await db.job.findFirstOrThrow({ where: { organizationId: scope.organizationId } });
    expect(job.status).toBe("FAILED"); expect(job.result).toMatchObject({ supplierCostMicros: 1000, creditsConsumed: 0 });
    expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).available).toBe(500);
  });
  it("unsupported dates fail after generation, release credits, and cannot be approved from older revisions", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    await actOnProduction(scope, { action: "accept", quoteId: q.id });
    await runOneJob(async () => ({ ...await fixtureReasoner(), text: JSON.stringify({ ...creative, caption: "Book this Saturday." }) }));
    const job = await db.job.findFirstOrThrow({ where: { businessId: scope.businessId } });
    expect(job).toMatchObject({ status: "FAILED", errorCode: "QUALITY_CHECK_FAILED" });
    expect(job.result).toMatchObject({ creditsConsumed: 0, supplierCostMicros: 1000 });
    expect(await db.creativeRevision.count({ where: { itemId } })).toBe(0);
    await db.creativeRevision.create({ data: { itemId, organizationId: scope.organizationId, version: 1, status: "READY", content: { ...creative, caption: "Book this Saturday." } } });
    await expect(actOnProduction(scope, { action: "approve", itemId, version: 1 })).rejects.toThrow("unconfirmed");
    await expect(actOnProduction(scope, { action: "edit", itemId, version: 1, headline: creative.headline, caption: "This Saturday", cta: creative.cta })).rejects.toThrow("unconfirmed");
  });
  it("checks brand freshness before submission and releases a stale queued job", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    await actOnProduction(scope, { action: "accept", quoteId: q.id });
    await db.business.update({ where: { id: scope.businessId }, data: { version: 2 } });
    const call = vi.fn(fixtureReasoner); await runOneJob(call); expect(call).not.toHaveBeenCalled();
    expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).held).toBe(0);
  });
  it("never requeues an expired submitting lease", async () => {
    const { scope, itemId } = await setup(); const q = await quote(scope, itemId);
    await actOnProduction(scope, { action: "accept", quoteId: q.id });
    await db.job.updateMany({ where: { organizationId: scope.organizationId }, data: { status: "SUBMITTING", leaseUntil: new Date(0) } });
    await recoverExpiredLeases();
    expect((await db.job.findFirstOrThrow({ where: { organizationId: scope.organizationId } })).status).toBe("NEEDS_RECONCILIATION");
  });
  it("counts a prior-day authorization executed today against today's ceiling", async () => {
    const ctx = await setup(); const q = await quote(ctx.scope, ctx.itemId);
    await actOnProduction(ctx.scope, { action: "accept", quoteId: q.id });
    await db.generationQuote.update({ where: { id: q.id }, data: { acceptedAt: new Date(Date.now() - 2 * 86400_000) } });
    await runOneJob(fixtureReasoner);
    const next = await setup(); const nextQuote = await quote(next.scope, next.itemId);
    const all = await db.generationQuote.aggregate({ where: { status: { in: ["ACCEPTED", "RECONCILE", "COMPLETED"] }, organizationId: { in: organizations } }, _sum: { supplierCeilingMicros: true } });
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", String(all._sum.supplierCeilingMicros!));
    await heartbeat(workerId);
    try { await expect(actOnProduction(next.scope, { action: "accept", quoteId: nextQuote.id })).rejects.toThrow("supplier-spend limit"); }
    finally { vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "50000000"); await heartbeat(workerId); }
  });
});
