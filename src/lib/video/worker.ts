import { createHash } from "node:crypto";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, type Scope } from "../production/service";
import { assertBrandEditor } from "../knowledge/analysis";
import type { AssetStore } from "../assets/storage";
import { storyboardContext, videoScope, videoStore } from "./service";
import { renderMotion, type MotionRenderer } from "./render";
import { MAX_VIDEO_BYTES, MOTION_RENDERER_VERSION, motionDailyLimit, motionHash } from "./limits";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function runOneMotion(renderer: MotionRenderer = renderMotion, storage: () => AssetStore = videoStore) {
  motionDailyLimit();
  const claimed = await db.$transaction(async tx => {
    // One active render across all worker replicas. Expired jobs require recovery first.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403219)::text`;
    if (await tx.motionRender.count({ where: { status: { in: ["RUNNING", "STORING"] } } })) return null;
    const jobs = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "MotionRender" WHERE status='QUEUED' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!jobs[0]) return null;
    return tx.motionRender.update({ where: { id: jobs[0].id }, data: { status: "RUNNING", leaseUntil: new Date(Date.now() + 180000) } });
  });
  if (!claimed) return false;
  const scope = videoScope(claimed);
  const fresh = async (expected: "RUNNING" | "STORING") => db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const row = await tx.motionRender.findUniqueOrThrow({ where: { id: claimed.id } });
    const context = await storyboardContext(scope, row.storyboardId, tx);
    if (row.status !== expected || row.leaseUntil?.getTime() !== claimed.leaseUntil?.getTime() || row.leaseUntil!.getTime() <= Date.now() || row.rendererVersion !== MOTION_RENDERER_VERSION || row.purgeAfter <= new Date() || context.row.status !== "APPROVED" || motionHash(context.document) !== row.documentHash) throw Error("Motion authorization changed.");
    return { row, context };
  });
  try {
    const store = storage(), { context } = await fresh("RUNNING"), assets = new Map<string, Uint8Array>();
    for (const asset of context.assets) {
      const bytes = await store.get(asset.objectKey); if (hash(bytes) !== asset.sha256) throw Error("Motion input integrity failed."); assets.set(asset.id, bytes);
    }
    await fresh("RUNNING"); motionDailyLimit();
    const output = await renderer(context.document, assets);
    if (!output.bytes.length || output.bytes.length >= MAX_VIDEO_BYTES || output.width !== 720 || output.height !== 1280 || Math.abs(output.durationMs - claimed.durationMs) > 100) throw Error("Invalid motion render result.");
    await fresh("RUNNING");
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
      const ctx = await storyboardContext(scope, claimed.storyboardId, tx);
      if (ctx.row.status !== "APPROVED" || motionHash(ctx.document) !== claimed.documentHash) throw Error("Storyboard changed.");
      const updated = await tx.motionRender.updateMany({ where: { id: claimed.id, status: "RUNNING", leaseUntil: claimed.leaseUntil }, data: { status: "STORING", sha256: hash(output.bytes), bytes: output.bytes.length } });
      if (!updated.count) throw Error("Render lease changed.");
    });
    await store.put(claimed.objectKey, output.bytes, "video/mp4", true);
    const stored = await store.get(claimed.objectKey); if (stored.length !== output.bytes.length || hash(stored) !== hash(output.bytes)) throw Error("Motion storage verification failed.");
    await fresh("STORING");
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
      const ctx = await storyboardContext(scope, claimed.storyboardId, tx);
      if (ctx.row.status !== "APPROVED" || motionHash(ctx.document) !== claimed.documentHash) throw Error("Storyboard changed.");
      const updated = await tx.motionRender.updateMany({ where: { id: claimed.id, status: "STORING", leaseUntil: claimed.leaseUntil }, data: { status: "READY", leaseUntil: null } });
      if (!updated.count) throw Error("Render lease changed.");
      await tx.auditEvent.create({ data: { ...scope, action: "MOTION_READY", detail: "Silent H.264 motion reel normalized and storage-verified. Final watch-through approval required before download or publishing. No AI credits spent." } });
    });
  } catch {
    await db.motionRender.updateMany({ where: { id: claimed.id, status: { in: ["RUNNING", "STORING"] }, leaseUntil: claimed.leaseUntil }, data: { status: "FAILED", leaseUntil: null, errorCode: "RENDER_OR_STORAGE_FAILED", purgeAfter: new Date(Date.now() + 7 * 86400000) } });
  }
  return true;
}
export async function recoverMotionLeases() {
  // Do not spin forever after a crash: the user explicitly creates a new version
  // for another render, or recovers an already written object without rendering.
  await db.motionRender.updateMany({ where: { status: { in: ["RUNNING", "STORING"] }, leaseUntil: { lt: new Date() } }, data: { status: "FAILED", leaseUntil: null, errorCode: "RENDER_LEASE_EXPIRED", purgeAfter: new Date(Date.now() + 7 * 86400000) } });
}
export async function recoverMotionStorage(scope: Scope, id: string, store: AssetStore = videoStore()) {
  const row = await db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const found = await tx.motionRender.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId, status: "FAILED", sha256: { not: "" }, purgeAfter: { gt: new Date() } } });
    if (!found || found.leaseUntil && found.leaseUntil > new Date()) throw new AppError(409, "No recoverable stored video is available.");
    const ctx = await storyboardContext(scope, found.storyboardId, tx);
    if (ctx.row.status !== "APPROVED" || motionHash(ctx.document) !== found.documentHash || found.rendererVersion !== MOTION_RENDERER_VERSION) throw new AppError(409, "Storyboard changed; create a current render.");
    return found;
  });
  const bytes = await store.get(row.objectKey);
  if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new AppError(409, "Stored video fingerprint does not match.");
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const ctx = await storyboardContext(scope, row.storyboardId, tx);
    if (ctx.row.status !== "APPROVED" || motionHash(ctx.document) !== row.documentHash) throw new AppError(409, "Storyboard changed during recovery.");
    const changed = await tx.motionRender.updateMany({ where: { id, status: "FAILED", sha256: row.sha256, purgeAfter: { gt: new Date() } }, data: { status: "READY", leaseUntil: null, errorCode: null } });
    if (!changed.count) throw new AppError(409, "Render state changed during recovery.");
    await tx.auditEvent.create({ data: { ...scope, action: "MOTION_RECOVERED", detail: "Recovered private output using hash-verified read-back only. No second render or upload." } }); return { ok: true };
  });
}
export async function purgeMotion(store: AssetStore = videoStore(), now = new Date()) {
  const rows = await db.motionRender.findMany({ where: { status: { notIn: ["DELETED", "CANCELLED", "QUEUED", "RUNNING", "STORING"] }, purgeAfter: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, take: 10, orderBy: { purgeAfter: "asc" } });
  let count = 0;
  for (const row of rows) {
    const lease = new Date(Date.now() + 120000);
    const changed = await db.$transaction(async tx => {
      await lockBusiness(tx, videoScope(row));
      return tx.motionRender.updateMany({ where: { id: row.id, status: row.status, purgeAfter: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { status: "DELETING", approvedBy: null, leaseUntil: lease } });
    });
    if (!changed.count) continue;
    try {
      await store.remove(row.objectKey);
      count += await db.$transaction(async tx => {
        const deleted = await tx.motionRender.updateMany({ where: { id: row.id, status: "DELETING", leaseUntil: lease }, data: { status: "DELETED", bytes: 0, sha256: "", leaseUntil: null } });
        if (deleted.count) await tx.auditEvent.create({ data: { ...videoScope(row), actorId: "retention-worker", action: "MOTION_PURGED", detail: "Private motion output deleted from active storage. Previously downloaded copies and backups are separate." } });
        return deleted.count;
      });
    } catch { /* Keep quota and private tombstone; retry only after lease expiration. */ }
  }
  return count;
}
