import { requireBusiness, rateLimit } from "@/lib/auth";
import { api } from "@/lib/http";
import { readReviewMedia } from "@/lib/production/review";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    await rateLimit("review:read", user.id, 60);
    return readReviewMedia({ businessId: id, organizationId: business.organizationId, actorId: user.id }, Object.fromEntries(new URL(request.url).searchParams));
  });
}
