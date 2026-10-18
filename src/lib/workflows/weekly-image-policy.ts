import type { ImageGeneration, Prisma } from "@prisma/client";
import { AppError } from "../http";
import type { Scope } from "../production/service";
import { weekKey } from "./planning";

export type WeeklyImageAuthorization = { taskId: string; leaseUntil: Date };
// Caller holds the business lock. These checks run inside the image quote/accept transaction.
export async function weeklyImageContext(tx: Prisma.TransactionClient, scope: Scope, itemId: string, internal: WeeklyImageAuthorization) {
  const task = await tx.weeklyTask.findFirst({ where: { id: internal.taskId, itemId,
    cycle: { organizationId: scope.organizationId, businessId: scope.businessId } }, include: { cycle: true } });
  const policy = await tx.weeklyPolicy.findUnique({ where: { businessId: scope.businessId } });
  if (!task || !policy?.enabled || policy.mode !== "DRAFTS" || !policy.imagesAfterApproval || policy.actorId !== scope.actorId ||
    !["OPEN", "COMPLETE"].includes(task.cycle.status) || task.cycle.mediaStatus !== "OPEN" ||
    task.cycle.mediaLeaseUntil?.getTime() !== internal.leaseUntil.getTime() || internal.leaseUntil <= new Date() ||
    task.cycle.policyVersion !== policy.version || task.cycle.brandVersion !== policy.brandVersion || task.cycle.periodKey !== weekKey(new Date()) || task.status !== "AUTHORIZED")
    throw new AppError(409, "Recurring image authorization is stale or paused.");
  const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member || !["OWNER", "ADMIN"].includes(member.role)) throw new AppError(403, "Recurring authorizer no longer has permission.");
  const copy = task.quoteId && await tx.generationQuote.findFirst({ where: { id: task.quoteId, businessId: scope.businessId,
    organizationId: scope.organizationId, itemId, item: { planId: task.cycle.planId }, job: { status: "COMPLETED" } }, select: { id: true } });
  if (!copy) throw new AppError(409, "Finish the weekly copy job before authorizing its image.");
  return { task, policy };
}
export async function reserveWeeklyImage(tx: Prisma.TransactionClient, scope: Scope, row: ImageGeneration, internal: WeeklyImageAuthorization) {
  const { task, policy } = await weeklyImageContext(tx, scope, row.itemId, internal);
  if (row.parentId || task.imageGenerationId !== row.id || task.imageStatus !== "QUOTED" || row.brandVersion !== task.cycle.brandVersion || row.actorId !== scope.actorId)
    throw new AppError(409, "The recurring image offer changed.");
  if (task.cycle.creditsAuthorized + row.credits > policy.creditsPerWeek) throw new AppError(409, "Combined copy and image weekly credit ceiling reached.");
  await tx.weeklyCycle.update({ where: { id: task.cycleId }, data: { creditsAuthorized: { increment: row.credits } } });
  await tx.weeklyTask.update({ where: { id: task.id }, data: { imageStatus: "AUTHORIZED" } });
}
export async function stopWeeklyImages(tx: Prisma.TransactionClient, scope: Scope, cycleIds: string[]) {
  const tasks = await tx.weeklyTask.findMany({ where: { cycleId: { in: cycleIds }, cycle: { businessId: scope.businessId, organizationId: scope.organizationId }, imageStatus: { in: ["WAITING", "QUOTED", "STOPPED"] } }, select: { id: true, imageGenerationId: true, itemId: true } });
  for (const task of tasks) if (task.imageGenerationId) await tx.imageGeneration.updateMany({ where: {
    id: task.imageGenerationId, businessId: scope.businessId, organizationId: scope.organizationId, itemId: task.itemId,
    status: "OFFERED", acceptedAt: null,
  }, data: { status: "CANCELLED" } });
  await tx.weeklyTask.updateMany({ where: { id: { in: tasks.map(t => t.id) } }, data: { imageStatus: "CANCELLED" } });
  await tx.weeklyCycle.updateMany({ where: { id: { in: cycleIds }, businessId: scope.businessId, organizationId: scope.organizationId,
    mediaStatus: { in: ["OPEN", "BLOCKED"] } }, data: { mediaStatus: "CANCELLED", mediaLeaseUntil: null, nextMediaAt: null } });
}
