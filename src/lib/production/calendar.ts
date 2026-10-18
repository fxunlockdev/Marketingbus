import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { assertWorkspaceMfa } from "../identity/workspace-security";
import type { Scope } from "./service";

export const calendarExpectation = z.object({ id: z.string().min(1).max(100), version: z.number().int().positive() }).strict();
export const calendarQuery = z.object({
  start: z.iso.datetime(), end: z.iso.datetime(), after: z.string().min(1).max(100).optional(),
}).strict().refine(v => {
  const start = Date.parse(v.start), end = Date.parse(v.end);
  return start >= Date.UTC(2000, 0, 1) && end <= Date.UTC(2100, 0, 1) && end > start && end - start <= 42 * 86400000;
}, "Choose a calendar range of at most 42 days between 2000 and 2100.");
export const calendarPageSize = 100;
export const calendarPublicationStates = ["SCHEDULED", "SUBMITTING", "NEEDS_RECONCILIATION", "PUBLISHED"];

export async function authorizeCalendar(tx: Prisma.TransactionClient, scope: Scope, write = false) {
  const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member) throw new AppError(404, "Business not found.");
  await assertWorkspaceMfa(tx, scope.organizationId, scope.actorId);
  const canEdit = ["OWNER", "ADMIN", "EDITOR"].includes(member.role);
  if (write && !canEdit) throw new AppError(403, "Editing access is required to change the calendar.");
  return canEdit;
}

export async function checkCalendarChange(tx: Prisma.TransactionClient, scope: Scope, itemId: string, expected?: z.infer<typeof calendarExpectation>) {
  await authorizeCalendar(tx, scope, true);
  const existing = await tx.calendarEntry.findFirst({ where: { itemId, organizationId: scope.organizationId, item: { plan: { businessId: scope.businessId } } } });
  if (existing ? !expected || expected.id !== existing.id || expected.version !== existing.version : !!expected)
    throw new AppError(409, "The calendar reservation changed. Refresh before changing it again.");
  if (await tx.socialPublication.count({ where: { businessId: scope.businessId, organizationId: scope.organizationId, revision: { itemId }, status: { in: calendarPublicationStates } } }))
    throw new AppError(409, "This creative has a queued, published or unresolved social post. Manage it in Publishing & analytics; the internal calendar cannot change that post.");
  return existing;
}

export async function readCalendar(scope: Scope, raw: unknown) {
  const input = calendarQuery.parse(raw);
  return db.$transaction(async tx => {
    const canEdit = await authorizeCalendar(tx, scope);
    const business = await tx.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
    if (!business) throw new AppError(404, "Business not found.");
    const where = { organizationId: scope.organizationId, item: { plan: { businessId: scope.businessId } }, scheduledFor: { gte: new Date(input.start), lt: new Date(input.end) } };
    const anchor = input.after ? await tx.calendarEntry.findFirst({ where: { ...where, id: input.after }, select: { id: true, scheduledFor: true } }) : null;
    if (input.after && !anchor) throw new AppError(409, "Calendar page changed. Refresh the date range.");
    const rows = await tx.calendarEntry.findMany({
      where: { ...where, ...(anchor ? { OR: [{ scheduledFor: { gt: anchor.scheduledFor } }, { scheduledFor: anchor.scheduledFor, id: { gt: anchor.id } }] } : {}) },
      orderBy: [{ scheduledFor: "asc" }, { id: "asc" }], take: calendarPageSize + 1,
      select: { id: true, version: true, scheduledFor: true, timezone: true, status: true, revisionId: true,
        item: { select: { id: true, title: true, channel: true, format: true,
          plan: { select: { id: true, title: true, status: true, brandVersion: true } },
          revisions: { orderBy: { version: "desc" }, take: 1, select: { id: true, version: true, status: true, _count: { select: { comments: { where: { blocking: true, resolvedAt: null } } } } } },
        } },
      },
    });
    const page = rows.slice(0, calendarPageSize);
    const publications = await tx.socialPublication.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, revision: { itemId: { in: page.map(row => row.item.id) } }, status: { in: calendarPublicationStates } }, select: { revision: { select: { itemId: true } } }, distinct: ["revisionId"] });
    const publishedItems = new Set(publications.map(p => p.revision.itemId));
    return {
      entries: page.map(row => {
        const revision = row.item.revisions[0];
        const current = !!business.confirmedAt && row.item.plan.status === "PROPOSED" && row.item.plan.brandVersion === business.version && revision?.id === row.revisionId && revision.status === "APPROVED" && !revision._count.comments && row.status === "PLANNED";
        const publicationLinked = publishedItems.has(row.item.id);
        return { id: row.id, version: row.version, scheduledFor: row.scheduledFor, timezone: row.timezone, itemId: row.item.id, title: row.item.title,
          channel: row.item.channel, format: row.item.format, planId: row.item.plan.id, planTitle: row.item.plan.title,
          revisionVersion: revision?.id === row.revisionId ? revision.version : null,
          revisionApproved: current,
          canMove: canEdit && current && !publicationLinked, canRemove: canEdit && !publicationLinked,
          reason: publicationLinked ? "Manage this creative's social post in Publishing & analytics." : !canEdit ? "Read-only access." : !current ? "Brand, plan or approval changed. Review before rescheduling." : null,
        };
      }),
      nextCursor: rows.length > calendarPageSize ? page.at(-1)!.id : null,
      start: input.start, end: input.end,
    };
  }, { isolationLevel: "RepeatableRead" });
}
