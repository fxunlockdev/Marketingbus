import { runOneJob, recoverExpiredLeases } from "../src/lib/production/worker";
import { db } from "../src/lib/db";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { heartbeat, HEARTBEAT_TTL_MS } from "../src/lib/production/readiness";
import { purgeExpiredAssets } from "../src/lib/assets/service";
import { assetStore } from "../src/lib/assets/storage";
import { runOneSourceJob } from "../src/lib/knowledge/worker";
import { runOneEmail } from "../src/lib/identity/worker";
import { expireIdentityArtifacts } from "../src/lib/identity/service";
import { configuredSocialAdapters } from "../src/lib/social/contracts";
import { runOnePublication, runOneMetricSync, recoverSocialLeases } from "../src/lib/social/worker";
let stopping = false;
let lastHealthyAt = 0;
let lastRetentionCheck = 0;
const instance = process.env.RAILWAY_REPLICA_ID || randomUUID();
const server = createServer((req, res) => {
  if (req.url !== "/health") { res.writeHead(404).end(); return; }
  const healthy = !stopping && Date.now() - lastHealthyAt < HEARTBEAT_TTL_MS;
  res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ status: healthy ? "ok" : "unavailable" }));
});
function stop() {
  if (stopping) return;
  stopping = true;
  // Let the bounded provider request finish. A hard interruption is reconciled, never retried.
  void db.workerHeartbeat.deleteMany({ where: { id: instance } }).catch(() => {});
  setTimeout(() => process.exit(1), 110_000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
async function main() {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid worker port");
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolve); });
  console.info("Production worker started; paid execution requires explicit server configuration.");
  while (!stopping) {
    try {
      await recoverExpiredLeases();
      await recoverSocialLeases();
      const enabled = await heartbeat(instance);
      lastHealthyAt = Date.now();
      if (Date.now() - lastRetentionCheck > 300000) {
        lastRetentionCheck = Date.now();
        await expireIdentityArtifacts();
        // Separate from paid work. Each pass is bounded, and ambiguous deletes retain their tombstone.
        if (process.env.ASSET_S3_ENDPOINT) void purgeExpiredAssets(assetStore()).catch(() => console.error("Asset retention check failed; retry remains queued."));
      }
      if (!stopping && process.env.EMAIL_DELIVERY_ENABLED === "true") {
        try { await runOneEmail(); } catch { console.error("Email delivery check failed; other job types remain available."); }
      }
      if (!stopping && enabled && await runOneJob()) continue;
      if (!stopping && process.env.SOCIAL_EXECUTION_ENABLED === "true") {
        const adapters = configuredSocialAdapters();
        await runOnePublication(adapters);
        await runOneMetricSync(adapters);
      }
      if (!stopping && process.env.WEBSITE_EXTRACTION_ENABLED === "true" && await runOneSourceJob()) continue;
    } catch { console.error("Production worker check failed; no automatic provider retry."); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  await db.workerHeartbeat.deleteMany({ where: { id: instance } });
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.$disconnect();
}
void main().catch(async () => { console.error("Production worker stopped."); server.close(); await db.$disconnect(); process.exitCode = 1; });
