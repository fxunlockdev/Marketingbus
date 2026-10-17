import { z } from "zod";
import { assertReviewer, assertNoBlockingComments } from "../workflows/approvals";
import { reserveWeeklyAuthorization } from "../workflows/planning";
import { assertNoPublicationInFlight, invalidatePublications } from "../social/service";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { brandInput } from "../brand";
import { compileHarness } from "../harness/contracts";
import { reserveCreditsInTransaction } from "../billing/wallet";
import { assertExecutionEnabled, configurationHash, selectRoute, routeSchema } from "./router";
import { authorizeSupplier } from "./budget";
import { assertWorkerReady } from "./readiness";
import { creativeSchema, creativeJsonSchema, validateCreative } from "./content";
import { approvedFactText, evaluateCreative } from "./quality";
import { productionMemories, preferenceFingerprint } from "../social/learning-evidence";

export type Scope = { businessId: string; organizationId: string; actorId: string };
export const productionAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), itemId: z.string(), mode: z.enum(["initial", "copy", "concept"]), direction: z.string().trim().min(10).max(1000) }).strict(),
  z.object({ action: z.literal("accept"), quoteId: z.string() }).strict(),
  z.object({ action: z.enum(["approve", "reject", "revise"]), itemId: z.string(), version: z.number().int().positive(), feedback: z.string().trim().max(1000).default(""), remember: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal("edit"), itemId: z.string(), version: z.number().int().positive(), headline: creativeSchema.shape.headline, caption: creativeSchema.shape.caption, cta: creativeSchema.shape.cta }).strict(),
  z.object({ action: z.literal("schedule"), itemId: z.string(), version: z.number().int().positive(), scheduledFor: z.iso.datetime(), timezone: z.string().min(1).max(80) }).strict(),
  z.object({ action: z.literal("unschedule"), itemId: z.string() }).strict(),
]);
export const requestSchema = z.object({
  system: z.string().max(150000), input: z.string().max(150000), route: routeSchema,
  channel: z.string(), proof: z.string(), brandName: z.string(), color: z.string(), preset: z.string(),
  previous: creativeSchema.nullable(), feedback: z.string(), skillVersion: z.string(),
  approvedFacts: z.string().max(10000).default(""),
  preferenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sourceHashes: z.array(z.object({ file: z.string(), sha256: z.string() })),
}).strict();
export async function lockBusiness(tx: Prisma.TransactionClient, scope: Scope) {
  await tx.$queryRaw`SELECT id FROM "Business" WHERE id=${scope.businessId} AND "organizationId"=${scope.organizationId} FOR UPDATE`;
  const business = await tx.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!business) throw new AppError(404, "Business not found.");
  return business;
}
export async function currentItem(tx: Prisma.TransactionClient, scope: Scope, itemId: string) {
  const item = await tx.productionItem.findFirst({ where: { id: itemId, organizationId: scope.organizationId, plan: { businessId: scope.businessId } }, include: { plan: true, revisions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!item) throw new AppError(404, "Creative not found.");
  return item;
}
function audit(tx: Prisma.TransactionClient, scope: Scope, action: string, detail: string) {
  return tx.auditEvent.create({ data: { ...scope, action, detail } });
}
async function assertIdle(tx: Prisma.TransactionClient, itemId: string, organizationId: string) {
  const item = await tx.productionItem.findFirst({ where: { id: itemId, organizationId }, include: { plan: true } });
  if (item) await assertNoPublicationInFlight(tx, item.plan.businessId, itemId);
  if (await tx.job.count({ where: { organizationId, quote: { itemId }, status: { in: ["QUEUED", "RUNNING", "SUBMITTING", "NEEDS_RECONCILIATION"] } } })) throw new AppError(409, "This creative has an active or unresolved production job.");
}
export async function actOnProduction(scope: Scope, raw: unknown, internal?: { weeklyTaskId: string }) {
  const input = productionAction.parse(raw);
  // Build skill context outside the transaction. Recheck all mutable inputs under lock below.
  if (input.action === "quote") {
    assertExecutionEnabled();
    await assertWorkerReady();
    const context = await db.$transaction(async tx => {
      const business = await lockBusiness(tx, scope);
      const item = await currentItem(tx, scope, input.itemId);
      if (!business.confirmedAt || item.plan.brandVersion !== business.version || item.plan.status !== "PROPOSED") throw new AppError(409, "Confirm the current brand and create a current planning outline first.");
      if (item.format !== "static") throw new AppError(409, "Video production is not enabled yet. No credits were spent.");
      await assertIdle(tx, item.id, scope.organizationId);
      const previous = item.revisions[0];
      if (input.mode === "initial" ? !!previous : previous?.status !== "CHANGES_REQUESTED") throw new AppError(409, "For an existing creative, request changes before quoting a revision.");
      const memories = await productionMemories(tx, scope, business.version);
      return { business, item, previous, memories };
    });
    const { business, item, previous, memories } = context;
    const brand = brandInput.parse(Object.fromEntries(Object.keys(brandInput.shape).map(k => [k, business[k as keyof typeof business]])));
    const harness = await compileHarness({ organizationId: scope.organizationId, businessId: business.id, planItemId: item.id,
      brandVersion: business.version, discipline: item.channel === "LinkedIn" ? "linkedin" : "static", objective: brand.goal,
      audienceTension: `Address this audience: ${brand.audience}`.slice(0, 1000), proposition: (brand.difference || brand.offering).slice(0, 1000),
      evidence: brand.proof ? [{ id: "approved-brand-proof", claim: brand.proof.slice(0, 1000) }] : [],
      concept: item.title, direction: input.direction, brand, brandConfirmed: true, creditCeiling: 8000, preferences: memories.map(m => m.text),
    }, scope);
    const prior = previous ? creativeSchema.parse(previous.content) : null;
    const system = `${harness.system}\nReturn JSON ONLY matching this schema: ${JSON.stringify(creativeJsonSchema)}. evidenceUsed must contain only verbatim excerpts of approved brand proof, or be empty. No invented testimonials, numerical results or guarantees. Caption limits including any CTA/hashtags: X 280, Instagram 2200, LinkedIn 3000, Facebook 3000 characters. The caption is the complete publishable text. Headline/cta are for the visual. This deliverable is copy plus visual direction, NOT a generated image. ${input.mode === "copy" ? "Revise headline, caption and CTA only; retain the previous visual direction, rationale and evidence." : "Develop a specific audience insight and one ownable creative idea; apply the reference editorial checks before final output."}`;
    const prompt = JSON.stringify({ brief: JSON.parse(harness.input), mode: input.mode, previous: prior, feedback: previous?.feedback || "" });
    if (system.length + prompt.length > 150000) throw new AppError(409, "Brand context exceeds the safe production limit. Shorten the saved preferences.");
    const hash = configurationHash();
    const route = selectRoute(input.mode, Buffer.byteLength(system + prompt + JSON.stringify(creativeJsonSchema), "utf8"));
    const request = requestSchema.parse({ system, input: prompt, route, channel: item.channel, proof: brand.proof, brandName: brand.name, color: brand.color, preset: brand.designPreset,
      previous: prior, feedback: previous?.feedback || "", approvedFacts: approvedFactText(brand), preferenceFingerprint: preferenceFingerprint(memories), skillVersion: harness.skillVersion, sourceHashes: harness.sourceHashes });
    return db.$transaction(async tx => {
      const fresh = await lockBusiness(tx, scope);
      const latest = await currentItem(tx, scope, item.id);
      const latestMemories = await productionMemories(tx, scope, fresh.version);
      if (JSON.stringify(latestMemories) !== JSON.stringify(memories)) throw new AppError(409, "Brand preferences changed. Request a fresh quote.");
      if (!fresh.confirmedAt || fresh.version !== business.version || (latest.revisions[0]?.version || 0) !== (previous?.version || 0) || (latest.revisions[0]?.feedback || "") !== (previous?.feedback || "")) throw new AppError(409, "The brand or creative changed. Request a fresh quote.");
      await assertIdle(tx, item.id, scope.organizationId);
      await tx.generationQuote.updateMany({ where: { itemId: item.id, organizationId: scope.organizationId, status: "OFFERED" }, data: { status: "SUPERSEDED" } });
      const quote = await tx.generationQuote.create({ data: { organizationId: scope.organizationId, businessId: business.id, itemId: item.id,
        brandVersion: business.version, baseVersion: previous?.version || 0, mode: input.mode, credits: route.credits,
        supplierCeilingMicros: route.supplierCeilingMicros, request, configurationHash: hash, expiresAt: new Date(Date.now() + 10 * 60_000) } });
      return { ok: true, quote: { id: quote.id, credits: quote.credits, expiresAt: quote.expiresAt, model: route.model.model, reason: route.reason } };
    });
  }
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope);
    if (input.action === "accept") {
      assertExecutionEnabled();
      const quote = await tx.generationQuote.findFirst({ where: { id: input.quoteId, organizationId: scope.organizationId, businessId: scope.businessId }, include: { job: true } });
      if (!quote) throw new AppError(404, "Quote not found.");
      if (quote.job) return { ok: true, jobId: quote.job.id };
      await assertWorkerReady(tx);
      if (quote.status !== "OFFERED" || quote.expiresAt.getTime() < Date.now() || quote.configurationHash !== configurationHash()) throw new AppError(409, "This quote expired or changed. Request a fresh quote.");
      const item = await currentItem(tx, scope, quote.itemId);
      if (!business.confirmedAt || quote.brandVersion !== business.version || item.plan.status !== "PROPOSED" || (item.revisions[0]?.version || 0) !== quote.baseVersion) throw new AppError(409, "The brand or creative changed. Request a fresh quote.");
      if (requestSchema.parse(quote.request).preferenceFingerprint !== preferenceFingerprint(await productionMemories(tx, scope, business.version))) throw new AppError(409, "Brand preferences or experiment evidence changed. Request a fresh quote.");
      if (quote.baseVersion && item.revisions[0]?.status !== "CHANGES_REQUESTED") throw new AppError(409, "This revision is no longer awaiting changes.");
      await assertIdle(tx, item.id, scope.organizationId);
      await authorizeSupplier(tx, quote.id, quote.supplierCeilingMicros);
      if (internal) await reserveWeeklyAuthorization(tx, scope, internal.weeklyTaskId, quote);
      const reservation = await reserveCreditsInTransaction(tx, scope.organizationId, quote.id, quote.credits, quote.mode !== "initial");
      const job = await tx.job.create({ data: { organizationId: scope.organizationId, businessId: scope.businessId, key: `generation:${quote.id}`, kind: "STATIC_COPY", payload: { actorId: scope.actorId }, quoteId: quote.id, reservationId: reservation.id, maxAttempts: 1 } });
      await tx.generationQuote.update({ where: { id: quote.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
      await tx.productionItem.update({ where: { id: item.id }, data: { status: "QUEUED" } });
      await audit(tx, scope, "PRODUCTION_AUTHORIZED", `Reserved up to ${quote.credits} credits for one copy and layout-direction job. Publication is not authorized.`);
      return { ok: true, jobId: job.id };
    }
    const item = await currentItem(tx, scope, input.itemId);
    await assertIdle(tx, item.id, scope.organizationId);
    if (input.action === "unschedule") {
      await invalidatePublications(tx, scope.businessId, item.id);
      await tx.calendarEntry.deleteMany({ where: { itemId: item.id, organizationId: scope.organizationId } });
      await tx.productionItem.update({ where: { id: item.id }, data: { scheduledFor: null } });
      await audit(tx, scope, "CALENDAR_REMOVED", "Removed the internal calendar reservation.");
      return { ok: true };
    }
    const revision = item.revisions[0];
    if (!revision || revision.version !== input.version) throw new AppError(409, "This version is no longer current. Refresh before reviewing.");
    if (!business.confirmedAt || item.plan.brandVersion !== business.version || item.plan.status !== "PROPOSED") throw new AppError(409, "The brand changed. Create work from the current confirmed profile.");
    if (["approve", "schedule"].includes(input.action)) {
      await assertNoBlockingComments(tx, revision.id);
      if (input.action === "approve") await assertReviewer(tx, scope, business.independentApproval, revision.authorId);
      const quality = evaluateCreative(creativeSchema.parse(revision.content), { facts: approvedFactText(business) });
      if (!quality.eligible) throw new AppError(409, "This version contains unconfirmed dates, numbers or claims. Edit the copy or confirm supporting business facts before approval.");
    }
    if (input.action === "schedule") {
      if (revision.status !== "APPROVED") throw new AppError(409, "Approve this exact version before scheduling.");
      const when = new Date(input.scheduledFor);
      if (when.getTime() < Date.now() + 60_000 || when.getTime() > Date.now() + 366 * 86400_000) throw new AppError(400, "Choose a date at least one minute ahead and within one year.");
      try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(when); } catch { throw new AppError(400, "Choose a valid timezone."); }
      await tx.calendarEntry.upsert({ where: { itemId: item.id }, create: { organizationId: scope.organizationId, itemId: item.id, revisionId: revision.id, scheduledFor: when, timezone: input.timezone }, update: { revisionId: revision.id, scheduledFor: when, timezone: input.timezone, status: "PLANNED" } });
      await tx.productionItem.update({ where: { id: item.id }, data: { scheduledFor: when } });
      await audit(tx, scope, "CALENDAR_PLANNED", `Version ${revision.version} reserved for ${when.toISOString()}. Internal calendar only; no social post will be sent.`);
      return { ok: true };
    }
    await tx.generationQuote.updateMany({ where: { itemId: item.id, organizationId: scope.organizationId, status: "OFFERED" }, data: { status: "SUPERSEDED" } });
    if (input.action === "edit") {
      await invalidatePublications(tx, scope.businessId, item.id);
      if (!["READY", "APPROVED", "CHANGES_REQUESTED"].includes(revision.status)) throw new AppError(409, "This creative is not editable.");
      const content = validateCreative({ ...creativeSchema.parse(revision.content), headline: input.headline, caption: input.caption, cta: input.cta }, item.channel, business.proof);
      const quality = evaluateCreative(content, { facts: approvedFactText(business) });
      if (!quality.eligible) throw new AppError(409, "Remove unconfirmed dates, numbers or claims before saving this copy.");
      await tx.creativeRevision.update({ where: { id: revision.id }, data: { status: "SUPERSEDED" } });
      await tx.creativeRevision.create({ data: { organizationId: scope.organizationId, itemId: item.id, version: revision.version + 1, content, status: "READY", authorId: scope.actorId, provenance: { kind: "HUMAN_EDIT", actorId: scope.actorId, parentRevisionId: revision.id } } });
      await tx.productionItem.update({ where: { id: item.id }, data: { status: "READY", scheduledFor: null } });
      await tx.calendarEntry.deleteMany({ where: { itemId: item.id, organizationId: scope.organizationId } });
      await audit(tx, scope, "CREATIVE_EDITED", "Saved a new copy version without an AI call or credit charge. Previous approval and schedule revoked.");
      return { ok: true };
    }
    if (!["READY", "APPROVED"].includes(revision.status)) throw new AppError(409, "This version is not awaiting review.");
    if (input.action === "revise" && input.feedback.length < 3) throw new AppError(400, "Describe the specific change you want.");
    const status = input.action === "approve" ? "APPROVED" : input.action === "reject" ? "REJECTED" : "CHANGES_REQUESTED";
    if (input.action !== "approve") await invalidatePublications(tx, scope.businessId, item.id);
    await tx.creativeRevision.update({ where: { id: revision.id }, data: { status, feedback: input.feedback, approvedBy: input.action === "approve" ? scope.actorId : null, approvedAt: input.action === "approve" ? new Date() : null } });
    await tx.productionItem.update({ where: { id: item.id }, data: { status, ...(input.action === "approve" ? {} : { scheduledFor: null }) } });
    if (input.action !== "approve") await tx.calendarEntry.deleteMany({ where: { itemId: item.id, organizationId: scope.organizationId } });
    if (input.remember && input.feedback.length >= 3) {
      if (await tx.memory.count({ where: { businessId: scope.businessId } }) >= 100) throw new AppError(409, "Remove an unused preference before saving another.");
      await tx.memory.create({ data: { organizationId: scope.organizationId, businessId: scope.businessId, text: input.feedback } });
    }
    await audit(tx, scope, `CREATIVE_${status}`, `Version ${revision.version}: ${status.toLowerCase().replaceAll("_", " ")}. No generation or credit charge triggered.`);
    return { ok: true };
  });
}
