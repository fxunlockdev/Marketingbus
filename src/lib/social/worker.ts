import { frozenCopy, MAX_RECONCILIATION_ATTEMPTS } from "./integrity";
export { MAX_RECONCILIATION_ATTEMPTS } from "./integrity";
import { db } from "../db";
import { openSecret } from "../secrets";
import { lockBusiness } from "../production/service";
import { creativeSchema } from "../production/content";
import { approvedFactText, evaluateCreative } from "../production/quality";
import {
  metricReading,
  publishedReceipt,
  socialProvider,
  type Account,
  type SocialAdapters,
  type PublishOutcome,
} from "./contracts";
import type { SocialConnection } from "@prisma/client";

function account(connection: SocialConnection): Account {
  return {
    id: connection.id,
    externalAccountId: connection.externalAccountId,
    provider: socialProvider.parse(connection.provider),
    token: openSecret(
      connection.encryptedToken,
      `social:${connection.organizationId}:${connection.businessId}:${connection.id}`
    ),
  };
}
export function safePermalink(provider: string, value: string | null) {
  if (!value) return null;
  const url = new URL(value);
  const roots: Record<string, string[]> = {
    Facebook: ["facebook.com", "fb.com"],
    Instagram: ["instagram.com"],
    LinkedIn: ["linkedin.com"],
  };
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !roots[provider]?.some(
      (h) => url.hostname === h || url.hostname.endsWith(`.${h}`)
    )
  )
    throw Error("Invalid social permalink");
  return url.href;
}
export async function recoverSocialLeases() {
  // Do not retry an interrupted write: the provider may have committed it.
  await db.socialPublication.updateMany({
    where: { status: "SUBMITTING", leaseUntil: { lt: new Date() } },
    data: {
      status: "NEEDS_RECONCILIATION",
      errorCode: "SUBMISSION_INTERRUPTED",
      leaseUntil: null,
    },
  });
  await db.socialPublication.updateMany({
    where: { status: "NEEDS_RECONCILIATION", reconciliationAttempts: { gte: MAX_RECONCILIATION_ATTEMPTS }, leaseUntil: { lte: new Date() } },
    data: { leaseUntil: null, nextReconciliationAt: null, errorCode: "LOOKUP_INTERRUPTED_LIMIT" },
  });
}
export async function runOnePublication(adapters: SocialAdapters) {
  const providers = Object.keys(adapters);
  if (!providers.length) return false;
  const candidate = await db.socialPublication.findFirst({
    where: {
      status: "SCHEDULED",
      scheduledFor: { lte: new Date() },
      connection: { provider: { in: providers } },
    },
    orderBy: { scheduledFor: "asc" },
  });
  if (!candidate) return false;
  const scope = {
    businessId: candidate.businessId,
    organizationId: candidate.organizationId,
    actorId: "social-worker",
  };
  const claimed = await db.$transaction(async (tx) => {
    const business = await lockBusiness(tx, scope);
    const post = await tx.socialPublication.findUniqueOrThrow({
      where: { id: candidate.id },
      include: {
        connection: true,
        revision: {
          include: {
            item: {
              include: {
                plan: true,
                revisions: { orderBy: { version: "desc" }, take: 1 },
              },
            },
          },
        },
      },
    });
    if (post.status !== "SCHEDULED" || post.scheduledFor > new Date())
      return null;
    const current = post.revision.item.revisions[0];
    let reason: string | null = null;
    if (
      !business.confirmedAt ||
      business.version !== post.brandVersion ||
      post.revision.item.plan.businessId !== post.businessId ||
      post.revision.item.plan.brandVersion !== post.brandVersion ||
      post.revision.item.plan.status !== "PROPOSED" ||
      current?.id !== post.revisionId ||
      post.revision.status !== "APPROVED"
    )
      reason = "APPROVAL_CHANGED";
    if (
      post.connection.status !== "CONNECTED" ||
      (post.connection.expiresAt && post.connection.expiresAt <= new Date())
    )
      reason = "RECONNECT_REQUIRED";
    let payload: ReturnType<typeof frozenCopy> | undefined;
    try {
      payload = frozenCopy(post.payload, post.payloadHash, post.connection.provider);
      const creative = creativeSchema.parse(post.revision.content);
      if (payload.caption !== creative.caption || payload.channel !== post.revision.item.channel || payload.format !== post.revision.item.format) reason = "PAYLOAD_CHANGED";
      if (!evaluateCreative(creative, { facts: approvedFactText(business) }).eligible) reason = "FACT_CHECK_FAILED";
    } catch { reason = "PAYLOAD_INVALID"; }
    if (reason || !payload) {
      await tx.socialPublication.update({
        where: { id: post.id },
        data: { status: "CANCELLED", errorCode: reason ?? "PAYLOAD_INVALID" },
      });
      return null;
    }
    let token: Account;
    try { token = account(post.connection); }
    catch {
      await tx.socialPublication.update({ where: { id: post.id }, data: { status: "FAILED", errorCode: "CREDENTIAL_UNAVAILABLE" } });
      return null;
    }
    const submissionLease = new Date(Date.now() + 120000);
    await tx.socialPublication.update({
      where: { id: post.id },
      data: {
        status: "SUBMITTING",
        attempts: { increment: 1 },
        leaseUntil: submissionLease,
      },
    });
    return { post, payload, token, submissionLease };
  });
  if (!claimed) return true;
  const adapter = adapters[claimed.token.provider]!;
  let outcome: PublishOutcome;
  try {
    outcome = await adapter.publish(
      claimed.token,
      claimed.payload,
      claimed.post.id,
      AbortSignal.timeout(45000)
    );
  } catch {
    outcome = { state: "uncertain" };
  }
  try {
    await db.$transaction(async (tx) => {
      await lockBusiness(tx, scope);
      const fresh = await tx.socialPublication.findUniqueOrThrow({
        where: { id: claimed.post.id },
        include: { connection: true },
      });
      if (fresh.status !== "SUBMITTING" || fresh.leaseUntil?.getTime() !== claimed.submissionLease.getTime()) return;
      const validPayload = (() => { try { frozenCopy(fresh.payload, fresh.payloadHash, claimed.token.provider); return fresh.payloadHash === claimed.post.payloadHash; } catch { return false; } })();
      if (!validPayload || fresh.connection.status !== "CONNECTED" || fresh.connection.encryptedToken !== claimed.post.connection.encryptedToken || fresh.connection.externalAccountId !== claimed.post.connection.externalAccountId || fresh.connection.provider !== claimed.token.provider || fresh.connection.expiresAt && fresh.connection.expiresAt <= new Date()) {
        await tx.socialPublication.update({ where: { id: fresh.id }, data: { status: "NEEDS_RECONCILIATION", leaseUntil: null, errorCode: "SUBMISSION_CONTEXT_CHANGED" } });
        return;
      }
      if (outcome.state === "published") {
        const receipt = publishedReceipt.parse(outcome.receipt);
        if (
          receipt.publishedAt > new Date(Date.now() + 60000) ||
          receipt.publishedAt < fresh.createdAt
        )
          throw Error("Invalid publication time");
        await tx.socialPublication.update({
          where: { id: fresh.id },
          data: {
            ...receipt,
            permalink: safePermalink(claimed.token.provider, receipt.permalink),
            status: "PUBLISHED",
            leaseUntil: null,
            nextMetricsAt: adapter.metricsAvailable === false ? null : new Date(Date.now() + 3600000),
            errorCode: null,
          },
        });
      } else if (outcome.state === "retryable" && fresh.attempts < 3) {
        const seconds = Math.max(
          60,
          Math.min(
            86400,
            Number.isFinite(outcome.retryAfterSeconds)
              ? outcome.retryAfterSeconds
              : 3600
          )
        );
        await tx.socialPublication.update({
          where: { id: fresh.id },
          data: {
            status: "SCHEDULED",
            leaseUntil: null,
            scheduledFor: new Date(Date.now() + seconds * 1000),
            errorCode: outcome.code,
          },
        });
      } else {
        const uncertain = outcome.state === "uncertain";
        await tx.socialPublication.update({
          where: { id: fresh.id },
          data: {
            status: uncertain ? "NEEDS_RECONCILIATION" : "FAILED",
            leaseUntil: null,
            errorCode: uncertain
              ? "PROVIDER_OUTCOME_UNKNOWN"
              : outcome.state === "failed" || outcome.state === "retryable"
              ? outcome.code
              : "PROVIDER_ERROR",
          },
        });
        if (outcome.state === "failed" && outcome.code === "TOKEN_REVOKED")
          await tx.socialConnection.update({
            where: { id: claimed.post.connectionId },
            data: { status: "RECONNECT_REQUIRED", encryptedToken: "" },
          });
      }
      await tx.auditEvent.create({
        data: {
          ...scope,
          action: "SOCIAL_SUBMISSION_RESULT",
          detail: `Publication ${fresh.id}: ${outcome.state}. No provider token or raw response retained.`,
        },
      });
    });
  } catch {
    // Malformed receipts / uniqueness collisions are not proof that no post exists.
    await db.socialPublication.updateMany({
      where: { id: claimed.post.id, status: "SUBMITTING", leaseUntil: claimed.submissionLease },
      data: {
        status: "NEEDS_RECONCILIATION",
        leaseUntil: null,
        errorCode: "RECEIPT_UNVERIFIED",
      },
    });
  }
  return true;
}

const RECONCILIATION_LEASE_MS = 120000;
function reconciliationDue(now: Date) {
  return {
    status: "NEEDS_RECONCILIATION",
    reconciliationAttempts: { lt: MAX_RECONCILIATION_ATTEMPTS },
    AND: [
      { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      { OR: [{ nextReconciliationAt: { lte: now } }, { nextReconciliationAt: null, reconciliationAttempts: 0 }] },
    ],
  };
}

// At most one lookup per tick. Exhausted/invalid outcomes remain held for operator review.
export async function runOneReconciliation(adapters: SocialAdapters) {
  if (!Object.keys(adapters).length) return false;
  const candidate = await db.socialPublication.findFirst({
    where: { ...reconciliationDue(new Date()), connection: { provider: { in: Object.keys(adapters) } } },
    orderBy: [{ nextReconciliationAt: "asc" }, { createdAt: "asc" }],
  });
  if (!candidate) return false;
  await reconcilePublication(candidate.id, adapters);
  return true;
}

export async function reconcilePublication(publicationId: string, adapters: SocialAdapters) {
  const candidate = await db.socialPublication.findUnique({ where: { id: publicationId } });
  if (!candidate) return false;
  const scope = { businessId: candidate.businessId, organizationId: candidate.organizationId, actorId: "social-reconciler" };
  const leaseUntil = new Date(Date.now() + RECONCILIATION_LEASE_MS);
  const claimed = await db.$transaction(async tx => {
    await lockBusiness(tx, scope);
    const post = await tx.socialPublication.findFirst({ where: { id: publicationId, ...reconciliationDue(new Date()) }, include: { connection: true } });
    if (!post) return null;
    const provider = socialProvider.safeParse(post.connection.provider);
    if (!provider.success || !adapters[provider.data]) return null;
    await tx.socialPublication.update({ where: { id: post.id }, data: {
      reconciliationAttempts: { increment: 1 }, leaseUntil,
      // A crashed lookup can be repeated after its lease; a publish never can.
      nextReconciliationAt: leaseUntil,
    } });
    return { post, provider: provider.data, attempt: post.reconciliationAttempts + 1 };
  });
  if (!claimed) return false;
  const { post, provider, attempt } = claimed;
  const guard = { id: post.id, status: "NEEDS_RECONCILIATION", leaseUntil, reconciliationAttempts: attempt };
  async function unresolved(code: string, retry = true) {
    await db.socialPublication.updateMany({ where: guard, data: {
      leaseUntil: null, errorCode: code,
      nextReconciliationAt: retry && attempt < MAX_RECONCILIATION_ATTEMPTS ? new Date(Date.now() + 60000 * 2 ** (attempt - 1)) : null,
    } });
    return false;
  }
  let payload: ReturnType<typeof frozenCopy>, token: Account;
  try { payload = frozenCopy(post.payload, post.payloadHash, provider); }
  catch { return unresolved("RECONCILIATION_PAYLOAD_INVALID", false); }
  if (post.connection.status !== "CONNECTED" || post.connection.expiresAt && post.connection.expiresAt <= new Date())
    return unresolved("RECONNECT_REQUIRED", false);
  try { token = account(post.connection); }
  catch { return unresolved("CREDENTIAL_UNAVAILABLE", false); }
  try {
    const receipt = await adapters[provider]!.reconcile(token, post.id, payload, AbortSignal.timeout(45000));
    // An empty search result is not proof that no remote post exists. Never resend.
    if (!receipt) return unresolved("PUBLICATION_NOT_CONFIRMED");
    const verified = publishedReceipt.parse(receipt);
    const permalink = safePermalink(provider, verified.permalink);
    if (verified.publishedAt > new Date(Date.now() + 60000) || verified.publishedAt < post.createdAt) throw Error("Invalid publication time");
    return await db.$transaction(async tx => {
      await lockBusiness(tx, scope);
      const fresh = await tx.socialPublication.findFirst({ where: guard, include: { connection: true } });
      if (!fresh) return false;
      const validPayload = (() => { try { frozenCopy(fresh.payload, fresh.payloadHash, provider); return fresh.payloadHash === post.payloadHash; } catch { return false; } })();
      if (!validPayload || fresh.connection.status !== "CONNECTED" || fresh.connection.encryptedToken !== post.connection.encryptedToken ||
          fresh.connection.externalAccountId !== post.connection.externalAccountId || fresh.connection.provider !== provider ||
          fresh.connection.expiresAt && fresh.connection.expiresAt <= new Date()) {
        await tx.socialPublication.update({ where: { id: post.id }, data: { leaseUntil: null, nextReconciliationAt: null, errorCode: "RECONCILIATION_CONTEXT_CHANGED" } });
        return false;
      }
      await tx.socialPublication.update({ where: { id: post.id }, data: {
        ...verified, permalink, status: "PUBLISHED", errorCode: null, leaseUntil: null, nextReconciliationAt: null,
        nextMetricsAt: adapters[provider]!.metricsAvailable === false ? null : new Date(Date.now() + 3600000),
      } });
      await tx.auditEvent.create({ data: { ...scope, action: "SOCIAL_RECONCILED", detail: `Provider read-back confirmed publication ${post.id}. No new post submitted.` } });
      return true;
    });
  } catch { return unresolved("RECONCILIATION_UNVERIFIED"); }
}

export async function runOneMetricSync(adapters: SocialAdapters) {
  const providers = Object.entries(adapters).filter(([, adapter]) => adapter.metricsAvailable !== false).map(([provider]) => provider);
  if (!providers.length) return false;
  const candidate = await db.socialPublication.findFirst({
    where: {
      status: "PUBLISHED",
      externalPostId: { not: null },
      nextMetricsAt: { lte: new Date() },
      OR: [
        { metricsLeaseUntil: null },
        { metricsLeaseUntil: { lt: new Date() } },
      ],
      connection: {
        status: "CONNECTED",
        provider: { in: providers },
      },
    },
    orderBy: { nextMetricsAt: "asc" },
  });
  if (!candidate) return false;
  const leaseUntil = new Date(Date.now() + 120000);
  const claimed = await db.socialPublication.updateMany({
    where: {
      id: candidate.id,
      status: "PUBLISHED",
      externalPostId: candidate.externalPostId,
      nextMetricsAt: { lte: new Date() },
      OR: [
        { metricsLeaseUntil: null },
        { metricsLeaseUntil: { lt: new Date() } },
      ],
    },
    data: { metricsLeaseUntil: leaseUntil },
  });
  if (!claimed.count) return true;
  const scope = {
    businessId: candidate.businessId,
    organizationId: candidate.organizationId,
    actorId: "metrics-worker",
  };
  try {
    const connection = await db.socialConnection.findUniqueOrThrow({
      where: { id: candidate.connectionId },
    });
    if (
      connection.status !== "CONNECTED" ||
      (connection.expiresAt && connection.expiresAt <= new Date())
    )
      throw Error("Connection unavailable");
    const reading = metricReading.parse(
      await adapters[socialProvider.parse(connection.provider)]!.metrics(
        account(connection),
        candidate.externalPostId!,
        AbortSignal.timeout(30000)
      )
    );
    if (
      reading.observedAt > new Date(Date.now() + 60000) ||
      reading.observedAt < candidate.publishedAt!
    )
      throw Error("Invalid metric observation time");
    await db.$transaction(async (tx) => {
      await lockBusiness(tx, scope);
      const freshConnection = await tx.socialConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      const post = await tx.socialPublication.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      if (
        post.metricsLeaseUntil?.getTime() !== leaseUntil.getTime()
      )
        return;
      const validPayload = (() => { try { frozenCopy(post.payload, post.payloadHash, connection.provider); return post.payloadHash === candidate.payloadHash; } catch { return false; } })();
      if (!validPayload || freshConnection.status !== "CONNECTED" || freshConnection.encryptedToken !== connection.encryptedToken || freshConnection.externalAccountId !== connection.externalAccountId || freshConnection.provider !== connection.provider || freshConnection.expiresAt && freshConnection.expiresAt <= new Date() || post.status !== "PUBLISHED" || post.externalPostId !== candidate.externalPostId) {
        await tx.socialPublication.update({ where: { id: post.id }, data: { metricsLeaseUntil: null, nextMetricsAt: null, errorCode: "METRICS_CONTEXT_CHANGED" } });
        return;
      }
      // Lifetime snapshots are upserted, never summed over time. Missing metrics remain null.
      await tx.metricSnapshot.upsert({
        where: {
          publicationId_observedAt_definitionVersion: {
            publicationId: post.id,
            observedAt: reading.observedAt,
            definitionVersion: reading.definitionVersion,
          },
        },
        create: {
          publicationId: post.id,
          businessId: post.businessId,
          organizationId: post.organizationId,
          ...reading,
        },
        update: {},
      });
      const ageDays = (Date.now() - post.publishedAt!.getTime()) / 86400000;
      await tx.socialPublication.update({
        where: { id: post.id },
        data: {
          metricsLeaseUntil: null,
          metricsFailures: 0,
          nextMetricsAt:
            ageDays > 30
              ? null
              : new Date(Date.now() + (ageDays < 2 ? 6 : 24) * 3600000),
        },
      });
    });
  } catch {
    await db.socialPublication.updateMany({
      where: { id: candidate.id, metricsLeaseUntil: leaseUntil },
      data: {
        metricsLeaseUntil: null,
        metricsFailures: { increment: 1 },
        nextMetricsAt:
          candidate.metricsFailures >= 4
            ? null
            : new Date(Date.now() + 3600000 * 2 ** candidate.metricsFailures),
      },
    });
  }
  return true;
}
