import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "../src/lib/db";
import { reserveCredits, finishReservation } from "../src/lib/billing/wallet";
import { readCreditReport } from "../scripts/operations/credit-report";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local fixtures only");
suite("read-only credit accounting report", () => {
  const orgs: string[] = [];
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => { await db.billingPayment.deleteMany({ where: { organizationId: { in: orgs } } }); await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.$disconnect(); });
  async function setup(credits = 100, revisions = 50) {
    const org = await db.organization.create({ data: { name: "Secret fixture business name", wallet: { create: { available: credits, revisionAvailable: revisions } } } }); orgs.push(org.id);
    if (credits + revisions) await db.creditEntry.create({ data: { organizationId: org.id, key: `secret-grant-${crypto.randomUUID()}`, kind: "TEST_GRANT", amount: credits + revisions } });
    return org.id;
  }
  const codes = async (id: string) => (await readCreditReport(db, id)).issues.map(i => i.code);
  async function payment(id: string, refunds: number[] = [], general = 101, revision = 39) {
    const p = await db.billingPayment.create({ data: { id: `private:payment:${crypto.randomUUID()}`, organizationId: id, amountMinor: 1000, currency: "usd", generalCredits: general, revisionCredits: revision } });
    await db.creditEntry.create({ data: { organizationId: id, key: `payment:${p.id}`, kind: "PAYMENT_GRANT", amount: general + revision } });
    await db.wallet.update({ where: { organizationId: id }, data: { available: { increment: general }, revisionAvailable: { increment: revision } } });
    let previousGeneral = 0, previousRevision = 0;
    for (const cumulative of refunds) {
      const reclaimedGeneral = Math.floor(general * cumulative / 1000), reclaimedRevision = Math.floor(revision * cumulative / 1000);
      await db.creditEntry.create({ data: { organizationId: id, key: `refund:${p.id}:${cumulative}`, kind: "REFUND_RECLAIM", amount: reclaimedGeneral + reclaimedRevision - previousGeneral - previousRevision } });
      await db.wallet.update({ where: { organizationId: id }, data: { available: { decrement: reclaimedGeneral - previousGeneral }, revisionAvailable: { decrement: reclaimedRevision - previousRevision } } });
      await db.billingPayment.update({ where: { id: p.id }, data: { refundedMinor: cumulative, reclaimedGeneral, reclaimedRevision } });
      previousGeneral = reclaimedGeneral; previousRevision = reclaimedRevision;
    }
    return p;
  }
  it("matches payment grants and cumulative per-pool refund rounding, including zero-credit refunds", async () => {
    const id = await setup(0, 0);
    await payment(id, [100, 200, 1000]); await payment(id, [1, 2], 1, 1);
    expect((await readCreditReport(db, id)).needsAttention).toBe(false);
  });
  it.each(["missing-grant", "wrong-grant", "wrong-kind", "wrong-reclaimed", "missing-refund", "lost-zero-refund"])("detects payment backing mismatch: %s", async change => {
    const id = await setup(0, 0), p = await payment(id, change === "lost-zero-refund" ? [1] : [200], change === "lost-zero-refund" ? 1 : 101, 0);
    if (change === "missing-grant") await db.creditEntry.delete({ where: { key: `payment:${p.id}` } });
    if (change === "wrong-grant") await db.creditEntry.update({ where: { key: `payment:${p.id}` }, data: { amount: 99 } });
    if (change === "wrong-kind") await db.creditEntry.update({ where: { key: `payment:${p.id}` }, data: { kind: "TEST_GRANT" } });
    if (change === "wrong-reclaimed") await db.billingPayment.update({ where: { id: p.id }, data: { reclaimedGeneral: 19 } });
    if (change === "missing-refund" || change === "lost-zero-refund") await db.creditEntry.deleteMany({ where: { organizationId: id, kind: "REFUND_RECLAIM" } });
    expect(await codes(id)).toContain("PAYMENT_LEDGER_MISMATCH");
  });
  it("detects offsetting refund journal errors even when the net balance matches", async () => {
    const id = await setup(0, 0), p = await payment(id, [100, 200]);
    await db.creditEntry.update({ where: { key: `refund:${p.id}:100` }, data: { amount: { increment: 1 } } });
    await db.creditEntry.update({ where: { key: `refund:${p.id}:200` }, data: { amount: { decrement: 1 } } });
    const result = await codes(id); expect(result).toContain("REFUND_JOURNAL_MISMATCH"); expect(result).not.toContain("NET_BALANCE_MISMATCH");
  });
  it.each(["missing-payment", "foreign-payment", "malformed-suffix", "noncanonical-suffix", "oversized-suffix", "beyond-refunded"])("rejects unbound or invalid refund entries: %s", async change => {
    const id = await setup(0, 0), other = await setup(0, 0), p = await payment(change === "foreign-payment" ? other : id);
    const key = change === "missing-payment" ? "refund:missing:100" : `refund:${p.id}:${change === "malformed-suffix" ? "not-a-number" : change === "noncanonical-suffix" ? "00100" : change === "oversized-suffix" ? "999999999999999999999" : "100"}`;
    await db.creditEntry.create({ data: { organizationId: id, key, kind: "REFUND_RECLAIM", amount: 0 } });
    expect(await codes(id)).toContain(change === "beyond-refunded" ? "REFUND_JOURNAL_MISMATCH" : "ORPHAN_PAYMENT_ENTRIES");
    expect((await readCreditReport(db, other)).needsAttention).toBe(false);
  });
  it("flags a balanced payment grant with no same-workspace payment record", async () => {
    const id = await setup(0, 0), other = await setup(0, 0), p = await payment(other);
    await db.creditEntry.create({ data: { organizationId: id, key: `payment:unbound:${p.id}`, kind: "PAYMENT_GRANT", amount: 7 } });
    await db.wallet.update({ where: { organizationId: id }, data: { available: 7 } });
    expect(await codes(id)).toEqual(["ORPHAN_PAYMENT_ENTRIES"]);
  });
  it("never uses another workspace's payment to legitimize an exactly matching entry key", async () => {
    const id = await setup(0, 0), other = await setup(0, 0), p = await payment(other);
    await db.creditEntry.delete({ where: { key: `payment:${p.id}` } });
    await db.creditEntry.create({ data: { organizationId: id, key: `payment:${p.id}`, kind: "PAYMENT_GRANT", amount: 140 } });
    await db.wallet.update({ where: { organizationId: id }, data: { available: 140 } });
    expect(await codes(id)).toEqual(["ORPHAN_PAYMENT_ENTRIES"]);
    expect(await codes(other)).toContain("PAYMENT_LEDGER_MISMATCH");
  });
  it("balances zero, held, mixed-pool partial, full and zero-consumption settlements", async () => {
    expect((await readCreditReport(db, await setup(0, 0))).needsAttention).toBe(false);
    const id = await setup();
    const general = await reserveCredits(id, "secret-initial", 30), revision = await reserveCredits(id, "secret-revision", 70, true);
    expect(await readCreditReport(db, id)).toMatchObject({ needsAttention: false, accounting: { walletNetCredits: "150", ledgerNetCredits: "150", activeReservedCredits: "100" } });
    await finishReservation(id, revision.id, 60); await finishReservation(id, general.id, 0);
    const full = await reserveCredits(id, "secret-full", 20); await finishReservation(id, full.id, 20);
    expect(await readCreditReport(db, id)).toMatchObject({ needsAttention: false, accounting: { walletNetCredits: "70", ledgerNetCredits: "70", activeReservedCredits: "0", consumed: "80" } });
  });
  it("detects net-balance and held-balance drift separately", async () => {
    const id = await setup(); await reserveCredits(id, "hold", 10);
    await db.wallet.update({ where: { organizationId: id }, data: { available: { increment: 1 } } });
    expect(await codes(id)).toEqual(["NET_BALANCE_MISMATCH"]);
    await db.wallet.update({ where: { organizationId: id }, data: { available: { decrement: 2 }, held: { increment: 1 } } });
    expect(await codes(id)).toEqual(["HELD_BALANCE_MISMATCH"]);
  });
  it.each(["missing-reserve", "wrong-reserve", "missing-settle", "wrong-settle", "missing-release", "wrong-release", "held-with-settle", "wrong-state", "extra-release"])("detects %s without interpreting corrupt data as authority", async change => {
    const id = await setup(), hold = await reserveCredits(id, "secret-operation", 20);
    if (change !== "held-with-settle") await finishReservation(id, hold.id, change === "extra-release" ? 20 : 10);
    if (change === "missing-reserve") await db.creditEntry.delete({ where: { key: `reserve:${hold.key}` } });
    if (change === "wrong-reserve") await db.creditEntry.update({ where: { key: `reserve:${hold.key}` }, data: { kind: "RELEASE" } });
    if (change === "missing-settle") await db.creditEntry.delete({ where: { key: `settle:${hold.key}` } });
    if (change === "wrong-settle") await db.creditEntry.update({ where: { key: `settle:${hold.key}` }, data: { amount: 21 } });
    if (change === "missing-release") await db.creditEntry.delete({ where: { key: `release:${hold.key}` } });
    if (change === "wrong-release") await db.creditEntry.update({ where: { key: `release:${hold.key}` }, data: { amount: 9 } });
    if (change === "held-with-settle") await db.creditEntry.create({ data: { organizationId: id, key: `settle:${hold.key}`, kind: "CONSUME", amount: 0 } });
    if (change === "wrong-state") await db.reservation.update({ where: { id: hold.id }, data: { state: "RELEASED" } });
    if (change === "extra-release") await db.creditEntry.create({ data: { organizationId: id, key: `release:${hold.key}`, kind: "RELEASE", amount: 0 } });
    expect(await codes(id)).toContain("RESERVATION_LEDGER_MISMATCH");
  });
  it("rejects orphan ledger entries, unknown kinds and cross-workspace reservation references", async () => {
    const a = await setup(), b = await setup(), hold = await reserveCredits(b, "foreign-secret-operation", 10);
    await db.creditEntry.createMany({ data: [
      { organizationId: a, key: `settle:${hold.key}`, kind: "CONSUME", amount: 0 },
      { organizationId: a, key: "unknown-secret-key", kind: "private-unknown-kind", amount: 0 },
    ] });
    expect(await readCreditReport(db, a)).toMatchObject({ issues: [{ code: "UNSUPPORTED_LEDGER_ENTRIES", count: "1" }, { code: "ORPHAN_RESERVATION_ENTRIES", count: "1" }] });
    expect((await readCreditReport(db, b)).needsAttention).toBe(false);
  });
  it("does not mutate records, reveal keys or make network requests", async () => {
    const id = await setup(), hold = await reserveCredits(id, "private-operation-token", 20);
    const before = await db.wallet.findUniqueOrThrow({ where: { organizationId: id } });
    const entries = await db.creditEntry.findMany({ where: { organizationId: id }, orderBy: { id: "asc" } });
    const network = vi.fn(() => { throw Error("No provider calls"); }); vi.stubGlobal("fetch", network);
    const report = await readCreditReport(db, id);
    expect(report.readOnly).toBe(true); expect(JSON.stringify(report)).not.toMatch(/secret-grant|private-operation-token|Secret fixture|encrypted|password/);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: id } })).toEqual(before);
    expect(await db.creditEntry.findMany({ where: { organizationId: id }, orderBy: { id: "asc" } })).toEqual(entries);
    expect(await db.reservation.findUniqueOrThrow({ where: { id: hold.id } })).toEqual(hold); expect(network).not.toHaveBeenCalled();
  });
  it("denies invalid or missing scope and does not accept business/global fallback", async () => {
    await expect(readCreditReport(db, "bad'; DROP TABLE Wallet")).rejects.toThrow();
    await expect(readCreditReport(db, "missing-fixture-workspace")).rejects.toThrow("not found");
    await expect(readCreditReport(db, "")).rejects.toThrow();
  });
  it("uses integer-safe lifetime sums rather than 32-bit aggregate arithmetic", async () => {
    const id = await setup(0, 0);
    await db.creditEntry.createMany({ data: [1, 2, 3].flatMap(i => [
      { organizationId: id, key: `large-grant-${id}-${i}`, kind: "TEST_GRANT", amount: 2000000000 },
      { organizationId: id, key: `settle:large-${id}-${i}`, kind: "CONSUME", amount: 2000000000 },
      { organizationId: id, key: `reserve:large-${id}-${i}`, kind: "RESERVE", amount: 2000000000 },
    ]) });
    await db.reservation.createMany({ data: [1, 2, 3].map(i => ({ organizationId: id, key: `large-${id}-${i}`, credits: 2000000000, state: "SETTLED" })) });
    expect(await readCreditReport(db, id)).toMatchObject({ needsAttention: false, accounting: { grants: "6000000000", consumed: "6000000000", ledgerNetCredits: "0" } });
  });
  it("gives monitoring exit codes and sanitized errors through the real CLI", async () => {
    const id = await setup(), run = promisify(execFile);
    const options = { env: { NODE_ENV: "test" as const, PATH: process.env.PATH, DATABASE_URL: process.env.TEST_DATABASE_URL, PAID_EXECUTION_ENABLED: "false" }, encoding: "utf8" as const, timeout: 15000 };
    const ok = await run(process.execPath, ["--import", "tsx", "scripts/credit-report.ts", "--organization", id, "--check"], options);
    expect(JSON.parse(ok.stdout).needsAttention).toBe(false);
    await db.wallet.update({ where: { organizationId: id }, data: { available: { increment: 1 } } });
    await expect(run(process.execPath, ["--import", "tsx", "scripts/credit-report.ts", "--organization", id, "--check"], options)).rejects.toMatchObject({ code: 2 });
    await expect(run(process.execPath, ["--import", "tsx", "scripts/credit-report.ts", "--all"], options)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("No accounting change was made.") });
  });
  it("enforces a read-only repeatable snapshot and statement timeout in PostgreSQL", async () => {
    const id = await setup(); let inspected = false;
    const client = { $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) => db.$transaction(async tx => {
      const result = await callback(tx);
      expect(await tx.$queryRaw`SELECT current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout, current_setting('transaction_isolation') AS isolation`).toEqual([{ readonly: "on", timeout: "3s", isolation: "repeatable read" }]);
      inspected = true; return result;
    }, options) } as unknown as PrismaClient;
    expect((await readCreditReport(client, id)).needsAttention).toBe(false); expect(inspected).toBe(true);
  });
});
