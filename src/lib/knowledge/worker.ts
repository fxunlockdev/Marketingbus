import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { selfHostedScraperBase } from "./service";
import { readWebsite, scraperHeaders } from "./scraper-client";
import { SourceImportError } from "./import-errors";
import type { Job, Prisma } from "@prisma/client";
const payloadSchema = z.object({ sourceId: z.string(), url: z.url() }).strict();
async function sourceContext(tx: Prisma.TransactionClient, job: Job, status: "QUEUED" | "FETCHING", requestedBy?: string) {
  const payload = payloadSchema.parse(job.payload);
  if (job.key !== `source:${payload.sourceId}`) throw new SourceImportError("SOURCE_CONTEXT_CHANGED");
  // Lock the retained request and authorizer through each short boundary transaction.
  // Never hold either lock across a network request.
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id=${job.id} FOR UPDATE`;
  const current = await tx.job.findFirst({ where: { id: job.id, kind: "WEBSITE_READ",
    businessId: job.businessId, organizationId: job.organizationId, key: job.key, status: "RUNNING",
    leaseUntil: job.leaseUntil, payload: { equals: job.payload as Prisma.InputJsonValue } } });
  if (!current || !current.leaseUntil || current.leaseUntil <= new Date()) throw new SourceImportError("IMPORT_INTERRUPTED");
  await tx.$queryRaw`SELECT id FROM "KnowledgeSource" WHERE id=${payload.sourceId}
    AND "businessId"=${job.businessId} AND "organizationId"=${job.organizationId} FOR UPDATE`;
  const source = await tx.knowledgeSource.findFirst({ where: { id: payload.sourceId,
    businessId: job.businessId, organizationId: job.organizationId, kind: "WEBSITE", status, sourceUrl: payload.url } });
  if (!source || requestedBy !== undefined && source.createdBy !== requestedBy) throw new SourceImportError("SOURCE_CONTEXT_CHANGED");
  const members = await tx.$queryRaw<{ role: string }[]>`SELECT role FROM "Membership"
    WHERE "organizationId"=${job.organizationId} AND "userId"=${source.createdBy} FOR SHARE`;
  if (!members.some(member => ["OWNER", "ADMIN", "EDITOR"].includes(member.role))) throw new SourceImportError("SOURCE_AUTHORITY_CHANGED");
  return source;
}
async function failSource(tx: Prisma.TransactionClient, job: Job) {
  // Use the durable submission key, not an untrusted/changed payload reference.
  const sourceId = job.key.startsWith("source:") ? job.key.slice("source:".length) : "";
  if (sourceId)
    await tx.knowledgeSource.updateMany({ where: { id: sourceId, businessId: job.businessId,
      organizationId: job.organizationId, kind: "WEBSITE", status: { in: ["QUEUED", "FETCHING"] } }, data: { status: "FAILED" } });
}
export async function runOneSourceJob(transport: typeof fetch = fetch) {
  const base = selfHostedScraperBase();
  // Invalid operator credentials must not consume a customer's queued attempt.
  const headers = scraperHeaders();
  const job = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403219)::text`;
    const stale = await tx.job.findMany({ where: { kind: "WEBSITE_READ", status: "RUNNING", leaseUntil: { lt: new Date() } } });
    for (const row of stale) {
      await tx.job.update({ where: { id: row.id }, data: { status: "FAILED", errorCode: "IMPORT_INTERRUPTED", leaseUntil: null } });
      await failSource(tx, row);
    }
    if (await tx.job.count({ where: { kind: "WEBSITE_READ", status: "RUNNING" } })) return null;
    const next = await tx.job.findFirst({ where: { kind: "WEBSITE_READ", status: "QUEUED" }, orderBy: { createdAt: "asc" } });
    if (!next) return null;
    return tx.job.update({ where: { id: next.id }, data: { status: "RUNNING", attempts: { increment: 1 }, leaseUntil: new Date(Date.now() + 120000) } });
  });
  if (!job) return false;
  try {
    const payload = payloadSchema.parse(job.payload);
    const source = await db.$transaction(async tx => {
      const source = await sourceContext(tx, job, "QUEUED");
      const owned = await tx.job.updateMany({ where: { id: job.id, status: "RUNNING", leaseUntil: job.leaseUntil,
        AND: { leaseUntil: { gt: new Date() } } }, data: { status: "RUNNING" } });
      if (!owned.count) throw new SourceImportError("IMPORT_INTERRUPTED");
      return tx.knowledgeSource.update({ where: { id: source.id }, data: { status: "FETCHING" } });
    });
    const data = await readWebsite(base, payload.url, headers, transport);
    await db.$transaction(async tx => {
      await sourceContext(tx, job, "FETCHING", source.createdBy);
      const owned = await tx.job.updateMany({ where: { id: job.id, status: "RUNNING", leaseUntil: job.leaseUntil,
        AND: { leaseUntil: { gt: new Date() } } }, data: { status: "COMPLETED", leaseUntil: null, result: { sourceId: source.id, bytes: Buffer.byteLength(data.markdown), aiCalls: 0 } } });
      if (!owned.count) return;
      await tx.knowledgeSource.update({ where: { id: source.id }, data: { status: "PROPOSED", body: data.markdown, title: (data.metadata.title || source.title).slice(0, 120), sha256: createHash("sha256").update(data.markdown).digest("hex"), retrievedAt: new Date() } });
    });
  } catch (error) {
    await db.$transaction(async tx => {
      const owned = await tx.job.updateMany({ where: { id: job.id, status: "RUNNING", leaseUntil: job.leaseUntil }, data: { status: "FAILED", errorCode: error instanceof SourceImportError ? error.code : "SOURCE_IMPORT_FAILED", leaseUntil: null } });
      if (!owned.count) return;
      await failSource(tx, job);
    });
  }
  return true;
}
