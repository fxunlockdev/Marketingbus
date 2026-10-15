import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, type Scope } from "../production/service";
import { publicUrl } from "../providers/url-policy";
export const sourceInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("document"), title: z.string().trim().min(2).max(120), text: z.string().trim().min(20).max(24000).refine(s => Buffer.byteLength(s) <= 24000 && !/[\u0000\uFFFD]/.test(s), "Use valid UTF-8 text up to 24 KB."), rightsConfirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("website"), url: z.url().max(500), rightsConfirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("delete"), sourceId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("evidence"), sourceId: z.string().min(1), quote: z.string().trim().min(10).max(1800) }).strict(),
]);
export const sourceFields = { id: true, kind: true, title: true, sourceUrl: true, body: true, status: true, createdAt: true, retrievedAt: true } as const;
export function selfHostedScraperBase() {
  const value = process.env.FIRECRAWL_SELF_HOSTED_URL;
  if (process.env.WEBSITE_EXTRACTION_ENABLED !== "true" || !value) throw new AppError(503, "Self-hosted website extraction is not configured yet. You can upload a text document instead.");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !["http:", "https:"].includes(url.protocol)) throw new AppError(503, "Invalid scraper configuration.");
  if (!url.hostname.endsWith(".railway.internal") && !(process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new AppError(503, "The scraper must use its private service address.");
  // Deployment must attest network-level restrictions: DNS preflight alone cannot prevent redirect/rebinding SSRF.
  if (process.env.FIRECRAWL_EGRESS_RESTRICTED !== "true") throw new AppError(503, "Scraper network isolation must be verified before importing websites.");
  return url;
}
export async function manageSource(scope: Scope, raw: unknown) {
  const input = sourceInput.parse(raw);
  let url = "";
  if (input.action === "website") {
    selfHostedScraperBase();
    try { url = publicUrl(input.url).href; } catch { throw new AppError(400, "Use a public HTTPS website without credentials or custom ports."); }
  }
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope);
    if (input.action === "evidence") {
      const source = await tx.knowledgeSource.findFirst({ where: { id: input.sourceId, businessId: scope.businessId, organizationId: scope.organizationId, status: "PROPOSED" } });
      if (!source) throw new AppError(404, "Source not found.");
      if (!source.body.includes(input.quote)) throw new AppError(400, "Evidence must be an exact excerpt from this source.");
      await tx.auditEvent.create({ data: { ...scope, action: "EVIDENCE_SELECTED", detail: `Source ${source.id}, SHA256 ${source.sha256}: an exact excerpt was selected for profile review; it is not automatically approved.` } });
      return { ok: true, evidence: { quote: input.quote, sourceId: source.id, sha256: source.sha256, sourceUrl: source.sourceUrl } };
    }
    if (input.action === "delete") {
      const source = await tx.knowledgeSource.findFirst({ where: { id: input.sourceId, businessId: scope.businessId, organizationId: scope.organizationId } });
      if (!source) throw new AppError(404, "Source not found.");
      if (["QUEUED", "FETCHING"].includes(source.status)) throw new AppError(409, "Wait for the active import before deleting this source.");
      await tx.knowledgeSource.delete({ where: { id: source.id } });
      await tx.auditEvent.create({ data: { ...scope, action: "SOURCE_DELETED", detail: "Source text removed from the active database. Already-confirmed profile facts and backups are separate." } });
      return { ok: true };
    }
    const sources = await tx.knowledgeSource.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId }, select: { id: true, sourceUrl: true, body: true, status: true, retrievedAt: true, createdAt: true, sha256: true } });
    const sha256 = input.action === "document" ? createHash("sha256").update(input.text).digest("hex") : "";
    const existing = sources.find(s => input.action === "document" ? s.sha256 === sha256 : s.sourceUrl === url && (s.status === "QUEUED" || s.status === "FETCHING" || s.status === "PROPOSED" && !!s.retrievedAt && s.retrievedAt.getTime() > Date.now() - 7 * 86400000));
    if (existing) return { ok: true, sourceId: existing.id, cached: true };
    const reservedBytes = sources.reduce((n, s) => n + (["QUEUED", "FETCHING"].includes(s.status) ? 80000 : Buffer.byteLength(s.body)), 0);
    if (sources.length >= 30 || reservedBytes + (input.action === "website" ? 80000 : Buffer.byteLength(input.text)) > 750000) throw new AppError(409, "Remove unused sources before adding more (30 sources / 750 KB pilot allowance).");
    if (input.action === "website" && await tx.job.count({ where: { businessId: scope.businessId, kind: "WEBSITE_READ", createdAt: { gt: new Date(Date.now() - 86400000) } } }) >= 3) throw new AppError(429, "Website imports are limited to three pages per business per day.");
    const source = await tx.knowledgeSource.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, createdBy: scope.actorId,
      kind: input.action === "website" ? "WEBSITE" : "TEXT_DOCUMENT", title: input.action === "document" ? input.title : new URL(url).hostname,
      sourceUrl: url, body: input.action === "document" ? input.text : "", sha256,
      status: input.action === "website" ? "QUEUED" : "PROPOSED", retrievedAt: input.action === "document" ? new Date() : null } });
    if (input.action === "website") await tx.job.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, kind: "WEBSITE_READ", key: `source:${source.id}`, maxAttempts: 1, payload: { sourceId: source.id, url } } });
    await tx.auditEvent.create({ data: { ...scope, action: "SOURCE_ADDED", detail: `${source.kind} source added for review. It is not approved business evidence and cannot change the brand automatically.` } });
    return { ok: true, sourceId: source.id, cached: false };
  });
}
