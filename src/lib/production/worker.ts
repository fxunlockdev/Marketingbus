import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { reason } from "../providers/reasoning";
import { finishReservationInTransaction } from "../billing/wallet";
import { assertExecutionEnabled, configurationHash, keyFor, actualCostMicros } from "./router";
import { requestSchema, lockBusiness, currentItem } from "./service";
import { creativeJsonSchema, validateCreative } from "./content";
import { evaluateCreative } from "./quality";

type Reasoner = typeof reason;
// A test can inject a fixture transport. No environment switch can enable fake results in the application.
export async function runOneJob(reasoner: Reasoner = reason) {
  assertExecutionEnabled();
  const job = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Job" WHERE status='QUEUED' AND kind='STATIC_COPY' AND "availableAt"<=NOW() ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows[0]) return null;
    return tx.job.update({ where: { id: rows[0].id }, data: { status: "RUNNING", attempts: { increment: 1 }, leaseUntil: new Date(Date.now() + 5 * 60_000) }, include: { quote: true } });
  });
  if (!job) return false;
  const scope = { businessId: job.businessId, organizationId: job.organizationId, actorId: "production-worker" };
  let submitted = false;
  try {
    const quote = job.quote;
    if (!quote || !job.reservationId) throw Error("Missing authorization");
    const request = requestSchema.parse(quote.request);
    const key = keyFor(request.route.model.provider);
    if (!key || quote.configurationHash !== configurationHash() || new Date(request.route.model.verifiedUntil).getTime() <= Date.now()) throw Error("Configuration changed");
    // No network I/O while holding business/wallet locks.
    await db.$transaction(async tx => {
      const business = await lockBusiness(tx, scope);
      const item = await currentItem(tx, scope, quote.itemId);
      if (!business.confirmedAt || business.version !== quote.brandVersion || item.plan.status !== "PROPOSED" || (item.revisions[0]?.version || 0) !== quote.baseVersion) throw Error("Stale brand or revision");
      assertExecutionEnabled();
      const changed = await tx.job.updateMany({ where: { id: job.id, status: "RUNNING" }, data: { status: "SUBMITTING", submittedAt: new Date() } });
      if (changed.count !== 1) throw Error("Job no longer owned");
    });
    submitted = true;
    const result = await reasoner(request.route.model.provider, { system: request.system, input: request.input,
      model: request.route.model.model, maxOutputTokens: request.route.maxOutputTokens, jsonSchema: creativeJsonSchema }, key);
    const micros = actualCostMicros(request.route, result.usage);
    let content: ReturnType<typeof validateCreative> | null = null;
    let quality: ReturnType<typeof evaluateCreative> | null = null;
    try {
      content = validateCreative(JSON.parse(result.text), request.channel, request.proof);
      if (quote.mode === "copy" && request.previous) content = { ...request.previous, headline: content.headline, caption: content.caption, cta: content.cta };
      quality = evaluateCreative(content, { facts: request.approvedFacts, feedback: request.feedback, previous: request.previous });
      if (!quality.eligible) content = null;
    } catch { /* Invalid deliverables do not reach customer review. Record cost and release customer credits. */ }
    await db.$transaction(async tx => {
      const business = await lockBusiness(tx, scope);
      const item = await currentItem(tx, scope, quote.itemId);
      const current = await tx.job.findUniqueOrThrow({ where: { id: job.id } });
      if (current.status !== "SUBMITTING") throw Error("Lost submission lease; reconcile instead of duplicating output");
      const fresh = !!business.confirmedAt && business.version === quote.brandVersion && item.plan.status === "PROPOSED" && (item.revisions[0]?.version || 0) === quote.baseVersion;
      const deliver = fresh && content !== null;
      const consumed = deliver ? Math.max(1, Math.ceil(micros / 10_000)) : 0;
      if (deliver && content) {
        await tx.creativeRevision.updateMany({ where: { itemId: item.id, organizationId: scope.organizationId }, data: { status: "SUPERSEDED" } });
        await tx.creativeRevision.create({ data: { itemId: item.id, organizationId: scope.organizationId, version: quote.baseVersion + 1,
          content, status: "READY", authorId: typeof (job.payload as { actorId?: unknown }).actorId === "string" ? (job.payload as { actorId: string }).actorId : null, provenance: { kind: "AI_COPY", provider: request.route.model.provider, model: request.route.model.model,
            providerResponseId: result.id, skillVersion: request.skillVersion, sourceHashes: request.sourceHashes,
            brandVersion: quote.brandVersion, brandName: request.brandName, color: request.color, preset: request.preset,
            supplierCostMicros: micros, usage: result.usage as Prisma.InputJsonValue,
            quality } } });
        await tx.calendarEntry.deleteMany({ where: { itemId: item.id, organizationId: scope.organizationId } });
      }
      await finishReservationInTransaction(tx, scope.organizationId, job.reservationId!, consumed);
      await tx.productionItem.update({ where: { id: item.id }, data: { status: deliver ? "READY" : fresh ? "FAILED" : "SUPERSEDED", scheduledFor: null } });
      await tx.job.update({ where: { id: job.id }, data: { status: deliver ? "COMPLETED" : "FAILED", providerTaskId: result.id, leaseUntil: null,
        errorCode: deliver ? null : fresh ? quality && !quality.eligible ? "QUALITY_CHECK_FAILED" : "OUTPUT_VALIDATION_FAILED" : "BRAND_CHANGED",
        result: { supplierCostMicros: micros, creditsConsumed: consumed, usage: result.usage as Prisma.InputJsonValue, quality } } });
      // The provider incurred cost even when the result was invalid or the brand changed mid-flight.
      await tx.generationQuote.update({ where: { id: quote.id }, data: { status: "COMPLETED" } });
      await tx.auditEvent.create({ data: { ...scope, action: deliver ? "CREATIVE_READY" : "PRODUCTION_FAILED",
        detail: deliver ? `Version ${quote.baseVersion + 1} is ready for human review. ${consumed} credits used; unused reservation released.` : "Production returned no eligible creative. Customer credits released; supplier usage recorded." } });
    });
  } catch {
    // Once submission starts, even an HTTP error/timeout can have ambiguous billing. Never auto-retry it.
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope);
      const current = await tx.job.findUniqueOrThrow({ where: { id: job.id } });
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) return;
      const ambiguous = submitted || current.status === "SUBMITTING";
      if (!ambiguous && job.reservationId) await finishReservationInTransaction(tx, scope.organizationId, job.reservationId, 0);
      await tx.job.update({ where: { id: job.id }, data: { status: ambiguous ? "NEEDS_RECONCILIATION" : "FAILED", errorCode: ambiguous ? "PROVIDER_OUTCOME_UNKNOWN" : "PREFLIGHT_FAILED", leaseUntil: null } });
      if (job.quoteId) {
        await tx.generationQuote.update({ where: { id: job.quoteId }, data: { status: ambiguous ? "RECONCILE" : "RELEASED" } });
        await tx.productionItem.update({ where: { id: job.quote!.itemId }, data: { status: ambiguous ? "NEEDS_RECONCILIATION" : "FAILED" } });
      }
      await tx.auditEvent.create({ data: { ...scope, action: "PRODUCTION_STOPPED", detail: ambiguous
        ? "Provider outcome is uncertain. Credits remain held for operator reconciliation; no automatic retry."
        : "Production stopped before submission. Reserved credits were released." } });
    });
  }
  return true;
}

export async function recoverExpiredLeases() {
  // A RUNNING job has not submitted; SUBMITTING is never blindly re-enqueued.
  return db.$transaction(async tx => {
    const stale = await tx.job.findMany({ where: { kind: "STATIC_COPY", status: { in: ["RUNNING", "SUBMITTING"] }, leaseUntil: { lt: new Date() } }, take: 100 });
    let recovered = 0;
    for (const job of stale) {
      const status = job.status === "RUNNING" ? "QUEUED" : "NEEDS_RECONCILIATION";
      const changed = await tx.job.updateMany({ where: { id: job.id, status: job.status, leaseUntil: { lt: new Date() } }, data: { status, leaseUntil: null, errorCode: status === "QUEUED" ? null : "LEASE_EXPIRED_AFTER_SUBMISSION" } });
      if (changed.count && status === "NEEDS_RECONCILIATION" && job.quoteId) await tx.generationQuote.update({ where: { id: job.quoteId }, data: { status: "RECONCILE" } });
      recovered += changed.count;
    }
    return recovered;
  });
}
