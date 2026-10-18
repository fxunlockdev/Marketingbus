import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { authorizeSocialScope, type OAuthScope } from "./oauth";
import { eraseSocialData } from "./account-data-service";

export const disconnectInput = z.object({
  action: z.literal("disconnect"), connectionId: z.string().min(1).max(100),
  authorizationVersion: z.number().int().positive(),
}).strict();

// Local credential removal, not remote grant revocation or deletion of remote posts.
// In-flight HTTP cannot be recalled; its result stays uncertain rather than becoming retryable.
export async function disconnectSocialAccount(scope: OAuthScope, raw: unknown) {
  const input = disconnectInput.parse(raw);
  return db.$transaction(async tx => {
    await authorizeSocialScope(tx, scope);
    const account = await tx.socialConnection.findFirst({ where: {
      id: input.connectionId, businessId: scope.businessId, organizationId: scope.organizationId,
    } });
    if (!account) throw new AppError(404, "Social account not found.");
    if (account.authorizationVersion !== input.authorizationVersion)
      throw new AppError(409, "Account access changed. Refresh connections and review before disconnecting.");
    if (account.status === "DISCONNECTED") return { ok: true, alreadyDisconnected: true };
    await tx.socialConnection.update({ where: { id: account.id }, data: {
      ...eraseSocialData, status: "DISCONNECTED", encryptedToken: "", permissions: [], expiresAt: null,
      authorizationVersion: { increment: 1 },
    } });
    const posts = { connectionId: account.id, businessId: scope.businessId, organizationId: scope.organizationId };
    const cancelled = await tx.socialPublication.updateMany({ where: { ...posts, status: "SCHEDULED" },
      data: { status: "CANCELLED", errorCode: "ACCOUNT_DISCONNECTED", leaseUntil: null } });
    // Retain the active request's lease as a reconnect barrier; never discard candidate IDs or the write fence.
    const uncertain = await tx.socialPublication.updateMany({ where: { ...posts, status: { in: ["SUBMITTING", "NEEDS_RECONCILIATION"] } },
      data: { status: "NEEDS_RECONCILIATION", nextReconciliationAt: null, errorCode: "ACCOUNT_DISCONNECTED" } });
    await tx.socialPublication.updateMany({ where: posts, data: { nextMetricsAt: null, metricsLeaseUntil: null } });
    // Pending encrypted choices may contain this same grant. Cancel this provider's flows across sessions,
    // but never other businesses/providers. A new explicit connection can be started after disconnection.
    const flows = await tx.socialOAuthFlow.updateMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId,
      provider: account.provider, status: { in: ["PENDING", "EXCHANGING", "CHOOSING"] } },
      data: { status: "CANCELLED", encryptedVerifier: null, encryptedCandidates: null, errorCode: "ACCOUNT_DISCONNECTED" } });
    await tx.auditEvent.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, actorId: scope.actorId,
      action: "SOCIAL_DISCONNECTED", detail: `Account ${account.id}; queued posts cancelled: ${cancelled.count}; uncertain posts retained: ${uncertain.count}; pending ${account.provider} requests cancelled: ${flows.count}. Local credentials removed; remote grants/posts unchanged.` } });
    return { ok: true, alreadyDisconnected: false };
  });
}
