import { rateLimit, requireBusiness, requireSessionId } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { beginSocialOAuth, cancelSocialOAuth, chooseSocialAccount, configuredSocialOAuthAdapters, connectionAction, readSocialConnections } from "@/lib/social/oauth";
import { configuredSocialDataAdapters } from "@/lib/social/account-data-adapters";
import { disconnectInput, disconnectSocialAccount } from "@/lib/social/disconnect";
type Context = { params: Promise<{ id: string }> };
async function scope(context: Context) {
  const { id } = await context.params, { user, business } = await requireBusiness(id);
  return { businessId: id, organizationId: business.organizationId, actorId: user.id, sessionId: await requireSessionId() };
}
export async function GET(_request: Request, context: Context) {
  return api(async () => ({ ...await readSocialConnections(await scope(context), configuredSocialOAuthAdapters()), dataEnabledProviders: Object.keys(configuredSocialDataAdapters()) }));
}
export async function POST(request: Request, context: Context) {
  return api(async () => {
    const actor = await scope(context), raw = await readBody(request);
    await rateLimit("social:connect", actor.actorId, 20);
    const disconnection = disconnectInput.safeParse(raw);
    if (disconnection.success) return disconnectSocialAccount(actor, disconnection.data);
    const input = connectionAction.parse(raw);
    if (input.action === "begin") return beginSocialOAuth(actor, input.provider, configuredSocialOAuthAdapters());
    if (input.action === "choose") return chooseSocialAccount(actor, input.flowId, input.choiceId, configuredSocialOAuthAdapters());
    return cancelSocialOAuth(actor, input.flowId);
  });
}
