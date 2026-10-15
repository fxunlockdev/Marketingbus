import { createHash } from "node:crypto";
import { assertReviewer, assertNoBlockingComments } from "../workflows/approvals";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, currentItem, type Scope } from "../production/service";
import { invalidatePublications } from "../social/service";
import { creativeSchema } from "../production/content";
import { canvasDocument, initialCanvas, type Placement } from "./document";
import { renderCanvas } from "./render";
import { assetStore, type AssetStore } from "../assets/storage";
export const compositionAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      itemId: z.string().min(1),
      revisionVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("edit"),
      itemId: z.string().min(1),
      version: z.number().int().positive(),
      document: canvasDocument,
    })
    .strict(),
  z
    .object({
      action: z.literal("approve"),
      itemId: z.string().min(1),
      version: z.number().int().positive(),
    })
    .strict(),
]);
export async function manageComposition(scope: Scope, raw: unknown) {
  const input = compositionAction.parse(raw);
  return db.$transaction(async (tx) => {
    const business = await lockBusiness(tx, scope),
      item = await currentItem(tx, scope, input.itemId),
      revision = item.revisions[0];
    if (
      !business.confirmedAt ||
      item.plan.brandVersion !== business.version ||
      item.plan.status !== "PROPOSED" ||
      !revision ||
      !["READY", "APPROVED"].includes(revision.status)
    )
      throw new AppError(
        409,
        "Create current, reviewed copy before composing a static image."
      );
    if (item.format !== "static")
      throw new AppError(409, "Static composition requires a static creative.");
    const previous = await tx.staticComposition.findFirst({
      where: {
        itemId: item.id,
        businessId: scope.businessId,
        organizationId: scope.organizationId,
      },
      orderBy: { version: "desc" },
    });
    const assets = await tx.brandAsset.findMany({
      where: {
        businessId: scope.businessId,
        organizationId: scope.organizationId,
        status: "READY",
        approvedForGeneration: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 100,
    });
    if (
      (input.action === "create" &&
        revision.version !== input.revisionVersion) ||
      (input.action !== "create" && previous?.version !== input.version)
    )
      throw new AppError(409, "This work changed. Refresh before composing.");
    if (
      input.action !== "create" &&
      (previous?.revisionId !== revision.id ||
        previous.brandVersion !== business.version)
    )
      throw new AppError(
        409,
        "Create a composition for the current copy first."
      );
    if (
      input.action === "create" &&
      previous?.revisionId === revision.id &&
      previous.brandVersion === business.version
    )
      return { ok: true, composition: previous };
    const document =
      input.action === "create"
        ? initialCanvas(business, assets)
        : input.action === "edit"
        ? input.document
        : canvasDocument.parse(previous!.document);
    for (const layer of document.layers)
      if (
        layer.kind === "image" &&
        !assets.some((a) => a.id === layer.assetId && a.sha256 === layer.sha256)
      )
        throw new AppError(
          409,
          "Every image must be an approved, unchanged asset from this business."
        );
    await invalidatePublications(tx, scope.businessId, item.id);
    if (input.action === "approve") {
      await assertReviewer(tx, scope, business.independentApproval, previous!.authorId);
      await assertNoBlockingComments(tx, revision.id);
      if (revision.status !== "APPROVED")
        throw new AppError(
          409,
          "Approve the exact copy before approving its composition."
        );
      const composition = await tx.staticComposition.update({
        where: { id: previous!.id },
        data: { status: "APPROVED", approvedBy: scope.actorId },
      });
      await tx.auditEvent.create({
        data: {
          ...scope,
          action: "COMPOSITION_APPROVED",
          detail: `Composition ${composition.id}, copy version ${revision.version}: explicit visual approval. Export checks still enforce asset permissions and layout fit.`,
        },
      });
      return { ok: true, composition };
    }
    if ((previous?.version ?? 0) >= 100)
      throw new AppError(
        409,
        "Composition version allowance reached for this creative."
      );
    if (previous)
      await tx.staticComposition.update({
        where: { id: previous.id },
        data: { status: "SUPERSEDED" },
      });
    const composition = await tx.staticComposition.create({
      data: {
        businessId: scope.businessId,
        organizationId: scope.organizationId,
        itemId: item.id,
        revisionId: revision.id,
        brandVersion: business.version,
        version: (previous?.version ?? 0) + 1,
        document,
        authorId: scope.actorId,
      },
    });
    await tx.auditEvent.create({
      data: {
        ...scope,
        action: "COMPOSITION_SAVED",
        detail: `Editable composition ${composition.id} created using approved assets only. No model call or credit charge.`,
      },
    });
    return { ok: true, composition };
  });
}
export async function exportComposition(
  scope: Scope,
  id: string,
  placement: Placement,
  preview = false,
  store?: AssetStore
) {
  async function context() {
    const composition = await db.staticComposition.findFirst({
      where: {
        id,
        businessId: scope.businessId,
        organizationId: scope.organizationId,
      },
    });
    if (!composition) throw new AppError(404, "Composition not found.");
    const business = await db.business.findFirstOrThrow({
      where: { id: scope.businessId, organizationId: scope.organizationId },
    });
    const item = await db.productionItem.findFirst({
      where: {
        id: composition.itemId,
        organizationId: scope.organizationId,
        plan: { businessId: scope.businessId, status: "PROPOSED" },
      },
      include: { revisions: { orderBy: { version: "desc" }, take: 1 } },
    });
    const revision = item?.revisions[0];
    if (
      !business.confirmedAt ||
      composition.brandVersion !== business.version ||
      revision?.id !== composition.revisionId ||
      !["READY", "APPROVED"].includes(revision.status) ||
      composition.status === "SUPERSEDED"
    )
      throw new AppError(
        409,
        "The brand, copy or composition changed. Review a current composition."
      );
    if (
      !preview &&
      (composition.status !== "APPROVED" || revision.status !== "APPROVED")
    )
      throw new AppError(
        409,
        "Approve the exact copy and composition before downloading."
      );
    const document = canvasDocument.parse(composition.document);
    const images = document.layers.filter((l) => l.kind === "image");
    const assets = await db.brandAsset.findMany({
      where: {
        id: { in: images.map((l) => l.assetId) },
        businessId: scope.businessId,
        organizationId: scope.organizationId,
        status: "READY",
        approvedForGeneration: true,
      },
    });
    if (
      images.some(
        (l) => !assets.some((a) => a.id === l.assetId && a.sha256 === l.sha256)
      )
    )
      throw new AppError(
        409,
        "An image was removed or its permission revoked. Update this composition."
      );
    return {
      composition,
      document,
      assets,
      copy: { brand: business.name, ...creativeSchema.parse(revision.content) },
    };
  }
  const initial = await context(),
    images = new Map<string, Uint8Array>();
  for (const asset of initial.assets) {
    const data = await (store ?? assetStore()).get(asset.objectKey);
    if (createHash("sha256").update(data).digest("hex") !== asset.sha256)
      throw new AppError(409, "Stored image integrity check failed.");
    images.set(asset.id, data);
  }
  let rendered: Awaited<ReturnType<typeof renderCanvas>>;
  try {
    rendered = await renderCanvas(
      initial.document,
      placement,
      initial.copy,
      images
    );
  } catch (error) {
    throw new AppError(
      422,
      error instanceof Error
        ? error.message
        : "Composition could not be rendered."
    );
  }
  // Recheck permissions after storage/rendering, which may be slow. Never cache private output.
  await context();
  return { ...rendered, document: initial.document };
}
