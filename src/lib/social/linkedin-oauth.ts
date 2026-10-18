import { createHash } from "node:crypto";
import { z } from "zod";
import type { SocialOAuthAdapter } from "./oauth";

export const LINKEDIN_AUTHORIZATION_ENDPOINT = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_SCOPES = ["r_organization_admin", "w_organization_social", "r_organization_social"];
const settings = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  clientSecret: z.string().min(1).max(2000),
  apiVersion: z.string().regex(/^20\d{2}(0[1-9]|1[0-2])$/),
  verifiedUntil: z.iso.datetime(),
}).strict();
export type LinkedInOAuthSettings = z.infer<typeof settings>;
const failure = () => new Error("LinkedIn account authorization could not be verified. Start again or contact support.");
const urn = z.string().regex(/^urn:li:organization:[1-9][0-9]{0,15}$/);

// Provider endpoints are code-owned. No customer URL or paging href is ever fetched.
async function json(fetcher: typeof fetch, url: string, init: RequestInit, parent: AbortSignal): Promise<unknown> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
  signal.throwIfAborted();
  let response: Response | undefined;
  try {
    response = await fetcher(url, { ...init, signal, redirect: "error", cache: "no-store", credentials: "omit" });
    signal.throwIfAborted();
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") || !response.body) throw failure();
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65536)) throw failure();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536) throw failure();
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    // Provider error bodies may contain tokens or user data. Never propagate them.
    throw failure();
  }
}

export function createLinkedInOAuthAdapter(raw: LinkedInOAuthSettings, fetcher: typeof fetch = fetch): SocialOAuthAdapter {
  const config = settings.parse(raw);
  const assertFresh = () => {
    const remaining = Date.parse(config.verifiedUntil) - Date.now();
    if (remaining <= 0 || remaining > 90 * 86400000) throw failure();
  };
  assertFresh();
  // Rotating a credential/version invalidates pending flows without retaining the secret in the flow.
  const fingerprint = createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 32);
  return {
    config: {
      version: `linkedin-company-v1:${fingerprint}`, clientId: config.clientId,
      authorizationEndpoint: LINKEDIN_AUTHORIZATION_ENDPOINT,
      authentication: "LINKEDIN_CONFIDENTIAL", scopes: [...LINKEDIN_SCOPES],
    },
    async exchange({ code, redirectUri, signal }) {
      try {
        assertFresh();
        const body = (fields: Record<string, string>): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(fields) });
        const grant = z.object({ access_token: z.string().min(1).max(20000), expires_in: z.number().int().positive().max(366 * 86400) }).parse(
          await json(fetcher, "https://www.linkedin.com/oauth/v2/accessToken", body({ grant_type: "authorization_code", code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri }), signal));
        const receivedAt = Date.now();
        const token = z.object({ active: z.literal(true), status: z.literal("active"), client_id: z.literal(config.clientId), auth_type: z.literal("3L"), expires_at: z.number().int().positive().max(Math.floor(receivedAt / 1000) + 366 * 86400), scope: z.string().max(4000) }).parse(
          await json(fetcher, "https://www.linkedin.com/oauth/v2/introspectToken", body({ client_id: config.clientId, client_secret: config.clientSecret, token: grant.access_token }), signal));
        const permissions = [...new Set(token.scope.split(/[\s,]+/).filter(Boolean))];
        if (permissions.length > 30 || permissions.some(p => !/^[a-zA-Z0-9_.:-]{1,100}$/.test(p)) || LINKEDIN_SCOPES.some(p => !permissions.includes(p))) throw failure();
        const expiresAt = Math.min(receivedAt + grant.expires_in * 1000, token.expires_at * 1000);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() + 60000) throw failure();
        const headers = { Authorization: `Bearer ${grant.access_token}`, Accept: "application/json", "LinkedIn-Version": config.apiVersion, "X-Restli-Protocol-Version": "2.0.0" };
        const ids: string[] = [];
        let assignee: string | undefined;
        for (let page = 0; page < 2; page++) {
          const start = page * 10;
          const acl = z.object({
            elements: z.array(z.object({ role: z.literal("ADMINISTRATOR"), state: z.literal("APPROVED"), roleAssignee: z.string().regex(/^urn:li:person:[A-Za-z0-9_-]{1,200}$/), organization: urn.optional(), organizationTarget: urn.optional() })).max(10),
            paging: z.object({ start: z.literal(start), count: z.literal(10), total: z.number().int().nonnegative().max(20).optional(), links: z.array(z.object({ rel: z.string().max(30), href: z.string().max(4000).optional() })).max(10) }),
          }).parse(await json(fetcher, `https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=10&start=${start}`, { headers }, signal));
          for (const entry of acl.elements) {
            const id = entry.organization ?? entry.organizationTarget;
            if (!id || (entry.organization && entry.organizationTarget && entry.organization !== entry.organizationTarget) || ids.includes(id) || (assignee && assignee !== entry.roleAssignee)) throw failure();
            assignee = entry.roleAssignee;
            ids.push(id);
          }
          const next = acl.paging.links.some(link => link.rel === "next") || (acl.paging.total !== undefined && acl.paging.total > start + acl.elements.length);
          if (!next) break;
          if (page === 1 || acl.elements.length !== 10) throw failure();
        }
        if (!ids.length) throw failure();
        const accounts = [];
        for (const id of ids) {
          const number = id.slice("urn:li:organization:".length);
          const organization = z.object({ id: z.number().int().positive().safe(), localizedName: z.string().trim().min(1).max(120) }).parse(
            await json(fetcher, `https://api.linkedin.com/rest/organizations/${number}`, { headers }, signal));
          if (String(organization.id) !== number) throw failure();
          accounts.push({ externalAccountId: id, label: organization.localizedName, token: grant.access_token, permissions, expiresAt: new Date(expiresAt).toISOString() });
        }
        signal.throwIfAborted(); assertFresh();
        if (expiresAt <= Date.now() + 60000) throw failure();
        return accounts;
      } catch { throw failure(); }
    },
  };
}
