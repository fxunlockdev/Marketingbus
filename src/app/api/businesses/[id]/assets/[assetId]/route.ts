import { api, readBody } from "@/lib/http";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { readAsset, changeAsset } from "@/lib/assets/service";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  return api(async () => {
    const { id, assetId } = await context.params;
    const { user, business } = await requireBusiness(id, true);
    await rateLimit("assets:manage", user.id, 60);
    return changeAsset({ businessId: id, organizationId: business.organizationId, actorId: user.id }, assetId, await readBody(request));
  });
}
export async function GET(_request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  try {
    const { id, assetId } = await context.params; const { user, business } = await requireBusiness(id);
    await rateLimit("assets:read", user.id, 300);
    const image = await readAsset({ businessId: id, organizationId: business.organizationId }, assetId);
    return new Response(new Uint8Array(image), { headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline; filename=brand-image.webp" } });
  } catch (error) { return api(async () => { throw error; }); }
}
