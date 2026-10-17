import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

// Operator CLI only: not a customer data-access API. Never import worker/provider modules here.
const definitions = [
  { name: "jobs", table: "Job", scope: "business", lease: true, due: "availableAt", waiting: ["QUEUED"], active: ["RUNNING", "SUBMITTING"] },
  { name: "brand", table: "BrandAnalysis", scope: "business", lease: true, due: "acceptedAt", waiting: ["QUEUED"], active: ["RUNNING", "SUBMITTING"] },
  { name: "images", table: "ImageGeneration", scope: "business", lease: true, due: "acceptedAt", waiting: ["QUEUED"], active: ["RUNNING", "SUBMITTING"] },
  { name: "video", table: "VideoGeneration", scope: "business", lease: true, due: "nextPollAt", waiting: ["QUEUED", "POLLING"], active: ["RUNNING", "SUBMITTING", "INGESTING", "POLLING"] },
  { name: "clips", table: "VideoClip", scope: "business", lease: true, waiting: ["QUEUED"], active: ["UPLOADING", "RUNNING", "STORING", "DELETING"] },
  { name: "motion", table: "MotionRender", scope: "business", lease: true, waiting: ["QUEUED"], active: ["RUNNING", "STORING", "DELETING"] },
  { name: "exports", table: "CompositionExport", scope: "business", lease: true, waiting: [], active: ["STORING", "DELETING"] },
  { name: "social", table: "SocialPublication", scope: "business", lease: true, due: "scheduledFor", waiting: ["SCHEDULED"], active: ["SUBMITTING"] },
  { name: "weekly", table: "WeeklyCycle", scope: "business", lease: true, waiting: ["OPEN"], active: ["RUNNING"] },
  { name: "checkout", table: "BillingCheckout", scope: "organization", waiting: [], active: [] },
  { name: "refunds", table: "BillingRefundOperation", scope: "organization", due: "updatedAt", waiting: ["PENDING"], active: ["SUBMITTING"] },
  // These records have no authoritative tenant column. Never infer ownership from payloads or user memberships.
  { name: "payments", table: "BillingEvent", scope: "global", due: "availableAt", waiting: ["PENDING", "WAITING"], active: [] },
  { name: "email", table: "EmailOutbox", scope: "global", lease: true, due: "availableAt", waiting: ["QUEUED"], active: ["SENDING"] },
] as const;
type Definition = { name: string; table: string; scope: string; lease?: boolean; due?: string; waiting: readonly string[]; active: readonly string[] };
const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("organization"), organizationId: identifier, businessId: identifier.optional() }).strict(),
]);
const optionsSchema = z.object({ scope: scopeSchema, limit: z.number().int().min(1).max(100).default(50), overdueMinutes: z.number().int().min(1).max(10080).default(15), cursor: z.string().max(4096).optional() }).strict();
export type QueueReportOptions = z.input<typeof optionsSchema>;
const cursorSchema = z.object({ version: z.literal(1), scope: scopeSchema, overdueMinutes: z.number().int(), asOf: z.iso.datetime(), createdAt: z.iso.datetime(), queue: z.string().max(30), id: identifier }).strict();
const attentionStatuses = ["NEEDS_RECONCILIATION", "NEEDS_REVIEW", "REQUIRES_ACTION", "UNKNOWN", "RECONCILE"];
const failureStatuses = ["FAILED", "DELETE_FAILED", "PURGE_FAILED", "BLOCKED"];
const knownStatuses = new Set([...attentionStatuses, ...failureStatuses, ...definitions.flatMap(d => [...d.waiting, ...d.active])]);
const guidance = {
  UNCERTAIN_OUTCOME: "Verify provider/storage evidence using the module recovery procedure. Do not resubmit, publish, refund or release holds from this report.",
  FAILED: "Inspect the module's failure evidence and current permissions. A failed record is not authorization to retry or refund.",
  EXPIRED_LEASE: "Check worker health and the module lease-recovery procedure. A lost lease does not prove a supplier operation failed.",
  OVERDUE: "Check feature activation, worker readiness and configured backoff. Overdue work may be intentionally disabled; do not bypass its gates.",
} as const;
type Reason = keyof typeof guidance;
type Row = { queue: string; id: string; organizationId: string | null; businessId: string | null; status: string; createdAt: Date; leaseUntil: Date | null; reason: Reason };
// Only static definitions reach Prisma.raw. Every operator input is a bound SQL value.
const column = (name: string) => Prisma.raw(`"${name}"`);
function inValues(expression: Prisma.Sql, values: readonly string[]) { return values.length ? Prisma.sql`${expression} IN (${Prisma.join([...values])})` : Prisma.sql`FALSE`; }

export async function readQueueReport(client: PrismaClient, raw: QueueReportOptions, now = new Date()) {
  const options = optionsSchema.parse(raw);
  if (!Number.isFinite(now.getTime())) throw Error("Invalid report time.");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (options.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"))); }
    catch { throw Error("Invalid queue report cursor."); }
    if (JSON.stringify(cursor.scope) !== JSON.stringify(options.scope) || cursor.overdueMinutes !== options.overdueMinutes
      || !definitions.some(d => d.name === cursor!.queue) || new Date(cursor.asOf) > now || new Date(cursor.createdAt) > new Date(cursor.asOf))
      throw Error("Cursor does not match the report scope or time.");
  }
  const asOf = cursor ? new Date(cursor.asOf) : now;
  const overdue = new Date(asOf.getTime() - options.overdueMinutes * 60000);
  const eligible = definitions.filter(d => options.scope.kind === "all" || (d.scope !== "global" && (!options.scope.businessId || d.scope === "business")));
  const parts = eligible.map((d: Definition) => {
    const status = column("status"), lease = d.lease ? column("leaseUntil") : Prisma.sql`NULL::timestamp`;
    const org = d.scope === "global" ? Prisma.sql`NULL::text` : column("organizationId");
    const business = d.scope === "business" ? column("businessId") : Prisma.sql`NULL::text`;
    const due = d.name === "video" ? Prisma.sql`COALESCE("nextPollAt", "acceptedAt", "createdAt")`
      : d.due ? Prisma.sql`COALESCE(${column(d.due)}, "createdAt")` : column("createdAt");
    const scope = options.scope.kind === "all" ? Prisma.sql`TRUE` : Prisma.sql`${org} = ${options.scope.organizationId} ${options.scope.businessId ? Prisma.sql`AND ${business} = ${options.scope.businessId}` : Prisma.empty}`;
    return Prisma.sql`SELECT ${d.name}::text AS queue, "id", ${org} AS "organizationId", ${business} AS "businessId", "status", "createdAt", ${lease} AS "leaseUntil",
      CASE WHEN ${inValues(status, attentionStatuses)} THEN 'UNCERTAIN_OUTCOME'
        WHEN ${inValues(status, failureStatuses)} THEN 'FAILED'
        WHEN ${inValues(status, d.active)} AND ${lease} <= ${asOf} THEN 'EXPIRED_LEASE'
        WHEN (${inValues(status, d.waiting)} OR (${inValues(status, d.active)} AND ${lease} IS NULL))
          AND ${due} <= ${overdue} AND (${lease} IS NULL OR ${lease} <= ${asOf}) THEN 'OVERDUE'
        ELSE NULL END AS reason
      FROM ${column(d.table)} WHERE ${scope} AND "createdAt" <= ${asOf}`;
  });
  const rows = await client.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    if (options.scope.kind === "organization") {
      const found = await tx.$queryRaw<{ present: boolean }[]>(options.scope.businessId
        ? Prisma.sql`SELECT EXISTS(SELECT 1 FROM "Business" WHERE "id" = ${options.scope.businessId} AND "organizationId" = ${options.scope.organizationId}) AS present`
        : Prisma.sql`SELECT EXISTS(SELECT 1 FROM "Organization" WHERE "id" = ${options.scope.organizationId}) AS present`);
      if (!found[0]?.present) throw Error("Report scope not found.");
    }
    return tx.$queryRaw<Row[]>(Prisma.sql`WITH candidates AS (${Prisma.join(parts, " UNION ALL ")})
      SELECT * FROM candidates WHERE reason IS NOT NULL
      ${cursor ? Prisma.sql`AND ("createdAt", queue, id) > (${new Date(cursor.createdAt)}, ${cursor.queue}, ${cursor.id})` : Prisma.empty}
      ORDER BY "createdAt" ASC, queue ASC, id ASC LIMIT ${options.limit + 1}`);
  }, { timeout: 5000 });
  const page = rows.slice(0, options.limit), last = page.at(-1);
  return {
    version: 1, asOf: asOf.toISOString(), scope: options.scope, overdueMinutes: options.overdueMinutes,
    readOnly: true, hasMore: rows.length > options.limit,
    excludedQueues: definitions.filter(d => !eligible.includes(d)).map(d => d.name),
    nextCursor: rows.length > options.limit && last ? Buffer.from(JSON.stringify({ version: 1, scope: options.scope, overdueMinutes: options.overdueMinutes, asOf: asOf.toISOString(), createdAt: last.createdAt.toISOString(), queue: last.queue, id: last.id })).toString("base64url") : null,
    items: page.map(row => ({ queue: row.queue, id: row.id, organizationId: row.organizationId, businessId: row.businessId,
      status: knownStatuses.has(row.status) ? row.status : "REDACTED", reason: row.reason,
      createdAt: row.createdAt.toISOString(), ageSinceCreationMinutes: Math.max(0, Math.floor((asOf.getTime() - row.createdAt.getTime()) / 60000)),
      leaseActiveAtReportTime: !!row.leaseUntil && row.leaseUntil > asOf, guidance: guidance[row.reason] })),
  };
}
