import { db } from "../db";
import { openSecret } from "../secrets";
import { lockBusiness } from "../production/service";
import { frozenCopy, payloadHash, validCandidateId } from "./integrity";
import { assertPublicationMedia } from "./image-transfer";
import type { Account, PublicationPayload } from "./contracts";
export type SubmissionContext = { requestId: string; account: Account; payload: PublicationPayload; adapterVersion: string };
export interface SubmissionJournal {
  begin(context: SubmissionContext): Promise<boolean>;
  record(context: SubmissionContext, externalPostId: string): Promise<void>;
  candidate(context: SubmissionContext): Promise<string | null>;
}
// A durable local write fence is not provider idempotency. Lost remote IDs remain uncertain.
import type { Prisma, SocialPublication, SocialConnection } from "@prisma/client";
export async function withSubmissionContext<T>(context: SubmissionContext, run: (tx: Prisma.TransactionClient, post: SocialPublication & { connection: SocialConnection }) => Promise<T>) {
  return db.$transaction(async tx => {
    const initial = await tx.socialPublication.findUniqueOrThrow({ where: { id: context.requestId } });
    await lockBusiness(tx, { organizationId: initial.organizationId, businessId: initial.businessId, actorId: "social-transport" });
    const post = await tx.socialPublication.findUniqueOrThrow({ where: { id: initial.id }, include: { connection: true } });
    const c = post.connection;
    // A reconnect revokes old delivery/writes, but an operator may still read a known post candidate.
    if (post.status === "SUBMITTING" && post.mediaDeliveryAuthorizationVersion !== null && post.mediaDeliveryAuthorizationVersion !== c.authorizationVersion) throw Error("Media delivery authorization changed.");
    frozenCopy(post.payload, post.payloadHash, c.provider);
    if (!["SUBMITTING", "NEEDS_RECONCILIATION"].includes(post.status) || c.id !== context.account.id || c.provider !== context.account.provider || c.externalAccountId !== context.account.externalAccountId || c.status !== "CONNECTED" || !c.expiresAt || c.expiresAt <= new Date() || post.payloadHash !== payloadHash(context.payload) || openSecret(c.encryptedToken, `social:${post.organizationId}:${post.businessId}:${c.id}`) !== context.account.token) throw Error("Publication context changed.");
    return run(tx, post);
  });
}
const transact = withSubmissionContext;
export const submissionJournal: SubmissionJournal = {
  begin: context => transact(context, async (tx, post) => {
    if (post.submissionAdapterVersion || post.status !== "SUBMITTING" || !post.leaseUntil || post.leaseUntil <= new Date()) return false;
    if (context.payload.mediaExportId) {
      if (post.mediaTransferVersion !== context.adapterVersion || !post.mediaExternalId || !post.mediaUploaded) return false;
      if (context.payload.video && process.env.INSTAGRAM_REELS_ENABLED !== "true") return false;
      await assertPublicationMedia(tx, { businessId: post.businessId, organizationId: post.organizationId, actorId: "social-transport" }, post.revisionId, context.payload);
    }
    await tx.socialPublication.update({ where: { id: post.id }, data: { submissionAdapterVersion: context.adapterVersion } });
    return true;
  }),
  record: (context, externalPostId) => transact(context, async (tx, post) => {
    if (post.submissionAdapterVersion !== context.adapterVersion || (post.candidatePostId && post.candidatePostId !== externalPostId) || !validCandidateId(context.account.provider, externalPostId, context.account.externalAccountId)) throw Error("Unverified publication candidate.");
    await tx.socialPublication.update({ where: { id: post.id }, data: { candidatePostId: externalPostId } });
  }),
  candidate: context => transact(context, async (_tx, post) => post.submissionAdapterVersion === context.adapterVersion ? post.candidatePostId : null),
};
