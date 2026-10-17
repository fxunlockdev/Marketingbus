import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { listShotGenerations, manageShotGeneration } from "@/lib/video/generation-service";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    return listShotGenerations({ businessId: id, organizationId: business.organizationId, actorId: user.id });
  });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id, true);
    const body = await readBody(request); await rateLimit("video-generation:write", user.id, 60);
    return manageShotGeneration({ businessId: id, organizationId: business.organizationId, actorId: user.id }, body);
  });
}
