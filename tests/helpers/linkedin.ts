import { vi } from "vitest";
import { LINKEDIN_SCOPES, type LinkedInOAuthSettings } from "../../src/lib/social/linkedin-oauth";

export function linkedInFixture() {
  const config: LinkedInOAuthSettings = { clientId: "local-client", clientSecret: "local-client-secret", apiVersion: "202606", verifiedUntil: new Date(Date.now() + 86400000).toISOString() };
  const introspection = { active: true, status: "active", client_id: config.clientId, auth_type: "3L", expires_at: Math.floor(Date.now() / 1000) + 3600, scope: LINKEDIN_SCOPES.join(",") };
  const entry = (id: number) => ({ role: "ADMINISTRATOR", state: "APPROVED", roleAssignee: "urn:li:person:local-user", organization: `urn:li:organization:${id}` });
  const replies: unknown[] = [
    { access_token: "local-access-token", expires_in: 7200 },
    introspection,
    { elements: [entry(123)], paging: { start: 0, count: 10, links: [] } },
    { id: 123, localizedName: "Local test company" },
  ];
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (!replies.length) throw Error("Unexpected request");
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply instanceof Response ? reply : Response.json(reply);
  });
  const input = { code: "local-authorization-code", verifier: "", redirectUri: "http://127.0.0.1:3000/api/social/linkedin/callback", signal: AbortSignal.timeout(30000) };
  return { config, introspection, entry, replies, fetcher, input };
}
