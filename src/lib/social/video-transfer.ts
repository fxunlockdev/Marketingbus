import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import type { Scope } from "../production/service";
import { storyboardContext, shotHash } from "../video/service";
import { MOTION_RENDERER_VERSION, motionHash } from "../video/limits";
import { totalDuration, shotApprovals } from "../video/document";
import { videoLayout } from "../video/layout";
import { publicationVideo, type PublicationPayload } from "./contracts";

// A retained, reviewed final render, never an arbitrary upload, clip, URL or storage key.
export async function publicationRender(client: Prisma.TransactionClient | typeof db, scope: Scope, id: string, revisionId: string) {
  const row = await client.motionRender.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId,
    status: "APPROVED", approvedBy: { not: null }, purgeAfter: { gt: new Date() }, storyboard: { copyRevisionId: revisionId } } });
  if (!row) throw new AppError(409, "Choose a retained, approved final video for this exact copy version.");
  const ctx = await storyboardContext(scope, row.storyboardId, client);
  const reviews = shotApprovals.parse(ctx.row.shotApprovals), dimensions = videoLayout(ctx.document);
  if (ctx.row.status !== "APPROVED" || !ctx.row.approvedBy || ctx.row.copyRevisionId !== revisionId || row.rendererVersion !== MOTION_RENDERER_VERSION ||
      row.documentHash !== motionHash(ctx.document) || row.durationMs !== totalDuration(ctx.document) ||
      ctx.document.shots.some(shot => !reviews.some(r => r.shotId === shot.id && r.hash === shotHash(ctx.document, shot))))
    throw new AppError(409, "Review and export the current complete storyboard before publishing.");
  const video = publicationVideo.safeParse({ sha256: row.sha256, bytes: row.bytes, width: dimensions.width, height: dimensions.height, durationMs: row.durationMs, shareToFeed: false });
  if (!video.success) throw new AppError(409, "Reels require a portrait 720×1280 export, 3–30 seconds, at most 20 MB; Facebook requires at least four seconds.");
  return { row, video: video.data, storyboard: ctx.row };
}
export async function assertPublicationVideo(client: Prisma.TransactionClient | typeof db, scope: Scope, revisionId: string, payload: PublicationPayload) {
  if (!payload.video || !payload.mediaExportId || !["Instagram", "Facebook"].includes(payload.channel)) throw new AppError(409, "An approved final Reel is required.");
  const current = await publicationRender(client, scope, payload.mediaExportId, revisionId);
  const { shareToFeed: _placement, ...expected } = payload.video;
  const { shareToFeed: _default, ...actual } = current.video;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new AppError(409, "The approved video fingerprint changed.");
  return current.row;
}
export async function listPublicationVideos(scope: Scope) {
  const candidates = await db.motionRender.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, status: "APPROVED", purgeAfter: { gt: new Date() } },
    include: { storyboard: { select: { copyRevisionId: true } } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 50 });
  const result = [];
  for (const candidate of candidates) {
    if (!candidate.storyboard.copyRevisionId) continue;
    try {
      const { row, storyboard } = await publicationRender(db, scope, candidate.id, candidate.storyboard.copyRevisionId);
      const revision = await db.creativeRevision.findUniqueOrThrow({ where: { id: storyboard.copyRevisionId! } });
      result.push({ id: row.id, itemId: storyboard.itemId, revisionVersion: revision.version, durationMs: row.durationMs, expiresAt: row.purgeAfter, bytes: row.bytes });
    } catch (error) { if (!(error instanceof AppError)) throw error; }
  }
  return result;
}
