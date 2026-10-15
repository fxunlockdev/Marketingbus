import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { readPlanning, savePlanning } from "@/lib/workflows/planning";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const { id } = await context.params, { user, business } = await requireBusiness(id); return readPlanning({ businessId: id, organizationId: business.organizationId, actorId: user.id }); });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const { id } = await context.params, { user, business } = await requireBusiness(id, true); const body = await readBody(request); await rateLimit("planning:write", user.id, 30); return savePlanning({ businessId: id, organizationId: business.organizationId, actorId: user.id }, body); });
}
