import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { selfHostedScraperBase } from "./service";
import { readWebsite, scraperHeaders } from "./scraper-client";
import { SourceImportError } from "./import-errors";
const payloadSchema = z.object({ sourceId: z.string(), url: z.url() }).strict();
export async function runOneSourceJob(transport: typeof fetch = fetch) {
  const base = selfHostedScraperBase();
  // Invalid operator credentials must not consume a customer's queued attempt.
  const headers = scraperHeaders();
  const job = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403219)::text`;
    const stale = await tx.job.findMany({ where: { kind: "WEBSITE_READ", status: "RUNNING", leaseUntil: { lt: new Date() } } });
    for (const row of stale) {
      await tx.job.update({ where: { id: row.id }, data: { status: "FAILED", errorCode: "IMPORT_INTERRUPTED", leaseUntil: null } });
      const parsed = payloadSchema.safeParse(row.payload);
      if (parsed.success) await tx.knowledgeSource.updateMany({ where: { id: parsed.data.sourceId, businessId: row.businessId, organizationId: row.organizationId }, data: { status: "FAILED" } });
    }
    if (await tx.job.count({ where: { kind: "WEBSITE_READ", status: "RUNNING" } })) return null;
    const next = await tx.job.findFirst({ where: { kind: "WEBSITE_READ", status: "QUEUED" }, orderBy: { createdAt: "asc" } });
    if (!next) return null;
    return tx.job.update({ where: { id: next.id }, data: { status: "RUNNING", attempts: { increment: 1 }, leaseUntil: new Date(Date.now() + 120000) } });
  });
  if (!job) return false;
  try {
    const payload = payloadSchema.parse(job.payload);
    const source = await db.knowledgeSource.findFirstOrThrow({ where: { id: payload.sourceId, businessId: job.businessId, organizationId: job.organizationId, status: "QUEUED" } });
    await db.knowledgeSource.update({ where: { id: source.id }, data: { status: "FETCHING" } });
    const data = await readWebsite(base, payload.url, headers, transport);
    await db.$transaction(async tx => {
      const owned = await tx.job.updateMany({ where: { id: job.id, status: "RUNNING", leaseUntil: job.leaseUntil }, data: { status: "COMPLETED", leaseUntil: null, result: { sourceId: source.id, bytes: Buffer.byteLength(data.markdown), aiCalls: 0 } } });
      if (!owned.count) return;
      await tx.knowledgeSource.update({ where: { id: source.id }, data: { status: "PROPOSED", body: data.markdown, title: (data.metadata.title || source.title).slice(0, 120), sha256: createHash("sha256").update(data.markdown).digest("hex"), retrievedAt: new Date() } });
    });
  } catch (error) {
    await db.$transaction(async tx => {
      const owned = await tx.job.updateMany({ where: { id: job.id, status: "RUNNING", leaseUntil: job.leaseUntil }, data: { status: "FAILED", errorCode: error instanceof SourceImportError ? error.code : "SOURCE_IMPORT_FAILED", leaseUntil: null } });
      if (!owned.count) return;
      const payload = payloadSchema.safeParse(job.payload);
      if (payload.success) await tx.knowledgeSource.updateMany({ where: { id: payload.data.sourceId, businessId: job.businessId, organizationId: job.organizationId }, data: { status: "FAILED" } });
    });
  }
  return true;
}
