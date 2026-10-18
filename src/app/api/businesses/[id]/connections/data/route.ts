import { z } from "zod";
import { rateLimit, requireBusiness, requireSessionId } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { forgetSocialAccountData, readSocialAccountData, refreshSocialAccountData } from "@/lib/social/account-data-service";
type Context = { params: Promise<{ id: string }> };
const connectionId = z.string().min(1).max(100);
async function scope(context: Context) {
  const { id } = await context.params, { business, user } = await requireBusiness(id);
  return { businessId: id, organizationId: business.organizationId, actorId: user.id, sessionId: await requireSessionId() };
}
export async function GET(request: Request, context: Context) {
  return api(async () => readSocialAccountData(await scope(context), connectionId.parse(new URL(request.url).searchParams.get("connectionId"))));
}
export async function POST(request: Request, context: Context) {
  return api(async () => {
    const actor = await scope(context), input = z.object({ action: z.enum(["refresh", "forget"]), connectionId }).strict().parse(await readBody(request));
    await rateLimit("social:data", actor.actorId, 20);
    return input.action === "refresh" ? refreshSocialAccountData(actor, input.connectionId) : forgetSocialAccountData(actor, input.connectionId);
  });
}
