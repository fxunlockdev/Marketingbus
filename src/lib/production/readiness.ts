import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { assertExecutionEnabled, configurationHash, configuredModels, keyFor } from "./router";

export const WORKER_RUNTIME = "studio-v4-social-composition-teams";
export const HEARTBEAT_TTL_MS = 120_000;
export function workerConfigurationHash() {
  return createHash("sha256").update(JSON.stringify({
    rates: configurationHash(), daily: process.env.DAILY_SUPPLIER_BUDGET_MICROS,
    total: process.env.TOTAL_SUPPLIER_BUDGET_MICROS,
    providers: { openai: !!keyFor("openai"), anthropic: !!keyFor("anthropic") },
  })).digest("hex");
}
export async function heartbeat(id: string) {
  let executionEnabled = false;
  try {
    assertExecutionEnabled();
    executionEnabled = configuredModels().some(m => !!keyFor(m.provider) && new Date(m.verifiedUntil).getTime() > Date.now());
  } catch { /* A paused worker is still operationally healthy. */ }
  const data = { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled, lastSeenAt: new Date() };
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
