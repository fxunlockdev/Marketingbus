import { vi } from "vitest";
import { META_SCOPES, type MetaProvider, type MetaSettings } from "../../src/lib/social/meta-oauth";
export function metaFixture(provider: MetaProvider = "Facebook") {
  const config: MetaSettings = { appId: "12345", appSecret: "local-fixture-client-secret-only", apiVersion: "v26.0", verifiedUntil: new Date(Date.now() + 86400000).toISOString() };
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const user = { app_id: config.appId, is_valid: true, type: "USER", user_id: "456", expires_at: expires, data_access_expires_at: expires + 600, scopes: META_SCOPES[provider] };
  const page = { id: "789", name: "Local company", access_token: "local-page-token", tasks: ["CREATE_CONTENT", "ANALYZE"], instagram_business_account: { id: "987" } };
  const inspectedPage = { ...user, type: "PAGE", profile_id: page.id, expires_at: 0 };
  const identity = { id: page.id, name: page.name, instagram_business_account: page.instagram_business_account };
  const replies: unknown[] = [{ access_token: "local-short-token", expires_in: 7200 }, { access_token: "local-long-token", expires_in: 5184000 }, { data: user }, { data: [page] }, { data: inspectedPage }, identity];
  if (provider === "Instagram") replies.push({ id: "987", username: "local_company" });
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (!replies.length) throw Error("Unexpected request");
    const value = replies.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  });
  const input = { code: "local-code", verifier: "", redirectUri: `http://127.0.0.1:3000/api/social/${provider.toLowerCase()}/callback`, signal: AbortSignal.timeout(30000) };
  return { provider, config, user, page, inspectedPage, identity, replies, fetcher, input };
}
