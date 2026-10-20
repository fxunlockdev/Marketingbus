import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { supplierExposure } from "../../src/lib/production/budget";

// The retained supplier ledger is deliberately global, including deleted tenants.
// No customer endpoint, fallback tenant attribution, invoice or repair authority.
const scopeSchema = z.object({ all: z.literal(true) }).strict();
function limit(value: string | undefined) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000_000 ? BigInt(amount) : null;
}
export async function readSupplierReport(client: PrismaClient, scope: { all: true }) {
  scopeSchema.parse(scope);
  const daily = limit(process.env.DAILY_SUPPLIER_BUDGET_MICROS), total = limit(process.env.TOTAL_SUPPLIER_BUDGET_MICROS);
  const executionEnabled = process.env.PAID_EXECUTION_ENABLED === "true";
  const { asOf, day, exposure } = await client.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS now`;
    const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
    return { asOf: now, day, exposure: await supplierExposure(tx, day) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 5000 });
  const issues: string[] = [];
  if (daily === null) issues.push("DAILY_LIMIT_UNCONFIGURED");
  else if (exposure.dailyMicros >= daily) issues.push("DAILY_ALLOWANCE_EXHAUSTED");
  if (total === null) issues.push("TOTAL_LIMIT_UNCONFIGURED");
  else if (exposure.lifetimeMicros >= total) issues.push("TOTAL_ALLOWANCE_EXHAUSTED");
  const remaining = (ceiling: bigint | null, used: bigint) => ceiling === null ? null : (ceiling > used ? ceiling - used : 0n).toString();
  return {
    version: 1, scope: "all", readOnly: true, asOf: asOf.toISOString(), utcDay: day.toISOString(),
    executionEnabled, needsAttention: issues.length > 0, issues,
    configuredLimitsMicros: { daily: daily?.toString() ?? null, total: total?.toString() ?? null },
    authorizationExposure: Object.fromEntries(Object.entries(exposure).map(([key, value]) => [key, value.toString()])),
    remainingAuthorizationMicros: { daily: remaining(daily, exposure.dailyMicros), total: remaining(total, exposure.lifetimeMicros) },
    guidance: "Authorization ceilings are not actual supplier bills, cash balance, customer credits or permission to spend. Older unresolved and provisional work can consume today's allowance; released work still consumes lifetime authorization. Investigate original jobs and independent invoices before separately authorized reconciliation. Do not reset this ledger, raise limits, retry jobs or release customer holds from this report.",
  };
}
