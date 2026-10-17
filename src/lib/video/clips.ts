import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, type Scope } from "../production/service";
import { assertBrandEditor } from "../knowledge/analysis";
import { assertReviewer } from "../workflows/approvals";
import { invalidatePublications } from "../social/service";
import { assetStore, type AssetStore } from "../assets/storage";
import { WORKER_RUNTIME, HEARTBEAT_TTL_MS, workerConfigurationHash } from "../production/readiness";
import { MAX_VIDEO_BYTES, motionDailyLimit } from "./limits";
import { assertClipSignature, CLIP_PROCESSOR_VERSION, READABLE_CLIP_VERSIONS, normalizeClip, type ClipNormalizer } from "./clip-normalizer";
export const clipStore = () => assetStore(MAX_VIDEO_BYTES);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const scopeOf = (r: { businessId: string; organizationId: string; createdBy: string }): Scope => ({ businessId: r.businessId, organizationId: r.organizationId, actorId: r.createdBy });
const activeStatuses = ["UPLOADING", "QUEUED", "RUNNING", "STORING"];
export const clipFields = { id: true, label: true, status: true, sha256: true, durationMs: true, brandVersion: true, processorVersion: true, createdAt: true, purgeAfter: true, errorCode: true } as const;
export async function eligibleClips(client: Pick<Prisma.TransactionClient, "videoClip">, scope: Scope, brandVersion: number, ids?: string[]) {
  return client.videoClip.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, brandVersion, status: "APPROVED", approvedBy: { not: null }, processorVersion: { in: READABLE_CLIP_VERSIONS }, purgeAfter: { gt: new Date() }, ...(ids ? { id: { in: ids } } : {}) }, take: 100 });
}
export async function listClips(scope: Scope) {
  if (!await db.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } })) throw new AppError(404, "Workspace not found.");
  const business = await db.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!business) throw new AppError(404, "Business not found.");
  const rows = await db.videoClip.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId }, select: { ...clipFields, approvedBy: true }, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map(({ approvedBy, ...row }) => ({ ...row, usable: !!business.confirmedAt && business.version === row.brandVersion && row.status === "APPROVED" && !!approvedBy && READABLE_CLIP_VERSIONS.includes(row.processorVersion) && row.purgeAfter > new Date() }));
}
export async function uploadClip(scope: Scope, raw: unknown, input: Buffer, store: AssetStore = clipStore()) {
  const fields = z.object({ label: z.string().trim().min(1).max(80), rightsConfirmed: z.literal(true) }).strict().parse(raw);
  assertClipSignature(input); const dailyLimit = motionDailyLimit();
  const row = await db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    if (!business.confirmedAt) throw new AppError(409, "Confirm your brand before uploading footage.");
    if (!await tx.workerHeartbeat.findFirst({ where: { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), motionReady: true, lastSeenAt: { gt: new Date(Date.now() - HEARTBEAT_TTL_MS) } } })) throw new AppError(503, "A matching video worker is not ready. Nothing was uploaded.");
    // Forty MB reserved for each original+normalized pair, including failed or ambiguous writes.
    if (await tx.videoClip.count({ where: { businessId: scope.businessId, status: { not: "DELETED" } } }) >= 5) throw new AppError(409, "Five private clips are already retained. Remove unused clips and allow cleanup first.");
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    if (await tx.videoClip.count({ where: { businessId: scope.businessId, createdAt: { gte: today } } }) >= 6) throw new AppError(429, "Six clip uploads per business per day are allowed.");
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403219)::text`;
    if (await tx.motionAuthorization.count({ where: { createdAt: { gte: today } } }) >= dailyLimit) throw new AppError(409, "The operator's daily video processing limit is reached.");
    const id = randomUUID(); await tx.motionAuthorization.create({ data: { key: id } });
    const row = await tx.videoClip.create({ data: { id, label: fields.label, businessId: scope.businessId, organizationId: scope.organizationId, brandVersion: business.version, createdBy: scope.actorId, rightsConfirmedAt: new Date(), sourceKey: `${scope.organizationId}/${scope.businessId}/clips/${id}-source.mp4`, objectKey: `${scope.organizationId}/${scope.businessId}/clips/${id}.mp4`, sourceHash: hash(input), sourceBytes: input.length, processorVersion: CLIP_PROCESSOR_VERSION, leaseUntil: new Date(Date.now() + 120000), purgeAfter: new Date(Date.now() + 30 * 86400000) } });
    await tx.auditEvent.create({ data: { ...scope, action: "CLIP_QUARANTINED", detail: "Rights asserted; private original reserved for single-submit processing. Not previewable or approved. No AI credit spend." } });
    return row;
  });
  try {
    await store.put(row.sourceKey, input, "video/mp4", true);
    const stored = await store.get(row.sourceKey); if (stored.length !== row.sourceBytes || hash(stored) !== row.sourceHash) throw Error("Upload integrity failed.");
    await db.$transaction(async tx => {
      const b = await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
      if (!b.confirmedAt || b.version !== row.brandVersion) throw Error("Brand changed during upload.");
      const updated = await tx.videoClip.updateMany({ where: { id: row.id, status: "UPLOADING", leaseUntil: { gt: new Date() } }, data: { status: "QUEUED", leaseUntil: null } });
      if (!updated.count) throw Error("Upload lease changed.");
    });
    return { ok: true, clipId: row.id };
  } catch {
    await db.videoClip.updateMany({ where: { id: row.id, status: "UPLOADING" }, data: { status: "FAILED", leaseUntil: null, errorCode: "UPLOAD_UNVERIFIED", purgeAfter: new Date(Date.now() + 7 * 86400000) } });
    throw new AppError(409, "Clip upload could not be verified. It remains private and is queued for cleanup; no automatic retry.");
  }
}
async function clipContext(scope: Scope, id: string, client: Prisma.TransactionClient = db) {
  if (!await client.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } })) throw new AppError(404, "Workspace not found.");
  const row = await client.videoClip.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId } });
  const business = await client.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!row || !business) throw new AppError(404, "Clip not found.");
  if (!business.confirmedAt || business.version !== row.brandVersion || !READABLE_CLIP_VERSIONS.includes(row.processorVersion) || row.purgeAfter <= new Date()) throw new AppError(409, "Clip brand or retention changed. Upload and review a current clip.");
  return { row, business };
}
export async function readClip(scope: Scope, id: string, store: AssetStore = clipStore()) {
  const before = await clipContext(scope, id);
  if (!["READY", "APPROVED", "REJECTED"].includes(before.row.status)) throw new AppError(404, "Only processed clips can be previewed.");
  const bytes = await store.get(before.row.objectKey);
  if (bytes.length !== before.row.bytes || hash(bytes) !== before.row.sha256) throw new AppError(409, "Clip storage integrity failed.");
  const after = await clipContext(scope, id);
  if (!["READY", "APPROVED", "REJECTED"].includes(after.row.status) || after.row.sha256 !== before.row.sha256) throw new AppError(409, "Clip changed during preview.");
  return bytes;
}
export async function reviewClip(scope: Scope, id: string, raw: unknown) {
  const input = z.object({ action: z.enum(["approve", "reject", "remove"]), watched: z.boolean().optional() }).strict().parse(raw);
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const row = await tx.videoClip.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId } });
    if (!row) throw new AppError(404, "Clip not found.");
    if (input.action === "remove") {
      if (["ARCHIVED", "DELETING", "DELETED"].includes(row.status)) return { ok: true };
      if (["UPLOADING", "RUNNING", "STORING"].includes(row.status)) throw new AppError(409, "Wait for active clip processing to settle.");
      await tx.videoClip.update({ where: { id }, data: { status: "ARCHIVED", approvedBy: null, purgeAfter: new Date(Date.now() + 7 * 86400000) } });
    } else {
      const { business } = await clipContext(scope, id, tx);
      if (!["READY", "APPROVED", "REJECTED"].includes(row.status)) throw new AppError(409, "Review a processed clip first.");
      await assertReviewer(tx, scope, business.independentApproval, row.createdBy);
      if (input.action === "approve" && input.watched !== true) throw new AppError(400, "Watch the complete silent clip and check rights, accuracy and brand fidelity.");
      await tx.videoClip.update({ where: { id }, data: { status: input.action === "approve" ? "APPROVED" : "REJECTED", approvedBy: input.action === "approve" ? scope.actorId : null } });
    }
    if (input.action !== "approve") {
      const usingClip = { businessId: scope.businessId, organizationId: scope.organizationId, document: { path: ["shots"], array_contains: [{ clip: { id } }] } };
      await tx.videoStoryboard.updateMany({ where: { ...usingClip, status: { not: "SUPERSEDED" } }, data: { status: "DRAFT", shotApprovals: [], approvedBy: null } });
      await tx.motionRender.updateMany({ where: { storyboard: usingClip, status: "APPROVED" }, data: { status: "READY", approvedBy: null } });
    }
    await invalidatePublications(tx, scope.businessId);
    await tx.auditEvent.create({ data: { ...scope, action: "CLIP_REVIEWED", detail: `${input.action}: original and normalized copies remain private. Removal revokes dependent delivery; deletion follows in seven days.` } });
    return { ok: true };
  });
}
export async function runOneClip(processor: ClipNormalizer = normalizeClip, storage: () => AssetStore = clipStore) {
  motionDailyLimit();
  const claimed = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403219)::text`;
    if (await tx.motionRender.count({ where: { status: { in: ["RUNNING", "STORING"] } } }) || await tx.videoClip.count({ where: { status: { in: ["RUNNING", "STORING"] } } })) return null;
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "VideoClip" WHERE status='QUEUED' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows[0]) return null;
    return tx.videoClip.update({ where: { id: rows[0].id }, data: { status: "RUNNING", leaseUntil: new Date(Date.now() + 180000) } });
  });
  if (!claimed) return false;
  const scope = scopeOf(claimed);
  const fresh = async (tx: Prisma.TransactionClient, status: string) => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const { row } = await clipContext(scope, claimed.id, tx);
    if (row.status !== status || row.processorVersion !== CLIP_PROCESSOR_VERSION || row.leaseUntil?.getTime() !== claimed.leaseUntil?.getTime() || !row.leaseUntil || row.leaseUntil <= new Date()) throw Error("Clip authorization changed.");
    return row;
  };
  try {
    await db.$transaction(tx => fresh(tx, "RUNNING")); const store = storage(), source = await store.get(claimed.sourceKey);
    if (source.length !== claimed.sourceBytes || hash(source) !== claimed.sourceHash) throw Error("Source integrity failed.");
    await db.$transaction(tx => fresh(tx, "RUNNING")); motionDailyLimit();
    const output = await processor(Buffer.from(source));
    if (!output.bytes.length || output.bytes.length >= MAX_VIDEO_BYTES || !Number.isSafeInteger(output.durationMs) || output.durationMs < 1000 || output.durationMs > 8100) throw Error("Invalid processor result.");
    await db.$transaction(async tx => {
      await fresh(tx, "RUNNING");
      await tx.videoClip.update({ where: { id: claimed.id }, data: { status: "STORING", sha256: hash(output.bytes), bytes: output.bytes.length, durationMs: output.durationMs } });
    });
    await store.put(claimed.objectKey, output.bytes, "video/mp4", true);
    const stored = await store.get(claimed.objectKey); if (stored.length !== output.bytes.length || hash(stored) !== hash(output.bytes)) throw Error("Normalized storage integrity failed.");
    await db.$transaction(async tx => {
      await fresh(tx, "STORING"); await tx.videoClip.update({ where: { id: claimed.id }, data: { status: "READY", leaseUntil: null } });
      await tx.auditEvent.create({ data: { ...scope, action: "CLIP_READY", detail: "Silent H.264 clip normalized and storage verified. Human review required; not authorized for use yet." } });
    });
  } catch {
    await db.videoClip.updateMany({ where: { id: claimed.id, status: { in: ["RUNNING", "STORING"] }, leaseUntil: claimed.leaseUntil }, data: { status: "FAILED", leaseUntil: null, errorCode: "PROCESSING_UNVERIFIED", purgeAfter: new Date(Date.now() + 7 * 86400000) } });
  }
  return true;
}
export async function recoverClipLeases() {
  return db.videoClip.updateMany({ where: { status: { in: activeStatuses.filter(s => s !== "QUEUED") }, leaseUntil: { lt: new Date() } }, data: { status: "FAILED", leaseUntil: null, errorCode: "LEASE_EXPIRED", purgeAfter: new Date(Date.now() + 7 * 86400000) } });
}
export async function recoverClipStorage(scope: Scope, id: string, store: AssetStore = clipStore()) {
  const before = await db.$transaction(async tx => { await lockBusiness(tx, scope); await assertBrandEditor(tx, scope); const { row } = await clipContext(scope, id, tx); if (row.status !== "FAILED" || !row.sha256 || !row.bytes) throw new AppError(409, "No processed output is available for recovery."); return row; });
  const bytes = await store.get(before.objectKey);
  if (bytes.length !== before.bytes || hash(bytes) !== before.sha256) throw new AppError(409, "Stored clip fingerprint differs.");
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope); const { row } = await clipContext(scope, id, tx);
    if (row.status !== "FAILED" || row.sha256 !== before.sha256) throw new AppError(409, "Clip state changed.");
    await tx.videoClip.update({ where: { id }, data: { status: "READY", errorCode: null, leaseUntil: null } });
    await tx.auditEvent.create({ data: { ...scope, action: "CLIP_RECOVERED", detail: "Hash-verified read-back only. No reprocessing or upload; human approval still required." } });
    return { ok: true };
  });
}
export async function purgeClips(store: AssetStore = clipStore(), now = new Date()) {
  const rows = await db.videoClip.findMany({ where: { status: { notIn: ["DELETED", ...activeStatuses.filter(s => s !== "QUEUED")] }, purgeAfter: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, take: 5, orderBy: { purgeAfter: "asc" } });
  let count = 0;
  for (const row of rows) {
    const lease = new Date(Date.now() + 120000);
    const changed = await db.$transaction(async tx => { await lockBusiness(tx, scopeOf(row)); return tx.videoClip.updateMany({ where: { id: row.id, status: row.status, purgeAfter: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { status: "DELETING", approvedBy: null, leaseUntil: lease } }); });
    if (!changed.count) continue;
    try {
      await store.remove(row.sourceKey); await store.remove(row.objectKey);
      count += (await db.videoClip.updateMany({ where: { id: row.id, status: "DELETING", leaseUntil: lease }, data: { status: "DELETED", leaseUntil: null, bytes: 0, sha256: "" } })).count;
    } catch { /* A partial/ambiguous deletion keeps both-file quota and retries after the lease. */ }
  }
  return count;
}
