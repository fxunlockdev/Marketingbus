import type { Prisma, VideoGeneration } from "@prisma/client";
import { AppError } from "../http";
import type { Scope } from "../production/service";
import { weekKey } from "./planning";

export type WeeklyVideoAuthorization = { taskId: string; leaseUntil: Date };
// All callers hold the business lock. Never accept authorization supplied through an HTTP body.
export async function weeklyVideoContext(tx: Prisma.TransactionClient, scope: Scope, internal: WeeklyVideoAuthorization) {
  const task = await tx.weeklyTask.findFirst({ where: { id: internal.taskId,
    cycle: { businessId: scope.businessId, organizationId: scope.organizationId } }, include: { cycle: true, shots: true } });
  const policy = await tx.weeklyPolicy.findUnique({ where: { businessId: scope.businessId } });
  const business = await tx.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!task || !policy?.enabled || policy.mode !== "DRAFTS" || !policy.videosAfterApproval || policy.actorId !== scope.actorId ||
    !business?.confirmedAt || business.version !== task.cycle.brandVersion || policy.brandVersion !== business.version ||
    !["OPEN", "COMPLETE"].includes(task.cycle.status) || task.cycle.videoStatus !== "OPEN" || task.status !== "AUTHORIZED" ||
    !["WAITING", "STORYBOARD", "PRODUCING", "REVIEW"].includes(task.videoStatus) ||
    task.cycle.videoLeaseUntil?.getTime() !== internal.leaseUntil.getTime() || internal.leaseUntil <= new Date() ||
    task.cycle.policyVersion !== policy.version || task.cycle.periodKey !== weekKey(new Date()))
    throw new AppError(409, "Recurring video authorization is stale or paused.");
  const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member || !["OWNER", "ADMIN"].includes(member.role)) throw new AppError(403, "Recurring authorizer no longer has permission.");
  const item = await tx.productionItem.findFirst({ where: { id: task.itemId, planId: task.cycle.planId, organizationId: scope.organizationId,
    format: "motion", plan: { status: "PROPOSED", brandVersion: business.version } }, include: { revisions: { orderBy: { version: "desc" }, take: 1 } } });
  const copy = task.quoteId && await tx.generationQuote.findFirst({ where: { id: task.quoteId, itemId: task.itemId,
    businessId: scope.businessId, organizationId: scope.organizationId, job: { status: "COMPLETED" } } });
  if (!item || !copy || item.revisions[0]?.status !== "APPROVED") throw new AppError(409, "Approve the current weekly video copy first.");
  if (await tx.reviewComment.count({ where: { revisionId: item.revisions[0].id, blocking: true, resolvedAt: null } })) throw new AppError(409, "Resolve blocking copy comments first.");
  return { task, policy, item };
}
export async function reserveWeeklyVideo(tx: Prisma.TransactionClient, scope: Scope, row: VideoGeneration, internal: WeeklyVideoAuthorization) {
  const { task, policy, item } = await weeklyVideoContext(tx, scope, internal);
  if (row.revisionOfId || row.itemId !== task.itemId || row.storyboardId !== task.storyboardId || row.copyRevisionId !== item.revisions[0].id ||
    row.actorId !== scope.actorId || row.brandVersion !== task.cycle.brandVersion ||
    !task.shots.some(s => s.generationId === row.id && s.shotId === row.shotId)) throw new AppError(409, "The recurring shot offer changed.");
  if (task.cycle.creditsAuthorized + row.credits > policy.creditsPerWeek) throw new AppError(409, "Combined copy, image and video weekly credit ceiling reached.");
  await tx.weeklyCycle.update({ where: { id: task.cycleId }, data: { creditsAuthorized: { increment: row.credits } } });
  await tx.weeklyTask.update({ where: { id: task.id }, data: { videoStatus: "PRODUCING" } });
}
export async function stopWeeklyVideos(tx: Prisma.TransactionClient, scope: Scope, cycleIds: string[]) {
  const tasks = await tx.weeklyTask.findMany({ where: { cycleId: { in: cycleIds },
    cycle: { businessId: scope.businessId, organizationId: scope.organizationId },
    videoStatus: { in: ["WAITING", "STORYBOARD", "PRODUCING", "REVIEW", "STOPPED"] } }, include: { shots: true } });
  for (const task of tasks) await tx.videoGeneration.updateMany({ where: {
    id: { in: task.shots.map(s => s.generationId) }, itemId: task.itemId, businessId: scope.businessId,
    organizationId: scope.organizationId, status: "OFFERED", acceptedAt: null,
  }, data: { status: "CANCELLED" } });
  await tx.weeklyTask.updateMany({ where: { id: { in: tasks.map(t => t.id) } }, data: { videoStatus: "CANCELLED" } });
  await tx.weeklyCycle.updateMany({ where: { id: { in: cycleIds }, businessId: scope.businessId, organizationId: scope.organizationId,
    videoStatus: { in: ["OPEN", "BLOCKED"] } }, data: { videoStatus: "CANCELLED", videoLeaseUntil: null, nextVideoAt: null } });
}
