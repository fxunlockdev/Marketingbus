import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient, type Job } from "@prisma/client";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { isolatedEnvironment } from "../scripts/recovery/safety";
import { reserveCreditsInTransaction } from "../src/lib/billing/wallet";

const local = process.env.TEST_DATABASE_URL;
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Local fixture server required");
const suite = local ? describe : describe.skip;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  do { if (await check()) return; await delay(100); } while (Date.now() < end);
  throw Error("Worker process checkpoint timed out");
}
async function worker(database: string) {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address(); if (!address || typeof address === "string") throw Error("Port unavailable");
  const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const id = `crash-fixture-${crypto.randomUUID()}`;
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/production-worker.ts"], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...isolatedEnvironment({ DATABASE_URL: database }),
      RECOVERY_QUARANTINE: "false", PORT: String(port), RAILWAY_REPLICA_ID: id, APP_ORIGIN: "http://127.0.0.1:3000" },
  });
  // Drain bounded diagnostics without exposing connection strings or fixture contents.
  let output = "", closed = false;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data.toString()).slice(-10000); });
  const completion = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  return { id, completion, closed: () => closed, output: () => output,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    healthy: async () => {
      if (closed) throw Error("Worker exited before readiness");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        expect(response.headers.get("cache-control")).toBe("no-store");
        return response.status === 200;
      } catch { return false; }
    },
  };
}

suite("isolated production worker crash and overlapping restart", () => {
  const admin = local ? new PrismaClient({ datasourceUrl: local, log: [] }) : null;
  afterAll(async () => admin?.$disconnect());
  it("preserves uncertain holds, recovers only pre-submission work and exposes reconciliation after SIGKILL", async () => {
    for (const file of [".env", ".env.local", ".env.test", ".env.test.local"])
      if (existsSync(file)) throw Error("Run process recovery tests without environment files");
    const name = `mb_worker_${crypto.randomUUID().replaceAll("-", "")}`;
    if (!/^mb_worker_[a-f0-9]{32}$/.test(name)) throw Error("Unsafe disposable database name");
    const url = new URL(local!); url.pathname = `/${name}`;
    const client = new PrismaClient({ datasourceUrl: url.href, log: [] });
    const workers: Awaited<ReturnType<typeof worker>>[] = [];
    let created = false;
    try {
      // No IF NOT EXISTS and no external dataset: only this random, newly created DB is used.
      await admin!.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created = true;
      await promisify(execFile)(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"],
        { env: isolatedEnvironment({ DATABASE_URL: url.href }), timeout: 60000, maxBuffer: 1024 * 1024 });
      const org = await client.organization.create({ data: { name: "Crash fixture", wallet: { create: { available: 100 } } } });
      const business = await client.business.create({ data: { organizationId: org.id, name: "Crash fixture", confirmedAt: new Date() } });
      const other = await client.organization.create({ data: { name: "Untouched tenant", wallet: { create: { available: 17 } } } });
      const plan = await client.productionPlan.create({ data: { businessId: business.id, organizationId: org.id, brandVersion: 1, title: "Crash fixture", creditCeiling: 100 } });
      const first = await worker(url.href); workers.push(first); await until(first.healthy);
      const jobs: Job[] = [];
      for (const status of ["RUNNING", "SUBMITTING"] as const) {
        const item = await client.productionItem.create({ data: { planId: plan.id, organizationId: org.id, title: status, channel: "LinkedIn", format: "static", brief: {}, status: "QUEUED" } });
        const quote = await client.generationQuote.create({ data: { itemId: item.id, businessId: business.id, organizationId: org.id,
          brandVersion: 1, baseVersion: 0, mode: "initial", credits: 10, supplierCeilingMicros: 1000, request: {}, configurationHash: "synthetic",
          status: "ACCEPTED", acceptedAt: new Date(), expiresAt: new Date(Date.now() + 60000) } });
        const reservation = await client.$transaction(tx => reserveCreditsInTransaction(tx, org.id, quote.id, 10));
        jobs.push(await client.job.create({ data: { businessId: business.id, organizationId: org.id, quoteId: quote.id,
          reservationId: reservation.id, kind: "STATIC_COPY", key: quote.id, status, payload: { fixture: true }, attempts: 1,
          submittedAt: status === "SUBMITTING" ? new Date() : null, leaseUntil: new Date(Date.now() + 300000) } }));
      }
      const wallet = await client.wallet.findMany({ orderBy: { organizationId: "asc" } });
      const journal = await client.creditEntry.findMany({ orderBy: { id: "asc" } });
      const reservations = await client.reservation.findMany({ orderBy: { id: "asc" } });
      first.kill("SIGKILL"); await until(async () => first.closed());
      expect((await first.completion).signal).toBe("SIGKILL");
      expect(await client.workerHeartbeat.findUnique({ where: { id: first.id } })).not.toBeNull();
      expect(await client.job.findMany({ orderBy: { id: "asc" } })).toEqual([...jobs].sort((a, b) => a.id.localeCompare(b.id)));
      // Advance only this fixture's leases, not host time or the shared test server.
      // This simulates expiry after the hard stop, not a real supplier call in flight.
      await client.job.updateMany({ data: { leaseUntil: new Date(0) } });
      const second = await worker(url.href); workers.push(second);
      const third = await worker(url.href); workers.push(third);
      await Promise.all([until(second.healthy), until(third.healthy)]);
      await until(async () => (await client.job.findUniqueOrThrow({ where: { id: jobs[1].id } })).status === "NEEDS_RECONCILIATION");
      expect(await client.job.findUniqueOrThrow({ where: { id: jobs[0].id } })).toMatchObject({ status: "QUEUED", attempts: 1, leaseUntil: null, submittedAt: null });
      expect(await client.job.findUniqueOrThrow({ where: { id: jobs[1].id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", attempts: 1, leaseUntil: null, errorCode: "LEASE_EXPIRED_AFTER_SUBMISSION", submittedAt: jobs[1].submittedAt });
      const quote = await client.generationQuote.findUniqueOrThrow({ where: { id: jobs[1].quoteId! } });
      expect(quote.status).toBe("RECONCILE");
      expect((await client.productionItem.findUniqueOrThrow({ where: { id: quote.itemId } })).status).toBe("NEEDS_RECONCILIATION");
      // Another real polling interval must not retry or settle uncertain work.
      await delay(5200);
      expect(await client.wallet.findMany({ orderBy: { organizationId: "asc" } })).toEqual(wallet);
      expect(await client.creditEntry.findMany({ orderBy: { id: "asc" } })).toEqual(journal);
      expect(await client.reservation.findMany({ orderBy: { id: "asc" } })).toEqual(reservations);
      expect(await client.creativeRevision.count()).toBe(0);
      expect((await client.wallet.findUniqueOrThrow({ where: { organizationId: other.id } })).available).toBe(17);
      expect((await client.job.findMany()).every(job => job.attempts === 1)).toBe(true);
      for (const current of [second, third]) {
        current.kill("SIGTERM"); await until(async () => current.closed());
        expect((await current.completion).code).toBe(0);
        expect(await client.workerHeartbeat.findUnique({ where: { id: current.id } })).toBeNull();
        expect(current.output()).not.toContain("Worker lane");
      }
    } finally {
      for (const current of workers) { if (!current.closed()) current.kill("SIGKILL"); await current.completion.catch(() => {}); }
      await client.$disconnect();
      if (created) await admin!.$executeRawUnsafe(`DROP DATABASE "${name}"`);
    }
  }, 90000);
});
