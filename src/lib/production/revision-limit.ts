import type { Prisma } from "@prisma/client";
import type { Scope } from "./service";
import { AppError } from "../http";
import { storyboardDocument } from "../video/document";

export const CREATIVE_REVISION_LIMIT = 3;
export const revisionLimitMessage = "This creative has used its three AI revision requests. You can still edit manually, comment, approve or reject. A new quote or deleted output does not reset the limit.";

// Call under the business lock. Acceptance and the wallet hold commit together;
// idempotent acceptance returns before this function. No browser-supplied counter.
export async function checkCreativeRevision(tx: Prisma.TransactionClient, scope: Scope, itemId: string, consume = false) {
  const where = { id: itemId, organizationId: scope.organizationId, plan: { businessId: scope.businessId } };
  // Reconcile the immutable authorization history as a floor. This also covers
  // an older web process accepting work during a rolling deployment.
  const [history] = await tx.$queryRaw<{ used: number }[]>`SELECT (
    (SELECT COUNT(*) FROM "GenerationQuote" WHERE "itemId"=${itemId} AND "organizationId"=${scope.organizationId} AND "businessId"=${scope.businessId} AND "acceptedAt" IS NOT NULL AND "baseVersion">0)
    + (SELECT GREATEST(COUNT(*)-1,0) FROM "ImageGeneration" WHERE "itemId"=${itemId} AND "organizationId"=${scope.organizationId} AND "businessId"=${scope.businessId} AND "acceptedAt" IS NOT NULL)
    + (SELECT COALESCE(SUM(s.n),0) FROM (SELECT GREATEST(COUNT(*)-1,COUNT(*) FILTER (WHERE "revisionOfId" IS NOT NULL)) AS n FROM "VideoGeneration" WHERE "itemId"=${itemId} AND "organizationId"=${scope.organizationId} AND "businessId"=${scope.businessId} AND "acceptedAt" IS NOT NULL GROUP BY "shotId") s)
  )::integer AS used`;
  if (history.used > 0) await tx.productionItem.updateMany({ where: { ...where, revisionRequests: { lt: history.used } }, data: { revisionRequests: history.used } });
  if (consume) {
    const result = await tx.productionItem.updateMany({ where: { ...where, revisionRequests: { lt: CREATIVE_REVISION_LIMIT } }, data: { revisionRequests: { increment: 1 } } });
    if (!result.count) throw new AppError(409, revisionLimitMessage);
  } else {
    const item = await tx.productionItem.findFirst({ where, select: { revisionRequests: true } });
    if (!item) throw new AppError(404, "Creative not found.");
    if (item.revisionRequests >= CREATIVE_REVISION_LIMIT) throw new AppError(409, revisionLimitMessage);
  }
}

export async function isMediaRevision(tx: Prisma.TransactionClient, scope: Scope, itemId: string, kind: "image" | "video", parent?: string | null, shotId?: string) {
  if (parent) return true;
  const where = { itemId, businessId: scope.businessId, organizationId: scope.organizationId, acceptedAt: { not: null } };
  // Each original storyboard scene may be produced once. Replacing the take for
  // that scene shares the same allowance, even without an explicit parent pointer.
  if (kind === "image") return !!await tx.imageGeneration.count({ where });
  if (await tx.videoGeneration.count({ where: { ...where, shotId } })) return true;
  const first = await tx.videoGeneration.findFirst({ where, orderBy: [{ acceptedAt: "asc" }, { id: "asc" }], select: { storyboardId: true } });
  if (!first) return false;
  const original = await tx.videoStoryboard.findFirst({ where: { id: first.storyboardId, itemId, businessId: scope.businessId, organizationId: scope.organizationId }, select: { document: true } });
  const baseline = storyboardDocument.safeParse(original?.document);
  // Renaming/recreating scenes cannot manufacture new free initial takes.
  return !baseline.success || !baseline.data.shots.some(shot => shot.id === shotId);
}
