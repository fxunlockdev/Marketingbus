import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { currentItem, lockBusiness, type Scope } from "../production/service";
import { invalidatePublications } from "../social/service";

export async function assertReviewer(tx: Prisma.TransactionClient, scope: Scope, independent: boolean, authorId: string | null) {
  if (!independent) return;
  const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member || !["OWNER", "ADMIN"].includes(member.role)) throw new AppError(403, "An owner or administrator must independently approve this work.");
  if (!authorId || authorId === scope.actorId) throw new AppError(409, "A different person must approve this version. Legacy work without an author must first be saved as a new version.");
}
export async function assertNoBlockingComments(tx: Prisma.TransactionClient, revisionId: string) {
  if (await tx.reviewComment.count({ where: { revisionId, blocking: true, resolvedAt: null } })) throw new AppError(409, "Resolve blocking review comments before approval or scheduling.");
}
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("policy"), independent: z.boolean() }).strict(),
  z.object({ action: z.literal("comment"), itemId: z.string().min(1), version: z.number().int().positive(), body: z.string().trim().min(2).max(2000), blocking: z.boolean() }).strict(),
  z.object({ action: z.literal("resolve"), commentId: z.string().min(1) }).strict(),
]);
export async function readApprovals(scope: Scope, itemId?: string) {
  const business = await db.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!business) throw new AppError(404, "Business not found.");
  return { independent: business.independentApproval, comments: await db.reviewComment.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, ...(itemId ? { revision: { itemId } } : {}) }, orderBy: { createdAt: "desc" }, take: 100, include: { revision: { select: { version: true } } } }) };
}
export async function manageApprovals(scope: Scope, raw: unknown) {
  const input = actionSchema.parse(raw);
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope);
    const membership = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
    if (!membership || !["OWNER", "ADMIN", "EDITOR"].includes(membership.role)) throw new AppError(403, "Workspace editing access required.");
    if (input.action === "policy") {
      if (!["OWNER", "ADMIN"].includes(membership.role)) throw new AppError(403, "Administrator access required.");
      if (input.independent === business.independentApproval) return { ok: true };
      if (input.independent && await tx.membership.count({ where: { organizationId: scope.organizationId, role: { in: ["OWNER", "ADMIN"] } } }) < 2)
        throw new AppError(409, "Add a second owner or administrator before requiring independent approval.");
      await invalidatePublications(tx, scope.businessId);
      await tx.business.update({ where: { id: scope.businessId }, data: { independentApproval: input.independent } });
      await tx.creativeRevision.updateMany({ where: { item: { plan: { businessId: scope.businessId } }, status: "APPROVED" }, data: { status: "READY", approvedBy: null, approvedAt: null } });
      await tx.productionItem.updateMany({ where: { plan: { businessId: scope.businessId } }, data: { scheduledFor: null } });
      await tx.productionItem.updateMany({ where: { plan: { businessId: scope.businessId }, status: "APPROVED" }, data: { status: "READY" } });
      await tx.staticComposition.updateMany({ where: { businessId: scope.businessId, status: "APPROVED" }, data: { status: "DRAFT", approvedBy: null } });
      await tx.imageGeneration.updateMany({ where: { businessId: scope.businessId, status: "APPROVED" }, data: { status: "READY", approvedBy: null } });
      await tx.brandAsset.updateMany({ where: { businessId: scope.businessId, purpose: "generated" }, data: { approvedForGeneration: false } });
      await tx.calendarEntry.deleteMany({ where: { item: { plan: { businessId: scope.businessId } } } });
    } else if (input.action === "comment") {
      const item = await currentItem(tx, scope, input.itemId), revision = item.revisions[0];
      if (!revision || revision.version !== input.version) throw new AppError(409, "Comment on the current version. Refresh first.");
      if (await tx.reviewComment.count({ where: { revisionId: revision.id } }) >= 200) throw new AppError(409, "Review comment limit reached for this version.");
      if (input.blocking) {
        await invalidatePublications(tx, scope.businessId, item.id);
        if (revision.status === "APPROVED") {
          await tx.creativeRevision.update({ where: { id: revision.id }, data: { status: "READY", approvedBy: null, approvedAt: null } });
          await tx.productionItem.update({ where: { id: item.id }, data: { status: "READY", scheduledFor: null } });
        }
        await tx.staticComposition.updateMany({ where: { revisionId: revision.id, status: "APPROVED" }, data: { status: "DRAFT", approvedBy: null } });
        await tx.imageGeneration.updateMany({ where: { revisionId: revision.id, status: "APPROVED" }, data: { status: "READY", approvedBy: null } });
        await tx.brandAsset.updateMany({ where: { generation: { revisionId: revision.id } }, data: { approvedForGeneration: false } });
        await tx.calendarEntry.deleteMany({ where: { revisionId: revision.id } });
      }
      await tx.reviewComment.create({ data: { ...scope, revisionId: revision.id, body: input.body, blocking: input.blocking } });
    } else {
      const comment = await tx.reviewComment.findFirst({ where: { id: input.commentId, businessId: scope.businessId, organizationId: scope.organizationId } });
      if (!comment) throw new AppError(404, "Comment not found.");
      if (comment.actorId !== scope.actorId && !["OWNER", "ADMIN"].includes(membership.role)) throw new AppError(403, "Only the commenter or an administrator can resolve this comment.");
      await tx.reviewComment.updateMany({ where: { id: comment.id, resolvedAt: null }, data: { resolvedBy: scope.actorId, resolvedAt: new Date() } });
    }
    await tx.auditEvent.create({ data: { ...scope, action: `REVIEW_${input.action.toUpperCase()}`, detail: "Explicit review action recorded. No generation or publication authorized." } });
    return { ok: true };
  });
}
