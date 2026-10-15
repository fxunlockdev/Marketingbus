import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { brandInput, proposePlan } from "../brand";
import { actOnProduction, lockBusiness, type Scope } from "../production/service";

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
const policySchema = z.object({ enabled: z.boolean(), mode: z.enum(["PLAN", "DRAFTS"]), maxItems: z.number().int().min(1).max(12), creditsPerWeek: z.number().int().min(0).max(8000), weekday: z.number().int().min(0).max(6), hourUTC: z.number().int().min(0).max(23), version: z.number().int().nonnegative() }).strict();
export async function readPlanning(scope: Scope) {
  return { policy: await db.weeklyPolicy.findFirst({ where: { businessId: scope.businessId, organizationId: scope.organizationId } }), cycles: await db.weeklyCycle.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId }, orderBy: { createdAt: "desc" }, take: 20, include: { tasks: true } }) };
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
    await tx.weeklyCycle.updateMany({ where: { businessId: scope.businessId, status: "OPEN" }, data: { status: "CANCELLED", errorCode: "POLICY_CHANGED", leaseUntil: null } });
    const data = { ...input, version: input.version + 1, actorId: scope.actorId, brandVersion: business.version, nextRunAt: nextWeekly(input.weekday, input.hourUTC, new Date()) };
    await tx.weeklyPolicy.upsert({ where: { businessId: scope.businessId }, create: { businessId: scope.businessId, organizationId: scope.organizationId, ...data }, update: data });
    await tx.auditEvent.create({ data: { ...scope, action: "WEEKLY_POLICY_UPDATED", detail: `${input.enabled ? input.mode : "PAUSED"}; at most ${input.maxItems} planned items and ${input.creditsPerWeek} credits per UTC week. Already-authorized jobs are not cancelled. Approval and social publication remain separate.` } });
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
    const plan = await tx.productionPlan.create({ data: { businessId: business.id, organizationId: scope.organizationId, brandVersion: business.version, title: `Week of ${periodKey} · review required`, creditCeiling: policy.creditsPerWeek, items: { create: Array.from({ length: policy.maxItems }, (_, i) => ({ ...templates[i % templates.length], title: `${templates[i % templates.length].title} · ${i + 1}` })) } }, include: { items: true } });
    await tx.weeklyCycle.create({ data: { businessId: business.id, organizationId: scope.organizationId, periodKey, policyVersion: policy.version, brandVersion: business.version, planId: plan.id, status: policy.mode === "PLAN" ? "COMPLETE" : "OPEN", tasks: { create: plan.items.map(item => ({ itemId: item.id, status: policy.mode === "PLAN" || item.format !== "static" ? "SKIPPED" : "PENDING", errorCode: item.format !== "static" ? "MEDIA_REQUIRES_DIRECTION" : null })) } } });
    await tx.auditEvent.create({ data: { ...scope, action: "WEEKLY_PLAN_CREATED", detail: `One idempotent planning cycle for UTC week ${periodKey}; no approval or publication implied.` } });
    return true;
  });
}

// Called inside the SAME acceptance transaction as the wallet reservation and job creation.
export async function reserveWeeklyAuthorization(tx: Prisma.TransactionClient, scope: Scope, taskId: string, quote: { id: string; itemId: string; credits: number; mode: string; brandVersion: number }) {
  const task = await tx.weeklyTask.findFirst({ where: { id: taskId, itemId: quote.itemId, cycle: { businessId: scope.businessId, organizationId: scope.organizationId } }, include: { cycle: true } });
  const policy = await tx.weeklyPolicy.findUnique({ where: { businessId: scope.businessId } });
  if (!task || !policy?.enabled || policy.mode !== "DRAFTS" || policy.actorId !== scope.actorId || task.cycle.status !== "OPEN" || task.cycle.periodKey !== weekKey(new Date()) || task.cycle.policyVersion !== policy.version || task.cycle.brandVersion !== quote.brandVersion || quote.mode !== "initial" || task.quoteId !== quote.id || task.status !== "QUOTED") throw new AppError(409, "Recurring authorization is stale or paused.");
  const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member || !["OWNER", "ADMIN"].includes(member.role)) throw new AppError(403, "Recurring authorizer no longer has permission.");
  if (task.cycle.creditsAuthorized + quote.credits > policy.creditsPerWeek) throw new AppError(409, "Weekly credit ceiling reached.");
  await tx.weeklyCycle.update({ where: { id: task.cycleId }, data: { creditsAuthorized: { increment: quote.credits } } });
  await tx.weeklyTask.update({ where: { id: task.id }, data: { status: "AUTHORIZED" } });
}
export async function runOneWeeklyDraft() {
  const cycle = await db.weeklyCycle.findFirst({ where: { status: "OPEN", OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, orderBy: { createdAt: "asc" } });
  if (!cycle) return false;
  const leaseUntil = new Date(Date.now() + 120000);
  if (!(await db.weeklyCycle.updateMany({ where: { id: cycle.id, status: "OPEN", OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseUntil } })).count) return true;
  let taskId: string | undefined;
  try {
    const policy = await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: cycle.businessId } });
    if (!policy.enabled || policy.version !== cycle.policyVersion || cycle.periodKey !== weekKey(new Date())) throw new AppError(409, "Recurring policy changed or cycle expired.");
    const task = await db.weeklyTask.findFirst({ where: { cycleId: cycle.id, status: { in: ["PENDING", "QUOTED"] } }, orderBy: { id: "asc" } });
    if (!task) { await db.weeklyCycle.updateMany({ where: { id: cycle.id, status: "OPEN" }, data: { status: "COMPLETE" } }); return true; }
    taskId = task.id;
    const scope = { businessId: cycle.businessId, organizationId: cycle.organizationId, actorId: policy.actorId };
    let quoteId = task.quoteId;
    if (!quoteId) {
      const result = await actOnProduction(scope, { action: "quote", itemId: task.itemId, mode: "initial", direction: "Create one specific audience-relevant draft from this planned brief. Use confirmed brand facts only. No invented dates, offers, prices or results. Human approval is required." });
      if (!("quote" in result) || !result.quote) throw Error("Missing recurring quote");
      quoteId = result.quote.id;
      await db.weeklyTask.update({ where: { id: task.id }, data: { quoteId, status: "QUOTED" } });
    }
    await actOnProduction(scope, { action: "accept", quoteId }, { weeklyTaskId: task.id });
  } catch (error) {
    // A failed authorization does not trigger a model call or unbounded retry. Resume next week only.
    if (taskId) await db.weeklyTask.updateMany({ where: { id: taskId, status: { not: "AUTHORIZED" } }, data: { status: "STOPPED", errorCode: "AUTHORIZATION_BLOCKED" } });
    await db.weeklyCycle.updateMany({ where: { id: cycle.id, status: "OPEN" }, data: { status: "BLOCKED", errorCode: error instanceof AppError ? `AUTHORIZATION_${error.status}` : "AUTHORIZATION_FAILED" } });
  } finally { await db.weeklyCycle.updateMany({ where: { id: cycle.id, leaseUntil }, data: { leaseUntil: null } }); }
  return true;
}
