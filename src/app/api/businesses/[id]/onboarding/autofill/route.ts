import { api } from "@/lib/http";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { prepareSetupAutofill, readSetupAutofill } from "@/lib/onboarding/autofill";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params;
    const { user, business } = await requireBusiness(id);
    await rateLimit("setup-autofill:read", user.id, 300);
    return readSetupAutofill({ businessId: id, organizationId: business.organizationId, actorId: user.id });
  });
}
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params;
    const { user, business } = await requireBusiness(id, true);
    await rateLimit("setup-autofill:prepare", user.id, 60);
    return prepareSetupAutofill({ businessId: id, organizationId: business.organizationId, actorId: user.id });
  });
}
