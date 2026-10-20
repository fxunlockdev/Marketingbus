import type { BrandAnalysis, Prisma } from "@prisma/client";

/** Caller holds the business lock. Serialize a worker boundary, never its network call. */
export async function ownedAnalysisClaim(
  tx: Prisma.TransactionClient,
  claimed: BrandAnalysis,
  purpose: "BRAND" | "SKILL_REFLECTION",
  statuses: string[],
  requireLive: boolean,
) {
  if (claimed.purpose !== purpose) return null;
  await tx.$queryRaw`SELECT id FROM "BrandAnalysis" WHERE id=${claimed.id} FOR UPDATE`;
  const row = await tx.brandAnalysis.findFirst({ where: {
    id: claimed.id, organizationId: claimed.organizationId, businessId: claimed.businessId,
    purpose, actorId: claimed.actorId, brandVersion: claimed.brandVersion,
    reservationId: claimed.reservationId, configurationHash: claimed.configurationHash,
    credits: claimed.credits, supplierCeilingMicros: claimed.supplierCeilingMicros,
    acceptedAt: claimed.acceptedAt, leaseUntil: claimed.leaseUntil, status: { in: statuses },
  } });
  if (!row || !row.leaseUntil || !row.reservationId || !row.acceptedAt ||
    JSON.stringify(row.sources) !== JSON.stringify(claimed.sources) ||
    JSON.stringify(row.route) !== JSON.stringify(claimed.route) ||
    requireLive && row.leaseUntil.getTime() <= Date.now()) return null;
  return row;
}
