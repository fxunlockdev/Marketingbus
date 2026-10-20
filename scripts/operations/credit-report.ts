import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

// Operator-only inspection. No provider, grant, refund or repair imports.
const organization = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
type Snapshot = {
  asOf: Date; available: number; revisionAvailable: number; held: number; debt: number; revisionDebt: number;
  grants: bigint; consumed: bigint; reclaimed: bigint; reserved: bigint;
  unknownEntries: bigint; invalidReservations: bigint; orphanEntries: bigint;
  invalidPayments: bigint; invalidRefunds: bigint; orphanPaymentEntries: bigint;
};

export async function readCreditReport(client: PrismaClient, organizationId: string) {
  organization.parse(organizationId);
  const row = await client.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    const rows = await tx.$queryRaw<Snapshot[]>`
      WITH entries AS (
        SELECT "key", "kind", "amount" FROM "CreditEntry" WHERE "organizationId" = ${organizationId}
      ), reservations AS (
        SELECT * FROM "Reservation" WHERE "organizationId" = ${organizationId}
      ), payments AS (
        SELECT * FROM "BillingPayment" WHERE "organizationId" = ${organizationId}
      ), refund_keys AS (
        SELECT *, substring("key" FROM ':([0-9]{1,10})$')::bigint AS cumulative
        FROM entries WHERE "kind" = 'REFUND_RECLAIM'
      ), refund_bound AS (
        SELECT r.*, p."id" AS "paymentId", p."amountMinor", p."refundedMinor", p."generalCredits", p."revisionCredits"
        FROM refund_keys r LEFT JOIN payments p ON r."key" = 'refund:' || p."id" || ':' || r.cumulative::text
      ), refund_steps AS (
        SELECT *, LAG(cumulative, 1, 0::bigint) OVER (PARTITION BY "paymentId" ORDER BY cumulative) AS previous
        FROM refund_bound
      ), refund_totals AS (
        SELECT "paymentId", SUM("amount")::bigint AS reclaimed, MAX(cumulative) AS cumulative
        FROM refund_bound WHERE "paymentId" IS NOT NULL GROUP BY "paymentId"
      ), payment_check AS (
        SELECT COUNT(*) FILTER (WHERE
          allocation."key" IS NULL OR allocation."kind" <> 'PAYMENT_GRANT' OR allocation."amount"::bigint <> p."generalCredits"::bigint + p."revisionCredits"::bigint
          OR p."amountMinor" <= 0 OR p."refundedMinor" < 0 OR p."refundedMinor" > p."amountMinor"
          OR p."reclaimedGeneral" <> FLOOR(p."generalCredits"::numeric * p."refundedMinor" / NULLIF(p."amountMinor", 0))
          OR p."reclaimedRevision" <> FLOOR(p."revisionCredits"::numeric * p."refundedMinor" / NULLIF(p."amountMinor", 0))
          OR COALESCE(refunds.reclaimed, 0) <> p."reclaimedGeneral"::bigint + p."reclaimedRevision"::bigint
          OR COALESCE(refunds.cumulative, 0) <> p."refundedMinor"
        ) AS "invalidPayments"
        FROM payments p LEFT JOIN entries allocation ON allocation."key" = 'payment:' || p."id"
        LEFT JOIN refund_totals refunds ON refunds."paymentId" = p."id"
      ), refund_check AS (
        SELECT COUNT(*) FILTER (WHERE "paymentId" IS NOT NULL AND (
          cumulative <= 0 OR cumulative > "refundedMinor" OR cumulative > "amountMinor"
          OR "amount"::numeric <>
            FLOOR("generalCredits"::numeric * cumulative / NULLIF("amountMinor", 0)) + FLOOR("revisionCredits"::numeric * cumulative / NULLIF("amountMinor", 0))
            - FLOOR("generalCredits"::numeric * previous / NULLIF("amountMinor", 0)) - FLOOR("revisionCredits"::numeric * previous / NULLIF("amountMinor", 0))
        )) AS "invalidRefunds" FROM refund_steps
      ), payment_orphans AS (
        SELECT (SELECT COUNT(*) FROM entries e WHERE e."kind" = 'PAYMENT_GRANT' AND NOT EXISTS (
          SELECT 1 FROM payments p WHERE e."key" = 'payment:' || p."id"
        )) + (SELECT COUNT(*) FROM refund_bound WHERE "paymentId" IS NULL) AS "orphanPaymentEntries"
      ), ledger AS (
        SELECT COALESCE(SUM("amount") FILTER (WHERE "kind" IN ('PAYMENT_GRANT', 'TEST_GRANT')), 0)::bigint AS grants,
          COALESCE(SUM("amount") FILTER (WHERE "kind" = 'CONSUME'), 0)::bigint AS consumed,
          COALESCE(SUM("amount") FILTER (WHERE "kind" = 'REFUND_RECLAIM'), 0)::bigint AS reclaimed,
          COUNT(*) FILTER (WHERE "kind" NOT IN ('PAYMENT_GRANT', 'TEST_GRANT', 'CONSUME', 'REFUND_RECLAIM', 'RESERVE', 'RELEASE') OR "amount" < 0) AS "unknownEntries"
        FROM entries
      ), reservation_check AS (
        SELECT COALESCE(SUM(r."credits") FILTER (WHERE r."state" = 'HELD'), 0)::bigint AS reserved,
          COUNT(*) FILTER (WHERE
            r."credits" <= 0 OR r."revisionCredits" < 0 OR r."revisionCredits" > r."credits"
            OR r."purpose" NOT IN ('INITIAL', 'REVISION') OR (r."purpose" = 'INITIAL' AND r."revisionCredits" <> 0)
            OR reserve."key" IS NULL OR reserve."kind" <> 'RESERVE' OR reserve."amount" <> r."credits"
            OR r."state" NOT IN ('HELD', 'SETTLED', 'RELEASED')
            OR (r."state" = 'HELD' AND (settle."key" IS NOT NULL OR release."key" IS NOT NULL))
            OR (r."state" IN ('SETTLED', 'RELEASED') AND (
              settle."key" IS NULL OR settle."kind" <> 'CONSUME' OR settle."amount" < 0 OR settle."amount" > r."credits"
              OR (r."state" = 'SETTLED' AND settle."amount" = 0)
              OR (r."state" = 'RELEASED' AND settle."amount" <> 0)
              OR (settle."amount" = r."credits" AND release."key" IS NOT NULL)
              OR (settle."amount" < r."credits" AND (release."key" IS NULL OR release."kind" <> 'RELEASE' OR release."amount" <> r."credits" - settle."amount"))
            ))) AS "invalidReservations"
        FROM reservations r
        LEFT JOIN entries reserve ON reserve."key" = 'reserve:' || r."key"
        LEFT JOIN entries settle ON settle."key" = 'settle:' || r."key"
        LEFT JOIN entries release ON release."key" = 'release:' || r."key"
      ), orphan_check AS (
        SELECT COUNT(*) AS "orphanEntries" FROM entries e
        WHERE e."kind" IN ('RESERVE', 'CONSUME', 'RELEASE') AND NOT EXISTS (
          SELECT 1 FROM reservations r WHERE e."key" =
            CASE e."kind" WHEN 'RESERVE' THEN 'reserve:' WHEN 'CONSUME' THEN 'settle:' ELSE 'release:' END || r."key"
        )
      )
      SELECT CURRENT_TIMESTAMP AS "asOf", w."available", w."revisionAvailable", w."held", w."debt", w."revisionDebt",
        ledger.*, reservation_check.*, orphan_check.*, payment_check.*, refund_check.*, payment_orphans.*
      FROM "Wallet" w CROSS JOIN ledger CROSS JOIN reservation_check CROSS JOIN orphan_check
        CROSS JOIN payment_check CROSS JOIN refund_check CROSS JOIN payment_orphans
      WHERE w."organizationId" = ${organizationId}`;
    if (!rows[0]) throw Error("Workspace wallet not found.");
    return rows[0];
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 5000 });

  // BigInt arithmetic prevents large lifetime aggregates losing integer precision.
  // RESERVE/RELEASE transfer existing credits; neither is new income or consumption.
  const walletNet = BigInt(row.available) + BigInt(row.revisionAvailable) + BigInt(row.held) - BigInt(row.debt) - BigInt(row.revisionDebt);
  const ledgerNet = row.grants - row.consumed - row.reclaimed;
  const issues: { code: string; count?: string }[] = [];
  if (walletNet !== ledgerNet) issues.push({ code: "NET_BALANCE_MISMATCH" });
  if (BigInt(row.held) !== row.reserved) issues.push({ code: "HELD_BALANCE_MISMATCH" });
  if (row.unknownEntries) issues.push({ code: "UNSUPPORTED_LEDGER_ENTRIES", count: row.unknownEntries.toString() });
  if (row.invalidReservations) issues.push({ code: "RESERVATION_LEDGER_MISMATCH", count: row.invalidReservations.toString() });
  if (row.orphanEntries) issues.push({ code: "ORPHAN_RESERVATION_ENTRIES", count: row.orphanEntries.toString() });
  if (row.invalidPayments) issues.push({ code: "PAYMENT_LEDGER_MISMATCH", count: row.invalidPayments.toString() });
  if (row.invalidRefunds) issues.push({ code: "REFUND_JOURNAL_MISMATCH", count: row.invalidRefunds.toString() });
  if (row.orphanPaymentEntries) issues.push({ code: "ORPHAN_PAYMENT_ENTRIES", count: row.orphanPaymentEntries.toString() });
  return {
    version: 1, organizationId, asOf: row.asOf.toISOString(), readOnly: true, needsAttention: issues.length > 0,
    wallet: { available: row.available, revisionAvailable: row.revisionAvailable, held: row.held, debt: row.debt, revisionDebt: row.revisionDebt },
    accounting: { walletNetCredits: walletNet.toString(), ledgerNetCredits: ledgerNet.toString(), activeReservedCredits: row.reserved.toString(), grants: row.grants.toString(), consumed: row.consumed.toString(), reclaimed: row.reclaimed.toString() },
    issues,
    guidance: "Inspect the original ledger and module evidence before any separately authorized repair. Do not release holds, grant credits, retry jobs or issue refunds from this report. Balanced credits do not verify payments, supplier expense or cash settlement.",
  };
}
