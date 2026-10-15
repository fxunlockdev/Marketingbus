import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import type { Scope } from "./service";

export const planItemSelection = {
  id: true, title: true, channel: true, format: true, status: true,
  revisions: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true, content: true, status: true, feedback: true } },
  schedule: { select: { scheduledFor: true, timezone: true, revisionId: true } },
  quotes: { orderBy: { createdAt: "desc" }, take: 3, select: { id: true, credits: true, status: true, expiresAt: true, job: { select: { status: true, errorCode: true } } } },
} satisfies Prisma.ProductionItemSelect;
export const planSummarySelection = { id: true, title: true, status: true, brandVersion: true, createdAt: true } satisfies Prisma.ProductionPlanSelect;
export const historyQuery = z.object({ before: z.string().min(1).max(100).optional(), plan: z.string().min(1).max(100).optional() }).strict().refine(v => !(v.before && v.plan), "Choose a history page or one plan, not both.");

export async function readPlanHistory(scope: Scope, raw: unknown = {}) {
  const input = historyQuery.parse(raw);
  const business = await db.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  const member = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!business || !member) throw new AppError(404, "Business not found.");
  const scopeWhere = { businessId: scope.businessId, organizationId: scope.organizationId };
  if (input.plan) {
    const plan = await db.productionPlan.findFirst({ where: { ...scopeWhere, id: input.plan }, select: { ...planSummarySelection, items: { orderBy: { id: "asc" }, take: 100, select: planItemSelection } } });
    if (!plan) throw new AppError(404, "Plan not found.");
    // Old source versions stay inspectable, but cannot authorize new work.
    return { plan, canEdit: ["OWNER", "ADMIN", "EDITOR"].includes(member.role) && !!business.confirmedAt && plan.status === "PROPOSED" && plan.brandVersion === business.version };
  }
  const anchor = input.before ? await db.productionPlan.findFirst({ where: { ...scopeWhere, id: input.before }, select: { id: true, createdAt: true } }) : null;
  if (input.before && !anchor) throw new AppError(400, "History position is unavailable. Start from the latest plans.");
  const rows = await db.productionPlan.findMany({ where: { ...scopeWhere, ...(anchor ? { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 11, select: { ...planSummarySelection, _count: { select: { items: true } } },
  });
  const plans = rows.slice(0, 10);
  return { plans, nextCursor: rows.length > 10 ? plans.at(-1)!.id : null };
}
