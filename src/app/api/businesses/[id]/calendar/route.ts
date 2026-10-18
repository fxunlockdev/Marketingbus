import { requireBusiness } from "@/lib/auth";
import { api, AppError } from "@/lib/http";
import { readCalendar } from "@/lib/production/calendar";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    const params = new URL(request.url).searchParams;
    if (Array.from(params.keys()).length !== new Set(params.keys()).size) throw new AppError(400, "Repeated calendar parameters are not supported.");
    return readCalendar({ businessId: id, organizationId: business.organizationId, actorId: user.id }, Object.fromEntries(params));
  });
}
