import { rateLimit, requireBusiness, requireSessionId } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { beginSocialOAuth, cancelSocialOAuth, chooseSocialAccount, configuredSocialOAuthAdapters, connectionAction, readSocialConnections } from "@/lib/social/oauth";
type Context = { params: Promise<{ id: string }> };
async function scope(context: Context) {
  const { id } = await context.params, { user, business } = await requireBusiness(id);
  return { businessId: id, organizationId: business.organizationId, actorId: user.id, sessionId: await requireSessionId() };
}
export async function GET(_request: Request, context: Context) {
  return api(async () => readSocialConnections(await scope(context), configuredSocialOAuthAdapters()));
}
export async function POST(request: Request, context: Context) {
  return api(async () => {
    const actor = await scope(context), input = connectionAction.parse(await readBody(request));
    await rateLimit("social:connect", actor.actorId, 20);
    if (input.action === "begin") return beginSocialOAuth(actor, input.provider, configuredSocialOAuthAdapters());
    if (input.action === "choose") return chooseSocialAccount(actor, input.flowId, input.choiceId, configuredSocialOAuthAdapters());
    return cancelSocialOAuth(actor, input.flowId);
  });
}
