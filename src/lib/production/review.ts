import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { STATIC_RENDERER_VERSION } from "../composition/version";
import { MOTION_RENDERER_VERSION } from "../video/version";
import { storyboardDocument, subtitleVtt } from "../video/document";
import type { Scope } from "./service";

export const reviewQuery = z.object({ plan: z.string().min(1).max(100) }).strict();

// A bounded, read-only projection. Never return prompts, supplier receipts,
// storage keys or signed URLs; every actual preview revalidates its source.
export async function readReviewMedia(scope: Scope, raw: unknown) {
  const { plan: planId } = reviewQuery.parse(raw);
  return db.$transaction(async tx => {
    const business = await tx.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
    const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
    if (!business || !member) throw new AppError(404, "Business not found.");
    const where = { businessId: scope.businessId, organizationId: scope.organizationId };
    const plan = await tx.productionPlan.findFirst({ where: { ...where, id: planId }, select: {
      id: true, status: true, brandVersion: true,
      items: { orderBy: { id: "asc" }, take: 100, select: {
        id: true, revisionRequests: true, revisions: { orderBy: { version: "desc" }, take: 1, select: { id: true, status: true } },
        images: { where, orderBy: { version: "desc" }, take: 1, select: { id: true, revisionId: true, brandVersion: true, version: true, status: true, output: { select: { status: true } } } },
        storyboards: { where, orderBy: { version: "desc" }, take: 1, select: {
          id: true, copyRevisionId: true, brandVersion: true, version: true, status: true, document: true,
          renders: { where: { ...where, rendererVersion: MOTION_RENDERER_VERSION }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, durationMs: true, purgeAfter: true } },
        } },
      } },
    } });
    if (!plan) throw new AppError(404, "Plan not found.");
    const compositions = await tx.staticComposition.findMany({ where: { ...where, itemId: { in: plan.items.map(i => i.id) } }, distinct: ["itemId"], orderBy: { version: "desc" }, take: 100,
      select: { id: true, itemId: true, revisionId: true, brandVersion: true, version: true, status: true, approvedRendererVersion: true },
    });
    const current = !!business.confirmedAt && plan.status === "PROPOSED" && plan.brandVersion === business.version;
    return {
      canEdit: current && ["OWNER", "ADMIN", "EDITOR"].includes(member.role),
      items: plan.items.map(item => {
        const copy = item.revisions[0], image = item.images[0], layout = compositions.find(c => c.itemId === item.id), board = item.storyboards[0];
        const imageCurrent = current && !!copy && image?.revisionId === copy.id && image?.brandVersion === business.version && copy.status === "APPROVED";
        const layoutCurrent = current && !!copy && layout?.revisionId === copy.id && layout?.brandVersion === business.version && ["READY", "APPROVED"].includes(copy.status) && layout.status !== "SUPERSEDED";
        const boardCurrent = current && board?.brandVersion === business.version && board.copyRevisionId === (copy?.id ?? null) && (!copy || copy.status === "APPROVED") && board.status !== "SUPERSEDED";
        const parsed = board ? storyboardDocument.safeParse(board.document) : null, render = board?.renders[0];
        return {
          itemId: item.id,
          revisionAllowance: { used: item.revisionRequests, limit: 3, remaining: Math.max(0, 3 - item.revisionRequests) },
          copyRevisionId: copy?.id ?? null,
          image: image ? { id: image.id, version: image.version, status: image.status, current: imageCurrent, previewable: imageCurrent && ["READY", "APPROVED", "REJECTED"].includes(image.status) && image.output?.status === "READY" } : null,
          composition: layout ? { id: layout.id, version: layout.version, status: layout.status, current: layoutCurrent, approved: layoutCurrent && layout.status === "APPROVED" && layout.approvedRendererVersion === STATIC_RENDERER_VERSION, previewable: layoutCurrent } : null,
          video: board ? { id: board.id, version: board.version, status: board.status, current: boardCurrent,
            format: parsed?.success ? parsed.data.format ?? "portrait" : null,
            render: render ? { id: render.id, status: render.status, durationMs: render.durationMs, previewable: boardCurrent && board.status === "APPROVED" && !!parsed?.success && ["READY", "APPROVED", "REJECTED"].includes(render.status) && render.purgeAfter > new Date() } : null,
            captions: boardCurrent && parsed?.success ? subtitleVtt(parsed.data) : null,
            hasMusic: !!(parsed?.success && parsed.data.soundtrack),
          } : null,
        };
      }),
    };
  }, { isolationLevel: "RepeatableRead" });
}

export type ReviewMedia = Awaited<ReturnType<typeof readReviewMedia>>;
export type ReviewMediaItem = ReviewMedia["items"][number];
