import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { brandInput, proposePlan } from "../brand";
import { actOnProduction, lockBusiness, type Scope } from "../production/service";
import { stopWeeklyImages } from "./weekly-image-policy";
import { stopWeeklyVideos } from "./weekly-video-policy";

export function nextWeekly(weekday: number, hourUTC: number, now: Date) {
  const next = new Date(now); next.setUTCHours(hourUTC, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + (weekday - next.getUTCDay() + 7) % 7);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}
export function weekKey(now: Date) {
  const monday = new Date(now); monday.setUTCHours(0, 0, 0, 0); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0, 10);
}
const policySchema = z.object({ enabled: z.boolean(), mode: z.enum(["PLAN", "DRAFTS"]), imagesAfterApproval: z.boolean().default(false), videosAfterApproval: z.boolean().default(false), videoItems: z.number().int().min(0).max(12).default(0), maxItems: z.number().int().min(1).max(12), creditsPerWeek: z.number().int().min(0).max(8000), weekday: z.number().int().min(0).max(6), hourUTC: z.number().int().min(0).max(23), version: z.number().int().nonnegative() }).strict()
  .refine(p => !p.imagesAfterApproval || p.mode === "DRAFTS", "Automatic images require draft mode.")
  .refine(p => p.videoItems <= p.maxItems, "Video items cannot exceed the total planned items.")
  .refine(p => !p.videosAfterApproval || p.mode === "DRAFTS" && p.videoItems > 0, "Automatic video requires draft mode and at least one video item.");
export async function readPlanning(scope: Scope) {
  return db.$transaction(async tx => {
    const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
    if (!member || !await tx.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId }, select: { id: true } })) throw new AppError(404, "Business not found.");
    const canManage = ["OWNER", "ADMIN"].includes(member.role);
    const policy = await tx.weeklyPolicy.findFirst({ where: { businessId: scope.businessId, organizationId: scope.organizationId }, select: { enabled: true, mode: true, imagesAfterApproval: true, videosAfterApproval: true, videoItems: true, maxItems: true, creditsPerWeek: true, weekday: true, hourUTC: true, version: true } });
    const cycles = await tx.weeklyCycle.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21,
      select: { id: true, planId: true, periodKey: true, policyVersion: true, status: true, mediaStatus: true, videoStatus: true, creditsAuthorized: true, tasks: { take: 13, orderBy: { id: "asc" }, select: { id: true, itemId: true, quoteId: true, status: true, imageStatus: true, imageGenerationId: true, videoStatus: true, renderId: true, shots: { take: 6, select: { generationId: true } } } } } });
    const page = cycles.slice(0, 20), tasks = page.flatMap(c => c.tasks.slice(0, 12));
    const items = await tx.productionItem.findMany({ where: { id: { in: tasks.map(t => t.itemId) }, organizationId: scope.organizationId, plan: { businessId: scope.businessId } }, select: { id: true, planId: true, title: true, channel: true } });
    const quotes = await tx.generationQuote.findMany({ where: { id: { in: tasks.flatMap(t => t.quoteId ? [t.quoteId] : []) }, organizationId: scope.organizationId, businessId: scope.businessId }, select: { id: true, itemId: true, job: { select: { status: true, reservation: { select: { state: true, credits: true } } } } } });
    const images = await tx.imageGeneration.findMany({ where: { id: { in: tasks.flatMap(t => t.imageGenerationId ? [t.imageGenerationId] : []) }, businessId: scope.businessId, organizationId: scope.organizationId }, select: { id: true, itemId: true, status: true, reservationId: true } });
    const holds = await tx.reservation.findMany({ where: { id: { in: images.flatMap(i => i.reservationId ? [i.reservationId] : []) }, organizationId: scope.organizationId, state: "HELD" }, select: { id: true, credits: true } });
    const videos = await tx.videoGeneration.findMany({ where: { id: { in: tasks.flatMap(t => t.shots.map(s => s.generationId)) }, businessId: scope.businessId, organizationId: scope.organizationId }, select: { id: true, itemId: true, status: true, reservationId: true } });
    const videoHolds = await tx.reservation.findMany({ where: { id: { in: videos.flatMap(v => v.reservationId ? [v.reservationId] : []) }, organizationId: scope.organizationId, state: "HELD" }, select: { id: true, credits: true } });
    const renders = await tx.motionRender.findMany({ where: { id: { in: tasks.flatMap(t => t.renderId ? [t.renderId] : []) }, businessId: scope.businessId, organizationId: scope.organizationId }, select: { id: true, status: true, storyboard: { select: { itemId: true } } } });
    return { policy, canManage, hasOlderCycles: cycles.length > 20, cycles: page.map(c => ({ id: c.id, periodKey: c.periodKey, policyVersion: c.policyVersion, status: c.status, mediaStatus: c.mediaStatus, videoStatus: c.videoStatus, creditsAuthorized: c.creditsAuthorized,
      canCancel: canManage && [c.status, c.mediaStatus, c.videoStatus].some(s => ["OPEN", "BLOCKED"].includes(s)), tasksTruncated: c.tasks.length > 12,
      tasks: c.tasks.slice(0, 12).map(t => {
        const item = items.find(i => i.id === t.itemId && i.planId === c.planId), quote = item ? quotes.find(q => q.id === t.quoteId && q.itemId === item.id) : undefined;
        const image = item ? images.find(i => i.id === t.imageGenerationId && i.itemId === item.id) : undefined;
        return { id: t.id, title: item?.title ?? "Unavailable creative", channel: item?.channel ?? "", status: t.status, jobStatus: quote?.job?.status ?? null,
          heldCredits: quote?.job?.reservation?.state === "HELD" ? quote.job.reservation.credits : 0,
          imageStatus: t.imageStatus, imageJobStatus: image?.status ?? null, imageHeldCredits: holds.find(h => h.id === image?.reservationId)?.credits ?? 0,
          videoStatus: t.videoStatus, videoJobStatuses: videos.filter(v => v.itemId === item?.id && t.shots.some(s => s.generationId === v.id)).map(v => v.status),
          videoHeldCredits: videos.filter(v => v.itemId === item?.id && t.shots.some(s => s.generationId === v.id)).reduce((sum, v) => sum + (videoHolds.find(h => h.id === v.reservationId)?.credits ?? 0), 0),
          renderStatus: renders.find(r => r.id === t.renderId && r.storyboard.itemId === item?.id)?.status ?? null };
      }) })) };
  }, { isolationLevel: "RepeatableRead" });
}
export const cancelCycleSchema = z.object({ action: z.literal("cancelCycle"), cycleId: z.string().min(1).max(100), policyVersion: z.number().int().positive() }).strict();
export async function cancelWeeklyCycle(scope: Scope, raw: unknown) {
  const input = cancelCycleSchema.parse(raw);
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope);
    const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
    if (!member || !["OWNER", "ADMIN"].includes(member.role)) throw new AppError(403, "Only workspace administrators can stop recurring runs.");
    const cycle = await tx.weeklyCycle.findFirst({ where: { id: input.cycleId, businessId: scope.businessId, organizationId: scope.organizationId } });
    if (!cycle) throw new AppError(404, "Weekly run not found.");
    if (cycle.policyVersion !== input.policyVersion) throw new AppError(409, "Weekly run changed. Refresh first.");
    if (cycle.status === "CANCELLED" && ![cycle.mediaStatus, cycle.videoStatus].some(s => ["OPEN", "BLOCKED"].includes(s))) return { ok: true };
    if (![cycle.status, cycle.mediaStatus, cycle.videoStatus].some(s => ["OPEN", "BLOCKED"].includes(s))) throw new AppError(409, "This run has finished authorizing work. Already-authorized jobs cannot be stopped here.");
    await stopUnacceptedTasks(tx, scope, [cycle.id]);
    await tx.weeklyCycle.update({ where: { id: cycle.id }, data: { status: "CANCELLED", leaseUntil: null, errorCode: "ADMIN_CANCELLED" } });
    await tx.auditEvent.create({ data: { ...scope, action: "WEEKLY_RUN_CANCELLED", detail: `Stopped remaining authorization for run ${cycle.id}. Authorized jobs, credit holds and cumulative weekly spend remain unchanged. Future weekly policy remains unchanged.` } });
    return { ok: true };
  });
}
async function stopUnacceptedTasks(tx: Prisma.TransactionClient, scope: Scope, cycleIds: string[]) {
  await stopWeeklyImages(tx, scope, cycleIds);
  await stopWeeklyVideos(tx, scope, cycleIds);
  const tasks = await tx.weeklyTask.findMany({ where: { cycleId: { in: cycleIds }, status: { in: ["PENDING", "QUOTED", "STOPPED"] } }, select: { id: true, itemId: true, quoteId: true } });
  for (const task of tasks) if (task.quoteId) await tx.generationQuote.updateMany({ where: { id: task.quoteId, itemId: task.itemId, organizationId: scope.organizationId, businessId: scope.businessId, status: "OFFERED", job: null }, data: { status: "CANCELLED" } });
  await tx.weeklyTask.updateMany({ where: { id: { in: tasks.map(t => t.id) } }, data: { status: "CANCELLED", errorCode: "RUN_CANCELLED" } });
}
export async function savePlanning(scope: Scope, raw: unknown) {
  const input = policySchema.parse(raw);
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope);
    const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
    if (!member || !["OWNER", "ADMIN"].includes(member.role)) throw new AppError(403, "Only workspace administrators can authorize recurring work.");
    const current = await tx.weeklyPolicy.findUnique({ where: { businessId: scope.businessId } });
    if ((current?.version ?? 0) !== input.version) throw new AppError(409, "Planning settings changed. Reload before saving.");
    if (input.enabled && !business.confirmedAt) throw new AppError(409, "Confirm the current brand before enabling recurring work.");
    if (input.enabled && input.mode === "DRAFTS" && input.creditsPerWeek < 1) throw new AppError(400, "Set a weekly credit ceiling for automatic draft generation.");
    // Reconfiguration never resets the current week's authorization or creates a catch-up backlog.
    const open = await tx.weeklyCycle.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, OR: [{ status: { in: ["OPEN", "BLOCKED"] } }, { mediaStatus: { in: ["OPEN", "BLOCKED"] } }, { videoStatus: { in: ["OPEN", "BLOCKED"] } }] }, select: { id: true } });
    await stopUnacceptedTasks(tx, scope, open.map(c => c.id));
    await tx.weeklyCycle.updateMany({ where: { id: { in: open.map(c => c.id) } }, data: { status: "CANCELLED", errorCode: "POLICY_CHANGED", leaseUntil: null } });
    const data = { ...input, version: input.version + 1, actorId: scope.actorId, brandVersion: business.version, nextRunAt: nextWeekly(input.weekday, input.hourUTC, new Date()) };
    await tx.weeklyPolicy.upsert({ where: { businessId: scope.businessId }, create: { businessId: scope.businessId, organizationId: scope.organizationId, ...data }, update: data });
    await tx.auditEvent.create({ data: { ...scope, action: "WEEKLY_POLICY_UPDATED", detail: `${input.enabled ? input.mode : "PAUSED"}; at most ${input.maxItems} planned items (${input.videoItems} video) and ${input.creditsPerWeek} combined credits per UTC week. Image authorization: ${input.imagesAfterApproval}; video scene authorization and source-rights confirmation: ${input.videosAfterApproval}. Already-authorized jobs are not cancelled. Approval and social publication remain separate.` } });
    return { ok: true };
  });
}
export async function createDuePlan(now = new Date()) {
  const due = await db.weeklyPolicy.findFirst({ where: { enabled: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: "asc" } });
  if (!due) return false;
  return db.$transaction(async tx => {
    const scope = { businessId: due.businessId, organizationId: due.organizationId, actorId: due.actorId }, business = await lockBusiness(tx, scope);
    const policy = await tx.weeklyPolicy.findUniqueOrThrow({ where: { businessId: due.businessId } });
    if (!policy.enabled || policy.nextRunAt > now) return false;
    const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: policy.actorId } } });
    if (!business.confirmedAt || policy.brandVersion !== business.version || !member || !["OWNER", "ADMIN"].includes(member.role)) {
      await tx.weeklyPolicy.update({ where: { businessId: business.id }, data: { enabled: false } });
      await tx.auditEvent.create({ data: { ...scope, action: "WEEKLY_POLICY_PAUSED", detail: "Brand or authorizing membership changed; administrator confirmation required." } });
      return true;
    }
    await tx.weeklyPolicy.update({ where: { businessId: business.id }, data: { nextRunAt: nextWeekly(policy.weekday, policy.hourUTC, now) } });
    const periodKey = weekKey(now);
    if (await tx.weeklyCycle.findUnique({ where: { businessId_periodKey: { businessId: business.id, periodKey } } })) return true;
    const brand = brandInput.parse(Object.fromEntries(Object.keys(brandInput.shape).map(k => [k, business[k as keyof typeof business]])));
    const templates = proposePlan(brand);
    // Null preserves legacy platform defaults and spending consent until an admin saves a mix.
    const legacy = policy.videoItems === null;
    const plan = await tx.productionPlan.create({ data: { businessId: business.id, organizationId: scope.organizationId, brandVersion: business.version, title: `Week of ${periodKey} · review required`, creditCeiling: policy.creditsPerWeek, items: { create: Array.from({ length: policy.maxItems }, (_, i) => ({ ...templates[i % templates.length], format: legacy ? templates[i % templates.length].format : i < policy.videoItems! ? "motion" : "static", title: `${templates[i % templates.length].title} · ${i + 1}` })) } }, include: { items: true } });
    await tx.weeklyCycle.create({ data: { businessId: business.id, organizationId: scope.organizationId, periodKey, policyVersion: policy.version, brandVersion: business.version, planId: plan.id, status: policy.mode === "PLAN" ? "COMPLETE" : "OPEN", mediaStatus: policy.imagesAfterApproval ? "OPEN" : "NONE", videoStatus: policy.videosAfterApproval ? "OPEN" : "NONE", tasks: { create: plan.items.map(item => ({ itemId: item.id, status: policy.mode === "PLAN" || legacy && item.format !== "static" ? "SKIPPED" : "PENDING", errorCode: legacy && item.format !== "static" ? "MEDIA_REQUIRES_DIRECTION" : null, imageStatus: policy.imagesAfterApproval && item.format === "static" ? "WAITING" : "SKIPPED", videoStatus: policy.videosAfterApproval && item.format === "motion" ? "WAITING" : "SKIPPED" })) } } });
    await tx.auditEvent.create({ data: { ...scope, action: "WEEKLY_PLAN_CREATED", detail: `One idempotent planning cycle for UTC week ${periodKey}; no approval or publication implied.` } });
    return true;
  });
}

// Called inside the SAME acceptance transaction as the wallet reservation and job creation.
export async function reserveWeeklyAuthorization(tx: Prisma.TransactionClient, scope: Scope, taskId: string, quote: { id: string; itemId: string; credits: number; mode: string; brandVersion: number }, leaseUntil: Date) {
  const task = await tx.weeklyTask.findFirst({ where: { id: taskId, itemId: quote.itemId, cycle: { businessId: scope.businessId, organizationId: scope.organizationId } }, include: { cycle: true } });
  const policy = await tx.weeklyPolicy.findUnique({ where: { businessId: scope.businessId } });
  if (!task || !policy?.enabled || policy.mode !== "DRAFTS" || policy.actorId !== scope.actorId || task.cycle.status !== "OPEN" || !leaseUntil || leaseUntil <= new Date() || task.cycle.leaseUntil?.getTime() !== leaseUntil.getTime() || task.cycle.periodKey !== weekKey(new Date()) || task.cycle.policyVersion !== policy.version || task.cycle.brandVersion !== quote.brandVersion || quote.mode !== "initial" || task.quoteId !== quote.id || task.status !== "QUOTED") throw new AppError(409, "Recurring authorization is stale or paused.");
  const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member || !["OWNER", "ADMIN"].includes(member.role)) throw new AppError(403, "Recurring authorizer no longer has permission.");
  if (task.cycle.creditsAuthorized + quote.credits > policy.creditsPerWeek) throw new AppError(409, "Weekly credit ceiling reached.");
  await tx.weeklyCycle.update({ where: { id: task.cycleId }, data: { creditsAuthorized: { increment: quote.credits } } });
  await tx.weeklyTask.update({ where: { id: task.id }, data: { status: "AUTHORIZED" } });
}
export async function runOneWeeklyDraft(execute: typeof actOnProduction = actOnProduction) {
  const cycle = await db.weeklyCycle.findFirst({ where: { status: "OPEN", OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, orderBy: { createdAt: "asc" } });
  if (!cycle) return false;
  const leaseUntil = new Date(Date.now() + 120000);
  if (!(await db.weeklyCycle.updateMany({ where: { id: cycle.id, status: "OPEN", OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseUntil } })).count) return true;
  let taskId: string | undefined;
  try {
    const policy = await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: cycle.businessId } });
    if (!policy.enabled || policy.version !== cycle.policyVersion || cycle.periodKey !== weekKey(new Date())) throw new AppError(409, "Recurring policy changed or cycle expired.");
    const task = await db.weeklyTask.findFirst({ where: { cycleId: cycle.id, status: { in: ["PENDING", "QUOTED"] } }, orderBy: { id: "asc" } });
    if (!task) { await db.weeklyCycle.updateMany({ where: { id: cycle.id, status: "OPEN", leaseUntil: { equals: leaseUntil, gt: new Date() } }, data: { status: "COMPLETE" } }); return true; }
    taskId = task.id;
    const scope = { businessId: cycle.businessId, organizationId: cycle.organizationId, actorId: policy.actorId };
    let quoteId = task.quoteId;
    if (!quoteId) {
      const result = await execute(scope, { action: "quote", itemId: task.itemId, mode: "initial", direction: "Create one specific audience-relevant draft from this planned brief. Use confirmed brand facts only. No invented dates, offers, prices or results. Human approval is required." });
      if (!("quote" in result) || !result.quote) throw Error("Missing recurring quote");
      quoteId = result.quote.id;
      const generatedQuoteId = result.quote.id;
      const attached = await db.$transaction(async tx => {
        await lockBusiness(tx, scope);
        const fresh = await tx.weeklyCycle.findFirst({ where: { id: cycle.id, status: "OPEN", leaseUntil, policyVersion: policy.version } });
        if (!fresh || leaseUntil <= new Date()) {
          await tx.generationQuote.updateMany({ where: { id: generatedQuoteId, itemId: task.itemId, businessId: scope.businessId, organizationId: scope.organizationId, status: "OFFERED", job: null }, data: { status: "CANCELLED" } });
          return false;
        }
        return (await tx.weeklyTask.updateMany({ where: { id: task.id, cycleId: cycle.id, status: "PENDING", quoteId: null }, data: { quoteId: generatedQuoteId, status: "QUOTED" } })).count === 1;
      });
      if (!attached) return true;
    }
    await execute(scope, { action: "accept", quoteId }, { weeklyTaskId: task.id, weeklyLeaseUntil: leaseUntil });
  } catch (error) {
    // A failed authorization does not trigger a model call or unbounded retry. Resume next week only.
    await db.$transaction(async tx => {
      await lockBusiness(tx, { businessId: cycle.businessId, organizationId: cycle.organizationId, actorId: "weekly-worker" });
      if (!await tx.weeklyCycle.findFirst({ where: { id: cycle.id, status: "OPEN", leaseUntil: { equals: leaseUntil, gt: new Date() } } })) return;
      if (taskId) await tx.weeklyTask.updateMany({ where: { id: taskId, cycleId: cycle.id, status: { in: ["PENDING", "QUOTED"] } }, data: { status: "STOPPED", errorCode: "AUTHORIZATION_BLOCKED" } });
      await stopWeeklyImages(tx, { businessId: cycle.businessId, organizationId: cycle.organizationId, actorId: "weekly-worker" }, [cycle.id]);
      await stopWeeklyVideos(tx, { businessId: cycle.businessId, organizationId: cycle.organizationId, actorId: "weekly-worker" }, [cycle.id]);
      await tx.weeklyCycle.update({ where: { id: cycle.id }, data: { status: "BLOCKED", errorCode: error instanceof AppError ? `AUTHORIZATION_${error.status}` : "AUTHORIZATION_FAILED" } });
    });
  } finally { await db.weeklyCycle.updateMany({ where: { id: cycle.id, leaseUntil }, data: { leaseUntil: null } }); }
  return true;
}
