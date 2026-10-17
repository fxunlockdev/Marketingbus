import { createHash } from "node:crypto";
import type { Prisma, VideoGeneration } from "@prisma/client";
import { db } from "../db";
import { lockBusiness } from "../production/service";
import { assertBrandEditor } from "../knowledge/analysis";
import { assertExecutionEnabled } from "../production/router";
import { finishReservationInTransaction } from "../billing/wallet";
import type { AssetStore } from "../assets/storage";
import { videoStore } from "./service";
import { assertClipSignature } from "./clip-normalizer";
import { MAX_VIDEO_BYTES } from "./limits";
import { assertShotContext, generationScope, failGeneratedClip } from "./generation-context";
import { configuredShotAdapters, shotAdapter, shotRoute, shotConfigurationHash, submissionReceipt, pollReceipt, MAX_SHOT_POLLS, type ShotAdapter } from "./generation-contracts";
const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const cleanupAt = () => new Date(Date.now() + 7 * 86400000);
async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([fn(abort.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(Error("Supplier timeout")); }, 60000); })]); }
  finally { clearTimeout(timer); abort.abort(); }
}
// Only the owner of the current lease may change accounting. Unknown expense retains the hold.
async function stopShot(claimed: VideoGeneration, code: string, cost: number | null, submitted: boolean, receipt?: Prisma.InputJsonValue) {
  await db.$transaction(async tx => {
    const scope = generationScope(claimed); await lockBusiness(tx, scope);
    const row = await tx.videoGeneration.findUniqueOrThrow({ where: { id: claimed.id } });
    if (!["RUNNING", "SUBMITTING", "POLLING", "INGESTING"].includes(row.status) || row.leaseUntil?.getTime() !== claimed.leaseUntil?.getTime()) return;
    const uncertain = submitted && cost === null;
    if (!uncertain) await finishReservationInTransaction(tx, row.organizationId, row.reservationId!, 0);
    await tx.videoGeneration.update({ where: { id: row.id }, data: { status: uncertain ? "NEEDS_RECONCILIATION" : "FAILED", errorCode: code, leaseUntil: null, nextPollAt: null, ...(cost !== null ? { supplierCostMicros: cost, settledAt: new Date() } : {}), ...(receipt ? { receipt } : {}) } });
    if (!uncertain) await tx.videoClip.updateMany({ where: { generationId: row.id }, data: { status: submitted ? "FAILED" : "DELETED", leaseUntil: null, purgeAfter: cleanupAt(), errorCode: code } });
    await tx.auditEvent.create({ data: { ...scope, action: "SHOT_STOPPED", detail: uncertain ? "Supplier expense is uncertain. Customer hold retained for operator review; no automatic resubmission." : "No usable footage delivered. Customer hold released; known supplier expense retained and private files scheduled for cleanup." } });
  });
}
export async function runOneShotGeneration(adapters: ShotAdapter[] = configuredShotAdapters(), storage: () => AssetStore = videoStore) {
  const claimed = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "VideoGeneration" WHERE status='QUEUED' OR (status='POLLING' AND "leaseUntil" IS NULL AND "nextPollAt" <= NOW()) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows[0]) return null;
    const row = await tx.videoGeneration.findUniqueOrThrow({ where: { id: rows[0].id } });
    return tx.videoGeneration.update({ where: { id: row.id }, data: { status: row.status === "QUEUED" ? "RUNNING" : "POLLING", leaseUntil: new Date(Date.now() + 120000), ...(row.status === "POLLING" ? { pollCount: { increment: 1 } } : {}) } });
  });
  if (!claimed) return false;
  const scope = generationScope(claimed); let submitted = claimed.status === "POLLING", cost: number | null = null, receipt: Prisma.InputJsonValue | undefined;
  const owned = async (tx: Prisma.TransactionClient, status: string) => {
    await lockBusiness(tx, scope);
    const row = await tx.videoGeneration.findUniqueOrThrow({ where: { id: claimed.id }, include: { output: true } });
    if (row.status !== status || row.leaseUntil?.getTime() !== claimed.leaseUntil?.getTime() || !row.leaseUntil || row.leaseUntil <= new Date()) throw Error("Shot lease changed");
    return row;
  };
  try {
    const route = shotRoute.parse(claimed.route), adapter = shotAdapter(route, adapters);
    if (claimed.configurationHash !== shotConfigurationHash()) throw Error("Shot configuration changed");
    if (claimed.status === "RUNNING") {
      await db.$transaction(async tx => {
        const row = await owned(tx, "RUNNING"); assertExecutionEnabled(); await assertBrandEditor(tx, scope); await assertShotContext(tx, row);
        if (new Date(route.verifiedUntil) <= new Date() || row.output?.status !== "AWAITING_GENERATION") throw Error("Shot authorization changed");
        storage();
        await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "SUBMITTING", submittedAt: new Date() } });
      });
      submitted = true;
      const accepted = submissionReceipt.parse(await bounded(signal => adapter.submit({ requestId: claimed.id, prompt: claimed.prompt, route, signal })));
      if (accepted.requestId !== claimed.id || accepted.accountId !== route.accountId) throw Error("Supplier receipt binding differs");
      await db.$transaction(async tx => {
        await owned(tx, "SUBMITTING");
        await tx.videoGeneration.update({ where: { id: claimed.id }, data: { status: "POLLING", providerJobId: accepted.providerJobId, providerJobKey: hash(JSON.stringify([route.provider, route.accountId, accepted.providerJobId])), leaseUntil: null, nextPollAt: new Date(Date.now() + 30000) } });
      });
      return true;
    }
    if (!claimed.providerJobId || claimed.pollCount > MAX_SHOT_POLLS || !claimed.submittedAt || Date.now() - claimed.submittedAt.getTime() > 3600000) throw Error("Polling allowance exhausted");
    const result = pollReceipt.parse(await bounded(signal => adapter.poll({ requestId: claimed.id, providerJobId: claimed.providerJobId!, route, signal })));
    if (result.requestId !== claimed.id || result.providerJobId !== claimed.providerJobId || result.accountId !== route.accountId || result.model !== route.model) throw Error("Supplier result binding differs");
    if (result.status === "pending") {
      if (claimed.pollCount >= MAX_SHOT_POLLS) throw Error("Polling allowance exhausted");
      await db.$transaction(async tx => { await owned(tx, "POLLING"); await tx.videoGeneration.update({ where: { id: claimed.id }, data: { leaseUntil: null, nextPollAt: new Date(Date.now() + Math.min(300000, 30000 * 2 ** Math.min(4, claimed.pollCount))) } }); });
      return true;
    }
    if (result.costMicros > claimed.supplierCeilingMicros) throw Error("Supplier expense exceeds authorization");
    cost = result.costMicros;
    receipt = { requestId: result.requestId, providerJobId: result.providerJobId, accountId: result.accountId, model: result.model, status: result.status, costMicros: cost };
    if (result.status === "failed") { await stopShot(claimed, "SUPPLIER_FAILED", cost, true, receipt); return true; }
    if (!result.bytes.byteLength || result.bytes.byteLength > MAX_VIDEO_BYTES) throw Error("Generated footage exceeds its allowance");
    const bytes = Buffer.from(result.bytes); assertClipSignature(bytes);
    const clip = await db.$transaction(async tx => {
      const row = await owned(tx, "POLLING"); await assertBrandEditor(tx, scope); await assertShotContext(tx, row);
      if (row.output?.status !== "AWAITING_GENERATION") throw Error("Reserved footage changed");
      await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "INGESTING", supplierCostMicros: cost, receipt, nextPollAt: null } });
      return tx.videoClip.update({ where: { id: row.output.id }, data: { status: "UPLOADING", sourceHash: hash(bytes), sourceBytes: bytes.length, leaseUntil: claimed.leaseUntil } });
    });
    const store = storage(); await store.put(clip.sourceKey, bytes, "video/mp4", true);
    const stored = await store.get(clip.sourceKey); if (stored.length !== bytes.length || hash(stored) !== clip.sourceHash) throw Error("Generated original storage differs");
    await db.$transaction(async tx => {
      const row = await owned(tx, "INGESTING"); await assertBrandEditor(tx, scope); await assertShotContext(tx, row);
      const changed = await tx.videoClip.updateMany({ where: { id: clip.id, status: "UPLOADING", leaseUntil: claimed.leaseUntil }, data: { status: "QUEUED", leaseUntil: null } });
      if (!changed.count) throw Error("Generated original lease changed");
      await tx.videoGeneration.update({ where: { id: row.id }, data: { leaseUntil: null } });
      await tx.auditEvent.create({ data: { ...scope, action: "SHOT_QUARANTINED", detail: "Supplier receipt and private original verified. Credits remain held until silent normalization; human review follows." } });
    });
  } catch { await stopShot(claimed, submitted ? "SUPPLIER_OR_OUTPUT_UNVERIFIED" : "PREFLIGHT_FAILED", cost, submitted, receipt); }
  return true;
}
export async function recoverShotGenerations() {
  const rows = await db.videoGeneration.findMany({ where: { OR: [
    { status: { in: ["RUNNING", "SUBMITTING", "POLLING", "INGESTING"] }, leaseUntil: { lt: new Date() } },
    { status: { in: ["QUEUED", "INGESTING"] }, leaseUntil: null, acceptedAt: { lt: new Date(Date.now() - 3600000) } },
  ] }, take: 25 });
  for (const target of rows) await db.$transaction(async tx => {
    const scope = generationScope(target); await lockBusiness(tx, scope);
    const row = await tx.videoGeneration.findUniqueOrThrow({ where: { id: target.id }, include: { output: true } });
    if (row.status !== target.status || row.leaseUntil?.getTime() !== target.leaseUntil?.getTime()) return;
    if (row.status === "INGESTING" && row.output && ["RUNNING", "STORING"].includes(row.output.status) && row.output.leaseUntil && row.output.leaseUntil > new Date()) return;
    if (row.status === "POLLING" && row.pollCount < MAX_SHOT_POLLS && row.submittedAt && row.submittedAt > new Date(Date.now() - 3600000)) {
      await tx.videoGeneration.update({ where: { id: row.id }, data: { leaseUntil: null, nextPollAt: new Date(Date.now() + 60000) } }); return;
    }
    if (row.status === "RUNNING") { await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "QUEUED", leaseUntil: null } }); return; }
    if (row.status === "QUEUED") {
      await finishReservationInTransaction(tx, row.organizationId, row.reservationId!, 0);
      await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "FAILED", errorCode: "QUEUE_EXPIRED" } });
    } else if (row.status === "INGESTING") await failGeneratedClip(tx, row.id, "INGESTION_EXPIRED");
    else { await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "NEEDS_RECONCILIATION", leaseUntil: null, nextPollAt: null, errorCode: "SUPPLIER_LEASE_EXPIRED" } }); return; }
    if (row.output) await tx.videoClip.update({ where: { id: row.output.id }, data: { status: "FAILED", leaseUntil: null, purgeAfter: cleanupAt() } });
  });
}
