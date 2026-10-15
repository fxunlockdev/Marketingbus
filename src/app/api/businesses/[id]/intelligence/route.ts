import { api, readBody } from "@/lib/http";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { readBrandAnalyses, manageBrandAnalysis } from "@/lib/knowledge/analysis";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    await rateLimit("brand-analysis:read", user.id, 300);
    return readBrandAnalyses({ businessId: id, organizationId: business.organizationId, actorId: user.id });
  });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id, true);
    await rateLimit("brand-analysis:write", user.id, 30);
    return manageBrandAnalysis({ businessId: id, organizationId: business.organizationId, actorId: user.id }, await readBody(request));
  });
}
