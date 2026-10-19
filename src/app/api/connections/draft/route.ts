import { api, readBody, AppError } from "@/lib/http";
import { requireUser, rateLimit } from "@/lib/auth";
import { startConnectionDraft } from "@/lib/onboarding/service";

export async function POST(request: Request) {
  return api(async () => {
    const user = await requireUser(), input = await readBody(request);
    if (!user.memberships.some(m => m.organizationId === input?.organizationId && ["OWNER", "ADMIN"].includes(m.role)))
      throw new AppError(403, "Choose a workspace you administer.");
    await rateLimit("business:create", user.id, 10);
    return startConnectionDraft(user.id, input);
  });
}
