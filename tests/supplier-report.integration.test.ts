import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "../src/lib/db";
import { authorizeSupplier, supplierExposure } from "../src/lib/production/budget";
import { readSupplierReport } from "../scripts/operations/supplier-report";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local fixtures only");
suite("read-only global supplier authorization exposure", () => {
  const keys: string[] = [], orgs: string[] = [];
  const old = new Date("2000-01-01T00:00:00Z");
  const report = () => readSupplierReport(db, { all: true });
  beforeEach(() => {
    vi.stubEnv("PAID_EXECUTION_ENABLED", "false");
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "1000000000"); vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000");
  });
  afterEach(async () => {
    await db.imageGeneration.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.videoGeneration.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.supplierAuthorization.deleteMany({ where: { key: { in: keys } } });
    keys.length = orgs.length = 0; vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });
  afterAll(() => db.$disconnect());
  async function authorization(amount = 100, createdAt = old) {
    const key = `private-supplier-${crypto.randomUUID()}`; keys.push(key);
    await db.supplierAuthorization.create({ data: { key, ceilingMicros: amount, createdAt } }); return key;
  }
  async function source(lane: "copy" | "brand" | "learning" | "image" | "video", status: string, today = false) {
    const id = await authorization(100, today ? new Date() : old);
    const org = await db.organization.create({ data: { name: "Private supplier fixture", wallet: { create: { available: 70, held: 0 } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { name: "Private brand", organizationId: org.id } });
    const common = { id, businessId: business.id, organizationId: org.id, brandVersion: 1, status,
      credits: 1, supplierCeilingMicros: 100, configurationHash: "private-config", expiresAt: new Date("2099-01-01"), acceptedAt: old };
    if (lane === "brand" || lane === "learning") {
      await db.brandAnalysis.create({ data: { ...common, actorId: "private-actor", sources: [], route: {}, purpose: lane === "brand" ? "BRAND" : "SKILL_REFLECTION" } });
    } else if (lane === "video") {
      await db.videoGeneration.create({ data: { ...common, actorId: "private-actor", storyboardId: "private-board", itemId: "private-item", shotId: "shot", shotLabel: "Secret shot", documentHash: "private-document", prompt: "Secret prompt", route: {}, durationMs: 1000 } });
    } else {
      const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Fixture", creditCeiling: 1, items: { create: { title: "Fixture", format: "static", channel: "Instagram", brief: {} } } }, include: { items: true } });
      if (lane === "copy") await db.generationQuote.create({ data: { ...common, itemId: plan.items[0].id, baseVersion: 0, mode: "initial", request: {} } });
      else await db.imageGeneration.create({ data: { ...common, actorId: "private-actor", itemId: plan.items[0].id, revisionId: "private-revision", version: 1, prompt: "Secret prompt", references: [], route: {} } });
    }
    return { id, org: org.id };
  }
  it("counts today's detached authorizations and preserves older lifetime authorization without inferring an invoice", async () => {
    const before = (await report()).authorizationExposure;
    await authorization(100, new Date()); await authorization(200);
    const result = await report(), after = result.authorizationExposure;
    expect(BigInt(after.lifetimeMicros) - BigInt(before.lifetimeMicros)).toBe(300n);
    expect(BigInt(after.dailyMicros) - BigInt(before.dailyMicros)).toBe(100n);
    expect(BigInt(after.todayMicros) - BigInt(before.todayMicros)).toBe(100n);
    expect(after.carriedMicros).toBe(before.carriedMicros);
    expect(result).toMatchObject({ executionEnabled: false, readOnly: true, scope: "all" });
  });
  it.each(["copy", "brand", "learning", "image", "video"] as const)("carries older unresolved %s once, without double counting today's entries", async lane => {
    const before = (await report()).authorizationExposure;
    await source(lane, lane === "copy" ? "RECONCILE" : "NEEDS_RECONCILIATION");
    await source(lane, lane === "copy" ? "ACCEPTED" : "QUEUED", true);
    const after = (await report()).authorizationExposure;
    expect(BigInt(after.dailyMicros) - BigInt(before.dailyMicros)).toBe(200n);
    expect(BigInt(after.carriedMicros) - BigInt(before.carriedMicros)).toBe(100n);
    expect(BigInt(after.carriedCount) - BigInt(before.carriedCount)).toBe(1n);
    expect(BigInt(after.todayMicros) - BigInt(before.todayMicros)).toBe(100n);
  });
  it("retains provisional video across midnight, then includes final reconciliation day and preserves lifetime overrun", async () => {
    const before = (await report()).authorizationExposure, { id } = await source("video", "READY");
    await db.videoGeneration.update({ where: { id }, data: { expenseBasis: "ACCOUNT_QUOTE_V1", supplierEstimateMicros: 60, settledAt: old } });
    expect(BigInt((await report()).authorizationExposure.carriedMicros) - BigInt(before.carriedMicros)).toBe(100n);
    await db.videoGeneration.update({ where: { id }, data: { supplierCostMicros: 150, supplierReconciledAt: new Date() } });
    await db.supplierAuthorization.update({ where: { key: id }, data: { ceilingMicros: 150 } });
    expect(BigInt((await report()).authorizationExposure.carriedMicros) - BigInt(before.carriedMicros)).toBe(150n);
    await db.videoGeneration.update({ where: { id }, data: { supplierReconciledAt: old } });
    const after = (await report()).authorizationExposure;
    expect(after.dailyMicros).toBe(before.dailyMicros);
    expect(BigInt(after.lifetimeMicros) - BigInt(before.lifetimeMicros)).toBe(150n);
  });
  it("counts completed work submitted today and does not replenish lifetime after failure or tenant deletion", async () => {
    const before = (await report()).authorizationExposure, { id, org } = await source("brand", "FAILED");
    await db.brandAnalysis.update({ where: { id }, data: { submittedAt: new Date(), supplierCostMicros: 20 } });
    expect(BigInt((await report()).authorizationExposure.dailyMicros) - BigInt(before.dailyMicros)).toBe(100n);
    await db.organization.delete({ where: { id: org } });
    const after = (await report()).authorizationExposure;
    expect(after.dailyMicros).toBe(before.dailyMicros);
    expect(BigInt(after.lifetimeMicros) - BigInt(before.lifetimeMicros)).toBe(100n);
  });
  it("agrees with real shared admission at exact daily and lifetime boundaries", async () => {
    await authorization(100, new Date());
    const snapshot = await report(), key = crypto.randomUUID(); keys.push(key);
    vi.stubEnv("PAID_EXECUTION_ENABLED", "true");
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", snapshot.authorizationExposure.dailyMicros);
    expect((await report()).issues).toContain("DAILY_ALLOWANCE_EXHAUSTED");
    await expect(db.$transaction(tx => authorizeSupplier(tx, key, 1))).rejects.toThrow("safe supplier-spend limit");
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "1000000000");
    vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", snapshot.authorizationExposure.lifetimeMicros);
    expect((await report()).remainingAuthorizationMicros.total).toBe("0");
    await expect(db.$transaction(tx => authorizeSupplier(tx, key, 1))).rejects.toThrow("total supplier-spend budget");
    expect(await db.supplierAuthorization.findUnique({ where: { key } })).toBeNull();
  });
  it.each(["", "NaN", "-1", "0", "1.5", "1000000001"])("reports invalid limits without treating %s as zero or enabling execution", async value => {
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", value); vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", value);
    expect(await report()).toMatchObject({ needsAttention: true, executionEnabled: false,
      issues: ["DAILY_LIMIT_UNCONFIGURED", "TOTAL_LIMIT_UNCONFIGURED"], remainingAuthorizationMicros: { daily: null, total: null } });
  });
  it("keeps integer-safe aggregates and clamps remaining authority after limits are lowered", async () => {
    const before = (await report()).authorizationExposure;
    for (let i = 0; i < 3; i++) await authorization(2_000_000_000, new Date());
    const result = await report();
    expect(BigInt(result.authorizationExposure.lifetimeMicros) - BigInt(before.lifetimeMicros)).toBe(6_000_000_000n);
    expect(result.remainingAuthorizationMicros).toEqual({ daily: "0", total: "0" });
    expect(result.issues).toEqual(["DAILY_ALLOWANCE_EXHAUSTED", "TOTAL_ALLOWANCE_EXHAUSTED"]);
  });
  it("requires explicit global operator scope, never falling back from a customer scope", async () => {
    for (const scope of [{}, { all: false }, { organizationId: "other" }, { all: true, organizationId: "other" }]) {
      await expect(readSupplierReport(db, scope as { all: true })).rejects.toThrow();
    }
    await expect(db.$transaction(tx => supplierExposure(tx, new Date("invalid")))).rejects.toThrow("UTC day");
    await expect(db.$transaction(tx => supplierExposure(tx, new Date("2026-10-20T12:00:00Z")))).rejects.toThrow("UTC day");
  });
  it("returns only aggregate data without mutation or network access", async () => {
    const { org } = await source("brand", "SUBMITTING");
    const before = await db.supplierAuthorization.findMany({ where: { key: { in: keys } } });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: org } });
    const jobs = await db.brandAnalysis.findMany({ where: { organizationId: org } });
    const network = vi.fn(() => { throw Error("No network"); }); vi.stubGlobal("fetch", network);
    const result = await report();
    expect(JSON.stringify(result)).not.toMatch(/private-|Private|Secret|prompt|api.key/i);
    expect(await db.supplierAuthorization.findMany({ where: { key: { in: keys } } })).toEqual(before);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: org } })).toEqual(wallet);
    expect(await db.brandAnalysis.findMany({ where: { organizationId: org } })).toEqual(jobs);
    expect(network).not.toHaveBeenCalled();
  });
  it("enforces database read-only repeatable snapshots and bounded statement time", async () => {
    let inspected = false;
    const client = { $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) => db.$transaction(async tx => {
      const result = await callback(tx);
      expect(await tx.$queryRaw`SELECT current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout, current_setting('transaction_isolation') AS isolation`).toEqual([{ readonly: "on", timeout: "3s", isolation: "repeatable read" }]);
      inspected = true; return result;
    }, options) } as unknown as PrismaClient;
    await readSupplierReport(client, { all: true }); expect(inspected).toBe(true);
  });
  it("provides real CLI monitoring codes and sanitized errors, even with execution paused", async () => {
    const run = promisify(execFile);
    const options = { env: { NODE_ENV: "test" as const, PATH: process.env.PATH, DATABASE_URL: process.env.TEST_DATABASE_URL,
      PAID_EXECUTION_ENABLED: "false", DAILY_SUPPLIER_BUDGET_MICROS: "1000000000", TOTAL_SUPPLIER_BUDGET_MICROS: "1000000000" }, encoding: "utf8" as const, timeout: 15000 };
    const ok = await run(process.execPath, ["--import", "tsx", "scripts/supplier-report.ts", "--all", "--check"], options);
    expect(JSON.parse(ok.stdout).readOnly).toBe(true);
    await authorization(100, new Date());
    await expect(run(process.execPath, ["--import", "tsx", "scripts/supplier-report.ts", "--all", "--check"], { ...options, env: { ...options.env, DAILY_SUPPLIER_BUDGET_MICROS: "1" } })).rejects.toMatchObject({ code: 2 });
    await expect(run(process.execPath, ["--import", "tsx", "scripts/supplier-report.ts", "--organization", "private-tenant"], options)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("No budget or accounting change was made.") });
    await expect(run(process.execPath, ["--import", "tsx", "scripts/supplier-report.ts"], options)).rejects.toMatchObject({ code: 1 });
  });
});
