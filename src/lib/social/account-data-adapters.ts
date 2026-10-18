import { z } from "zod";
import { createMetaOAuthAdapter, META_SCOPES, metaClient, metaEnvironment, metaId, metaSettings, verifyMetaToken, type MetaProvider, type MetaSettings } from "./meta-oauth";
import { createLinkedInOAuthAdapter, LINKEDIN_SCOPES, type LinkedInOAuthSettings } from "./linkedin-oauth";
import { socialJson, SocialReadError } from "./provider-http";
import { accountSnapshot, safeSocialPermalink, socialCount, unavailableOrganic, type AccountSnapshot, type SocialDataAdapter, type SocialDataAdapters } from "./account-data-contracts";
const time = (raw: string | number) => {
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.getTime() < 0 || date.getTime() > Date.now() + 60000) throw Error("Invalid provider timestamp.");
  return date.toISOString();
};
const text = (raw = "") => ({ text: raw.slice(0, 5000), textTruncated: raw.length > 5000 });
const paging = z.object({ next: z.string().max(4000).optional() }).optional();
export function createMetaDataAdapter(provider: MetaProvider, raw: MetaSettings, fetcher: typeof fetch = fetch): SocialDataAdapter {
  const config = metaSettings.parse(raw), version = `${createMetaOAuthAdapter(provider, config).config.version}:data-v1`;
  return { version, async read(account, signal) {
    try {
      if (account.provider !== provider) throw Error();
      const id = metaId.parse(account.externalAccountId), graph = metaClient(config, fetcher, signal);
      const token = await verifyMetaToken(config, fetcher, account.token, provider, signal, "PAGE");
      const page = z.object({ id: metaId, name: z.string().trim().min(1).max(120), instagram_business_account: z.object({ id: metaId }).optional() }).parse(await graph("me", account.token, { fields: "id,name,instagram_business_account" }));
      if (token.profile_id !== page.id || (provider === "Facebook" ? page.id !== id : page.instagram_business_account?.id !== id)) throw Error();
      for (const scope of token.granular_scopes ?? []) if (META_SCOPES[provider].includes(scope.scope) && scope.target_ids && !scope.target_ids.some(target => target === id || target === page.id)) throw Error();
      let profile: AccountSnapshot["profile"], posts: AccountSnapshot["posts"], hasMore: boolean;
      if (provider === "Facebook") {
        const info = z.object({ id: z.literal(id), name: z.string().trim().min(1).max(120), followers_count: socialCount.optional(), fan_count: socialCount.optional() }).parse(await graph(id, account.token, { fields: "id,name,followers_count,fan_count" }));
        profile = { name: info.name, followers: info.followers_count ?? null, likes: info.fan_count ?? null, mediaCount: null };
        const result = z.object({ data: z.array(z.object({ id: z.string().regex(/^[1-9][0-9]*_[1-9][0-9]*$/).max(100), from: z.object({ id: z.literal(id) }), message: z.string().max(64000).optional(), created_time: z.string().max(100), permalink_url: z.string().max(2000).optional() })).max(20), paging }).parse(await graph(`${id}/published_posts`, account.token, { fields: "id,from,message,created_time,permalink_url", limit: "20", include_hidden: "false" }));
        posts = result.data.map(post => {
          if (!post.id.startsWith(`${id}_`)) throw Error();
          return { externalId: post.id, ...text(post.message), publishedAt: time(post.created_time), permalink: safeSocialPermalink(post.permalink_url, provider), format: "POST", likes: null, comments: null, sponsored: null };
        }); hasMore = !!result.paging?.next;
      } else {
        const info = z.object({ id: z.literal(id), username: z.string().regex(/^[A-Za-z0-9_.]{1,30}$/), followers_count: socialCount.optional(), media_count: socialCount.optional() }).parse(await graph(id, account.token, { fields: "id,username,followers_count,media_count" }));
        profile = { name: `@${info.username}`, followers: info.followers_count ?? null, likes: null, mediaCount: info.media_count ?? null };
        const result = z.object({ data: z.array(z.object({ id: metaId, owner: z.object({ id: z.literal(id) }), caption: z.string().max(64000).optional(), timestamp: z.string().max(100), permalink: z.string().max(2000).optional(), media_type: z.enum(["IMAGE", "VIDEO", "CAROUSEL_ALBUM"]), like_count: socialCount.optional(), comments_count: socialCount.optional() })).max(20), paging }).parse(await graph(`${id}/media`, account.token, { fields: "id,owner,caption,timestamp,permalink,media_type,like_count,comments_count", limit: "20" }));
        posts = result.data.map(post => ({ externalId: post.id, ...text(post.caption), publishedAt: time(post.timestamp), permalink: safeSocialPermalink(post.permalink, provider), format: post.media_type, likes: post.like_count ?? null, comments: post.comments_count ?? null, sponsored: null })); hasMore = !!result.paging?.next;
      }
      signal.throwIfAborted();
      return accountSnapshot.parse({ provider, externalAccountId: id, observedAt: new Date().toISOString(), definitionVersion: `${provider.toLowerCase()}-profile-posts-${config.apiVersion}-v1`, profile, posts, hasMore, lifetimeOrganic: unavailableOrganic() });
    } catch { throw Error("Account data could not be verified. Reconnect or ask an administrator to check access."); }
  } };
}
export function createLinkedInDataAdapter(config: LinkedInOAuthSettings, fetcher: typeof fetch = fetch): SocialDataAdapter {
  const version = `${createLinkedInOAuthAdapter(config).config.version}:data-v1`;
  return { version, async read(account, signal) {
    try {
      createLinkedInOAuthAdapter(config); // Recheck the operator deadline on each read.
      const id = z.string().regex(/^urn:li:organization:[1-9][0-9]{0,15}$/).parse(account.externalAccountId);
      if (account.provider !== "LinkedIn") throw Error();
      const inspected = z.object({ active: z.literal(true), status: z.literal("active"), client_id: z.literal(config.clientId), auth_type: z.literal("3L"), expires_at: z.number().int().positive().safe(), scope: z.string().max(4000) }).parse(await socialJson(fetcher, "https://www.linkedin.com/oauth/v2/introspectToken", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, token: account.token }) }, signal));
      if (inspected.expires_at * 1000 <= Date.now() + 60000 || LINKEDIN_SCOPES.some(p => !inspected.scope.split(/[\s,]+/).includes(p))) throw Error();
      const headers = { Authorization: `Bearer ${account.token}`, Accept: "application/json", "LinkedIn-Version": config.apiVersion, "X-Restli-Protocol-Version": "2.0.0" };
      const get = (path: string) => socialJson(fetcher, `https://api.linkedin.com/rest/${path}`, { headers }, signal);
      const info = z.object({ id: z.number().int().positive().safe(), localizedName: z.string().trim().min(1).max(120) }).parse(await get(`organizations/${id.split(":")[3]}`));
      if (`urn:li:organization:${info.id}` !== id) throw Error();
      const result = z.object({ elements: z.array(z.object({ id: z.string().regex(/^urn:li:(share|ugcPost):[1-9][0-9]*$/).max(200), author: z.literal(id), lifecycleState: z.literal("PUBLISHED"), commentary: z.string().max(64000), publishedAt: z.number().int().positive().safe(), adContext: z.object({ isDsc: z.boolean().optional() }).optional() })).max(20), paging: z.object({ links: z.array(z.object({ rel: z.string().max(30) })).max(10).optional() }).optional() }).parse(await get(`posts?${new URLSearchParams({ q: "author", author: id, count: "20", sortBy: "CREATED", viewContext: "READER" })}`));
      let lifetimeOrganic: AccountSnapshot["lifetimeOrganic"] = unavailableOrganic();
      try {
        const stats = z.object({ elements: z.array(z.object({ organizationalEntity: z.literal(id), totalShareStatistics: z.object({ impressionCount: socialCount.optional(), uniqueImpressionsCount: socialCount.optional(), clickCount: socialCount.optional(), likeCount: socialCount.optional(), commentCount: socialCount.optional(), shareCount: socialCount.optional() }) })).max(1) }).parse(await get(`organizationalEntityShareStatistics?${new URLSearchParams({ q: "organizationalEntity", organizationalEntity: id })}`));
        if (stats.elements.length) {
          const s = stats.elements[0].totalShareStatistics;
          lifetimeOrganic = { available: true, impressions: s.impressionCount ?? null, uniqueImpressions: s.uniqueImpressionsCount ?? null, clicks: s.clickCount ?? null, likes: s.likeCount ?? null, comments: s.commentCount ?? null, shares: s.shareCount ?? null };
        }
      } catch (error) { if (!(error instanceof SocialReadError) || ![400, 403, 404].includes(error.status ?? 0)) throw error; }
      signal.throwIfAborted(); createLinkedInOAuthAdapter(config);
      return accountSnapshot.parse({ provider: "LinkedIn", externalAccountId: id, observedAt: new Date().toISOString(), definitionVersion: `linkedin-organic-lifetime-${config.apiVersion}-v1`, profile: { name: info.localizedName, followers: null, likes: null, mediaCount: null }, lifetimeOrganic,
        posts: result.elements.map(p => ({ externalId: p.id, ...text(p.commentary), publishedAt: time(p.publishedAt), permalink: null, format: "POST", likes: null, comments: null, sponsored: p.adContext?.isDsc ?? null })), hasMore: !!result.paging?.links?.some(link => link.rel === "next") });
    } catch { throw Error("Account data could not be verified. Reconnect or ask an administrator to check access."); }
  } };
}
export function configuredSocialDataAdapters(): SocialDataAdapters {
  if (process.env.SOCIAL_DATA_ENABLED !== "true") return {};
  const result: SocialDataAdapters = {};
  for (const provider of ["Facebook", "Instagram"] as const) if (process.env[`${provider.toUpperCase()}_CONNECTIONS_ENABLED`] === "true") {
    try { result[provider] = createMetaDataAdapter(provider, metaEnvironment()); } catch { /* Disabled until configured. */ }
  }
  if (process.env.LINKEDIN_CONNECTIONS_ENABLED === "true") {
    try { result.LinkedIn = createLinkedInDataAdapter({ clientId: process.env.LINKEDIN_CLIENT_ID || "", clientSecret: process.env.LINKEDIN_CLIENT_SECRET || "", apiVersion: process.env.LINKEDIN_API_VERSION || "", verifiedUntil: process.env.LINKEDIN_API_VERIFIED_UNTIL || "" }); } catch { /* Disabled until configured. */ }
  }
  return result;
}
