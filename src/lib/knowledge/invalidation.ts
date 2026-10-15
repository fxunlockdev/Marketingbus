import { Prisma } from "@prisma/client";
import { finishReservationInTransaction } from "../billing/wallet";
import type { Scope } from "../production/service";

// Caller holds the business lock. Submitted calls cannot safely be cancelled/retried.
export async function invalidateBrandAnalyses(tx: Prisma.TransactionClient, scope: Scope, sourceId?: string) {
  const rows = await tx.brandAnalysis.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId,
    ...(sourceId ? { sources: { array_contains: [{ id: sourceId }] } } : { status: { in: ["OFFERED", "QUEUED", "RUNNING", "READY"] } }),
  } });
  for (const row of rows) {
    if (sourceId && !(row.sources as { id: string }[]).some(s => s.id === sourceId)) continue;
    const active = ["SUBMITTING", "NEEDS_RECONCILIATION"].includes(row.status);
    if (["QUEUED", "RUNNING"].includes(row.status) && row.reservationId) await finishReservationInTransaction(tx, scope.organizationId, row.reservationId, 0);
    await tx.brandAnalysis.update({ where: { id: row.id }, data: {
      ...(!active && ["OFFERED", "QUEUED", "RUNNING", "READY"].includes(row.status) ? { status: "STALE", leaseUntil: null } : {}),
      // Deletion removes source-derived proposals even from historical review rows.
      ...(sourceId ? { suggestions: Prisma.DbNull, errorCode: "SOURCE_REMOVED" } : {}),
    } });
  }
}
