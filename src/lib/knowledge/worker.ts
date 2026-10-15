import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { selfHostedScraperBase } from "./service";
import { validatePublicDns } from "../providers/url-policy";
const payloadSchema = z.object({ sourceId: z.string(), url: z.url() }).strict();
const resultSchema = z.object({ success: z.literal(true), data: z.object({ markdown: z.string().min(20).max(80000), metadata: z.object({ statusCode: z.number().int(), sourceURL: z.string().optional(), title: z.string().max(1000).optional() }) }) });
export async function runOneSourceJob(transport: typeof fetch = fetch) {
  const base = selfHostedScraperBase();
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
    const url = await validatePublicDns(payload.url);
    await db.knowledgeSource.update({ where: { id: source.id }, data: { status: "FETCHING" } });
    // No Firecrawl AI extraction/branding/agent features or proxy fallback. One explicit page, no crawl.
    const response = await transport(new URL("v2/scrape", base), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.href, formats: ["markdown"], onlyMainContent: true, timeout: 30000, maxAge: 604800000 }),
      signal: AbortSignal.timeout(45000), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw Error("Scrape failed"); }
    const reader = response.body?.getReader(); if (!reader) throw Error("Missing response");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 500000) { await reader.cancel(); throw Error("Response too large"); } chunks.push(part.value); }
    const result = resultSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (Buffer.byteLength(result.data.markdown) > 80000) throw Error("Extracted text exceeded its reserved storage allowance");
    if (result.data.metadata.statusCode < 200 || result.data.metadata.statusCode >= 300) throw Error("Target did not load");
    const finalUrl = result.data.metadata.sourceURL ? await validatePublicDns(result.data.metadata.sourceURL) : url;
    if (finalUrl.origin !== url.origin) throw Error("Cross-origin redirect needs explicit import");
    await db.$transaction(async tx => {
      const owned = await tx.job.updateMany({ where: { id: job.id, status: "RUNNING", leaseUntil: job.leaseUntil }, data: { status: "COMPLETED", leaseUntil: null, result: { sourceId: source.id, bytes: Buffer.byteLength(result.data.markdown), aiCalls: 0 } } });
      if (!owned.count) return;
      await tx.knowledgeSource.update({ where: { id: source.id }, data: { status: "PROPOSED", body: result.data.markdown, title: (result.data.metadata.title || source.title).slice(0, 120), sha256: createHash("sha256").update(result.data.markdown).digest("hex"), retrievedAt: new Date() } });
    });
  } catch {
    await db.$transaction(async tx => {
      const owned = await tx.job.updateMany({ where: { id: job.id, status: "RUNNING", leaseUntil: job.leaseUntil }, data: { status: "FAILED", errorCode: "SOURCE_IMPORT_FAILED", leaseUntil: null } });
      if (!owned.count) return;
      const payload = payloadSchema.safeParse(job.payload);
      if (payload.success) await tx.knowledgeSource.updateMany({ where: { id: payload.data.sourceId, businessId: job.businessId, organizationId: job.organizationId }, data: { status: "FAILED" } });
    });
  }
  return true;
}
