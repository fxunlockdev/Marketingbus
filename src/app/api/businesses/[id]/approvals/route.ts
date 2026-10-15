import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { manageApprovals, readApprovals } from "@/lib/workflows/approvals";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const { id } = await context.params, { user, business } = await requireBusiness(id);
    return readApprovals({ businessId: id, organizationId: business.organizationId, actorId: user.id }, new URL(request.url).searchParams.get("itemId") ?? undefined); });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const { id } = await context.params, { user, business } = await requireBusiness(id, true); const body = await readBody(request); await rateLimit("review:write", user.id, 100);
    return manageApprovals({ businessId: id, organizationId: business.organizationId, actorId: user.id }, body); });
}
