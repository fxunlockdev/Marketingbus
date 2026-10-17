import type { Prisma, VideoGeneration, VideoClip } from "@prisma/client";
import { AppError } from "../http";
import { motionHash } from "./limits";
import { storyboardDocument } from "./document";
import { finishReservationInTransaction } from "../billing/wallet";
export type ShotContextClient = Pick<Prisma.TransactionClient, "business" | "productionItem" | "reviewComment" | "videoStoryboard" | "videoGeneration">;
export const generationScope = (r: VideoGeneration) => ({ businessId: r.businessId, organizationId: r.organizationId, actorId: r.actorId });
export async function assertShotContext(client: ShotContextClient, row: VideoGeneration, requireStoryboard = true) {
  const business = await client.business.findFirst({ where: { id: row.businessId, organizationId: row.organizationId } });
  const item = await client.productionItem.findFirst({ where: { id: row.itemId, organizationId: row.organizationId, plan: { businessId: row.businessId, brandVersion: row.brandVersion, status: "PROPOSED" } }, include: { revisions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!business?.confirmedAt || business.version !== row.brandVersion || !item || (item.revisions[0]?.id ?? null) !== row.copyRevisionId || row.copyRevisionId && item.revisions[0]?.status !== "APPROVED") throw new AppError(409, "Generated footage source brand or approved copy changed.");
  if (row.copyRevisionId && await client.reviewComment.count({ where: { revisionId: row.copyRevisionId, blocking: true, resolvedAt: null } })) throw new AppError(409, "Generated footage has unresolved source-copy comments.");
  const board = await client.videoStoryboard.findFirst({ where: { id: row.storyboardId, businessId: row.businessId, organizationId: row.organizationId, itemId: row.itemId, status: { in: requireStoryboard ? ["APPROVED"] : ["APPROVED", "SUPERSEDED"] }, approvedBy: { not: null } } });
  if (!board || motionHash(storyboardDocument.parse(board.document)) !== row.documentHash) throw new AppError(409, "The approved generation storyboard changed.");
}
export async function assertGeneratedClip(client: ShotContextClient, clip: Pick<VideoClip, "generationId" | "id" | "businessId" | "organizationId">) {
  if (!clip.generationId) return;
  const row = await client.videoGeneration.findFirst({ where: { id: clip.generationId, businessId: clip.businessId, organizationId: clip.organizationId, output: { id: clip.id } } });
  if (!row || !["INGESTING", "READY"].includes(row.status)) throw new AppError(409, "Generated footage is not deliverable.");
  await assertShotContext(client, row, row.status !== "READY");
}
// Runs in the same transaction as normalized clip readiness. Never charge for raw bytes.
export async function finishGeneratedClip(tx: Prisma.TransactionClient, clip: VideoClip, durationMs: number) {
  if (!clip.generationId) return;
  const row = await tx.videoGeneration.findUniqueOrThrow({ where: { id: clip.generationId } });
  if (row.status !== "INGESTING" || !row.reservationId || row.supplierCostMicros === null || durationMs < row.durationMs || durationMs > 8100) throw Error("Generated footage settlement is unavailable or duration differs.");
  await assertShotContext(tx, row);
  await finishReservationInTransaction(tx, row.organizationId, row.reservationId, Math.ceil(row.supplierCostMicros / 10000));
  await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "READY", leaseUntil: null, settledAt: new Date() } });
}
export async function failGeneratedClip(tx: Prisma.TransactionClient, generationId: string | null, errorCode: string) {
  if (!generationId) return;
  const row = await tx.videoGeneration.findUniqueOrThrow({ where: { id: generationId } });
  if (row.status !== "INGESTING") return;
  if (!row.reservationId || row.supplierCostMicros === null) throw Error("Generated footage accounting is incomplete.");
  await finishReservationInTransaction(tx, row.organizationId, row.reservationId, 0);
  await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "FAILED", errorCode, leaseUntil: null, settledAt: new Date() } });
}
