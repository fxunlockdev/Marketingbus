import { runOneJob, recoverExpiredLeases } from "../src/lib/production/worker";
import { runOneShotGeneration, recoverShotGenerations } from "../src/lib/video/generation-worker";
import { processOnePayment } from "../src/lib/billing/payments";
import { db } from "../src/lib/db";
import { createDuePlan, runOneWeeklyDraft } from "../src/lib/workflows/planning";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { heartbeat, HEARTBEAT_TTL_MS } from "../src/lib/production/readiness";
import { runWorkerCycle, type WorkerStep } from "../src/lib/production/cycle";
import { purgeExpiredAssets } from "../src/lib/assets/service";
import { purgeCompositionExports } from "../src/lib/composition/exports";
import { assetStore } from "../src/lib/assets/storage";
import { runOneSourceJob } from "../src/lib/knowledge/worker";
import { runOneBrandAnalysis, recoverBrandAnalysisLeases } from "../src/lib/knowledge/analysis-worker";
import { runOneImage, recoverImageLeases } from "../src/lib/images/worker";
import { runOneMotion, recoverMotionLeases, purgeMotion } from "../src/lib/video/worker";
import { videoStore } from "../src/lib/video/service";
import { runOneClip, recoverClipLeases, purgeClips } from "../src/lib/video/clips";
import { runOneEmail } from "../src/lib/identity/worker";
import { expireIdentityArtifacts } from "../src/lib/identity/service";
import { configuredSocialAdapters } from "../src/lib/social/contracts";
import { expireSocialOAuth } from "../src/lib/social/oauth";
import { expireSocialAccountData } from "../src/lib/social/account-data-service";
import { runOnePublication, runOneMetricSync, recoverSocialLeases, runOneReconciliation } from "../src/lib/social/worker";
let stopping = false;
let lastHealthyAt = 0;
let lastRetentionCheck = 0;
const instance = process.env.RAILWAY_REPLICA_ID || randomUUID();
const steps: WorkerStep[] = [
  { name: "copy-recovery", run: recoverExpiredLeases },
  { name: "brand-recovery", run: recoverBrandAnalysisLeases },
  { name: "image-recovery", run: recoverImageLeases },
  { name: "motion-recovery", run: recoverMotionLeases },
  { name: "clip-recovery", run: recoverClipLeases },
  { name: "shot-recovery", run: recoverShotGenerations },
  { name: "social-recovery", run: recoverSocialLeases },
  { name: "payments", run: processOnePayment },
  { name: "weekly-plan", run: createDuePlan },
  { name: "weekly-draft", enabled: paid => paid, run: runOneWeeklyDraft },
  { name: "retention", run: async () => {
    if (Date.now() - lastRetentionCheck <= 300000) return;
    lastRetentionCheck = Date.now();
    await expireIdentityArtifacts();
    await expireSocialOAuth();
    await expireSocialAccountData();
    if (process.env.ASSET_S3_ENDPOINT) {
      const store = assetStore();
      void purgeExpiredAssets(store).catch(() => console.error("Asset retention check failed; retry remains queued."));
      void purgeCompositionExports(store).catch(() => console.error("Export retention check failed; private tombstones retained for retry."));
      void purgeMotion(videoStore()).catch(() => console.error("Motion retention check failed; private tombstones retained for retry."));
      void purgeClips(videoStore()).catch(() => console.error("Clip retention check failed; private tombstones retained for retry."));
    }
  } },
  { name: "email", enabled: () => process.env.EMAIL_DELIVERY_ENABLED === "true", run: runOneEmail },
  { name: "brand", enabled: paid => paid, run: runOneBrandAnalysis },
  { name: "image", enabled: paid => paid, run: runOneImage },
  { name: "shot", run: runOneShotGeneration },
  { name: "clip", enabled: () => process.env.MOTION_RENDERING_ENABLED === "true", run: runOneClip },
  { name: "motion", enabled: () => process.env.MOTION_RENDERING_ENABLED === "true", run: runOneMotion },
  { name: "copy", enabled: paid => paid, run: runOneJob },
  { name: "social-publish", enabled: () => process.env.SOCIAL_EXECUTION_ENABLED === "true", run: async () => runOnePublication(configuredSocialAdapters()) },
  { name: "social-reconcile", enabled: () => process.env.SOCIAL_EXECUTION_ENABLED === "true", run: async () => runOneReconciliation(configuredSocialAdapters()) },
  { name: "social-metrics", enabled: () => process.env.SOCIAL_EXECUTION_ENABLED === "true", run: async () => runOneMetricSync(configuredSocialAdapters()) },
  { name: "website", enabled: () => process.env.WEBSITE_EXTRACTION_ENABLED === "true", run: runOneSourceJob },
];
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
      await runWorkerCycle(steps, {
        heartbeat: async () => { const enabled = await heartbeat(instance); lastHealthyAt = Date.now(); return enabled; },
        stopping: () => stopping,
        failed: name => console.error(`Worker lane ${name} failed; other lanes remain available. No automatic provider resubmission.`),
      });
    } catch { lastHealthyAt = 0; console.error("Worker readiness check failed; cycle stopped without provider retries."); }
    if (stopping) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  await db.workerHeartbeat.deleteMany({ where: { id: instance } });
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.$disconnect();
}
void main().catch(async () => { console.error("Production worker stopped."); server.close(); await db.$disconnect(); process.exitCode = 1; });
