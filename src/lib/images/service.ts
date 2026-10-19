import { createHash, randomUUID } from "node:crypto";
import type { ImageGeneration, Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { currentItem, lockBusiness, type Scope } from "../production/service";
import { assertBrandEditor } from "../knowledge/analysis";
import { assertWorkerReady } from "../production/readiness";
import { assertExecutionEnabled } from "../production/router";
import { authorizeSupplier } from "../production/budget";
import { reserveCreditsInTransaction, finishReservationInTransaction } from "../billing/wallet";
import { assertReviewer, assertNoBlockingComments } from "../workflows/approvals";
import { invalidatePublications } from "../social/service";
import { assetStore, type AssetStore } from "../assets/storage";
import { BUSINESS_ASSET_BYTES, MAX_IMAGE_BYTES } from "../assets/images";
import { creativeSchema } from "../production/content";
import { IMAGE_HARNESS, imageConfigurationHash, imageReferences, selectImageRoute } from "./contracts";
import { weeklyImageContext, reserveWeeklyImage, type WeeklyImageAuthorization } from "../workflows/weekly-image-policy";

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), itemId: z.string().min(1), parentId: z.string().min(1).optional(), feedback: z.string().trim().max(1000).default("") }).strict(),
  z.object({ action: z.enum(["accept", "cancel", "reject"]), generationId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("approve"), generationId: z.string().min(1), fidelityReviewed: z.literal(true) }).strict(),
]);
export const pendingImages = ["QUEUED", "RUNNING", "SUBMITTING", "NEEDS_RECONCILIATION"];
export function imageScope(row: ImageGeneration): Scope { return { businessId: row.businessId, organizationId: row.organizationId, actorId: row.actorId }; }
export async function imageReferenceAssets(client: Pick<Prisma.TransactionClient, "brandAsset">, row: ImageGeneration) {
  const refs = imageReferences.parse(row.references);
  const assets = await client.brandAsset.findMany({ where: { id: { in: refs.map(r => r.id) }, businessId: row.businessId, organizationId: row.organizationId, status: "READY" } });
  if (assets.length !== refs.length || refs.some(ref => !assets.some(a => a.id === ref.id && a.sha256 === ref.sha256 && (ref.parent ? a.generationId === row.parentId : a.purpose === "reference" && a.approvedForGeneration)))) throw new AppError(409, "An image reference changed or its permission was revoked.");
  return assets;
}
export async function currentImageContext(tx: Prisma.TransactionClient, row: ImageGeneration) {
  const scope = imageScope(row), business = await lockBusiness(tx, scope), item = await currentItem(tx, scope, row.itemId), revision = item.revisions[0];
  if (!business.confirmedAt || business.version !== row.brandVersion || item.plan.brandVersion !== business.version || item.plan.status !== "PROPOSED" || revision?.id !== row.revisionId || revision.status !== "APPROVED") throw new AppError(409, "Brand or approved copy changed. Request a new image quote.");
  const newer = await tx.imageGeneration.count({ where: { itemId: row.itemId, version: { gt: row.version }, acceptedAt: { not: null } } });
  if (newer) throw new AppError(409, "A newer image version was authorized.");
  const assets = await imageReferenceAssets(tx, row);
  return { business, item, revision, assets };
}
export async function listImages(scope: Scope) {
  const member = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member || !await db.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } })) throw new AppError(404, "Business not found.");
  return { canEdit: ["OWNER", "ADMIN", "EDITOR"].includes(member.role), images: await db.imageGeneration.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId }, orderBy: { createdAt: "desc" }, take: 100, select: {
    id: true, itemId: true, revisionId: true, version: true, status: true, credits: true, feedback: true, errorCode: true, expiresAt: true,
    output: { select: { id: true, status: true, approvedForGeneration: true } },
  } }) };
}
export async function manageImage(scope: Scope, raw: unknown, storage: () => AssetStore = assetStore, internal?: WeeklyImageAuthorization) {
  const input = action.parse(raw);
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const audit = (event: string, detail: string) => tx.auditEvent.create({ data: { ...scope, action: event, detail } });
    if (input.action === "quote") {
      assertExecutionEnabled(); await assertWorkerReady(tx); storage();
      const item = await currentItem(tx, scope, input.itemId), revision = item.revisions[0];
      if (internal) {
        const { task } = await weeklyImageContext(tx, scope, item.id, internal);
        if (task.imageStatus !== "WAITING" || task.imageGenerationId || input.parentId || input.feedback || await tx.imageGeneration.count({ where: { itemId: item.id } }))
          throw new AppError(409, "Manual image work or a previous weekly image already exists. It will not be replaced.");
      }
      if (!business.confirmedAt || item.plan.brandVersion !== business.version || item.plan.status !== "PROPOSED" || item.format !== "static" || revision?.status !== "APPROVED") throw new AppError(409, "Confirm the brand and approve current static copy before generating an image.");
      if (await tx.imageGeneration.count({ where: { businessId: scope.businessId, status: { in: pendingImages } } })) throw new AppError(409, "Resolve the current image job before requesting another.");
      if (await tx.imageGeneration.count({ where: { businessId: scope.businessId, createdAt: { gt: new Date(Date.now() - 86400000) } } }) >= 24) throw new AppError(429, "Image quotes are limited to 24 per business per day.");
      const previous = await tx.imageGeneration.findFirst({ where: { itemId: item.id }, orderBy: { version: "desc" } });
      if ((previous?.version || 0) >= 100) throw new AppError(409, "Image version allowance reached.");
      const assets = await tx.brandAsset.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, purpose: "reference", approvedForGeneration: true, status: "READY" }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 2 });
      const refs = assets.map(a => ({ id: a.id, sha256: a.sha256, parent: false }));
      if (input.parentId) {
        if (input.feedback.length < 5) throw new AppError(400, "Describe the specific change in at least five characters.");
        const parent = await tx.imageGeneration.findFirst({ where: { id: input.parentId, itemId: item.id, businessId: scope.businessId, organizationId: scope.organizationId, status: { in: ["READY", "APPROVED", "REJECTED"] } }, include: { output: true } });
        if (!parent?.output || parent.output.status !== "READY") throw new AppError(409, "Select a current, completed image to revise.");
        await currentImageContext(tx, parent);
        // Preserve the initial style permissions across the entire revision lineage.
        // Newly uploaded references must not silently change a focused revision.
        refs.splice(0, refs.length, ...imageReferences.parse(parent.references).filter(ref => !ref.parent));
        refs.push({ id: parent.output.id, sha256: parent.output.sha256, parent: true });
      } else if (input.feedback) throw new AppError(400, "Feedback belongs to a specific image revision.");
      const copy = creativeSchema.parse(revision.content);
      const prompt = IMAGE_HARNESS + "\nBRIEF DATA:\n" + JSON.stringify({ business: business.name, offering: business.offering, audience: business.audience, tone: business.tone, restrictions: business.restrictions, contentPreferences: business.contentPreferences, palette: business.color, preset: business.designPreset, direction: copy.visualDirection, feedback: input.feedback, referenceOrder: refs.map(r => r.parent ? "previous artwork to revise" : "style reference") });
      const route = selectImageRoute(!!input.parentId, prompt, refs.length);
      await tx.imageGeneration.updateMany({ where: { itemId: item.id, status: "OFFERED" }, data: { status: "CANCELLED" } });
      const row = await tx.imageGeneration.create({ data: { ...scope, itemId: item.id, revisionId: revision.id, brandVersion: business.version, version: (previous?.version || 0) + 1, parentId: input.parentId, feedback: input.feedback, prompt, references: refs, route, configurationHash: imageConfigurationHash(), credits: route.credits, supplierCeilingMicros: route.supplierCeilingMicros, expiresAt: new Date(Date.now() + 600000) } });
      if (internal) await tx.weeklyTask.update({ where: { id: internal.taskId }, data: { imageGenerationId: row.id, imageStatus: "QUOTED" } });
      await audit("IMAGE_QUOTED", "Supporting artwork quoted against approved copy and immutable reference hashes. No charge or provider call.");
      return { ok: true, generationId: row.id };
    }
    const row = await tx.imageGeneration.findFirst({ where: { id: input.generationId, businessId: scope.businessId, organizationId: scope.organizationId }, include: { output: true } });
    if (!row) throw new AppError(404, "Image job not found.");
    if (input.action === "cancel") {
      if (row.status === "CANCELLED") return { ok: true };
      if (!["OFFERED", "QUEUED", "RUNNING"].includes(row.status)) throw new AppError(409, "Submission started or finished. Uncertain outcomes require operator review, not a retry.");
      if (row.reservationId) await finishReservationInTransaction(tx, scope.organizationId, row.reservationId, 0);
      await tx.imageGeneration.update({ where: { id: row.id }, data: { status: "CANCELLED", leaseUntil: null } });
      if (row.output) await tx.brandAsset.update({ where: { id: row.output.id }, data: { status: "DELETED", bytes: 0 } });
      await audit("IMAGE_CANCELLED", "Cancelled before submission. Held credits and unused storage released.");
      return { ok: true };
    }
    if (input.action === "accept") {
      if (!internal && await tx.weeklyTask.count({ where: { imageGenerationId: row.id, imageStatus: "QUOTED" } }))
        throw new AppError(409, "This image offer belongs to an automatic weekly run. Stop that run before requesting a separate manual offer.");
      if (row.acceptedAt) return { ok: true };
      assertExecutionEnabled(); await assertWorkerReady(tx); storage();
      if (row.status !== "OFFERED" || row.expiresAt.getTime() <= Date.now() || row.configurationHash !== imageConfigurationHash()) throw new AppError(409, "Image quote expired or settings changed.");
      await currentImageContext(tx, row);
      if (await tx.imageGeneration.count({ where: { businessId: scope.businessId, status: { in: pendingImages } } })) throw new AppError(409, "Resolve the current image job first.");
      const quota = await tx.brandAsset.aggregate({ where: { businessId: scope.businessId, status: { not: "DELETED" } }, _sum: { bytes: true }, _count: true });
      if (quota._count >= 100 || (quota._sum.bytes || 0) + MAX_IMAGE_BYTES > BUSINESS_ASSET_BYTES) throw new AppError(409, "Allow 5 MB of free private image storage before generation.");
      if (internal) await reserveWeeklyImage(tx, scope, row, internal);
      await authorizeSupplier(tx, row.id, row.supplierCeilingMicros);
      const hold = await reserveCreditsInTransaction(tx, scope.organizationId, row.id, row.credits, !!row.parentId);
      await tx.brandAsset.create({ data: { organizationId: scope.organizationId, businessId: scope.businessId, generationId: row.id, purpose: "generated", label: `Artwork v${row.version}`, objectKey: `${scope.organizationId}/${scope.businessId}/${randomUUID()}.webp`, sha256: "", bytes: MAX_IMAGE_BYTES, width: 1, height: 1, uploadedBy: scope.actorId, rightsConfirmedAt: new Date() } });
      await invalidatePublications(tx, scope.businessId, row.itemId);
      await tx.brandAsset.updateMany({ where: { generation: { itemId: row.itemId }, approvedForGeneration: true }, data: { approvedForGeneration: false } });
      await tx.imageGeneration.updateMany({ where: { itemId: row.itemId, status: "APPROVED" }, data: { status: "SUPERSEDED", approvedBy: null } });
      await tx.staticComposition.updateMany({ where: { itemId: row.itemId }, data: { status: "SUPERSEDED", approvedBy: null } });
      await tx.imageGeneration.update({ where: { id: row.id }, data: { status: "QUEUED", reservationId: hold.id, acceptedAt: new Date(), actorId: scope.actorId } });
      await audit("IMAGE_AUTHORIZED", `At most ${row.credits} credits reserved; one submission only. Human visual approval required.`);
      return { ok: true };
    }
    await currentImageContext(tx, row);
    if (!["READY", "APPROVED", "REJECTED"].includes(row.status) || row.output?.status !== "READY") throw new AppError(409, "A verified current image is required for review.");
    await assertReviewer(tx, scope, business.independentApproval, row.actorId);
    await assertNoBlockingComments(tx, row.revisionId);
    if ((input.action === "approve" && row.status === "APPROVED" && row.output.approvedForGeneration) || (input.action === "reject" && row.status === "REJECTED" && !row.output.approvedForGeneration)) return { ok: true };
    await invalidatePublications(tx, scope.businessId, row.itemId);
    await tx.staticComposition.updateMany({ where: { itemId: row.itemId }, data: { status: "SUPERSEDED", approvedBy: null } });
    await tx.imageGeneration.update({ where: { id: row.id }, data: { status: input.action === "approve" ? "APPROVED" : "REJECTED", approvedBy: input.action === "approve" ? scope.actorId : null } });
    await tx.brandAsset.update({ where: { id: row.output.id }, data: { approvedForGeneration: input.action === "approve" } });
    await audit(`IMAGE_${input.action.toUpperCase()}`, "Human visual review recorded; this is not automated fidelity or factual certification. Compose and approve the final layout separately.");
    return { ok: true };
  });
}
export async function previewImage(scope: Scope, generationId: string, store: AssetStore = assetStore()) {
  const read = () => db.$transaction(async tx => {
    await lockBusiness(tx, scope);
    if (!await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } })) throw new AppError(404, "Workspace not found.");
    const row = await tx.imageGeneration.findFirst({ where: { id: generationId, businessId: scope.businessId, organizationId: scope.organizationId, status: { in: ["READY", "APPROVED", "REJECTED"] } }, include: { output: true } });
    if (row?.output?.status !== "READY") throw new AppError(404, "Image preview unavailable.");
    await currentImageContext(tx, row); return row.output;
  });
  const asset = await read(), bytes = await store.get(asset.objectKey);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new AppError(409, "Image integrity check failed.");
  await read(); return bytes;
}
