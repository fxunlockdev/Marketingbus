import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the built web runtime and actual worker, not a mocked proxy. Never
// inherit production URLs, secrets, injection options or automatically loaded env files.
for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(file)) throw Error("Run recovery checks in a checkout without environment files.");
}
if (!existsSync(".next/BUILD_ID")) throw Error("Build the application before running recovery checks.");
async function listen(server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function close(server) { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
async function freePort() { const server = createServer(); const port = await listen(server); await close(server); return port; }
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
let databaseConnections = 0;
const databaseTrap = createServer(socket => { databaseConnections++; socket.destroy(); });
const databasePort = await listen(databaseTrap);
let requests = 0;
try {
  for (const value of ["true", "misspelled"]) {
    for (const mode of ["web", "worker"]) {
      const port = await freePort();
      const child = spawn(process.execPath, mode === "web"
        ? ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)]
        : ["--import", "tsx", "scripts/production-worker.ts"], {
        stdio: ["ignore", "pipe", "pipe"], env: {
          PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
          DATABASE_URL: `postgresql://synthetic:synthetic@127.0.0.1:${databasePort}/no_database`,
          PORT: String(port), APP_ORIGIN: `http://127.0.0.1:${port}`, RECOVERY_QUARANTINE: value,
          PAID_EXECUTION_ENABLED: "true", SOCIAL_EXECUTION_ENABLED: "true", EMAIL_DELIVERY_ENABLED: "true",
          WEBSITE_EXTRACTION_ENABLED: "true", MOTION_RENDERING_ENABLED: "true", BILLING_EXECUTION_ENABLED: "true", STRIPE_REFUNDS_ENABLED: "true",
        },
      });
      let closed = false, output = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output = (output + bytes.toString()).slice(-10000); });
      const completion = new Promise((resolve, reject) => {
        child.once("error", reject); child.once("close", code => { closed = true; resolve(code); });
      });
      async function request(path, method = "GET", headers = {}) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, redirect: "manual", signal: AbortSignal.timeout(3000) });
        requests++;
        assert.equal(response.status, 503, `${mode} ${method} ${path}`);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(response.headers.get("location"), null);
        if (mode === "web") assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        if (method === "HEAD") assert.equal(await response.text(), "");
        else assert.deepEqual(await response.json(), mode === "web"
          ? { status: "unavailable", message: "Service temporarily unavailable." } : { status: "unavailable" });
      }
      try {
        let ready = false;
        for (let i = 0; i < 150 && !closed; i++) {
          try { await fetch(`http://127.0.0.1:${port}${mode === "web" ? "/api/health" : "/health"}`, { signal: AbortSignal.timeout(500) }); ready = true; break; }
          catch { await delay(100); }
        }
        assert.ok(ready, `Quarantined ${mode} did not start`);
        if (mode === "web") {
          for (const path of ["/", "/studio", "/login", "/api/health", "/api/businesses", "/favicon.ico", "/_next/static/missing.js",
            "/api/social/instagram/callback?code=synthetic-private-code&state=synthetic-private-state", "/api/social/media/example/private-token", "/not-a-route"]) await request(path);
          for (const path of ["/api/auth/login", "/api/billing/webhook", "/studio", "/api/businesses"]) await request(path, "POST", { "content-type": "application/json" });
          await request("/api/health", "HEAD"); await request("/api/billing/webhook", "OPTIONS");
          await request("/studio", "POST", { "next-action": "synthetic-action", rsc: "1" });
          await request("/api/businesses", "GET", { "x-middleware-subrequest": "src/proxy:src/proxy:src/proxy:src/proxy:src/proxy", "x-recovery-quarantine": "false" });
        } else {
          await request("/health");
          // Stay quarantined across a full worker polling interval, not just startup.
          await delay(5200); await request("/health");
          assert.ok(output.includes("Production worker quarantined"));
          assert.ok(!output.includes("Worker lane"));
        }
        assert.equal(databaseConnections, 0, "Quarantine attempted a database connection");
        child.kill("SIGTERM");
        const code = await bounded(completion, 10000, "Quarantine did not stop cleanly");
        // Next's CLI forwards SIGTERM as 128 + signal; the worker owns a graceful exit.
        assert.ok(mode === "web" ? code === 0 || code === 143 : code === 0, `Unexpected ${mode} shutdown status: ${code}`);
        assert.equal(databaseConnections, 0, "Shutdown attempted a database connection");
      } finally {
        if (!closed) child.kill("SIGKILL");
        await completion.catch(() => {});
      }
    }
  }
  console.log(JSON.stringify({ status: "passed", webAndWorkerConfigurations: 4, requests, databaseConnections, providerCredentials: "none" }));
} finally { await close(databaseTrap); }
