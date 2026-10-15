import type { Prisma } from "@prisma/client";
import type { BrandInput } from "../brand";
import type { Scope } from "../production/service";
import { finishReservationInTransaction } from "../billing/wallet";
import { invalidatePublications } from "../social/service";
import { invalidateBrandAnalyses } from "./invalidation";

// Both manual edits and applied suggestions use identical downstream invalidation.
// Caller must hold the business row lock and check the expected version.
export async function replaceBrandProfile(tx: Prisma.TransactionClient, scope: Scope, profile: BrandInput) {
  const id = scope.businessId;
  await invalidatePublications(tx, id);
  await invalidateBrandAnalyses(tx, scope);
  await tx.business.update({ where: { id }, data: { ...profile, version: { increment: 1 }, confirmedAt: null, productionEnabled: false } });
  await tx.productionPlan.updateMany({ where: { businessId: id, status: "PROPOSED" }, data: { status: "SUPERSEDED" } });
  await tx.calendarEntry.deleteMany({ where: { organizationId: scope.organizationId, item: { plan: { businessId: id } } } });
  await tx.productionItem.updateMany({ where: { organizationId: scope.organizationId, plan: { businessId: id } }, data: { scheduledFor: null } });
  await tx.generationQuote.updateMany({ where: { businessId: id, status: "OFFERED" }, data: { status: "SUPERSEDED" } });
  const queued = await tx.job.findMany({ where: { businessId: id, status: { in: ["QUEUED", "RUNNING"] }, kind: "STATIC_COPY" } });
  for (const job of queued) {
    if (job.reservationId) await finishReservationInTransaction(tx, scope.organizationId, job.reservationId, 0);
    await tx.job.update({ where: { id: job.id }, data: { status: "CANCELLED", leaseUntil: null, errorCode: "BRAND_CHANGED" } });
    if (job.quoteId) await tx.generationQuote.update({ where: { id: job.quoteId }, data: { status: "RELEASED" } });
  }
}
