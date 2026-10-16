import { createHash, randomUUID } from "node:crypto";
import type { Prisma, CompositionExport } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, type Scope } from "../production/service";
import { assertBrandEditor } from "../knowledge/analysis";
import { assetStore, type AssetStore } from "../assets/storage";
import { MAX_IMAGE_BYTES } from "../assets/images";
import { compositionContext, exportComposition } from "./service";
import { placements, type Placement } from "./document";
import { STATIC_RENDERER_VERSION } from "./version";
import { typographyManifest } from "../typography";
export const EXPORT_RENDERER_VERSION = STATIC_RENDERER_VERSION;
const MAX_BUSINESS_EXPORT_BYTES = 50 * 1024 * 1024;
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const exportFields = { id: true, compositionId: true, placement: true, status: true, bytes: true, sha256: true, rendererVersion: true, manifest: true, createdAt: true, purgeAfter: true } as const;
function manifest(ctx: Awaited<ReturnType<typeof compositionContext>>, placement: Placement) {
  return { version: 2, renderer: EXPORT_RENDERER_VERSION, typography: typographyManifest(), compositionId: ctx.composition.id, compositionVersion: ctx.composition.version,
    revisionId: ctx.composition.revisionId, brandVersion: ctx.composition.brandVersion, placement,
    width: placements[placement][0], height: placements[placement][1], documentHash: hash(JSON.stringify(ctx.document)), copyHash: hash(JSON.stringify(ctx.copy)),
    assets: ctx.assets.map(a => ({ id: a.id, sha256: a.sha256 })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
async function assertReader(scope: Scope, client: Pick<Prisma.TransactionClient, "membership"> = db) {
  if (!await client.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } })) throw new AppError(404, "Workspace not found.");
}
async function assertCurrent(scope: Scope, row: CompositionExport, client: Prisma.TransactionClient | typeof db = db) {
  const ctx = await compositionContext(scope, row.compositionId, false, client);
  if (row.rendererVersion !== EXPORT_RENDERER_VERSION) throw new AppError(409, "Create an export with the current renderer.");
  // PostgreSQL JSONB may reorder keys; compare canonical values, not insertion order.
  if (canonical(row.manifest) !== canonical(manifest(ctx, row.placement as Placement))) throw new AppError(409, "The export no longer matches the approved brand, copy or assets.");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export async function listCompositionExports(scope: Scope) {
  await assertReader(scope);
  return db.compositionExport.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, status: { not: "DELETED" } }, select: exportFields, orderBy: { createdAt: "desc" }, take: 50 });
}
export async function saveCompositionExport(scope: Scope, compositionId: string, placement: Placement, store: AssetStore = assetStore()) {
  if (!(placement in placements)) throw new AppError(400, "Unsupported placement.");
  const lease = new Date(Date.now() + 120000);
  const claim = await db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const context = await compositionContext(scope, compositionId, false, tx);
    const existing = await tx.compositionExport.findUnique({ where: { compositionId_placement_rendererVersion: { compositionId, placement, rendererVersion: EXPORT_RENDERER_VERSION } } });
    if (existing) {
      if (existing.status === "READY" && existing.purgeAfter > new Date()) { await assertCurrent(scope, existing, tx); return { row: existing, ready: true }; }
      // Empty fingerprint proves no put was started: the fingerprint commits
      // before the only conditional write. A new lease fences the previous renderer.
      if (["FAILED", "STORING"].includes(existing.status) && !existing.sha256 && (!existing.leaseUntil || existing.leaseUntil <= new Date()) && existing.purgeAfter > new Date()) {
        await assertCurrent(scope, existing, tx);
        return { row: await tx.compositionExport.update({ where: { id: existing.id }, data: { status: "STORING", leaseUntil: lease } }), ready: false };
      }
      throw new AppError(409, "An export already exists for this version. Check storage recovery or create a new layout version; it will not be overwritten.");
    }
    const usage = await tx.compositionExport.aggregate({ where: { businessId: scope.businessId, status: { not: "DELETED" } }, _sum: { bytes: true }, _count: true });
    if (usage._count >= 50 || (usage._sum.bytes || 0) + MAX_IMAGE_BYTES > MAX_BUSINESS_EXPORT_BYTES) throw new AppError(409, "Saved export allowance reached (50 MB or 50 exports). Remove unused exports and allow retention cleanup to finish.");
    const id = randomUUID();
    const row = await tx.compositionExport.create({ data: { id, businessId: scope.businessId, organizationId: scope.organizationId, compositionId,
      placement, rendererVersion: EXPORT_RENDERER_VERSION, manifest: manifest(context, placement),
      objectKey: `${scope.organizationId}/${scope.businessId}/exports/${id}.png`, bytes: MAX_IMAGE_BYTES, leaseUntil: lease,
      createdBy: scope.actorId, purgeAfter: new Date(Date.now() + 30 * 86400000) } });
    return { row, ready: false };
  });
  if (claim.ready) return { ok: true, id: claim.row.id, reused: true };
  const row = claim.row;
  try {
    const output = await exportComposition(scope, compositionId, placement, false, store);
    if (!output.png.length || output.png.length > MAX_IMAGE_BYTES) throw new AppError(413, "The exported PNG exceeds 5 MB. Simplify the layout or use a smaller image.");
    const sha256 = hash(output.png);
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope); await assertBrandEditor(tx, scope); await assertCurrent(scope, row, tx);
      if (lease.getTime() <= Date.now()) throw new AppError(409, "Export lease expired before storage.");
      const changed = await tx.compositionExport.updateMany({ where: { id: row.id, status: "STORING", leaseUntil: lease, sha256: "" }, data: { sha256, bytes: output.png.length } });
      if (!changed.count) throw new AppError(409, "Export storage ownership changed.");
    });
    // If storage acknowledges a timeout ambiguously, recovery only reads this key.
    // A conditional write prevents a resumed worker from overwriting an artifact.
    await store.put(row.objectKey, output.png, "image/png", true);
    const stored = await store.get(row.objectKey);
    if (stored.length !== output.png.length || hash(stored) !== sha256) throw Error("Export storage integrity failed");
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope); await assertBrandEditor(tx, scope); await assertCurrent(scope, row, tx);
      const changed = await tx.compositionExport.updateMany({ where: { id: row.id, status: "STORING", leaseUntil: lease }, data: { status: "READY", leaseUntil: null } });
      if (!changed.count) throw Error("Export completion ownership changed");
      await tx.auditEvent.create({ data: { ...scope, action: "COMPOSITION_EXPORT_SAVED", detail: `Private immutable ${placement} export ${row.id} verified by read-back. No publication or AI charge authorized.` } });
    });
    return { ok: true, id: row.id, reused: false };
  } catch (error) {
    await db.compositionExport.updateMany({ where: { id: row.id, status: "STORING", leaseUntil: lease }, data: { status: "FAILED", leaseUntil: null, purgeAfter: new Date(Date.now() + 7 * 86400000) } });
    if (error instanceof AppError) throw error;
    throw new AppError(503, "Export storage was not verified. It remains private. Use Check storage outcome; do not upload another copy.");
  }
}
export async function reconcileCompositionExport(scope: Scope, id: string, store: AssetStore = assetStore()) {
  const row = await db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const found = await tx.compositionExport.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId } });
    if (!found || !["FAILED", "STORING"].includes(found.status)) throw new AppError(409, "Only unverified exports can be checked.");
    if (found.leaseUntil && found.leaseUntil > new Date()) throw new AppError(409, "An export is still being saved. Wait for it to finish.");
    if (!found.sha256 || found.purgeAfter <= new Date()) throw new AppError(409, "No recoverable output was recorded. Remove this export and save a new layout version.");
    await assertCurrent(scope, found, tx); return found;
  });
  let bytes: Uint8Array;
  try { bytes = await store.get(row.objectKey); } catch { throw new AppError(503, "No verified stored object was found. Nothing was re-uploaded."); }
  if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new AppError(409, "Stored output does not match its fingerprint. No output was released.");
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope); await assertCurrent(scope, row, tx);
    const changed = await tx.compositionExport.updateMany({ where: { id, status: { in: ["FAILED", "STORING"] }, sha256: row.sha256, OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] }, data: { status: "READY", leaseUntil: null } });
    if (!changed.count) throw new AppError(409, "Export state changed during recovery.");
    await tx.auditEvent.create({ data: { ...scope, action: "COMPOSITION_EXPORT_RECOVERED", detail: `Export ${id} recovered using read-back only. No duplicate render or upload.` } });
    return { ok: true };
  });
}
export async function readCompositionExport(scope: Scope, id: string, store: AssetStore = assetStore()) {
  async function check() {
    await assertReader(scope);
    const row = await db.compositionExport.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId, status: "READY", purgeAfter: { gt: new Date() } } });
    if (!row) throw new AppError(404, "Saved export is unavailable.");
    await assertCurrent(scope, row); return row;
  }
  const row = await check(), bytes = await store.get(row.objectKey);
  if (bytes.length !== row.bytes || bytes.length > MAX_IMAGE_BYTES || hash(bytes) !== row.sha256) throw new AppError(409, "Export integrity check failed.");
  await check(); return { bytes, sha256: row.sha256, placement: row.placement };
}
export async function archiveCompositionExport(scope: Scope, id: string) {
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const row = await tx.compositionExport.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId } });
    if (!row || row.status === "DELETED") throw new AppError(404, "Export not found.");
    if (row.status === "DELETING" || row.leaseUntil && row.leaseUntil > new Date()) throw new AppError(409, "Wait for the current storage operation to finish.");
    if (row.status !== "ARCHIVED") await tx.compositionExport.update({ where: { id }, data: { status: "ARCHIVED", leaseUntil: null, purgeAfter: new Date(Date.now() + 7 * 86400000) } });
    await tx.auditEvent.create({ data: { ...scope, action: "COMPOSITION_EXPORT_ARCHIVED", detail: `Export ${id} is no longer downloadable; physical cleanup is scheduled after seven days. Previously downloaded copies are separate.` } });
    return { ok: true };
  });
}
export async function purgeCompositionExports(store: AssetStore, now = new Date()) {
  const rows = await db.compositionExport.findMany({ where: { status: { not: "DELETED" }, purgeAfter: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, take: 20, orderBy: { purgeAfter: "asc" } });
  let deleted = 0;
  for (const row of rows) {
    const lease = new Date(Math.max(now.getTime(), Date.now()) + 120000);
    const changed = await db.$transaction(async tx => {
      await lockBusiness(tx, { businessId: row.businessId, organizationId: row.organizationId, actorId: "retention-worker" });
      return tx.compositionExport.updateMany({ where: { id: row.id, status: row.status, purgeAfter: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, data: { status: "DELETING", leaseUntil: lease } });
    });
    if (!changed.count) continue;
    try {
      await store.remove(row.objectKey);
      deleted += await db.$transaction(async tx => {
        const changed = await tx.compositionExport.updateMany({ where: { id: row.id, status: "DELETING", leaseUntil: lease }, data: { status: "DELETED", bytes: 0, sha256: "", leaseUntil: null } });
        if (changed.count) await tx.auditEvent.create({ data: { businessId: row.businessId, organizationId: row.organizationId, actorId: "retention-worker", action: "COMPOSITION_EXPORT_PURGED", detail: `Export ${row.id} removed from active object storage. Downloaded copies and backup retention are separate.` } });
        return changed.count;
      });
    } catch { /* Keep quota and tombstone until a later bounded retry confirms deletion. */ }
  }
  return deleted;
}
