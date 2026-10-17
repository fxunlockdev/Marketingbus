import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../src/lib/db";
import { readQueueReport, type QueueReportOptions } from "../scripts/operations/queue-report";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local fixture database required");
const now = new Date("2026-10-18T00:00:00.000Z"), old = new Date(now.getTime() - 3600000), future = new Date(now.getTime() + 3600000);
suite("read-only operator queue inventory", () => {
  const orgs: string[] = [], users: string[] = [], events: string[] = [];
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await db.videoGeneration.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.billingRefundOperation.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.billingPayment.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.billingEvent.deleteMany({ where: { id: { in: events } } });
    await db.$disconnect();
  });
  async function setup() {
    const org = await db.organization.create({ data: { name: "Queue fixture", wallet: { create: { available: 100 } }, businesses: { create: { name: "Synthetic business" } } }, include: { businesses: true } }); orgs.push(org.id);
    return { organizationId: org.id, businessId: org.businesses[0].id };
  }
  const report = (scope: Awaited<ReturnType<typeof setup>>, extra: Partial<QueueReportOptions> = {}) => readQueueReport(db, { scope: { kind: "organization", ...scope }, ...extra }, now);
  async function job(scope: Awaited<ReturnType<typeof setup>>, status: string, extra = {}) {
    return db.job.create({ data: { ...scope, kind: "STATIC_COPY", key: crypto.randomUUID(), status, payload: { secret: "do-not-output-prompt" }, errorCode: "do-not-output-error-secret", createdAt: old, availableAt: old, ...extra } });
  }
  it("isolates organizations and businesses, including mismatched pairs", async () => {
    const a = await setup(), b = await setup(); const first = await job(a, "FAILED"); await job(b, "FAILED");
    const sibling = await db.business.create({ data: { organizationId: a.organizationId, name: "Sibling" } });
    const second = await job({ organizationId: a.organizationId, businessId: sibling.id }, "FAILED");
    expect((await report(a)).items.map(r => r.id)).toEqual([first.id]);
    expect((await report(a, { scope: { kind: "organization", organizationId: a.organizationId } })).items.map(r => r.id).sort()).toEqual([first.id, second.id].sort());
    await expect(report({ ...a, businessId: b.businessId })).rejects.toThrow("scope not found");
    await expect(report(a, { scope: { kind: "organization", organizationId: "missing-fixture-organization" } })).rejects.toThrow("scope not found");
  });
  it("reports failure, uncertainty, overdue work and expired leases without resending or ledger changes", async () => {
    const scope = await setup();
    await job(scope, "FAILED"); await job(scope, "NEEDS_RECONCILIATION"); await job(scope, "QUEUED");
    await job(scope, "SUBMITTING", { leaseUntil: old });
    const before = await db.job.findMany({ where: scope, orderBy: { id: "asc" } });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } });
    const network = vi.fn(() => { throw Error("No network permitted"); }); vi.stubGlobal("fetch", network);
    const result = await report(scope);
    expect(result.items.map(r => r.reason).sort()).toEqual(["EXPIRED_LEASE", "FAILED", "OVERDUE", "UNCERTAIN_OUTCOME"]);
    expect(JSON.stringify(result)).not.toMatch(/do-not-output|payload|errorCode|encrypted|providerTaskId/);
    expect(await db.job.findMany({ where: scope, orderBy: { id: "asc" } })).toEqual(before);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).toEqual(wallet);
    expect(network).not.toHaveBeenCalled();
  });
  it("does not flag future schedules, active leases, fresh queues or successful/cancelled work", async () => {
    const scope = await setup();
    await job(scope, "QUEUED", { availableAt: future }); await job(scope, "SUBMITTING", { leaseUntil: future });
    await job(scope, "QUEUED", { availableAt: now }); await job(scope, "COMPLETED"); await job(scope, "CANCELLED");
    expect((await report(scope)).items).toEqual([]);
    await job(scope, "NEEDS_RECONCILIATION", { leaseUntil: future });
    expect((await report(scope)).items[0]).toMatchObject({ reason: "UNCERTAIN_OUTCOME", leaseActiveAtReportTime: true });
  });
  it("paginates equal timestamps without duplicates, freezes cutoff and rejects cross-scope cursors", async () => {
    const scope = await setup(); for (let i = 0; i < 5; i++) await job(scope, "FAILED");
    const first = await report(scope, { limit: 2 });
    expect(first.hasMore).toBe(true); expect(first.nextCursor).toBeTruthy();
    await job(scope, "FAILED", { createdAt: future });
    const second = await readQueueReport(db, { scope: first.scope, limit: 2, cursor: first.nextCursor! }, future);
    const third = await readQueueReport(db, { scope: first.scope, limit: 2, cursor: second.nextCursor! }, future);
    expect(new Set([...first.items, ...second.items, ...third.items].map(r => r.id)).size).toBe(5);
    expect(third.hasMore).toBe(false); expect(third.nextCursor).toBeNull(); expect(third.asOf).toBe(now.toISOString());
    await expect(report(await setup(), { cursor: first.nextCursor! })).rejects.toThrow("scope");
    await expect(report(scope, { cursor: first.nextCursor!, overdueMinutes: 60 })).rejects.toThrow("scope");
  });
  it("never assigns global payment events or identity email to a tenant from untrusted payloads", async () => {
    const scope = await setup();
    const user = await db.user.create({ data: { email: `${crypto.randomUUID()}@example.test`, name: "Operator fixture", passwordHash: "not-a-password", memberships: { create: { organizationId: scope.organizationId } } } }); users.push(user.id);
    const mail = await db.emailOutbox.create({ data: { id: crypto.randomUUID(), userId: user.id, kind: "RECOVERY", encryptedPayload: "never-output-email-token", status: "FAILED", createdAt: old, expiresAt: future } });
    const event = await db.billingEvent.create({ data: { id: crypto.randomUUID(), payload: { organizationId: scope.organizationId, secret: "never-output-payment-data" }, digest: "fixture", status: "NEEDS_REVIEW", createdAt: old } }); events.push(event.id);
    const scoped = await report(scope, { scope: { kind: "organization", organizationId: scope.organizationId } });
    expect(scoped.items).toEqual([]); expect(scoped.excludedQueues).toEqual(["payments", "email"]);
    const global = await readQueueReport(db, { scope: { kind: "all" }, limit: 100 }, now);
    expect(global.items.find(r => r.id === mail.id)).toMatchObject({ queue: "email", organizationId: null, businessId: null });
    expect(global.items.find(r => r.id === event.id)).toMatchObject({ queue: "payments", reason: "UNCERTAIN_OUTCOME" });
    expect(JSON.stringify(global)).not.toMatch(/never-output|example.test/);
  });
  it("covers organization checkout/refund uncertainty without modifying payment accounting", async () => {
    const scope = await setup();
    const checkout = await db.billingCheckout.create({ data: { organizationId: scope.organizationId, actorId: "fixture", offer: {}, status: "UNKNOWN", createdAt: old, expiresAt: future, url: "https://example.test/secret" } });
    const payment = await db.billingPayment.create({ data: { id: crypto.randomUUID(), organizationId: scope.organizationId, amountMinor: 80000, currency: "usd", generalCredits: 100, revisionCredits: 10 } });
    const refund = await db.billingRefundOperation.create({ data: { id: crypto.randomUUID(), paymentId: payment.id, organizationId: scope.organizationId, amountMinor: 100, status: "UNKNOWN", operatorId: "fixture", evidence: "never-output-private-evidence", createdAt: old } });
    const result = await report(scope, { scope: { kind: "organization", organizationId: scope.organizationId } });
    expect(result.items.map(r => r.id).sort()).toEqual([checkout.id, refund.id].sort());
    expect((await report(scope)).excludedQueues).toContain("refunds"); expect((await report(scope)).items).toEqual([]);
    expect(await db.billingPayment.findUniqueOrThrow({ where: { id: payment.id } })).toEqual(payment);
    expect(JSON.stringify(result)).not.toMatch(/secret|private-evidence|amountMinor/);
  });
  it("uses due dates and expired polling leases for generated video, and flags blocked weekly plans", async () => {
    const scope = await setup();
    const base = { ...scope, actorId: "fixture", storyboardId: "fixture", itemId: "fixture", brandVersion: 1, shotId: "fixture", shotLabel: "fixture", documentHash: "fixture", prompt: "private prompt", route: {}, configurationHash: "fixture", durationMs: 1000, credits: 1, supplierCeilingMicros: 1, expiresAt: future, createdAt: old };
    await db.videoGeneration.create({ data: { ...base, status: "POLLING", nextPollAt: future } });
    await db.videoGeneration.create({ data: { ...base, status: "QUEUED", acceptedAt: now } });
    const expired = await db.videoGeneration.create({ data: { ...base, status: "POLLING", nextPollAt: old, leaseUntil: old } });
    const cycle = await db.weeklyCycle.create({ data: { ...scope, periodKey: "fixture", policyVersion: 1, brandVersion: 1, planId: "fixture", status: "BLOCKED", createdAt: old } });
    const result = await report(scope);
    expect(result.items.find(r => r.id === expired.id)?.reason).toBe("EXPIRED_LEASE");
    expect(result.items.find(r => r.id === cycle.id)?.reason).toBe("FAILED"); expect(result.items).toHaveLength(2);
  });
  it("respects configurable overdue threshold including the exact boundary", async () => {
    const scope = await setup(); await job(scope, "QUEUED", { availableAt: new Date(now.getTime() - 15 * 60000) });
    expect((await report(scope)).items).toHaveLength(1);
    expect((await report(scope, { overdueMinutes: 16 })).items).toEqual([]);
  });
  it("executes under PostgreSQL read-only enforcement and a bounded statement timeout", async () => {
    const scope = await setup(); let inspected = false;
    const client = { $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { timeout?: number }) => db.$transaction(async tx => {
      const result = await callback(tx);
      const settings = await tx.$queryRaw<{ readonly: string; timeout: string }[]>`SELECT current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout`;
      expect(settings).toEqual([{ readonly: "on", timeout: "3s" }]); inspected = true; return result;
    }, options) } as unknown as PrismaClient;
    await readQueueReport(client, { scope: { kind: "organization", ...scope } }, now);
    expect(inspected).toBe(true);
  });
  it("CLI distinguishes a healthy scoped report, attention, invalid scope and unsafe monitoring pagination", async () => {
    const scope = await setup();
    const run = async (...args: string[]) => {
      try { return { code: 0, ...await promisify(execFile)(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/queue-report.ts", ...args], { env: { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: "utf8", timeout: 15000, maxBuffer: 128000 }) }; }
      catch (error) { const result = error as { code: number; stdout: string; stderr: string }; return { code: result.code, stdout: result.stdout, stderr: result.stderr }; }
    };
    expect((await run("--organization", scope.organizationId, "--check")).code).toBe(0);
    const failed = await job(scope, "FAILED", { createdAt: new Date("2026-10-01T00:00:00Z") });
    const attention = await run("--organization", scope.organizationId, "--check");
    expect(attention.code).toBe(2); expect(JSON.parse(attention.stdout).items[0].id).toBe(failed.id);
    for (const args of [[], ["--all", "--organization", scope.organizationId], ["--organization", "missing-fixture-scope"], ["--all", "--check", "--cursor", "private-token-fixture"]]) {
      const result = await run(...args); expect(result.code).toBe(1); expect(result.stdout).toBe("");
      expect(result.stderr).toContain("No recovery action was taken"); expect(result.stderr).not.toMatch(/private-token|postgresql|Prisma/);
    }
  }, 30000);
});

describe("queue inventory input guards", () => {
  it.each([
    {}, { scope: { kind: "all" }, limit: 101 }, { scope: { kind: "all" }, limit: 0 },
    { scope: { kind: "all" }, overdueMinutes: 0 }, { scope: { kind: "all", organizationId: "tenant" } },
    { scope: { kind: "organization", organizationId: "' OR true --" } },
    { scope: { kind: "all" }, cursor: "invalid" }, { scope: { kind: "all" }, mutate: true },
  ])("refuses malformed or unsafe options before querying: %j", async raw => {
    const transaction = vi.spyOn(db, "$transaction");
    try { await expect(readQueueReport(db, raw as QueueReportOptions, now)).rejects.toThrow(); expect(transaction).not.toHaveBeenCalled(); }
    finally { transaction.mockRestore(); }
  });
});
