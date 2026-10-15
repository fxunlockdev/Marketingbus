import { requireBusiness } from "@/lib/auth";
import { api } from "@/lib/http";
import { readPlanHistory } from "@/lib/production/history";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    return readPlanHistory({ businessId: id, organizationId: business.organizationId, actorId: user.id }, Object.fromEntries(new URL(request.url).searchParams));
  });
}
