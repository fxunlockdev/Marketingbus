import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { manageLearning } from "@/lib/social/analytics";
import { manageLearnedSkills, readLearnedSkills } from "@/lib/harness/learning";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    return readLearnedSkills({ businessId: id, organizationId: business.organizationId, actorId: user.id });
  });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id, true);
    const input = await readBody(request); await rateLimit("learning:write", user.id, 30);
    const scope = { businessId: id, organizationId: business.organizationId, actorId: user.id };
    return input && typeof input === "object" && "action" in input && ["reflect-skills", "activate-skill", "retire-skill"].includes(String(input.action)) ? manageLearnedSkills(scope, input) : manageLearning(scope, input);
  });
}
