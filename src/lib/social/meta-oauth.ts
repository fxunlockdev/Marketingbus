import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { SocialOAuthAdapter } from "./oauth";
import { socialJson } from "./provider-http";

export const metaId = z.string().regex(/^[1-9][0-9]{0,39}$/);
export const metaSettings = z.object({ appId: metaId, appSecret: z.string().min(16).max(2000), apiVersion: z.string().regex(/^v[1-9][0-9]?\.0$/), verifiedUntil: z.iso.datetime() }).strict();
export type MetaSettings = z.infer<typeof metaSettings>;
export type MetaProvider = "Facebook" | "Instagram";
export const META_SCOPES = {
  Facebook: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "read_insights"],
  Instagram: ["pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_content_publish", "instagram_manage_insights"],
};
const failure = () => new Error("Meta account authorization could not be verified. Start again or contact support.");
export function assertMetaFresh(config: MetaSettings) {
  const remaining = Date.parse(config.verifiedUntil) - Date.now();
  if (remaining <= 0 || remaining > 90 * 86400000) throw failure();
}
export function metaClient(config: MetaSettings, fetcher: typeof fetch, signal: AbortSignal) {
  return async (path: string, token: string, fields: Record<string, string> = {}) => {
    assertMetaFresh(config);
    const query = new URLSearchParams({ ...fields, appsecret_proof: createHmac("sha256", config.appSecret).update(token).digest("hex") });
    return socialJson(fetcher, `https://graph.facebook.com/${config.apiVersion}/${path}?${query}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }, signal);
  };
}
export async function verifyMetaToken(config: MetaSettings, fetcher: typeof fetch, token: string, provider: MetaProvider, signal: AbortSignal, type: "USER" | "PAGE") {
  assertMetaFresh(config);
  const data = z.object({ data: z.object({
    app_id: z.literal(config.appId), is_valid: z.literal(true), type: z.literal(type),
    user_id: metaId, profile_id: metaId.optional(), expires_at: z.number().int().nonnegative().safe(),
    data_access_expires_at: z.number().int().nonnegative().safe(),
    scopes: z.array(z.string().regex(/^[a-z_]{1,100}$/)).max(30),
    granular_scopes: z.array(z.object({ scope: z.string().max(100), target_ids: z.array(metaId).max(1000).optional() })).max(30).optional(),
  }) }).parse(await socialJson(fetcher, `https://graph.facebook.com/${config.apiVersion}/debug_token?${new URLSearchParams({ input_token: token })}`, { headers: { Authorization: `Bearer ${config.appId}|${config.appSecret}`, Accept: "application/json" } }, signal)).data;
  if (META_SCOPES[provider].some(scope => !data.scopes.includes(scope))) throw failure();
  for (const expiry of [data.expires_at, data.data_access_expires_at]) if (expiry !== 0 && (expiry * 1000 <= Date.now() + 60000 || expiry * 1000 > Date.now() + 366 * 86400000)) throw failure();
  if (type === "USER" && !data.expires_at) throw failure();
  return data;
}
export function createMetaOAuthAdapter(provider: MetaProvider, raw: MetaSettings, fetcher: typeof fetch = fetch): SocialOAuthAdapter {
  const config = metaSettings.parse(raw); assertMetaFresh(config);
  return {
    config: { version: `meta-pages-v1:${createHash("sha256").update(JSON.stringify({ provider, ...config })).digest("hex").slice(0, 32)}`, clientId: config.appId,
      authorizationEndpoint: `https://www.facebook.com/${config.apiVersion}/dialog/oauth`, authentication: "META_CONFIDENTIAL", scopes: [...META_SCOPES[provider]] },
    async exchange({ code, redirectUri, signal }) {
      try {
        assertMetaFresh(config);
        const exchange = async (parameters: Record<string, string>) => z.object({ access_token: z.string().min(1).max(20000), expires_in: z.number().int().positive().max(366 * 86400).optional(), expires: z.number().int().positive().max(366 * 86400).optional() }).parse(
          await socialJson(fetcher, `https://graph.facebook.com/${config.apiVersion}/oauth/access_token?${new URLSearchParams({ client_id: config.appId, client_secret: config.appSecret, ...parameters })}`, { headers: { Accept: "application/json" } }, signal));
        const short = await exchange({ code, redirect_uri: redirectUri });
        const grant = await exchange({ grant_type: "fb_exchange_token", fb_exchange_token: short.access_token });
        const user = await verifyMetaToken(config, fetcher, grant.access_token, provider, signal, "USER");
        const seconds = grant.expires_in ?? grant.expires;
        if (!seconds) throw failure();
        const parentExpiry = Math.min(Date.now() + seconds * 1000, user.expires_at * 1000, user.data_access_expires_at ? user.data_access_expires_at * 1000 : Infinity);
        const graph = metaClient(config, fetcher, signal), pages = [], seen = new Set<string>();
        let after: string | undefined;
        for (let index = 0; index < 2; index++) {
          const result = z.object({ data: z.array(z.object({ id: metaId, name: z.string().trim().min(1).max(120), access_token: z.string().min(1).max(20000).optional(), tasks: z.array(z.string().max(100)).max(50), instagram_business_account: z.object({ id: metaId }).optional() })).max(10),
            paging: z.object({ cursors: z.object({ after: z.string().regex(/^[A-Za-z0-9_=-]{1,2000}$/).optional() }).optional(), next: z.string().max(4000).optional() }).optional(),
          }).parse(await graph("me/accounts", grant.access_token, { fields: "id,name,access_token,tasks,instagram_business_account", limit: "10", ...(after ? { after } : {}) }));
          for (const page of result.data) {
            if (seen.has(page.id)) throw failure(); seen.add(page.id);
            if (!page.tasks.some(t => ["MANAGE", "CREATE_CONTENT"].includes(t)) || !page.tasks.some(t => ["MANAGE", "ANALYZE"].includes(t))) continue;
            if (provider === "Instagram" && !page.instagram_business_account) continue;
            if (!page.access_token) throw failure();
            if ((user.granular_scopes ?? []).some(permission => META_SCOPES[provider].includes(permission.scope) && permission.target_ids && !permission.target_ids.some(id => id === page.id || id === page.instagram_business_account?.id))) continue;
            pages.push(page);
          }
          if (!result.paging?.next) break;
          const next = result.paging.cursors?.after;
          if (index === 1 || !next || next === after || !result.data.length) throw failure();
          after = next;
        }
        if (!pages.length) throw failure();
        const accounts = [], ids = new Set<string>();
        for (const page of pages) {
          const token = page.access_token!;
          const inspected = await verifyMetaToken(config, fetcher, token, provider, signal, "PAGE");
          if (inspected.user_id !== user.user_id || inspected.profile_id !== page.id) throw failure();
          if ((inspected.granular_scopes ?? []).some(permission => META_SCOPES[provider].includes(permission.scope) && permission.target_ids && !permission.target_ids.some(id => id === page.id || id === page.instagram_business_account?.id))) throw failure();
          const identity = z.object({ id: z.literal(page.id), name: z.string().trim().min(1).max(120), instagram_business_account: z.object({ id: metaId }).optional() }).parse(await graph("me", token, { fields: "id,name,instagram_business_account" }));
          let id = page.id, label = identity.name;
          if (provider === "Instagram") {
            if (identity.instagram_business_account?.id !== page.instagram_business_account!.id) throw failure();
            id = identity.instagram_business_account.id;
            const ig = z.object({ id: z.literal(id), username: z.string().regex(/^[A-Za-z0-9_.]{1,30}$/) }).parse(await graph(id, token, { fields: "id,username" }));
            label = `@${ig.username}`;
          }
          if (ids.has(id)) throw failure(); ids.add(id);
          const expiry = Math.min(parentExpiry, inspected.expires_at ? inspected.expires_at * 1000 : Infinity, inspected.data_access_expires_at ? inspected.data_access_expires_at * 1000 : Infinity);
          if (expiry <= Date.now() + 60000) throw failure();
          accounts.push({ externalAccountId: id, label, token, permissions: inspected.scopes, expiresAt: new Date(expiry).toISOString() });
        }
        signal.throwIfAborted(); assertMetaFresh(config);
        return accounts;
      } catch { throw failure(); }
    },
  };
}
export function metaEnvironment(): MetaSettings {
  return metaSettings.parse({ appId: process.env.META_APP_ID || "", appSecret: process.env.META_APP_SECRET || "", apiVersion: process.env.META_API_VERSION || "", verifiedUntil: process.env.META_API_VERIFIED_UNTIL || "" });
}
