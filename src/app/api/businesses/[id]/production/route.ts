import { api, readBody } from "@/lib/http";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { actOnProduction } from "@/lib/production/service";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params;
    const { user, business } = await requireBusiness(id, true);
    const input = await readBody(request);
    await rateLimit("production:write", user.id, 120);
    return actOnProduction({ businessId: id, organizationId: business.organizationId, actorId: user.id }, input);
  });
}
