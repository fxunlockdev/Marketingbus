import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { db } from "../src/lib/db";
import { heartbeat, WORKER_RUNTIME } from "../src/lib/production/readiness";

const local = process.env.TEST_DATABASE_URL;
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Local test database required");
const suite = local ? describe : describe.skip;
suite("production worker process", () => {
  afterAll(async () => db.$disconnect());
  it("persists the oldest group checkpoint rather than making a stalled worker look current", async () => {
    const id = `worker-process-test-${crypto.randomUUID()}`, at = new Date(Date.now() - 180000);
    try {
      await heartbeat(id, at);
      const row = await db.workerHeartbeat.findUniqueOrThrow({ where: { id } });
      expect(row.lastSeenAt).toEqual(at); expect(row.runtimeVersion).toBe(WORKER_RUNTIME);
      await expect(heartbeat(id, new Date(Date.now() + 60000))).rejects.toThrow("Invalid worker checkpoint");
      expect((await db.workerHeartbeat.findUniqueOrThrow({ where: { id } })).lastSeenAt).toEqual(at);
    } finally { await db.workerHeartbeat.deleteMany({ where: { id } }); }
  });
  it("starts disabled, reports health, writes matching readiness and drains cleanly", async () => {
    const portProbe = createServer(); portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
    const address = portProbe.address(); if (!address || typeof address === "string") throw Error("Port unavailable");
    const port = address.port; await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
    const id = `worker-process-test-${crypto.randomUUID()}`;
    // Deliberately do not inherit supplier keys, execution flags or storage credentials.
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/production-worker.ts"], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
        PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: local!, PORT: String(port), RAILWAY_REPLICA_ID: id,
        APP_ORIGIN: "http://127.0.0.1:3000", PAID_EXECUTION_ENABLED: "false", EMAIL_DELIVERY_ENABLED: "false", WEBSITE_EXTRACTION_ENABLED: "false", SOCIAL_EXECUTION_ENABLED: "false", MOTION_RENDERING_ENABLED: "false", BILLING_EXECUTION_ENABLED: "false", STRIPE_REFUNDS_ENABLED: "false",
      },
    });
    let output = "", closed = false;
    child.stdout.on("data", bytes => { output = (output + bytes.toString()).slice(-10000); });
    child.stderr.on("data", bytes => { output = (output + bytes.toString()).slice(-10000); });
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", code => { closed = true; resolve(code); });
    });
    const deadline = Date.now() + 15000;
    try {
      let response: Response | undefined;
      while (Date.now() < deadline && !closed) {
        try { response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }); if (response.status === 200) break; } catch { /* Startup not ready yet. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(response?.status, output).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      expect(await response?.json()).toEqual({ status: "ok" });
      expect((await fetch(`http://127.0.0.1:${port}/private`, { signal: AbortSignal.timeout(1000) })).status).toBe(404);
      expect(await db.workerHeartbeat.findUniqueOrThrow({ where: { id } })).toMatchObject({ runtimeVersion: WORKER_RUNTIME, executionEnabled: false, motionReady: false });
      child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { expect(await Promise.race([completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Worker did not drain")), 10000); })])).toBe(0); }
      finally { clearTimeout(timer); }
      expect(await db.workerHeartbeat.findUnique({ where: { id } })).toBeNull();
      expect(output).toContain("Production worker started");
      expect(output).not.toContain("Worker lane");
    } finally {
      if (!closed) child.kill("SIGKILL");
      await completion.catch(() => {});
      await db.workerHeartbeat.deleteMany({ where: { id } });
    }
  }, 30000);
});
