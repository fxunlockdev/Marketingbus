import { api, readBody } from "@/lib/http";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { manageSetup, readSetup } from "@/lib/onboarding/service";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params; const { user, business } = await requireBusiness(id);
    await rateLimit("setup:read", user.id, 300);
    return readSetup({ businessId: id, organizationId: business.organizationId, actorId: user.id });
  });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params; const { user, business } = await requireBusiness(id, true);
    await rateLimit("setup:write", user.id, 120);
    return manageSetup({ businessId: id, organizationId: business.organizationId, actorId: user.id }, await readBody(request));
  });
}
