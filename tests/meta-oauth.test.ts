import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetaOAuthAdapter, META_SCOPES } from "../src/lib/social/meta-oauth";
import { configuredSocialOAuthAdapters } from "../src/lib/social/oauth";
import { metaFixture } from "./helpers/meta";
afterEach(() => vi.unstubAllEnvs());
describe("official Meta account authorization", () => {
  it.each(["Facebook", "Instagram"] as const)("validates %s user/page grants and returns only explicit eligible choices", async provider => {
    const f = metaFixture(provider), adapter = createMetaOAuthAdapter(provider, f.config, f.fetcher);
    expect(adapter.config.authentication).toBe("META_CONFIDENTIAL");
    expect(adapter.config.authorizationEndpoint).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(JSON.stringify(adapter.config)).not.toContain(f.config.appSecret);
    const accounts = await adapter.exchange(f.input);
    expect(accounts).toEqual([{ externalAccountId: provider === "Facebook" ? "789" : "987", label: provider === "Facebook" ? "Local company" : "@local_company", token: "local-page-token", permissions: META_SCOPES[provider], expiresAt: new Date(f.user.expires_at * 1000).toISOString() }]);
    expect(f.fetcher).toHaveBeenCalledTimes(provider === "Facebook" ? 6 : 7);
    const exchange = new URL(String(f.fetcher.mock.calls[0][0]));
    expect(exchange.searchParams.get("redirect_uri")).toBe(f.input.redirectUri);
    expect(new URL(String(f.fetcher.mock.calls[1][0])).searchParams.get("grant_type")).toBe("fb_exchange_token");
    for (const [url, init] of f.fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe("https://graph.facebook.com");
      expect(init).toMatchObject({ redirect: "error", cache: "no-store", credentials: "omit" });
    }
    expect(f.fetcher.mock.calls[3][1]?.headers).toMatchObject({ Authorization: "Bearer local-long-token" });
    expect(new URL(String(f.fetcher.mock.calls[3][0])).searchParams.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([{ app_id: "999" }, { is_valid: false }, { type: "APP" }, { scopes: [] }, { expires_at: 1 }, { expires_at: 0 }, { data_access_expires_at: 1 }])("rejects invalid user authorization %j before discovery", async override => {
    const f = metaFixture(); f.replies[2] = { data: { ...f.user, ...override } };
    await expect(createMetaOAuthAdapter("Facebook", f.config, f.fetcher).exchange(f.input)).rejects.toThrow(/^Meta account authorization could not be verified/);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([{ profile_id: "999" }, { user_id: "999" }, { app_id: "999" }, { is_valid: false }, { scopes: [] }, { expires_at: 1 }, { granular_scopes: [{ scope: "pages_manage_posts", target_ids: ["111"] }] }])("rejects wrong page authority %j", async override => {
    const f = metaFixture(); f.replies[4] = { data: { ...f.inspectedPage, ...override } };
    await expect(createMetaOAuthAdapter("Facebook", f.config, f.fetcher).exchange(f.input)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(5);
  });
  it.each(["no-tasks", "missing-token", "duplicate", "empty", "foreign-identity"])("rejects %s discovery", async kind => {
    const f = metaFixture();
    if (kind === "no-tasks") f.replies[3] = { data: [{ ...f.page, tasks: ["ANALYZE"] }] };
    if (kind === "missing-token") f.replies[3] = { data: [{ ...f.page, access_token: undefined }] };
    if (kind === "duplicate") f.replies[3] = { data: [f.page, f.page] };
    if (kind === "empty") f.replies[3] = { data: [] };
    if (kind === "foreign-identity") f.replies[5] = { ...f.identity, id: "222" };
    await expect(createMetaOAuthAdapter("Facebook", f.config, f.fetcher).exchange(f.input)).rejects.toThrow();
  });
  it.each(["not-linked", "changed-link", "wrong-profile"])("rejects Instagram %s", async kind => {
    const f = metaFixture("Instagram");
    if (kind === "not-linked") f.replies[3] = { data: [{ ...f.page, instagram_business_account: undefined }] };
    if (kind === "changed-link") f.replies[5] = { ...f.identity, instagram_business_account: { id: "222" } };
    if (kind === "wrong-profile") f.replies[6] = { id: "222", username: "wrong" };
    await expect(createMetaOAuthAdapter("Instagram", f.config, f.fetcher).exchange(f.input)).rejects.toThrow();
  });
  it("filters pages outside granular grants without losing an authorized page", async () => {
    const f = metaFixture();
    f.replies[2] = { data: { ...f.user, granular_scopes: [{ scope: "pages_manage_posts", target_ids: ["789"] }] } };
    f.replies[3] = { data: [{ ...f.page, id: "111" }, f.page] };
    expect(await createMetaOAuthAdapter("Facebook", f.config, f.fetcher).exchange(f.input)).toHaveLength(1);
  });
  it("uses validated cursors without following next URLs", async () => {
    const f = metaFixture();
    f.replies.splice(3, 1, { data: [{ ...f.page, id: "111", tasks: [] }], paging: { next: "http://127.0.0.1/private", cursors: { after: "safe_cursor" } } }, { data: [f.page] });
    expect(await createMetaOAuthAdapter("Facebook", f.config, f.fetcher).exchange(f.input)).toHaveLength(1);
    expect(String(f.fetcher.mock.calls[4][0])).toContain("after=safe_cursor");
    expect(f.fetcher.mock.calls.every(([url]) => new URL(String(url)).origin === "https://graph.facebook.com")).toBe(true);
  });
  it.each(["missing-cursor", "unsafe-cursor", "overflow"])("fails closed on %s pagination", async kind => {
    const f = metaFixture();
    const paging = { next: "https://ignored.example", cursors: { after: kind === "missing-cursor" ? undefined : kind === "unsafe-cursor" ? "../private?secret" : "cursor" } };
    f.replies[3] = { data: [{ ...f.page, tasks: [] }], paging };
    if (kind === "overflow") f.replies[4] = { data: [{ ...f.page, id: "111" }], paging: { next: "https://ignored.example", cursors: { after: "cursor2" } } };
    await expect(createMetaOAuthAdapter("Facebook", f.config, f.fetcher).exchange(f.input)).rejects.toThrow();
  });
  it.each(["redirect", "network", "large", "html", "bad-json"])("redacts %s errors and never retries an exchange", async kind => {
    const f = metaFixture();
    f.replies[0] = kind === "redirect" ? new Response(null, { status: 302, headers: { location: "https://unsafe.example" } }) : kind === "network" ? Error("local-secret-token") : kind === "large" ? Response.json({ payload: "x".repeat(131073) }) : new Response("local-secret-token", { headers: { "content-type": kind === "html" ? "text/html" : "application/json" } });
    await expect(createMetaOAuthAdapter("Facebook", f.config, f.fetcher).exchange(f.input)).rejects.toThrow(/^Meta account authorization could not be verified/);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("honors cancellation and configuration expiration without provider I/O", async () => {
    const f = metaFixture();
    await expect(createMetaOAuthAdapter("Facebook", f.config, f.fetcher).exchange({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(() => createMetaOAuthAdapter("Facebook", { ...f.config, verifiedUntil: new Date(Date.now() - 1).toISOString() })).toThrow();
  });
  it("registers independently gated destinations, never fixture endpoints", () => {
    const f = metaFixture();
    vi.stubEnv("LINKEDIN_CONNECTIONS_ENABLED", "false"); vi.stubEnv("FACEBOOK_CONNECTIONS_ENABLED", "true"); vi.stubEnv("INSTAGRAM_CONNECTIONS_ENABLED", "false");
    vi.stubEnv("META_APP_ID", f.config.appId); vi.stubEnv("META_APP_SECRET", f.config.appSecret); vi.stubEnv("META_API_VERSION", f.config.apiVersion); vi.stubEnv("META_API_VERIFIED_UNTIL", f.config.verifiedUntil);
    expect(Object.keys(configuredSocialOAuthAdapters())).toEqual(["Facebook"]);
    vi.stubEnv("INSTAGRAM_CONNECTIONS_ENABLED", "true"); expect(Object.keys(configuredSocialOAuthAdapters())).toEqual(["Facebook", "Instagram"]);
    vi.stubEnv("META_API_VERSION", "https://attacker.example"); expect(configuredSocialOAuthAdapters()).toEqual({});
  });
});
