import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { assetStore, type AssetStore } from "../assets/storage";
import { assertCurrentExport } from "../composition/exports";
import { placements, type Placement } from "../composition/document";
import type { Scope } from "../production/service";
import { assertNoBlockingComments } from "../workflows/approvals";
import { publicationImage, type PublicationPayload } from "./contracts";
import { withSubmissionContext, type SubmissionContext } from "./submission-journal";

export const linkedInImageId = z.string().regex(/^urn:li:image:[A-Za-z0-9_-]{1,200}$/);
export const facebookImageId = z.string().regex(/^[1-9][0-9]{0,39}$/);
// A private export is selected by local ID. Clients cannot provide a URL, key or fingerprint.
export async function publicationExport(client: Prisma.TransactionClient | typeof db, scope: Scope, id: string, revisionId: string) {
  const row = await client.compositionExport.findFirst({ where: {
    id, businessId: scope.businessId, organizationId: scope.organizationId,
    status: "READY", purgeAfter: { gt: new Date() },
    composition: { revisionId, organizationId: scope.organizationId, businessId: scope.businessId },
  }, include: { composition: { select: { revisionId: true, itemId: true } } } });
  if (!row) throw new AppError(409, "Choose a retained, approved image export for this exact copy version.");
  await assertCurrentExport(scope, row, client);
  await assertNoBlockingComments(client, revisionId);
  const dimensions = placements[row.placement as Placement];
  if (!dimensions || !row.sha256 || !row.bytes) throw new AppError(409, "Image export metadata is unavailable.");
  return { row, dimensions };
}
export async function assertPublicationImage(client: Prisma.TransactionClient | typeof db, scope: Scope, revisionId: string, payload: PublicationPayload) {
  if (!payload.mediaExportId || !payload.image) throw new AppError(409, "An approved image is required.");
  const { row, dimensions } = await publicationExport(client, scope, payload.mediaExportId, revisionId);
  if (row.sha256 !== payload.image.sha256 || row.bytes !== payload.image.bytes || dimensions[0] !== payload.image.width || dimensions[1] !== payload.image.height) throw new AppError(409, "The selected image fingerprint changed.");
  const revision = await client.creativeRevision.findUniqueOrThrow({ where: { id: revisionId } });
  if (z.object({ headline: z.literal(payload.image.altText) }).safeParse(revision.content).success === false) throw new AppError(409, "The approved image description changed.");
  publicationImage.parse(payload.image);
  return row;
}
export async function listPublicationImages(scope: Scope) {
  const candidates = await db.compositionExport.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, status: "READY", purgeAfter: { gt: new Date() }, composition: { status: "APPROVED" } },
    include: { composition: { select: { revisionId: true, itemId: true } } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 50 });
  const revisions = await db.creativeRevision.findMany({ where: { id: { in: candidates.map(row => row.composition.revisionId) }, organizationId: scope.organizationId }, select: { id: true, version: true } });
  const result = [];
  for (const row of candidates) {
    try {
      await assertCurrentExport(scope, row);
      await assertNoBlockingComments(db, row.composition.revisionId);
      const revision = revisions.find(r => r.id === row.composition.revisionId);
      if (revision) result.push({ id: row.id, itemId: row.composition.itemId, revisionVersion: revision.version, placement: row.placement, expiresAt: row.purgeAfter, bytes: row.bytes });
    } catch (error) { if (!(error instanceof AppError)) throw error; }
  }
  return result;
}

export type ImageTransferState = { started: boolean; externalId: string | null; uploaded: boolean };
export interface SocialImageTransfer {
  inspect(context: SubmissionContext): Promise<ImageTransferState>;
  read(context: SubmissionContext): Promise<Uint8Array>;
  check(context: SubmissionContext): Promise<void>;
  begin(context: SubmissionContext): Promise<boolean>;
  record(context: SubmissionContext, externalId: string): Promise<void>;
  uploaded(context: SubmissionContext, externalId: string): Promise<void>;
}
// Separate fences for media registration and publication. Unknown outcomes never repeat writes.
export function createImageTransfer(store: () => AssetStore = assetStore): SocialImageTransfer {
  const current = async (tx: Prisma.TransactionClient, post: Parameters<Parameters<typeof withSubmissionContext>[1]>[1], ctx: SubmissionContext) => {
    if (post.status !== "SUBMITTING" || !post.leaseUntil || post.leaseUntil <= new Date() || post.submissionAdapterVersion) throw new AppError(409, "Image transfer ownership changed.");
    if (post.mediaTransferVersion && post.mediaTransferVersion !== ctx.adapterVersion) throw new AppError(409, "Image transfer configuration changed.");
    return assertPublicationImage(tx, { businessId: post.businessId, organizationId: post.organizationId, actorId: "social-media-worker" }, post.revisionId, ctx.payload);
  };
  return {
    inspect: ctx => withSubmissionContext(ctx, async (_tx, post) => {
      if (post.mediaTransferVersion && post.mediaTransferVersion !== ctx.adapterVersion) throw Error("Image transfer configuration changed.");
      return { started: !!post.mediaTransferVersion, externalId: post.mediaExternalId, uploaded: post.mediaUploaded };
    }),
    check: ctx => withSubmissionContext(ctx, async (tx, post) => { await current(tx, post, ctx); }),
    read: async ctx => {
      const row = await withSubmissionContext(ctx, (tx, post) => current(tx, post, ctx));
      const bytes = await store().get(row.objectKey);
      if (bytes.length !== ctx.payload.image?.bytes || createHash("sha256").update(bytes).digest("hex") !== ctx.payload.image.sha256) throw new AppError(409, "Stored publication image failed integrity checks.");
      await withSubmissionContext(ctx, (tx, post) => current(tx, post, ctx));
      return bytes;
    },
    begin: ctx => withSubmissionContext(ctx, async (tx, post) => {
      await current(tx, post, ctx);
      if (post.mediaTransferVersion) return false;
      await tx.socialPublication.update({ where: { id: post.id }, data: { mediaTransferVersion: ctx.adapterVersion } });
      return true;
    }),
    record: (ctx, id) => withSubmissionContext(ctx, async (tx, post) => {
      await current(tx, post, ctx);
      if (ctx.account.provider === "LinkedIn") linkedInImageId.parse(id);
      else if (["Facebook", "Instagram"].includes(ctx.account.provider)) facebookImageId.parse(id);
      else throw Error("Unsupported image destination.");
      if (post.mediaTransferVersion !== ctx.adapterVersion || post.mediaExternalId || post.mediaUploaded) throw Error("Image registration already recorded or unavailable.");
      await tx.socialPublication.update({ where: { id: post.id }, data: { mediaExternalId: id } });
    }),
    uploaded: (ctx, id) => withSubmissionContext(ctx, async (tx, post) => {
      await current(tx, post, ctx);
      if (post.mediaTransferVersion !== ctx.adapterVersion || post.mediaExternalId !== id) throw Error("Image upload identity changed.");
      await tx.socialPublication.update({ where: { id: post.id }, data: { mediaUploaded: true } });
    }),
  };
}
