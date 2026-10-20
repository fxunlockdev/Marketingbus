import { runOneJob, recoverExpiredLeases } from "../src/lib/production/worker";
import { runOneShotGeneration, recoverShotGenerations } from "../src/lib/video/generation-worker";
import { processOnePayment } from "../src/lib/billing/payments";
import { db } from "../src/lib/db";
import { createDuePlan, runOneWeeklyDraft } from "../src/lib/workflows/planning";
import { runOneWeeklyImage } from "../src/lib/workflows/weekly-images";
import { runOneWeeklyVideo } from "../src/lib/workflows/weekly-videos";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { heartbeat, HEARTBEAT_TTL_MS } from "../src/lib/production/readiness";
import { GroupReadiness, runWorkerGroups, validateWorkerGroups, WORKER_POLL_MS, type WorkerGroup } from "../src/lib/production/groups";
import { purgeExpiredAssets } from "../src/lib/assets/service";
import { purgeCompositionExports } from "../src/lib/composition/exports";
import { assetStore } from "../src/lib/assets/storage";
import { runOneSourceJob } from "../src/lib/knowledge/worker";
import { runOneBrandAnalysis, recoverBrandAnalysisLeases } from "../src/lib/knowledge/analysis-worker";
import { runOneProcedureReflection } from "../src/lib/harness/procedure-worker";
import { runOneImage, recoverImageLeases } from "../src/lib/images/worker";
import { runOneMotion, recoverMotionLeases, purgeMotion } from "../src/lib/video/worker";
import { videoStore } from "../src/lib/video/service";
import { runOneClip, recoverClipLeases, purgeClips } from "../src/lib/video/clips";
import { runOneEmail } from "../src/lib/identity/worker";
import { expireIdentityArtifacts } from "../src/lib/identity/service";
import { configuredSocialAdapters } from "../src/lib/social/contracts";
import { expireSocialOAuth } from "../src/lib/social/oauth";
import { expireSocialAccountData } from "../src/lib/social/account-data-service";
import { expireOneSocialConnection } from "../src/lib/social/access-lifecycle";
import { runOnePublication, runOneMetricSync, recoverSocialLeases, runOneReconciliation } from "../src/lib/social/worker";
import { recoveryQuarantined } from "../src/lib/recovery-quarantine";
// Deployment environment changes require a process restart. Never begin a lane
// (including maintenance/recovery/readiness writes) in a restored quarantine.
const quarantined = recoveryQuarantined();
let stopping = false;
let lastRetentionCheck = 0;
const instance = process.env.RAILWAY_REPLICA_ID || randomUUID();
const groups: WorkerGroup[] = [{ name: "production", steps: [
  { name: "copy-recovery", run: recoverExpiredLeases },
  { name: "brand-recovery", run: recoverBrandAnalysisLeases },
  { name: "image-recovery", run: recoverImageLeases },
  { name: "motion-recovery", run: recoverMotionLeases },
  { name: "clip-recovery", run: recoverClipLeases },
  { name: "shot-recovery", run: recoverShotGenerations },
  { name: "weekly-draft", enabled: paid => paid, run: runOneWeeklyDraft },
  { name: "weekly-image", enabled: paid => paid, run: runOneWeeklyImage },
  { name: "weekly-video", enabled: paid => paid, run: runOneWeeklyVideo },
  { name: "brand", enabled: paid => paid, run: runOneBrandAnalysis },
  { name: "reflection", enabled: paid => paid, run: runOneProcedureReflection },
  { name: "image", enabled: paid => paid, run: runOneImage },
  { name: "shot", run: runOneShotGeneration },
  { name: "clip", enabled: () => process.env.MOTION_RENDERING_ENABLED === "true", run: runOneClip },
  { name: "motion", enabled: () => process.env.MOTION_RENDERING_ENABLED === "true", run: runOneMotion },
  { name: "copy", enabled: paid => paid, run: runOneJob },
] }, { name: "publishing", steps: [
  { name: "social-recovery", run: recoverSocialLeases },
  { name: "social-publish", enabled: () => process.env.SOCIAL_EXECUTION_ENABLED === "true", run: async () => runOnePublication(configuredSocialAdapters()) },
  { name: "social-reconcile", enabled: () => process.env.SOCIAL_EXECUTION_ENABLED === "true", run: async () => runOneReconciliation(configuredSocialAdapters()) },
] }, { name: "metrics", steps: [
  { name: "social-metrics", enabled: () => process.env.SOCIAL_EXECUTION_ENABLED === "true", run: async () => runOneMetricSync(configuredSocialAdapters()) },
] }, { name: "delivery", steps: [
  { name: "payments", run: processOnePayment },
  { name: "weekly-plan", run: createDuePlan },
  { name: "email", enabled: () => process.env.EMAIL_DELIVERY_ENABLED === "true", run: runOneEmail },
] }, { name: "intake", steps: [
  { name: "website", enabled: () => process.env.WEBSITE_EXTRACTION_ENABLED === "true", run: runOneSourceJob },
] }, { name: "maintenance", steps: [
  { name: "social-access-expiry", run: expireOneSocialConnection },
  { name: "retention", run: async () => {
    if (Date.now() - lastRetentionCheck <= 300000) return;
    lastRetentionCheck = Date.now();
    await expireIdentityArtifacts();
    await expireSocialOAuth();
    await expireSocialAccountData();
    if (process.env.ASSET_S3_ENDPOINT) {
      const store = assetStore();
      await purgeExpiredAssets(store).catch(() => console.error("Asset retention check failed; retry remains queued."));
      await purgeCompositionExports(store).catch(() => console.error("Export retention check failed; private tombstones retained for retry."));
      await purgeMotion(videoStore()).catch(() => console.error("Motion retention check failed; private tombstones retained for retry."));
      await purgeClips(videoStore()).catch(() => console.error("Clip retention check failed; private tombstones retained for retry."));
    }
  } },
] }];
validateWorkerGroups(groups);
const readiness = new GroupReadiness(groups.map(group => group.name), {
  write: at => heartbeat(instance, at), stopping: () => stopping, ttlMs: HEARTBEAT_TTL_MS,
});
const sleepers = new Set<() => void>();
function pause() {
  return new Promise<void>(resolve => {
    if (stopping) { resolve(); return; }
    const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
    const timer = setTimeout(wake, WORKER_POLL_MS); sleepers.add(wake);
  });
}
let readinessRemoval: Promise<unknown> | undefined;
const server = createServer((req, res) => {
  if (req.url !== "/health") { res.writeHead(404).end(); return; }
  const healthy = !quarantined && readiness.healthy();
  res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ status: healthy ? "ok" : "unavailable" }));
});
function stop() {
  if (stopping) return;
  stopping = true;
  // Let the bounded provider request finish. A hard interruption is reconciled, never retried.
  for (const wake of sleepers) wake();
  // Serialize deletion after an in-flight readiness write; no late upsert can revive it.
  if (!quarantined) readinessRemoval = readiness.drain().then(() => db.workerHeartbeat.deleteMany({ where: { id: instance } })).catch(() => {});
  setTimeout(() => process.exit(1), 110_000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
async function main() {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid worker port");
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolve); });
  if (quarantined) {
    console.info("Production worker quarantined; all lanes and readiness writes are paused.");
    while (!stopping) await pause();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.$disconnect();
    return;
  }
  console.info("Production worker started; paid execution requires explicit server configuration.");
  await runWorkerGroups(groups, {
    readiness, stopping: () => stopping, sleep: pause,
    failed: (group, name) => console.error(`Worker lane ${group}/${name} failed; other lanes remain available. No automatic provider resubmission.`),
    readinessFailed: group => { if (!stopping) console.error(`Worker readiness unavailable for ${group}; cycle stopped without provider retries.`); },
  });
  await readinessRemoval;
  await db.workerHeartbeat.deleteMany({ where: { id: instance } });
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.$disconnect();
}
void main().catch(async () => { console.error("Production worker stopped."); server.close(); await db.$disconnect(); process.exitCode = 1; });
