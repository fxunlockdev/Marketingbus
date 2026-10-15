import { createHash } from "node:crypto";
import { db } from "../db";
import { openSecret } from "../secrets";
import { lockBusiness } from "../production/service";
import { creativeSchema } from "../production/content";
import { approvedFactText, evaluateCreative } from "../production/quality";
import {
  metricReading,
  publicationPayload,
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
    const payload = publicationPayload.parse(post.payload);
    if (
      createHash("sha256").update(JSON.stringify(payload)).digest("hex") !==
        post.payloadHash ||
      payload.caption !== creativeSchema.parse(post.revision.content).caption ||
      payload.channel !== post.connection.provider
    )
      reason = "PAYLOAD_CHANGED";
    if (
      !evaluateCreative(creativeSchema.parse(post.revision.content), {
        facts: approvedFactText(business),
      }).eligible
    )
      reason = "FACT_CHECK_FAILED";
    if (reason) {
      await tx.socialPublication.update({
        where: { id: post.id },
        data: { status: "CANCELLED", errorCode: reason },
      });
      return null;
    }
    const token = account(post.connection);
    await tx.socialPublication.update({
      where: { id: post.id },
      data: {
        status: "SUBMITTING",
        attempts: { increment: 1 },
        leaseUntil: new Date(Date.now() + 120000),
      },
    });
    return { post, payload, token };
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
      });
      if (fresh.status !== "SUBMITTING") return;
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
            nextMetricsAt: new Date(Date.now() + 3600000),
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
      where: { id: claimed.post.id, status: "SUBMITTING" },
      data: {
        status: "NEEDS_RECONCILIATION",
        leaseUntil: null,
        errorCode: "RECEIPT_UNVERIFIED",
      },
    });
  }
  return true;
}

export async function reconcilePublication(
  publicationId: string,
  adapters: SocialAdapters
) {
  const post = await db.socialPublication.findUnique({
    where: { id: publicationId },
    include: { connection: true },
  });
  if (!post || post.status !== "NEEDS_RECONCILIATION") return false;
  const provider = socialProvider.parse(post.connection.provider),
    adapter = adapters[provider];
  if (!adapter || post.connection.status !== "CONNECTED") return false;
  const receipt = await adapter.reconcile(
    account(post.connection),
    post.id,
    publicationPayload.parse(post.payload),
    AbortSignal.timeout(45000)
  );
  // Absence is not proof of non-publication: eventual consistency is common. Never resend.
  if (!receipt) return false;
  const verified = publishedReceipt.parse(receipt);
  if (
    verified.publishedAt > new Date(Date.now() + 60000) ||
    verified.publishedAt < post.createdAt
  )
    throw Error("Invalid publication time");
  const result = await db.socialPublication.updateMany({
    where: { id: post.id, status: "NEEDS_RECONCILIATION" },
    data: {
      ...verified,
      permalink: safePermalink(provider, verified.permalink),
      status: "PUBLISHED",
      errorCode: null,
      nextMetricsAt: new Date(Date.now() + 3600000),
    },
  });
  if (result.count)
    await db.auditEvent.create({
      data: {
        businessId: post.businessId,
        organizationId: post.organizationId,
        actorId: "social-reconciler",
        action: "SOCIAL_RECONCILED",
        detail: `Provider read-back confirmed publication ${post.id}. No new post submitted.`,
      },
    });
  return result.count > 0;
}

export async function runOneMetricSync(adapters: SocialAdapters) {
  if (!Object.keys(adapters).length) return false;
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
        provider: { in: Object.keys(adapters) },
      },
    },
    orderBy: { nextMetricsAt: "asc" },
  });
  if (!candidate) return false;
  const leaseUntil = new Date(Date.now() + 120000);
  const claimed = await db.socialPublication.updateMany({
    where: {
      id: candidate.id,
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
        freshConnection.status !== "CONNECTED" ||
        post.metricsLeaseUntil?.getTime() !== leaseUntil.getTime()
      )
        return;
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
