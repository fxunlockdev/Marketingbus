import { rateLimit, requireBusiness, requireSessionId } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { resumeMetricChecks } from "@/lib/social/metric-recovery";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    const input = await readBody(request);
    await rateLimit("social:metric-recovery", user.id, 12);
    return resumeMetricChecks({ businessId: id, organizationId: business.organizationId, actorId: user.id, sessionId: await requireSessionId() }, input);
  });
}
