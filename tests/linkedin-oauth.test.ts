import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinkedInOAuthAdapter, LINKEDIN_SCOPES } from "../src/lib/social/linkedin-oauth";
import { configuredSocialOAuthAdapters } from "../src/lib/social/oauth";
import { linkedInFixture } from "./helpers/linkedin";

afterEach(() => vi.unstubAllEnvs());
describe("official LinkedIn company authorization transport", () => {
  it("exchanges once, introspects audience/rights and resolves only administered company pages", async () => {
    const f = linkedInFixture(), adapter = createLinkedInOAuthAdapter(f.config, f.fetcher);
    const result = await adapter.exchange(f.input);
    expect(result).toEqual([{ externalAccountId: "urn:li:organization:123", label: "Local test company", token: "local-access-token", permissions: LINKEDIN_SCOPES, expiresAt: new Date(f.introspection.expires_at * 1000).toISOString() }]);
    expect(adapter.config.authentication).toBe("LINKEDIN_CONFIDENTIAL");
    expect(JSON.stringify(adapter.config)).not.toContain(f.config.clientSecret);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    const [url, request] = f.fetcher.mock.calls[0];
    expect(url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(Object.fromEntries(new URLSearchParams(request?.body as URLSearchParams))).toEqual({ grant_type: "authorization_code", code: f.input.code, client_id: f.config.clientId, client_secret: f.config.clientSecret, redirect_uri: f.input.redirectUri });
    expect(f.fetcher.mock.calls[1][0]).toBe("https://www.linkedin.com/oauth/v2/introspectToken");
    expect(String(f.fetcher.mock.calls[1][1]?.body)).toContain("token=local-access-token");
    for (const [address, init] of f.fetcher.mock.calls) {
      expect(String(address)).not.toMatch(/local-access-token|local-client-secret|local-authorization-code/);
      expect(init).toMatchObject({ redirect: "error", cache: "no-store", credentials: "omit" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(f.fetcher.mock.calls[2][1]?.headers).toMatchObject({ Authorization: "Bearer local-access-token", "LinkedIn-Version": "202606", "X-Restli-Protocol-Version": "2.0.0" });
  });
  it.each([
    { active: false }, { status: "revoked" }, { client_id: "other-app" }, { auth_type: "2L" },
    { expires_at: 1 }, { expires_at: Number.MAX_SAFE_INTEGER }, { scope: "w_member_social" },
    { scope: LINKEDIN_SCOPES.slice(1).join(",") }, { scope: "x".repeat(4001) },
  ])("rejects unverified token metadata %j before account lookup", async override => {
    const f = linkedInFixture(); f.replies[1] = { ...f.introspection, ...override };
    await expect(createLinkedInOAuthAdapter(f.config, f.fetcher).exchange(f.input)).rejects.toThrow("could not be verified");
    expect(f.fetcher.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it.each([0, -1, 0.5, 366 * 86400 + 1, "3600"])("rejects invalid token lifetime %s", async expires_in => {
    const f = linkedInFixture(); f.replies[0] = { access_token: "local-access-token", expires_in };
    await expect(createLinkedInOAuthAdapter(f.config, f.fetcher).exchange(f.input)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { role: "CONTENT_ADMIN" }, { state: "REQUESTED" }, { organization: "urn:li:person:123" },
    { organization: "urn:li:organization:../admin" }, { organizationTarget: "urn:li:organization:456" },
    { roleAssignee: "not-a-person" },
  ])("rejects unauthorized or ambiguous page entries %j", async override => {
    const f = linkedInFixture(); f.replies[2] = { elements: [{ ...f.entry(123), ...override }], paging: { start: 0, count: 10, links: [] } };
    await expect(createLinkedInOAuthAdapter(f.config, f.fetcher).exchange(f.input)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([{ ids: [] }, { ids: [123, 123] }])("rejects empty or duplicate company lists %j", async ({ ids }) => {
    const f = linkedInFixture(); f.replies[2] = { elements: ids.map(f.entry), paging: { start: 0, count: 10, links: [] } };
    await expect(createLinkedInOAuthAdapter(f.config, f.fetcher).exchange(f.input)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it("normalizes organizationTarget and never follows a provider-supplied next URL", async () => {
    const f = linkedInFixture();
    f.replies.splice(2, 2,
      { elements: Array.from({ length: 10 }, (_, n) => f.entry(n + 1)), paging: { start: 0, count: 10, links: [{ rel: "next", href: "http://127.0.0.1/private" }] } },
      { elements: [{ ...f.entry(11), organization: undefined, organizationTarget: "urn:li:organization:11" }], paging: { start: 10, count: 10, links: [] } },
      ...Array.from({ length: 11 }, (_, n) => ({ id: n + 1, localizedName: `Company ${n + 1}` })));
    const result = await createLinkedInOAuthAdapter(f.config, f.fetcher).exchange(f.input);
    expect(result).toHaveLength(11);
    expect(String(f.fetcher.mock.calls[3][0])).toContain("start=10");
    expect(f.fetcher.mock.calls.every(([url]) => new URL(String(url)).hostname.endsWith("linkedin.com"))).toBe(true);
  });
  it("rejects additional pages instead of silently dropping eligible accounts", async () => {
    const f = linkedInFixture();
    f.replies.splice(2, 2, ...[0, 10].map(start => ({ elements: Array.from({ length: 10 }, (_, n) => f.entry(start + n + 1)), paging: { start, count: 10, links: [{ rel: "next" }] } })));
    await expect(createLinkedInOAuthAdapter(f.config, f.fetcher).exchange(f.input)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([{ id: 456 }, { localizedName: "" }, { localizedName: "x".repeat(121) }])("rejects mismatched or malformed company details %j", async override => {
    const f = linkedInFixture(); f.replies[3] = { id: 123, localizedName: "Test", ...override };
    await expect(createLinkedInOAuthAdapter(f.config, f.fetcher).exchange(f.input)).rejects.toThrow();
  });
  it.each(["error", "redirect", "html", "invalid-json", "declared-large", "stream-large", "network"])("fails closed without retry or secret leakage on %s", async kind => {
    const f = linkedInFixture();
    const responses: Record<string, unknown> = {
      error: Response.json({ token: "secret-provider-body" }, { status: 401 }),
      redirect: new Response(null, { status: 302, headers: { location: "https://example.test" } }),
      html: new Response("secret-provider-body", { headers: { "content-type": "text/html" } }),
      "invalid-json": new Response("secret-provider-body", { headers: { "content-type": "application/json" } }),
      "declared-large": new Response("{}", { headers: { "content-type": "application/json", "content-length": "65537" } }),
      "stream-large": new Response('"' + "x".repeat(65537) + '"', { headers: { "content-type": "application/json" } }),
      network: new Error("secret-provider-body"),
    };
    f.replies[0] = responses[kind];
    await expect(createLinkedInOAuthAdapter(f.config, f.fetcher).exchange(f.input)).rejects.toThrow(/^LinkedIn account authorization could not be verified/);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("makes no request after cancellation or expired operator verification", async () => {
    const f = linkedInFixture();
    await expect(createLinkedInOAuthAdapter(f.config, f.fetcher).exchange({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(() => createLinkedInOAuthAdapter({ ...f.config, verifiedUntil: new Date(Date.now() - 1).toISOString() }, f.fetcher)).toThrow();
    expect(() => createLinkedInOAuthAdapter({ ...f.config, verifiedUntil: new Date(Date.now() + 91 * 86400000).toISOString() }, f.fetcher)).toThrow();
  });
  it("gates registration on explicit complete current configuration; never enables publishing", () => {
    const f = linkedInFixture();
    vi.stubEnv("LINKEDIN_CONNECTIONS_ENABLED", "false");
    expect(configuredSocialOAuthAdapters()).toEqual({});
    vi.stubEnv("LINKEDIN_CONNECTIONS_ENABLED", "true");
    vi.stubEnv("LINKEDIN_CLIENT_ID", f.config.clientId); vi.stubEnv("LINKEDIN_CLIENT_SECRET", f.config.clientSecret);
    vi.stubEnv("LINKEDIN_API_VERSION", f.config.apiVersion); vi.stubEnv("LINKEDIN_API_VERIFIED_UNTIL", "");
    expect(configuredSocialOAuthAdapters()).toEqual({});
    vi.stubEnv("LINKEDIN_API_VERIFIED_UNTIL", f.config.verifiedUntil);
    expect(Object.keys(configuredSocialOAuthAdapters())).toEqual(["LinkedIn"]);
    const original = configuredSocialOAuthAdapters().LinkedIn!.config.version;
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "rotated-secret");
    expect(configuredSocialOAuthAdapters().LinkedIn!.config.version).not.toBe(original);
  });
});
