import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { authorizeSocialScope, type OAuthScope } from "./oauth";
import { stopSocialAccess } from "./access-lifecycle";

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
    // Legacy/restored rows can be labelled disconnected without having erased all local secrets.
    if (account.status === "DISCONNECTED" && account.encryptedToken === "" && account.permissions.length === 0 &&
        account.expiresAt === null && account.dataSnapshot === null && account.dataFetchedAt === null &&
        account.dataLeaseId === null && account.dataLeaseUntil === null)
      return { ok: true, alreadyDisconnected: true };
    const stopped = await stopSocialAccess(tx, account, "ACCOUNT_DISCONNECTED");
    await tx.auditEvent.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, actorId: scope.actorId,
      action: "SOCIAL_DISCONNECTED", detail: `Account ${account.id}; queued posts cancelled: ${stopped.cancelled}; uncertain posts retained: ${stopped.uncertain}; pending ${account.provider} requests cancelled: ${stopped.flows}. Local credentials removed; remote grants/posts unchanged.` } });
    return { ok: true, alreadyDisconnected: false };
  });
}
