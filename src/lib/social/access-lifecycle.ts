import { Prisma, type SocialConnection } from "@prisma/client";
import { db } from "../db";

// These holds require explicit recovery after reconnection; a null next-check time is not a retry.
export const SOCIAL_ACCESS_HOLDS = ["ACCOUNT_DISCONNECTED", "ACCOUNT_EXPIRED", "ACCOUNT_REVOKED"];
type AccessLoss = "ACCOUNT_DISCONNECTED" | "ACCOUNT_EXPIRED" | "ACCOUNT_REVOKED";

// Caller must hold the owning Business row lock and revalidate the exact grant first.
// This is local credential removal, not a remote revoke or a remote-post deletion.
export async function stopSocialAccess(tx: Prisma.TransactionClient, account: SocialConnection, reason: AccessLoss) {
  await tx.socialConnection.update({ where: { id: account.id }, data: {
    status: reason === "ACCOUNT_DISCONNECTED" ? "DISCONNECTED" : "RECONNECT_REQUIRED",
    encryptedToken: "", permissions: [], expiresAt: null, authorizationVersion: { increment: 1 },
    dataSnapshot: Prisma.DbNull, dataFetchedAt: null, dataLeaseId: null, dataLeaseUntil: null, dataErrorCode: null,
  } });
  const posts = { connectionId: account.id, businessId: account.businessId, organizationId: account.organizationId };
  const cancelled = await tx.socialPublication.updateMany({ where: { ...posts, status: "SCHEDULED" },
    data: { status: "CANCELLED", errorCode: reason, leaseUntil: null } });
  // Keep leases, candidate IDs, upload IDs and submission fences. In-flight HTTP cannot be recalled.
  const uncertain = await tx.socialPublication.updateMany({ where: { ...posts, status: { in: ["SUBMITTING", "NEEDS_RECONCILIATION"] } },
    data: { status: "NEEDS_RECONCILIATION", nextReconciliationAt: null, errorCode: reason } });
  await tx.socialPublication.updateMany({ where: posts, data: { nextMetricsAt: null, metricsLeaseUntil: null } });
  // Expiry must not cancel a fresh renewal already in progress. Choices are independently checked
  // for expiry on selection. Explicit disconnection/revocation invalidates pending same-provider grants.
  const flows = reason === "ACCOUNT_EXPIRED" ? { count: 0 } : await tx.socialOAuthFlow.updateMany({
    where: { businessId: account.businessId, organizationId: account.organizationId, provider: account.provider,
      status: { in: ["PENDING", "EXCHANGING", "CHOOSING"] } },
    data: { status: "CANCELLED", encryptedVerifier: null, encryptedCandidates: null, errorCode: reason },
  });
  return { cancelled: cancelled.count, uncertain: uncertain.count, flows: flows.count };
}

export async function expireOneSocialConnection() {
  // One account per tick, even while publishing is disabled. No provider/network calls or decryption.
  const candidate = await db.socialConnection.findFirst({
    where: { status: "CONNECTED", expiresAt: { lte: new Date() } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    select: { id: true, businessId: true, organizationId: true, authorizationVersion: true, expiresAt: true },
  });
  if (!candidate) return false;
  return db.$transaction(async tx => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Business"
      WHERE id=${candidate.businessId} AND "organizationId"=${candidate.organizationId} FOR UPDATE SKIP LOCKED`;
    if (!locked.length) return false;
    const account = await tx.socialConnection.findUnique({ where: { id: candidate.id } });
    if (!account || account.status !== "CONNECTED" || account.authorizationVersion !== candidate.authorizationVersion ||
        !account.expiresAt || account.expiresAt.getTime() !== candidate.expiresAt?.getTime() || account.expiresAt > new Date()) return false;
    const stopped = await stopSocialAccess(tx, account, "ACCOUNT_EXPIRED");
    await tx.auditEvent.create({ data: {
      organizationId: account.organizationId, businessId: account.businessId, actorId: "social-access-worker",
      action: "SOCIAL_ACCESS_EXPIRED", detail: `Account ${account.id}; queued posts cancelled: ${stopped.cancelled}; uncertain posts retained: ${stopped.uncertain}. Expired local credentials and account snapshot removed. Remote posts unchanged; explicit reconnection required.`,
    } });
    return true;
  });
}
