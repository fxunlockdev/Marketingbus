import type { Prisma, VideoGeneration, VideoClip } from "@prisma/client";
import { AppError } from "../http";
import { motionHash } from "./limits";
import { storyboardDocument } from "./document";
import { finishReservationInTransaction } from "../billing/wallet";
import { shotRoute } from "./generation-contracts";
import { validateShotBriefBinding } from "./creative-brief";
import { assertKnowledgeCurrent, type GraphClient } from "../harness/knowledge-graph";
export type ShotContextClient = GraphClient & Pick<Prisma.TransactionClient, "reviewComment" | "videoStoryboard" | "videoGeneration">;
export const generationScope = (r: VideoGeneration) => ({ businessId: r.businessId, organizationId: r.organizationId, actorId: r.actorId });
type RevisionScope = Pick<VideoGeneration, "revisionOfId" | "businessId" | "organizationId" | "itemId" | "copyRevisionId" | "brandVersion" | "shotId">;
export async function assertShotRevisionSource(client: ShotContextClient, row: RevisionScope) {
  const parent = row.revisionOfId ? await client.videoGeneration.findFirst({ where: { id: row.revisionOfId, businessId: row.businessId, organizationId: row.organizationId, itemId: row.itemId, copyRevisionId: row.copyRevisionId, brandVersion: row.brandVersion, shotId: row.shotId, status: "READY" }, include: { output: true } }) : null;
  if (!parent?.output || !["READY", "APPROVED", "REJECTED"].includes(parent.output.status) || parent.output.mediaKind !== "VIDEO" || parent.output.purgeAfter <= new Date()) throw new AppError(409, "The source take is unavailable or belongs to a different creative. Choose retained completed footage from this exact scene.");
  // Only text direction is reused. No recursive media dependency or previous footage is sent.
  validateShotBriefBinding(parent.creativeBrief, parent.revisionOfId);
  await assertShotContext(client, parent, false);
  return parent;
}
export async function assertShotContext(client: ShotContextClient, row: VideoGeneration, requireStoryboard = true) {
  const brief = validateShotBriefBinding(row.creativeBrief, row.revisionOfId);
  if (row.revisionOfId && requireStoryboard) {
    const parent = await assertShotRevisionSource(client, row);
    const original = validateShotBriefBinding(parent.creativeBrief, parent.revisionOfId);
    if (brief.direction !== original.direction || JSON.stringify(brief.revisions.slice(0, -1)) !== JSON.stringify(original.revisions)) throw new AppError(409, "Generated-shot direction history changed.");
  }
  const business = await client.business.findFirst({ where: { id: row.businessId, organizationId: row.organizationId } });
  const item = await client.productionItem.findFirst({ where: { id: row.itemId, organizationId: row.organizationId, plan: { businessId: row.businessId, brandVersion: row.brandVersion, status: "PROPOSED" } }, include: { revisions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!business?.confirmedAt || business.version !== row.brandVersion || !item || (item.revisions[0]?.id ?? null) !== row.copyRevisionId || row.copyRevisionId && item.revisions[0]?.status !== "APPROVED") throw new AppError(409, "Generated footage source brand or approved copy changed.");
  if (row.status !== "READY") await assertKnowledgeCurrent(client, generationScope(row), row.knowledgeContext);
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
function deliveryCredits(row: VideoGeneration) {
  const route = shotRoute.parse(row.route);
  const quoted = row.expenseBasis === "ACCOUNT_QUOTE_V1";
  if (quoted !== (route.expensePolicy === "account-quote-v1")) throw Error("Generated footage expense policy differs.");
  const amount = quoted ? row.supplierEstimateMicros : row.supplierCostMicros;
  if (amount === null || amount < 0 || amount > row.supplierCeilingMicros || Math.ceil(amount / 10000) > row.credits) throw Error("Generated footage accounting is incomplete.");
  return Math.ceil(amount / 10000);
}
export async function finishGeneratedClip(tx: Prisma.TransactionClient, clip: VideoClip, durationMs: number) {
  if (!clip.generationId) return;
  const row = await tx.videoGeneration.findUniqueOrThrow({ where: { id: clip.generationId } });
  if (row.status !== "INGESTING" || !row.reservationId || durationMs < row.durationMs || durationMs > 8100) throw Error("Generated footage settlement is unavailable or duration differs.");
  await assertShotContext(tx, row);
  await finishReservationInTransaction(tx, row.organizationId, row.reservationId, deliveryCredits(row));
  await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "READY", leaseUntil: null, settledAt: new Date() } });
}
export async function failGeneratedClip(tx: Prisma.TransactionClient, generationId: string | null, errorCode: string) {
  if (!generationId) return;
  const row = await tx.videoGeneration.findUniqueOrThrow({ where: { id: generationId } });
  if (row.status !== "INGESTING") return;
  if (!row.reservationId) throw Error("Generated footage accounting is incomplete.");
  deliveryCredits(row);
  await finishReservationInTransaction(tx, row.organizationId, row.reservationId, 0);
  await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "FAILED", errorCode, leaseUntil: null, settledAt: new Date() } });
}
