import { api, checkOrigin, AppError } from "@/lib/http";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { boundedClipUpload } from "@/lib/video/clip-normalizer";
import { uploadClip, listClips } from "@/lib/video/clips";
export const runtime = "nodejs";
let activeUploads = 0;
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const { id } = await context.params, { user, business } = await requireBusiness(id); return { clips: await listClips({ businessId: id, organizationId: business.organizationId, actorId: user.id }) }; });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request); const { id } = await context.params, { user, business } = await requireBusiness(id, true);
    await rateLimit("clip:upload", user.id, 6);
    let label: string;
    try { label = decodeURIComponent(request.headers.get("x-clip-label") || ""); } catch { throw new AppError(400, "Invalid clip label."); }
    if (activeUploads >= 2) throw new AppError(429, "Clip uploads are busy. Try again shortly.");
    activeUploads++;
    try { return await uploadClip({ businessId: id, organizationId: business.organizationId, actorId: user.id }, { label, rightsConfirmed: request.headers.get("x-clip-rights") === "confirmed" }, await boundedClipUpload(request)); }
    finally { activeUploads--; }
  });
}
