import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness } from "../production/service";
import { openSecret } from "../secrets";
import { frozenCopy, MAX_RECONCILIATION_ATTEMPTS } from "./integrity";
import { SOCIAL_ACCESS_HOLDS } from "./access-lifecycle";

// Privileged server operation only. No customer route may call this helper.
// Reopens read-only lookup, never publication, receipt assignment or credit settlement.
export async function resumePublicationLookup(raw: unknown) {
  const input = z.object({ publicationId: z.string().min(1).max(100), operatorId: z.string().trim().min(3).max(120), evidence: z.string().trim().min(10).max(1000) }).strict().parse(raw);
  const initial = await db.socialPublication.findUnique({ where: { id: input.publicationId } });
  if (!initial) throw new AppError(404, "Publication not found.");
  return db.$transaction(async tx => {
    const scope = { businessId: initial.businessId, organizationId: initial.organizationId, actorId: input.operatorId };
    await lockBusiness(tx, scope);
    const post = await tx.socialPublication.findUniqueOrThrow({ where: { id: initial.id }, include: { connection: true } });
    if (post.status !== "NEEDS_RECONCILIATION" || post.externalPostId || post.publishedAt || post.leaseUntil && post.leaseUntil > new Date())
      throw new AppError(409, "Only an unconfirmed publication without an active lookup can be resumed.");
    if (!SOCIAL_ACCESS_HOLDS.includes(post.errorCode ?? "") && (!post.reconciliationAttempts || post.reconciliationAttempts < MAX_RECONCILIATION_ATTEMPTS && post.nextReconciliationAt))
      return { resumed: false }; // Already eligible or backing off: preserve its existing limit.
    try { frozenCopy(post.payload, post.payloadHash, post.connection.provider); }
    catch { throw new AppError(409, "Repair and verify the immutable publication snapshot before lookup."); }
    if (post.connection.status !== "CONNECTED" || post.connection.expiresAt && post.connection.expiresAt <= new Date())
      throw new AppError(409, "Verify the account connection before lookup.");
    try { openSecret(post.connection.encryptedToken, `social:${post.organizationId}:${post.businessId}:${post.connectionId}`); }
    catch { throw new AppError(409, "Restore credential decryption before lookup."); }
    await tx.socialPublication.update({ where: { id: post.id }, data: { reconciliationAttempts: 0, nextReconciliationAt: null, leaseUntil: null, errorCode: "OPERATOR_LOOKUP_RESUMED" } });
    await tx.auditEvent.create({ data: { ...scope, action: "SOCIAL_LOOKUP_RESUMED", detail: `Publication ${post.id}; prior checks ${post.reconciliationAttempts}. Operator evidence: ${input.evidence}` } });
    return { resumed: true };
  });
}
