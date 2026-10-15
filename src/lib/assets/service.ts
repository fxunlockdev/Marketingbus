import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, type Scope } from "../production/service";
import { BUSINESS_ASSET_BYTES, normalizeImage } from "./images";
import { assetStore, type AssetStore } from "./storage";
export const assetInput = z.object({ label: z.string().trim().min(1).max(100), purpose: z.enum(["logo", "product", "reference"]), rightsConfirmed: z.literal(true) }).strict();
export const publicAssetFields = { id: true, label: true, purpose: true, width: true, height: true, bytes: true, status: true, createdAt: true, approvedForGeneration: true, purgeAfter: true } as const;
export async function uploadAsset(scope: Scope, raw: unknown, bytes: Buffer, store: AssetStore = assetStore()) {
  const input = assetInput.parse(raw);
  const image = await normalizeImage(bytes);
  const reserved = await db.$transaction(async tx => {
    await lockBusiness(tx, scope);
    const existing = await tx.brandAsset.findFirst({ where: { businessId: scope.businessId, organizationId: scope.organizationId, sha256: image.sha256, purpose: input.purpose, status: "READY" }, select: publicAssetFields });
    if (existing) return { existing };
    const usage = await tx.brandAsset.aggregate({ where: { organizationId: scope.organizationId, businessId: scope.businessId, status: { not: "DELETED" } }, _sum: { bytes: true }, _count: true });
    if (usage._count >= 100 || (usage._sum.bytes || 0) + image.bytes > BUSINESS_ASSET_BYTES) throw new AppError(409, "This business has reached its pilot asset allowance (25 MB or 100 images).");
    const asset = await tx.brandAsset.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId,
      objectKey: `${scope.organizationId}/${scope.businessId}/${randomUUID()}.webp`, label: input.label, purpose: input.purpose,
      sha256: image.sha256, bytes: image.bytes, width: image.width, height: image.height, uploadedBy: scope.actorId, rightsConfirmedAt: new Date() } });
    return { asset };
  });
  if (reserved.existing) return { asset: reserved.existing, deduplicated: true };
  const asset = reserved.asset!;
  try {
    await store.put(asset.objectKey, image.data);
    return await db.$transaction(async tx => {
      const ready = await tx.brandAsset.update({ where: { id: asset.id }, data: { status: "READY" }, select: publicAssetFields });
      await tx.auditEvent.create({ data: { ...scope, action: "ASSET_UPLOADED", detail: `Private ${input.purpose} image uploaded. Rights confirmed; metadata removed. Not yet selected for generated creatives.` } });
      return { asset: ready, deduplicated: false };
    });
  } catch {
    // Keep the quota reservation if object storage outcome is ambiguous. Never expose partial uploads.
    await db.brandAsset.update({ where: { id: asset.id }, data: { status: "FAILED" } });
    throw new AppError(503, "The upload could not be confirmed. It remains private; an operator can reconcile it.");
  }
}
export const assetAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), approved: z.boolean() }).strict(),
  z.object({ action: z.enum(["archive", "restore"]) }).strict(),
]);
export async function changeAsset(scope: Scope, id: string, raw: unknown, now = new Date()) {
  const input = assetAction.parse(raw);
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope);
    const asset = await tx.brandAsset.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId } });
    if (!asset || asset.status === "DELETED") throw new AppError(404, "Image not found.");
    if (input.action === "approve") {
      if (asset.status !== "READY") throw new AppError(409, "Restore this image before approving it.");
      await tx.brandAsset.update({ where: { id }, data: { approvedForGeneration: input.approved } });
    } else if (input.action === "archive") {
      if (asset.status === "ARCHIVED") return { ok: true };
      if (!["READY", "FAILED"].includes(asset.status)) throw new AppError(409, "This image has an active storage operation. Try later.");
      await tx.brandAsset.update({ where: { id }, data: { status: "ARCHIVED", archivedFromStatus: asset.status, approvedForGeneration: false, archivedAt: now, purgeAfter: new Date(now.getTime() + 7 * 86400000) } });
    } else {
      if (asset.status !== "ARCHIVED" || !asset.purgeAfter || asset.purgeAfter <= now) throw new AppError(409, "The restore window has expired or deletion has begun.");
      // Failed/uncertain uploads cannot be restored as verified images.
      if (asset.archivedFromStatus !== "READY") throw new AppError(409, "This upload was never verified. An operator must reconcile it.");
      await tx.brandAsset.update({ where: { id }, data: { status: "READY", archivedAt: null, archivedFromStatus: null, purgeAfter: null, approvedForGeneration: false } });
    }
    await tx.generationQuote.updateMany({ where: { businessId: scope.businessId, status: "OFFERED" }, data: { status: "SUPERSEDED" } });
    await tx.auditEvent.create({ data: { ...scope, action: `ASSET_${input.action.toUpperCase()}`, detail: `Asset ${id}: ${input.action}. Removal revokes use permission; restore never automatically re-approves.` } });
    return { ok: true };
  });
}
/** Idempotent physical purge. A crash retains a private tombstone and a bounded retry lease. */
export async function purgeExpiredAssets(store: AssetStore, now = new Date()) {
  const candidates = await db.brandAsset.findMany({ where: { OR: [
    { status: "ARCHIVED", purgeAfter: { lte: now } },
    { status: "DELETING", purgeLeaseUntil: { lt: now } },
  ] }, take: 20, orderBy: { purgeAfter: "asc" } });
  let purged = 0;
  for (const asset of candidates) {
    // Earlier objects can take time to delete; never start the next object with an already-expired lease.
    const lease = new Date(Math.max(now.getTime(), Date.now()) + 120000);
    const claimed = await db.brandAsset.updateMany({ where: { id: asset.id, status: asset.status, purgeAfter: { lte: now }, ...(asset.status === "DELETING" ? { purgeLeaseUntil: { lt: now } } : {}) }, data: { status: "DELETING", purgeLeaseUntil: lease, approvedForGeneration: false } });
    if (!claimed.count) continue;
    try {
      await store.remove(asset.objectKey);
      await db.$transaction(async tx => {
        const completed = await tx.brandAsset.updateMany({ where: { id: asset.id, status: "DELETING", purgeLeaseUntil: lease }, data: { status: "DELETED", bytes: 0, label: "Deleted image", sha256: "", purgeLeaseUntil: null } });
        if (completed.count) await tx.auditEvent.create({ data: { businessId: asset.businessId, organizationId: asset.organizationId, actorId: "retention-worker", action: "ASSET_PURGED", detail: `Asset ${asset.id} removed from active object storage after its restore window. Backup retention is separate.` } });
      });
      purged++;
    } catch { /* Never expose the object or restore quota until deletion is confirmed. Retry after lease expiry. */ }
  }
  return purged;
}
export async function readAsset(scope: Pick<Scope, "businessId" | "organizationId">, id: string, store: AssetStore = assetStore()) {
  const asset = await db.brandAsset.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId, status: "READY" } });
  if (!asset) throw new AppError(404, "Image not found.");
  return store.get(asset.objectKey);
}
