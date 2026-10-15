import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { manageLearning } from "@/lib/social/analytics";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id, true);
    const input = await readBody(request); await rateLimit("learning:write", user.id, 30);
    return manageLearning({ businessId: id, organizationId: business.organizationId, actorId: user.id }, input);
  });
}
