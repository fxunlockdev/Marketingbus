import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { readProcedures, manageProcedures } from "@/lib/harness/procedures";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    await rateLimit("procedures:read", user.id, 120);
    return readProcedures({ businessId: id, organizationId: business.organizationId, actorId: user.id });
  });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id, true);
    await rateLimit("procedures:write", user.id, 30);
    return manageProcedures({ businessId: id, organizationId: business.organizationId, actorId: user.id }, await readBody(request));
  });
}
