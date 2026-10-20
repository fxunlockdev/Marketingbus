import type { Prisma } from "@prisma/client";
import { AppError } from "../http";
import { assertExecutionEnabled, totalSupplierBudget } from "./router";

// Called inside the same transaction as customer reservation and enqueueing.
// One global lock covers every paid workflow, including cross-tenant contention.
export async function authorizeSupplier(tx: Prisma.TransactionClient, key: string, ceiling: number) {
  const budget = assertExecutionEnabled();
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) throw Error("Invalid supplier ceiling");
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403218)::text`;
  const day = new Date(); day.setUTCHours(0, 0, 0, 0);
  const exposure = await supplierExposure(tx, day);
  if (exposure.lifetimeMicros + BigInt(ceiling) > BigInt(totalSupplierBudget())) throw new AppError(409, "The approved total supplier-spend budget is exhausted. An operator must authorize any increase.");
  if (exposure.dailyMicros + BigInt(ceiling) > BigInt(budget)) throw new AppError(409, "Production has reached its safe supplier-spend limit. Try later.");
  await tx.supplierAuthorization.create({ data: { key, ceilingMicros: ceiling } });
}

// Shared by admission and the privileged read-only report. These are retained
// authorization ceilings, not measured expense or available customer credits.
export async function supplierExposure(tx: Prisma.TransactionClient, day: Date) {
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(11) !== "00:00:00.000Z") throw Error("Expected a UTC day boundary");
  // Sum the union, not the maximum of overlapping totals: an older unresolved
  // call plus a deleted customer's authorization today must both count, once.
  const rows = await tx.$queryRaw<{
    lifetimeMicros: bigint; dailyMicros: bigint; todayMicros: bigint; carriedMicros: bigint;
    authorizationCount: bigint; carriedCount: bigint;
  }[]>`
    WITH exposure AS MATERIALIZED (
    SELECT s."ceilingMicros", s."createdAt", (s."createdAt" >= ${day}
    OR EXISTS (SELECT 1 FROM "GenerationQuote" q LEFT JOIN "Job" j ON j."quoteId" = q.id
      WHERE q.id = s.key AND (q.status IN ('ACCEPTED', 'RECONCILE')
        OR (q.status = 'COMPLETED' AND (q."acceptedAt" >= ${day} OR j."submittedAt" >= ${day}))))
    OR EXISTS (SELECT 1 FROM "BrandAnalysis" a WHERE a.id = s.key
      AND (a.status IN ('QUEUED', 'RUNNING', 'SUBMITTING', 'NEEDS_RECONCILIATION')
        OR a."acceptedAt" >= ${day} OR a."submittedAt" >= ${day}))
    OR EXISTS (SELECT 1 FROM "ImageGeneration" i WHERE i.id = s.key
      AND (i.status IN ('QUEUED', 'RUNNING', 'SUBMITTING', 'NEEDS_RECONCILIATION')
        OR i."acceptedAt" >= ${day} OR i."submittedAt" >= ${day}))
    OR EXISTS (SELECT 1 FROM "VideoGeneration" v WHERE v.id = s.key
      AND (v.status IN ('QUEUED', 'RUNNING', 'SUBMITTING', 'POLLING', 'INGESTING', 'NEEDS_RECONCILIATION')
        OR (v."expenseBasis" = 'ACCOUNT_QUOTE_V1' AND v."supplierCostMicros" IS NULL)
        OR v."acceptedAt" >= ${day} OR v."submittedAt" >= ${day} OR v."settledAt" >= ${day}
        OR v."supplierReconciledAt" >= ${day}))) AS daily
    FROM "SupplierAuthorization" s)
    SELECT COALESCE(SUM("ceilingMicros"), 0)::bigint AS "lifetimeMicros",
      COALESCE(SUM("ceilingMicros") FILTER (WHERE daily), 0)::bigint AS "dailyMicros",
      COALESCE(SUM("ceilingMicros") FILTER (WHERE "createdAt" >= ${day}), 0)::bigint AS "todayMicros",
      COALESCE(SUM("ceilingMicros") FILTER (WHERE daily AND "createdAt" < ${day}), 0)::bigint AS "carriedMicros",
      COUNT(*) AS "authorizationCount",
      COUNT(*) FILTER (WHERE daily AND "createdAt" < ${day}) AS "carriedCount"
    FROM exposure`;
  return rows[0];
}
