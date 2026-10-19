import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { manageSocial } from "@/lib/social/service";
import { configuredSocialAdapters } from "@/lib/social/contracts";
import { readSocialDashboard } from "@/lib/social/analytics";
import { listPublicationImages } from "@/lib/social/image-transfer";
import { listPublicationVideos } from "@/lib/social/video-transfer";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    const adapters = configuredSocialAdapters();
    const scope = { businessId: id, organizationId: business.organizationId, actorId: user.id };
    return { ...await readSocialDashboard(scope), mediaChoices: await listPublicationImages(scope), videoChoices: await listPublicationVideos(scope), videoProviders: Object.entries(adapters).filter(([, adapter]) => adapter.videoPublishingAvailable).map(([provider]) => provider), imageProviders: Object.entries(adapters).filter(([, adapter]) => adapter.imagePublishingAvailable).map(([provider]) => provider), enabledProviders: Object.keys(adapters), enabledMetricProviders: Object.entries(adapters).filter(([, adapter]) => adapter.metricsAvailable !== false).map(([provider]) => provider), canManageMetrics: user.memberships.some(m => m.organizationId === business.organizationId && ["OWNER", "ADMIN"].includes(m.role)) };
  });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id, true);
    const input = await readBody(request); await rateLimit("social:write", user.id, 60);
    return manageSocial({ businessId: id, organizationId: business.organizationId, actorId: user.id }, input, configuredSocialAdapters());
  });
}
