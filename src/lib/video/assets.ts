import type { Prisma } from "@prisma/client";
import type { Scope } from "../production/service";
import { imageReferences } from "../images/contracts";

export type MotionAssetClient = Pick<Prisma.TransactionClient, "brandAsset" | "imageGeneration" | "reviewComment">;

// Reuse approved artwork from the same business, not arbitrary generated files.
// Batch provenance reads so a storyboard/list does not issue one query per image.
export async function eligibleMotionAssets(client: MotionAssetClient, scope: Scope, brandVersion: number, ids?: string[]) {
  const assets = await client.brandAsset.findMany({
    where: { businessId: scope.businessId, organizationId: scope.organizationId, status: "READY", approvedForGeneration: true,
      ...(ids ? { id: { in: ids } } : {}),
      OR: [{ generationId: null }, { purpose: "generated", generation: { status: "APPROVED", brandVersion } }],
    },
    include: { generation: { include: { item: { include: { plan: true, revisions: { orderBy: { version: "desc" }, take: 1 } } } } } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 100,
  });
  const generations = assets.flatMap(a => a.generation ? [a.generation] : []);
  if (!generations.length) return assets;
  const references = new Map(generations.map(g => [g.id, imageReferences.safeParse(g.references)]));
  const referenceIds = [...new Set([...references.values()].flatMap(r => r.success ? r.data.map(ref => ref.id) : []))];
  const [originals, blockers, newer] = await Promise.all([
    client.brandAsset.findMany({ where: { id: { in: referenceIds }, businessId: scope.businessId, organizationId: scope.organizationId, status: "READY" } }),
    client.reviewComment.findMany({ where: { revisionId: { in: generations.map(g => g.revisionId) }, blocking: true, resolvedAt: null }, select: { revisionId: true } }),
    client.imageGeneration.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, acceptedAt: { not: null },
      OR: generations.map(g => ({ itemId: g.itemId, version: { gt: g.version } })),
    }, select: { itemId: true, version: true } }),
  ]);
  return assets.filter(asset => {
    const g = asset.generation; if (!g) return true;
    const copy = g.item.revisions[0], plan = g.item.plan, refs = references.get(g.id);
    return g.businessId === scope.businessId && g.organizationId === scope.organizationId && g.approvedBy !== null &&
      g.item.organizationId === scope.organizationId && plan.organizationId === scope.organizationId && plan.businessId === scope.businessId &&
      plan.status === "PROPOSED" && plan.brandVersion === brandVersion && copy?.id === g.revisionId && copy.status === "APPROVED" &&
      !blockers.some(b => b.revisionId === g.revisionId) && !newer.some(n => n.itemId === g.itemId && n.version > g.version) &&
      !!refs?.success && refs.data.every(ref => originals.some(a => a.id === ref.id && a.sha256 === ref.sha256 &&
        (ref.parent ? g.parentId !== null && a.generationId === g.parentId : a.purpose === "reference" && a.approvedForGeneration)));
  });
}
