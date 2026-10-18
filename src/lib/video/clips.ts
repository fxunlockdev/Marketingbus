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
import { assertGeneratedClip, finishGeneratedClip, failGeneratedClip, type ShotContextClient } from "./generation-context";
import { activeShots } from "./generation-contracts";
import { AUDIO_PROCESSOR_VERSION, MAX_AUDIO_BYTES, audioFormat, normalizeAudio, requireAudioProcessing } from "./audio-normalizer";
export type MediaKind = "VIDEO" | "AUDIO";
const versions = (kind: MediaKind) => kind === "AUDIO" ? [AUDIO_PROCESSOR_VERSION] : READABLE_CLIP_VERSIONS;
const processorVersion = (kind: MediaKind) => kind === "AUDIO" ? AUDIO_PROCESSOR_VERSION : CLIP_PROCESSOR_VERSION;
export const clipStore = () => assetStore(MAX_VIDEO_BYTES);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const scopeOf = (r: { businessId: string; organizationId: string; createdBy: string }): Scope => ({ businessId: r.businessId, organizationId: r.organizationId, actorId: r.createdBy });
const activeStatuses = ["UPLOADING", "QUEUED", "RUNNING", "STORING"];
export const clipFields = { id: true, label: true, status: true, sha256: true, durationMs: true, brandVersion: true, processorVersion: true, generationId: true, createdAt: true, purgeAfter: true, errorCode: true } as const;
export async function eligibleClips(client: Pick<Prisma.TransactionClient, "videoClip"> & ShotContextClient, scope: Scope, brandVersion: number, ids?: string[], kind: MediaKind = "VIDEO") {
  const rows = await client.videoClip.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, brandVersion, mediaKind: kind, status: "APPROVED", approvedBy: { not: null }, processorVersion: { in: versions(kind) }, purgeAfter: { gt: new Date() }, ...(ids ? { id: { in: ids } } : {}) }, take: 100 });
  const eligible = [];
  for (const row of rows) { try { await assertGeneratedClip(client, row); eligible.push(row); } catch (e) { if (!(e instanceof AppError)) throw e; } }
  return eligible;
}
export async function listClips(scope: Scope, kind: MediaKind = "VIDEO") {
  if (!await db.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } })) throw new AppError(404, "Workspace not found.");
  const business = await db.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!business) throw new AppError(404, "Business not found.");
  const rows = await db.videoClip.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, mediaKind: kind }, select: { ...clipFields, approvedBy: true }, orderBy: { createdAt: "desc" }, take: 50 });
  const usable = new Set((await eligibleClips(db, scope, business.version, undefined, kind)).map(c => c.id));
  return rows.map(({ approvedBy: _approvedBy, ...row }) => ({ ...row, usable: !!business.confirmedAt && usable.has(row.id) }));
}
export async function uploadClip(scope: Scope, raw: unknown, input: Buffer, store: AssetStore = clipStore(), kind: MediaKind = "VIDEO") {
  const fields = z.object({ label: z.string().trim().min(1).max(80), rightsConfirmed: z.literal(true), ...(kind === "AUDIO" ? { instrumentalConfirmed: z.literal(true) } : {}) }).strict().parse(raw);
  const format = kind === "AUDIO" ? audioFormat(input) : "mp4";
  if (kind === "AUDIO") requireAudioProcessing(); else assertClipSignature(input);
  const dailyLimit = motionDailyLimit();
  const row = await db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    if (!business.confirmedAt) throw new AppError(409, "Confirm your brand before uploading media.");
    if (!await tx.workerHeartbeat.findFirst({ where: { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), motionReady: true, lastSeenAt: { gt: new Date(Date.now() - HEARTBEAT_TTL_MS) } } })) throw new AppError(503, "A matching video worker is not ready. Nothing was uploaded.");
    // Forty MB reserved for each original+normalized pair, including failed or ambiguous writes.
    if (await tx.videoClip.count({ where: { businessId: scope.businessId, status: { not: "DELETED" } } }) >= 5) throw new AppError(409, "Five private footage/music files are already retained. Remove unused media and allow cleanup first.");
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    if (await tx.videoClip.count({ where: { businessId: scope.businessId, createdAt: { gte: today } } }) >= 6) throw new AppError(429, "Six clip uploads per business per day are allowed.");
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403219)::text`;
    if (await tx.motionAuthorization.count({ where: { createdAt: { gte: today } } }) >= dailyLimit) throw new AppError(409, "The operator's daily video processing limit is reached.");
    const id = randomUUID(); await tx.motionAuthorization.create({ data: { key: id } });
    const row = await tx.videoClip.create({ data: { id, label: fields.label, mediaKind: kind, instrumentalConfirmedAt: kind === "AUDIO" ? new Date() : null, businessId: scope.businessId, organizationId: scope.organizationId, brandVersion: business.version, createdBy: scope.actorId, rightsConfirmedAt: new Date(), sourceKey: `${scope.organizationId}/${scope.businessId}/clips/${id}-source.${format}`, objectKey: `${scope.organizationId}/${scope.businessId}/clips/${id}.${kind === "AUDIO" ? "wav" : "mp4"}`, sourceHash: hash(input), sourceBytes: input.length, processorVersion: processorVersion(kind), leaseUntil: new Date(Date.now() + 120000), purgeAfter: new Date(Date.now() + 30 * 86400000) } });
    await tx.auditEvent.create({ data: { ...scope, action: "CLIP_QUARANTINED", detail: "Rights asserted; private original reserved for single-submit processing. Not previewable or approved. No AI credit spend." } });
    return row;
  });
  try {
    await store.put(row.sourceKey, input, kind === "AUDIO" ? (format === "wav" ? "audio/wav" : "audio/mpeg") : "video/mp4", true);
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
async function clipContext(scope: Scope, id: string, client: Prisma.TransactionClient = db, kind: MediaKind = "VIDEO") {
  if (!await client.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } })) throw new AppError(404, "Workspace not found.");
  const row = await client.videoClip.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId } });
  const business = await client.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!row || !business || row.mediaKind !== kind) throw new AppError(404, "Media not found.");
  if (!business.confirmedAt || business.version !== row.brandVersion || !versions(kind).includes(row.processorVersion) || row.purgeAfter <= new Date()) throw new AppError(409, "Clip brand or retention changed. Upload and review current media.");
  await assertGeneratedClip(client, row);
  return { row, business };
}
export async function readClip(scope: Scope, id: string, store: AssetStore = clipStore(), kind: MediaKind = "VIDEO") {
  const before = await clipContext(scope, id, db, kind);
  if (!["READY", "APPROVED", "REJECTED"].includes(before.row.status)) throw new AppError(404, "Only processed clips can be previewed.");
  const bytes = await store.get(before.row.objectKey);
  if (bytes.length !== before.row.bytes || hash(bytes) !== before.row.sha256) throw new AppError(409, "Clip storage integrity failed.");
  const after = await clipContext(scope, id, db, kind);
  if (!["READY", "APPROVED", "REJECTED"].includes(after.row.status) || after.row.sha256 !== before.row.sha256) throw new AppError(409, "Clip changed during preview.");
  return bytes;
}
export async function reviewClip(scope: Scope, id: string, raw: unknown, kind: MediaKind = "VIDEO") {
  const input = z.object({ action: z.enum(["approve", "reject", "remove"]), watched: z.boolean().optional() }).strict().parse(raw);
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const row = await tx.videoClip.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId } });
    if (!row || row.mediaKind !== kind) throw new AppError(404, "Media not found.");
    if (input.action === "remove") {
      if (["ARCHIVED", "DELETING", "DELETED"].includes(row.status)) return { ok: true };
      if (["UPLOADING", "RUNNING", "STORING"].includes(row.status)) throw new AppError(409, "Wait for active clip processing to settle.");
      if (row.generationId && await tx.videoGeneration.count({ where: { id: row.generationId, status: { in: activeShots } } })) throw new AppError(409, "Resolve or cancel the generated-shot job before removing its reserved footage.");
      await tx.videoClip.update({ where: { id }, data: { status: "ARCHIVED", approvedBy: null, purgeAfter: new Date(Date.now() + 7 * 86400000) } });
    } else {
      const { business } = await clipContext(scope, id, tx, kind);
      if (!["READY", "APPROVED", "REJECTED"].includes(row.status)) throw new AppError(409, "Review a processed clip first.");
      await assertReviewer(tx, scope, business.independentApproval, row.createdBy);
      if (input.action === "approve" && input.watched !== true) throw new AppError(400, kind === "AUDIO" ? "Listen to the entire track and confirm rights, no speech or vocals, and brand fit." : "Watch the complete silent clip and check rights, accuracy and brand fidelity.");
      await tx.videoClip.update({ where: { id }, data: { status: input.action === "approve" ? "APPROVED" : "REJECTED", approvedBy: input.action === "approve" ? scope.actorId : null } });
    }
    if (input.action !== "approve") {
      const usingClip = { businessId: scope.businessId, organizationId: scope.organizationId, document: kind === "AUDIO" ? { path: ["soundtrack", "id"], equals: id } : { path: ["shots"], array_contains: [{ clip: { id } }] } };
      await tx.videoStoryboard.updateMany({ where: { ...usingClip, status: { not: "SUPERSEDED" } }, data: { status: "DRAFT", shotApprovals: [], approvedBy: null } });
      await tx.motionRender.updateMany({ where: { storyboard: usingClip, status: "APPROVED" }, data: { status: "READY", approvedBy: null } });
    }
    await invalidatePublications(tx, scope.businessId);
    await tx.auditEvent.create({ data: { ...scope, action: "CLIP_REVIEWED", detail: `${input.action}: original and normalized copies remain private. Removal revokes dependent delivery; deletion follows in seven days.` } });
    return { ok: true };
  });
}
export async function runOneClip(processor?: ClipNormalizer, storage: () => AssetStore = clipStore) {
  motionDailyLimit();
  const claimed = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403219)::text`;
    if (await tx.motionRender.count({ where: { status: { in: ["RUNNING", "STORING"] } } }) || await tx.videoClip.count({ where: { status: { in: ["RUNNING", "STORING"] } } })) return null;
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "VideoClip" WHERE status='QUEUED' AND ("mediaKind"='VIDEO' OR ${process.env.AUDIO_PROCESSING_ENABLED === "true"}) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows[0]) return null;
    return tx.videoClip.update({ where: { id: rows[0].id }, data: { status: "RUNNING", leaseUntil: new Date(Date.now() + 180000) } });
  });
  if (!claimed) return false;
  const scope = scopeOf(claimed);
  const kind = claimed.mediaKind as MediaKind;
  const fresh = async (tx: Prisma.TransactionClient, status: string) => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    if (kind === "AUDIO") requireAudioProcessing();
    const { row } = await clipContext(scope, claimed.id, tx, kind);
    if (row.status !== status || row.processorVersion !== processorVersion(kind) || row.leaseUntil?.getTime() !== claimed.leaseUntil?.getTime() || !row.leaseUntil || row.leaseUntil <= new Date()) throw Error("Clip authorization changed.");
    return row;
  };
  try {
    await db.$transaction(tx => fresh(tx, "RUNNING")); const store = storage(), source = await store.get(claimed.sourceKey);
    if (source.length !== claimed.sourceBytes || hash(source) !== claimed.sourceHash) throw Error("Source integrity failed.");
    await db.$transaction(tx => fresh(tx, "RUNNING")); motionDailyLimit();
    const output = await (processor ?? (kind === "AUDIO" ? normalizeAudio : normalizeClip))(Buffer.from(source));
    if (!output.bytes.length || output.bytes.length >= (kind === "AUDIO" ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES) || !Number.isSafeInteger(output.durationMs) || output.durationMs < 1000 || output.durationMs > (kind === "AUDIO" ? 30000 : 8100)) throw Error("Invalid processor result.");
    await db.$transaction(async tx => {
      await fresh(tx, "RUNNING");
      await tx.videoClip.update({ where: { id: claimed.id }, data: { status: "STORING", sha256: hash(output.bytes), bytes: output.bytes.length, durationMs: output.durationMs } });
    });
    await store.put(claimed.objectKey, output.bytes, kind === "AUDIO" ? "audio/wav" : "video/mp4", true);
    const stored = await store.get(claimed.objectKey); if (stored.length !== output.bytes.length || hash(stored) !== hash(output.bytes)) throw Error("Normalized storage integrity failed.");
    await db.$transaction(async tx => {
      const current = await fresh(tx, "STORING"); await finishGeneratedClip(tx, current, output.durationMs);
      await tx.videoClip.update({ where: { id: claimed.id }, data: { status: "READY", leaseUntil: null } });
      await tx.auditEvent.create({ data: { ...scope, action: "CLIP_READY", detail: `${kind === "AUDIO" ? "Instrumental PCM audio" : "Silent H.264 clip"} normalized and storage verified. Human review required; not authorized for use yet.` } });
    });
  } catch {
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope);
      const changed = await tx.videoClip.updateMany({ where: { id: claimed.id, status: { in: ["RUNNING", "STORING"] }, leaseUntil: claimed.leaseUntil }, data: { status: "FAILED", leaseUntil: null, errorCode: "PROCESSING_UNVERIFIED", purgeAfter: new Date(Date.now() + 7 * 86400000) } });
      if (changed.count) await failGeneratedClip(tx, claimed.generationId, "NORMALIZATION_UNVERIFIED");
    });
  }
  return true;
}
export async function recoverClipLeases() {
  const rows = await db.videoClip.findMany({ where: { status: { in: activeStatuses.filter(s => s !== "QUEUED") }, leaseUntil: { lt: new Date() } }, take: 25 });
  for (const row of rows) await db.$transaction(async tx => {
    await lockBusiness(tx, scopeOf(row));
    const changed = await tx.videoClip.updateMany({ where: { id: row.id, status: row.status, leaseUntil: row.leaseUntil }, data: { status: "FAILED", leaseUntil: null, errorCode: "LEASE_EXPIRED", purgeAfter: new Date(Date.now() + 7 * 86400000) } });
    if (changed.count) await failGeneratedClip(tx, row.generationId, "NORMALIZATION_LEASE_EXPIRED");
  });
}
export async function recoverClipStorage(scope: Scope, id: string, store: AssetStore = clipStore(), kind: MediaKind = "VIDEO") {
  const before = await db.$transaction(async tx => { await lockBusiness(tx, scope); await assertBrandEditor(tx, scope); const { row } = await clipContext(scope, id, tx, kind); if (row.status !== "FAILED" || !row.sha256 || !row.bytes) throw new AppError(409, "No processed output is available for recovery."); return row; });
  const bytes = await store.get(before.objectKey);
  if (bytes.length !== before.bytes || hash(bytes) !== before.sha256) throw new AppError(409, "Stored clip fingerprint differs.");
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope); const { row } = await clipContext(scope, id, tx, kind);
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
