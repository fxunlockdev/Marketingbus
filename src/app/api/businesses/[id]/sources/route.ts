import { api, readBody } from "@/lib/http";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { db } from "@/lib/db";
import { manageSource, sourceFields } from "@/lib/knowledge/service";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params; const { user, business } = await requireBusiness(id);
    await rateLimit("sources:read", user.id, 300);
    return { sources: await db.knowledgeSource.findMany({ where: { businessId: id, organizationId: business.organizationId }, select: sourceFields, orderBy: { createdAt: "desc" }, take: 30 }) };
  });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params; const { user, business } = await requireBusiness(id, true);
    await rateLimit("sources:write", user.id, 20);
    return manageSource({ businessId: id, organizationId: business.organizationId, actorId: user.id }, await readBody(request));
  });
}
