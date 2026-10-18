import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinkedInDataAdapter, createMetaDataAdapter, configuredSocialDataAdapters } from "../src/lib/social/account-data-adapters";
import { accountSnapshot, safeSocialPermalink } from "../src/lib/social/account-data-contracts";
import { metaFixture } from "./helpers/meta";
import { linkedInFixture } from "./helpers/linkedin";
const signal = () => AbortSignal.timeout(30000);
function meta(provider: "Facebook" | "Instagram" = "Facebook") {
  const f = metaFixture(provider), id = provider === "Facebook" ? "789" : "987";
  const profile = provider === "Facebook" ? { id, name: "Local page", followers_count: 0, fan_count: 4 } : { id, username: "local_company", followers_count: 0, media_count: 4 };
  const post = provider === "Facebook" ? { id: "789_123", from: { id }, message: "Original copy", created_time: "2026-01-01T00:00:00Z", permalink_url: "https://www.facebook.com/789/posts/123" } : { id: "123", owner: { id }, caption: "Original copy", timestamp: "2026-01-01T00:00:00Z", permalink: "https://www.instagram.com/p/local/", media_type: "IMAGE", like_count: 0 };
  f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, profile, { data: [post], paging: { next: "https://untrusted.example/never-follow" } });
  const adapter = createMetaDataAdapter(provider, f.config, f.fetcher);
  return { ...f, profile, post, adapter, account: { id: "local", provider, externalAccountId: id, token: "private-page-token" } };
}
function linkedin() {
  const f = linkedInFixture(), id = "urn:li:organization:123";
  const post = { id: "urn:li:share:456", author: id, lifecycleState: "PUBLISHED", commentary: "Company news", publishedAt: 1767225600000 };
  const stats = { elements: [{ organizationalEntity: id, totalShareStatistics: { impressionCount: 100, clickCount: 0, likeCount: 7 } }] };
  f.replies.splice(0, f.replies.length, f.introspection, { id: 123, localizedName: "Local company" }, { elements: [post], paging: { links: [{ rel: "next" }] } }, stats);
  return { ...f, post, stats, adapter: createLinkedInDataAdapter(f.config, f.fetcher), account: { id: "local", provider: "LinkedIn" as const, externalAccountId: id, token: "private-linkedin-token" } };
}
afterEach(() => vi.unstubAllEnvs());
describe("bounded social account data adapters", () => {
  it.each(["Facebook", "Instagram"] as const)("reads verified %s profile and published posts without following provider links", async provider => {
    const f = meta(provider), result = await f.adapter.read(f.account, signal());
    expect(result).toMatchObject({ provider, externalAccountId: f.account.externalAccountId, profile: { followers: 0 }, hasMore: true, lifetimeOrganic: { available: false, impressions: null } });
    expect(result.posts[0]).toMatchObject({ text: "Original copy", comments: null, likes: provider === "Instagram" ? 0 : null });
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    for (const [url, init] of f.fetcher.mock.calls) { expect(new URL(String(url)).hostname).toBe("graph.facebook.com"); expect(init?.redirect).toBe("error"); expect(init?.cache).toBe("no-store"); }
  });
  it("reads LinkedIn company totals separately from posts and preserves unavailable fields", async () => {
    const f = linkedin(), result = await f.adapter.read(f.account, signal());
    expect(result.lifetimeOrganic).toMatchObject({ available: true, impressions: 100, clicks: 0, comments: null });
    expect(result.posts[0]).toMatchObject({ likes: null, comments: null, permalink: null, sponsored: null });
    expect(result.profile.followers).toBeNull(); expect(result.hasMore).toBe(true);
    const [url, init] = f.fetcher.mock.calls[2];
    expect(new URL(String(url)).searchParams.get("viewContext")).toBe("READER");
    expect(init?.headers).toMatchObject({ "LinkedIn-Version": f.config.apiVersion, Authorization: `Bearer ${f.account.token}` });
  });
  it.each([400, 403, 404])("keeps unavailable LinkedIn statistics null after HTTP %s", async status => {
    const f = linkedin(); f.replies[3] = new Response("private-error", { status });
    const result = await f.adapter.read(f.account, signal()); expect(result.lifetimeOrganic).toMatchObject({ available: false, impressions: null, clicks: null });
  });
  it.each([401, 429, 500])("does not disguise LinkedIn HTTP %s as zero analytics or retry", async status => {
    const f = linkedin(); f.replies[3] = new Response("private-error", { status });
    await expect(f.adapter.read(f.account, signal())).rejects.toThrow("could not be verified"); expect(f.fetcher).toHaveBeenCalledTimes(4);
  });
  it.each(["foreign-post", "draft", "foreign-stats", "negative-count", "wrong-app", "revoked", "expired", "missing-scope"])("rejects LinkedIn %s", async fault => {
    const f = linkedin();
    if (fault === "foreign-post") f.post.author = "urn:li:organization:999";
    if (fault === "draft") f.post.lifecycleState = "DRAFT";
    if (fault === "foreign-stats") f.stats.elements[0].organizationalEntity = "urn:li:organization:999";
    if (fault === "negative-count") f.stats.elements[0].totalShareStatistics.impressionCount = -1;
    if (fault === "wrong-app") f.introspection.client_id = "other";
    if (fault === "revoked") f.introspection.active = false;
    if (fault === "expired") f.introspection.expires_at = 1;
    if (fault === "missing-scope") f.introspection.scope = "openid";
    await expect(f.adapter.read(f.account, signal())).rejects.toThrow("could not be verified");
  });
  it.each(["Facebook", "Instagram"] as const)("rejects %s data from another account", async provider => {
    const f = meta(provider); f.account.externalAccountId = "111";
    await expect(f.adapter.read(f.account, signal())).rejects.toThrow("could not be verified"); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["foreign-owner", "duplicate", "future", "oversize", "revoked"])("rejects invalid Meta response: %s", async fault => {
    const f = meta("Instagram"), post = { id: "123", owner: { id: fault === "foreign-owner" ? "111" : "987" }, caption: "Text", timestamp: fault === "future" ? "2099-01-01T00:00:00Z" : "2026-01-01T00:00:00Z", media_type: "VIDEO" };
    f.replies[3] = { data: fault === "duplicate" ? [post, post] : [post] };
    if (fault === "oversize") f.replies[3] = Response.json({ data: "x".repeat(150000) });
    if (fault === "revoked") f.inspectedPage.is_valid = false;
    await expect(f.adapter.read(f.account, signal())).rejects.toThrow("could not be verified");
  });
  it("truncates long captions explicitly and omits unsafe links", async () => {
    const f = meta("Instagram"); f.replies[3] = { data: [{ id: "123", owner: { id: "987" }, caption: "x".repeat(6000), timestamp: "2026-01-01T00:00:00Z", media_type: "IMAGE", permalink: "https://attacker.example/" }] };
    const result = await f.adapter.read(f.account, signal()); expect(result.posts[0]).toMatchObject({ textTruncated: true, permalink: null }); expect(result.posts[0].text).toHaveLength(5000);
  });
  it("honors cancellation without issuing a request", async () => {
    const f = meta(), controller = new AbortController(); controller.abort();
    await expect(f.adapter.read(f.account, controller.signal)).rejects.toThrow("could not be verified"); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["http://facebook.com/1", "https://facebook.com.attacker.example/", "https://facebook.com/?access_token=secret", "https://user:pass@facebook.com/", "javascript:alert(1)"])("excludes unsafe permalink %s", raw => expect(safeSocialPermalink(raw, "Facebook")).toBeNull());
  it("does not coerce missing metrics to zero or accept arbitrary extra snapshot fields", async () => {
    const f = meta(), value = await f.adapter.read(f.account, signal());
    expect(accountSnapshot.safeParse({ ...value, token: "private" }).success).toBe(false);
    expect(accountSnapshot.safeParse({ ...value, lifetimeOrganic: { ...value.lifetimeOrganic, clicks: 0 } }).success).toBe(false);
  });
  it("leaves reads disabled unless the global and matching destination gates are enabled", () => {
    vi.stubEnv("SOCIAL_DATA_ENABLED", "false"); expect(configuredSocialDataAdapters()).toEqual({});
    const f = meta(); vi.stubEnv("SOCIAL_DATA_ENABLED", "true"); vi.stubEnv("FACEBOOK_CONNECTIONS_ENABLED", "true"); vi.stubEnv("INSTAGRAM_CONNECTIONS_ENABLED", "false"); vi.stubEnv("LINKEDIN_CONNECTIONS_ENABLED", "false");
    for (const [key, value] of Object.entries({ META_APP_ID: f.config.appId, META_APP_SECRET: f.config.appSecret, META_API_VERSION: f.config.apiVersion, META_API_VERIFIED_UNTIL: f.config.verifiedUntil })) vi.stubEnv(key, value);
    expect(Object.keys(configuredSocialDataAdapters())).toEqual(["Facebook"]);
    vi.stubEnv("META_API_VERIFIED_UNTIL", "2020-01-01T00:00:00Z"); expect(configuredSocialDataAdapters()).toEqual({});
  });
});
