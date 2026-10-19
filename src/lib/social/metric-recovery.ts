import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { openSecret } from "../secrets";
import { authorizeSocialScope, type OAuthScope } from "./oauth";
import { configuredSocialAdapters, socialProvider, type SocialAdapters } from "./contracts";
import { frozenCopy } from "./integrity";

export const metricRecoveryRequest = z.object({
  publicationId: z.string().min(1).max(100),
  expectedRequestedAt: z.iso.datetime().nullable(),
}).strict();
export async function resumeMetricChecks(scope: OAuthScope, raw: unknown, adapters: () => SocialAdapters = configuredSocialAdapters) {
  const input = metricRecoveryRequest.parse(raw);
  return db.$transaction(async tx => {
    await authorizeSocialScope(tx, scope);
    const post = await tx.socialPublication.findFirst({ where: { id: input.publicationId, businessId: scope.businessId, organizationId: scope.organizationId }, include: { connection: true } });
    if (!post) throw new AppError(404, "Publication not found.");
    if ((post.metricsRequestedAt?.toISOString() ?? null) !== input.expectedRequestedAt) throw new AppError(409, "Metric recovery changed. Reload before requesting another check.");
    const now = new Date();
    if (post.status !== "PUBLISHED" || !post.externalPostId || !post.publishedAt || post.publishedAt > now || now.getTime() - post.publishedAt.getTime() > 30 * 86400000) throw new AppError(409, "Metric recovery requires a verified publication from the last 30 days.");
    if (post.metricsInvalidatedAt) throw new AppError(409, "This creative changed on the network. Its metrics cannot be re-approved or resumed.");
    if (post.nextMetricsAt || post.metricsLeaseUntil && post.metricsLeaseUntil > now) throw new AppError(409, "Metric checks are already scheduled or running. Existing backoff cannot be bypassed.");
    const connection = post.connection, provider = socialProvider.parse(connection.provider), adapter = adapters()[provider];
    if (!adapter || adapter.metricsAvailable === false) throw new AppError(503, "Verified post metrics are not enabled for this destination yet.");
    if (connection.status !== "CONNECTED" || connection.expiresAt && connection.expiresAt <= now) throw new AppError(409, "Reconnect this account before resuming metric checks.");
    try {
      if (frozenCopy(post.payload, post.payloadHash, provider).video) throw Error("Reel metrics are not enabled.");
      openSecret(connection.encryptedToken, `social:${scope.organizationId}:${scope.businessId}:${connection.id}`);
    } catch { throw new AppError(409, "The publication snapshot or account credentials cannot be verified. Contact your operator."); }
    if (post.metricsRequestedAt && now.getTime() - post.metricsRequestedAt.getTime() < 3600000) throw new AppError(429, "Wait one hour before resuming this publication again.");
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const used = await tx.auditEvent.count({ where: { businessId: scope.businessId, organizationId: scope.organizationId, action: "SOCIAL_METRICS_RESUMED", createdAt: { gte: dayStart } } });
    if (used >= 6) throw new AppError(429, "This business has used its six metric recovery requests for today (UTC).");
    await tx.socialPublication.update({ where: { id: post.id }, data: { metricsRequestedAt: now, metricsFailures: 0, metricsLeaseUntil: null, nextMetricsAt: now, errorCode: null } });
    await tx.auditEvent.create({ data: { organizationId: scope.organizationId, businessId: scope.businessId, actorId: scope.actorId, action: "SOCIAL_METRICS_RESUMED", detail: `Publication ${post.id}: resumed read-only metric checks after ${post.metricsFailures} failures. No post or credit operation.` } });
    return { ok: true, requestedAt: now.toISOString() };
  });
}
