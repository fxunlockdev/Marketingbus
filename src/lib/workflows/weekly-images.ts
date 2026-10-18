import { db } from "../db";
import { lockBusiness } from "../production/service";
import { manageImage, pendingImages } from "../images/service";
import { assetStore, type AssetStore } from "../assets/storage";
import { weekKey } from "./planning";
import { stopWeeklyImages } from "./weekly-image-policy";

// One bounded authorization per tick, never a provider call. Waiting businesses
// yield for five minutes so human review cannot monopolize the global worker.
export async function runOneWeeklyImage(execute: typeof manageImage = manageImage, storage: () => AssetStore = assetStore) {
  const now = new Date();
  const candidate = await db.weeklyCycle.findFirst({ where: { mediaStatus: "OPEN", AND: [
    { OR: [{ mediaLeaseUntil: null }, { mediaLeaseUntil: { lt: now } }] },
    { OR: [{ nextMediaAt: null }, { nextMediaAt: { lte: now } }] },
  ] }, orderBy: [{ nextMediaAt: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
  if (!candidate) return false;
  const leaseUntil = new Date(Date.now() + 120000);
  const work = await db.$transaction(async tx => {
    const policy = await tx.weeklyPolicy.findUnique({ where: { businessId: candidate.businessId } });
    const scope = { organizationId: candidate.organizationId, businessId: candidate.businessId, actorId: policy?.actorId ?? "weekly-worker" };
    const business = await lockBusiness(tx, scope);
    const cycle = await tx.weeklyCycle.findUniqueOrThrow({ where: { id: candidate.id } });
    if (cycle.mediaStatus !== "OPEN" || (cycle.mediaLeaseUntil && cycle.mediaLeaseUntil >= new Date()) || (cycle.nextMediaAt && cycle.nextMediaAt > new Date())) return null;
    // Reload policy after taking the business lock: settings can change during contention.
    const fresh = await tx.weeklyPolicy.findUnique({ where: { businessId: candidate.businessId } });
    const member = fresh && await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: fresh.actorId } } });
    if (!fresh?.enabled || fresh.mode !== "DRAFTS" || !fresh.imagesAfterApproval || fresh.actorId !== scope.actorId || fresh.version !== cycle.policyVersion ||
      !business.confirmedAt || business.version !== cycle.brandVersion || fresh.brandVersion !== business.version ||
      !member || !["OWNER", "ADMIN"].includes(member.role) || !["OPEN", "COMPLETE"].includes(cycle.status) || cycle.periodKey !== weekKey(new Date())) {
      await stopWeeklyImages(tx, scope, [cycle.id]);
      await tx.auditEvent.create({ data: { ...scope, action: "WEEKLY_IMAGES_STOPPED", detail: "Policy, brand, membership or UTC period changed. No further media authorization." } });
      return null;
    }
    await tx.weeklyCycle.update({ where: { id: cycle.id }, data: { mediaLeaseUntil: leaseUntil, nextMediaAt: new Date(Date.now() + 300000) } });
    const tasks = await tx.weeklyTask.findMany({ where: { cycleId: cycle.id, imageStatus: { in: ["WAITING", "QUOTED"] } }, orderBy: { id: "asc" }, take: 12 });
    if (!tasks.length) {
      await tx.weeklyCycle.update({ where: { id: cycle.id }, data: { mediaStatus: "COMPLETE", mediaLeaseUntil: null, nextMediaAt: null } }); return null;
    }
    let selected: typeof tasks[number] | undefined;
    for (const task of tasks) {
      if (task.imageStatus === "QUOTED") { selected = task; break; }
      if (task.status !== "AUTHORIZED") continue;
      const item = await tx.productionItem.findFirst({ where: { id: task.itemId, organizationId: scope.organizationId, planId: cycle.planId }, include: { revisions: { orderBy: { version: "desc" }, take: 1 } } });
      if (!item || item.format !== "static") continue;
      if (await tx.imageGeneration.count({ where: { itemId: task.itemId } })) {
        await tx.weeklyTask.update({ where: { id: task.id }, data: { imageStatus: "SKIPPED" } }); continue;
      }
      const copy = task.quoteId && await tx.generationQuote.findFirst({ where: { id: task.quoteId, itemId: task.itemId, organizationId: scope.organizationId, businessId: scope.businessId }, include: { job: true } });
      if (copy && copy.job && ["FAILED", "CANCELLED", "NEEDS_RECONCILIATION"].includes(copy.job.status)) {
        await tx.weeklyTask.update({ where: { id: task.id }, data: { imageStatus: "STOPPED" } }); continue;
      }
      if (!copy || copy.job?.status !== "COMPLETED" || item.revisions[0]?.status !== "APPROVED") continue;
      selected = task; break;
    }
    if (!selected || await tx.imageGeneration.count({ where: { businessId: scope.businessId, status: { in: pendingImages } } })) {
      await tx.weeklyCycle.update({ where: { id: cycle.id }, data: { mediaLeaseUntil: null } }); return null;
    }
    return { scope, task: selected };
  });
  if (!work) return true;
  try {
    const internal = { taskId: work.task.id, leaseUntil };
    let generationId = work.task.imageGenerationId;
    if (!generationId) {
      const result = await execute(work.scope, { action: "quote", itemId: work.task.itemId }, storage, internal);
      if (!result.generationId) throw Error("Missing recurring image quote");
      generationId = result.generationId;
    }
    await execute(work.scope, { action: "accept", generationId }, storage, internal);
  } catch {
    // Stop, don't regenerate/requote after ambiguity. Existing holds stay intact.
    await db.$transaction(async tx => {
      await lockBusiness(tx, work.scope);
      if (!await tx.weeklyCycle.findFirst({ where: { id: candidate.id, mediaStatus: "OPEN", mediaLeaseUntil: { equals: leaseUntil, gt: new Date() } } })) return;
      await stopWeeklyImages(tx, work.scope, [candidate.id]);
      await tx.weeklyTask.updateMany({ where: { id: work.task.id, imageStatus: "CANCELLED" }, data: { imageStatus: "STOPPED" } });
      await tx.weeklyCycle.update({ where: { id: candidate.id }, data: { mediaStatus: "BLOCKED" } });
      await tx.auditEvent.create({ data: { ...work.scope, action: "WEEKLY_IMAGES_BLOCKED", detail: "Image authorization stopped. Review image configuration, current approval and shared credit ceiling. No automatic retry; authorized work and holds remain unchanged." } });
    });
  } finally {
    await db.weeklyCycle.updateMany({ where: { id: candidate.id, mediaLeaseUntil: leaseUntil }, data: { mediaLeaseUntil: null } });
  }
  return true;
}
