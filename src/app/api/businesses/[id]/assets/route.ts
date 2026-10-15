import { api, checkOrigin, AppError } from "@/lib/http";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { boundedUpload } from "@/lib/assets/images";
import { uploadAsset, publicAssetFields } from "@/lib/assets/service";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params; const { business } = await requireBusiness(id);
    return { assets: await db.brandAsset.findMany({ where: { businessId: id, organizationId: business.organizationId, status: { in: ["READY", "ARCHIVED", "DELETING"] } }, select: publicAssetFields, orderBy: { createdAt: "desc" }, take: 100 }) };
  });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const { id } = await context.params; const { user, business } = await requireBusiness(id, true);
    await rateLimit("assets:upload", user.id, 30);
    let label: string;
    try { label = decodeURIComponent(request.headers.get("x-asset-label") || ""); } catch { throw new AppError(400, "Invalid image label."); }
    const input = { label, purpose: request.headers.get("x-asset-purpose"), rightsConfirmed: request.headers.get("x-asset-rights") === "confirmed" };
    return uploadAsset({ businessId: id, organizationId: business.organizationId, actorId: user.id }, input, await boundedUpload(request));
  });
}
