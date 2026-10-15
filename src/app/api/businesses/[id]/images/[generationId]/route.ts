import { requireBusiness, rateLimit } from "@/lib/auth";
import { api } from "@/lib/http";
import { previewImage } from "@/lib/images/service";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string; generationId: string }> }) {
  try {
    const { id, generationId } = await context.params, { user, business } = await requireBusiness(id);
    await rateLimit("image:preview", user.id, 60);
    const bytes = await previewImage({ businessId: id, organizationId: business.organizationId, actorId: user.id }, generationId);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline; filename=artwork-review.webp" } });
  } catch (error) { return api(async () => { throw error; }); }
}
