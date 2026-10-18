import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { assertExecutionEnabled, configurationHash, configuredModels, keyFor } from "./router";
import { imageConfigurationHash, imageRates } from "../images/contracts";
import { motionConfigurationHash } from "../video/limits";
import { motionRendererAvailable } from "../video/render";
import { shotConfigurationHash, shotRates, configuredShotAdapters } from "../video/generation-contracts";

export const WORKER_RUNTIME = "studio-v32-metric-recovery";
export const HEARTBEAT_TTL_MS = 120_000;
export function workerConfigurationHash() {
  return createHash("sha256").update(JSON.stringify({
    rates: configurationHash(), daily: process.env.DAILY_SUPPLIER_BUDGET_MICROS,
    images: imageConfigurationHash(),
    motion: motionConfigurationHash(),
    video: shotConfigurationHash(),
    billing: { enabled: process.env.BILLING_EXECUTION_ENABLED, account: process.env.STRIPE_ACCOUNT_ID, mode: process.env.STRIPE_MODE, offers: process.env.BILLING_OFFERS_JSON },
    total: process.env.TOTAL_SUPPLIER_BUDGET_MICROS,
    providers: { openai: !!keyFor("openai"), anthropic: !!keyFor("anthropic") },
  })).digest("hex");
}
export async function heartbeat(id: string) {
  let executionEnabled = false;
  try {
    assertExecutionEnabled();
    executionEnabled = configuredModels().some(m => !!keyFor(m.provider) && new Date(m.verifiedUntil).getTime() > Date.now()) || (!!process.env.GEMINI_API_KEY && imageRates().some(m => new Date(m.verifiedUntil).getTime() > Date.now()));
    executionEnabled ||= shotRates().some(r => new Date(r.verifiedUntil).getTime() > Date.now() && configuredShotAdapters().some(a => a.id === r.provider && a.accountId === r.accountId && a.version === r.adapterVersion));
  } catch { /* A paused worker is still operationally healthy. */ }
  const data = { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled, motionReady: await motionRendererAvailable(), lastSeenAt: new Date() };
  await db.workerHeartbeat.upsert({ where: { id }, create: { id, ...data }, update: data });
  return executionEnabled;
}
export async function assertWorkerReady(client: Pick<Prisma.TransactionClient, "workerHeartbeat"> = db) {
  const worker = await client.workerHeartbeat.findFirst({ where: {
    runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled: true,
    lastSeenAt: { gt: new Date(Date.now() - HEARTBEAT_TTL_MS) },
  }, select: { id: true } });
  if (!worker) throw new AppError(503, "Production worker is not ready with matching settings. No new credits were reserved.");
}
export async function assertBillingWorkerReady() {
  if (!await db.workerHeartbeat.findFirst({ where: { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), lastSeenAt: { gt: new Date(Date.now() - HEARTBEAT_TTL_MS) } }, select: { id: true } })) throw new AppError(503, "Billing worker is not ready with matching settings. Checkout has not started.");
}
