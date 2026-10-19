import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness } from "../production/service";
import { frozenCopy } from "./integrity";

const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const request = z.object({
  organizationId: identifier, businessId: identifier, publicationId: identifier,
  operatorId: z.string().trim().min(3).max(120).regex(/^[^\x00-\x1f\x7f]+$/),
  apply: z.boolean().default(false), expectedStateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  evidence: z.string().trim().min(10).max(1000).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.apply && (!value.expectedStateHash || !value.evidence))
    ctx.addIssue({ code: "custom", message: "Applying recovery requires the preview fingerprint and operator evidence." });
});

// Privileged, explicit-scope CLI only. Never expose as a customer action.
// This closes a LOCAL attempt; it neither establishes upload failure nor removes remote media.
export async function stopUnsubmittedImage(raw: unknown) {
  const input = request.parse(raw);
  return db.$transaction(async tx => {
    const scope = { organizationId: input.organizationId, businessId: input.businessId, actorId: input.operatorId };
    await lockBusiness(tx, scope);
    const post = await tx.socialPublication.findFirst({ where: {
      id: input.publicationId, organizationId: input.organizationId, businessId: input.businessId,
    }, include: { connection: { select: { provider: true } } } });
    if (!post) throw new AppError(404, "Publication not found in this scope.");
    if (post.status !== "NEEDS_RECONCILIATION" || post.submissionAdapterVersion !== null ||
        post.candidatePostId !== null || post.externalPostId !== null || post.publishedAt !== null ||
        post.permalink !== null || post.leaseUntil && post.leaseUntil > new Date())
      throw new AppError(409, "Recovery requires an inactive image attempt with no post-submission fence or receipt. Never abandon an uncertain post.");
    let payload;
    try { payload = frozenCopy(post.payload, post.payloadHash, post.connection.provider); }
    catch { throw new AppError(409, "The immutable image snapshot could not be verified."); }
    // This image payload was introduced together with the mandatory durable post fence.
    // Older text adapters did not all use that fence; null alone is not enough evidence.
    if (!["LinkedIn", "Facebook", "Instagram"].includes(post.connection.provider) || !payload.mediaExportId || !(payload.image || payload.video))
      throw new AppError(409, "Only journalled approved-image workflows support this recovery.");
    const stateHash = createHash("sha256").update(JSON.stringify(post)).digest("hex");
    if (input.expectedStateHash && stateHash !== input.expectedStateHash)
      throw new AppError(409, "The attempt changed after review. Preview it again before applying recovery.");
    const preview = {
      publicationId: post.id, organizationId: post.organizationId, businessId: post.businessId,
      stateHash, imageRegistered: post.mediaExternalId !== null,
      mediaKind: payload.video ? post.connection.provider === "LinkedIn" ? "video" : "reel" : "image",
      uploadAcknowledged: post.mediaUploaded,
      warning: `No post-submission fence exists. A remote ${payload.video ? "video container" : "image"} may remain; no remote media is deleted. This closes the local attempt only and never retries it.`,
    };
    if (!input.apply) return { ...preview, applied: false, status: post.status };
    await tx.socialPublication.update({ where: { id: post.id }, data: {
      status: "FAILED", errorCode: "PREPOST_IMAGE_STOPPED", leaseUntil: null,
      nextReconciliationAt: null, nextMetricsAt: null, metricsLeaseUntil: null,
    } });
    await tx.auditEvent.create({ data: { ...scope, action: "SOCIAL_PREPOST_IMAGE_STOPPED",
      detail: `Publication ${post.id}; no post-submission fence or receipt. Remote upload may remain. Operator evidence: ${input.evidence}`,
    } });
    return { ...preview, applied: true, status: "FAILED" };
  });
}
