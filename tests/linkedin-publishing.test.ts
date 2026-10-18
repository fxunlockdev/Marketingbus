import { describe, it, expect, vi, afterEach } from "vitest";
import { publishingFixture } from "./helpers/linkedin-publishing";
import { configuredSocialAdapters } from "../src/lib/social/contracts";
describe("LinkedIn verified text publication and per-post metrics", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("fences once, submits only approved text, persists the returned ID and verifies exact read-back", async () => {
    const f = publishingFixture(); const result = await f.adapter.publish(f.account, f.payload, "request", f.signal());
    expect(result).toMatchObject({ state: "published", receipt: { externalPostId: f.id, permalink: null } });
    expect(f.journal.begin).toHaveBeenCalledOnce(); expect(f.journal.record).toHaveBeenCalledWith(expect.anything(), f.id);
    const [url, init] = f.fetcher.mock.calls[2]; expect(url).toBe("https://api.linkedin.com/rest/posts");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ author: f.account.externalAccountId, commentary: f.payload.caption, lifecycleState: "PUBLISHED", visibility: "PUBLIC" });
    expect(String(f.fetcher.mock.calls[3][0])).toContain(encodeURIComponent(f.id));
  });
  it.each(["media", "provider", "channel", "format"])("refuses unsupported %s before networking", async kind => {
    const f = publishingFixture();
    if (kind === "media") f.payload.mediaExportId = "export";
    if (kind === "provider") f.account.provider = "Facebook";
    if (kind === "channel") f.payload.channel = "Instagram";
    if (kind === "format") f.payload.format = "video";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "failed", code: "INVALID_MEDIA" }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["role", "scope", "app", "expired", "revoked"])("rejects %s preflight before a write fence", async kind => {
    const f = publishingFixture();
    if (kind === "role") f.acl.elements[0].organization = "urn:li:organization:999";
    if (kind === "scope") f.introspection.scope = "openid";
    if (kind === "app") f.introspection.client_id = "other";
    if (kind === "expired") f.introspection.expires_at = 1;
    if (kind === "revoked") f.introspection.active = false;
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "failed" }); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it.each([429, 500, 503])("only allows retry for HTTP %s before submission", async status => {
    const f = publishingFixture(); f.replies[0] = new Response("private", { status });
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "retryable" }); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 429, 500, 503])("holds HTTP %s after the write fence as uncertain", async status => {
    const f = publishingFixture(); f.replies[2] = new Response("private-response", { status });
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" }); expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toBeNull(); expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it.each(["network", "missing-id", "wrong-id", "wrong-author", "changed-text", "draft", "media", "future"])("never claims success for %s", async kind => {
    const f = publishingFixture();
    if (kind === "network") f.replies[2] = Error("secret");
    if (kind === "missing-id") f.replies[2] = new Response(null, { status: 201 });
    if (kind === "wrong-id") f.replies[2] = new Response(null, { status: 201, headers: { "x-restli-id": "https://attacker.example/" } });
    if (kind === "wrong-author") f.post.author = "urn:li:organization:999";
    if (kind === "changed-text") f.post.commentary = "Different";
    if (kind === "draft") f.post.lifecycleState = "DRAFT";
    if (kind === "media") f.replies[3] = { ...f.post, content: { media: { id: "urn:li:image:other" } } };
    if (kind === "future") f.post.publishedAt = Date.now() + 1000000;
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
  });
  it("recovers a known candidate with reads only after the first read-back failed", async () => {
    const f = publishingFixture(); f.replies[3] = Error("read timeout");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    f.replies.push(f.introspection, f.acl, f.post);
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toMatchObject({ externalPostId: f.id });
    f.replies.push(f.introspection, f.acl);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls.filter(([url, init]) => url === "https://api.linkedin.com/rest/posts" && init?.method === "POST")).toHaveLength(1);
  });
  it("does not submit if the durable fence fails", async () => {
    const f = publishingFixture(); vi.mocked(f.journal.begin).mockRejectedValue(Error("database unavailable"));
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" }); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("maps exact-post organic metrics, separating missing reach and video views", async () => {
    const f = publishingFixture(); f.replies.splice(2, 2, f.post, f.stats);
    expect(await f.adapter.metrics(f.account, f.id, f.signal())).toMatchObject({ impressions: 100, engagements: 6, clicks: 4, reach: null, videoViews: null });
    expect(new URL(String(f.fetcher.mock.calls[3][0])).searchParams.get("shares")).toBe(`List(${f.id})`);
    expect(String(f.fetcher.mock.calls[3][0])).toContain(`shares=List(${encodeURIComponent(f.id)})`);
  });
  it("uses the exact UGC post filter and matching response identity", async () => {
    const f = publishingFixture(), id = "urn:li:ugcPost:456";
    f.post.id = id;
    f.replies.splice(2, 2, f.post, { elements: [{ organizationalEntity: f.account.externalAccountId, ugcPost: id, totalShareStatistics: f.stats.elements[0].totalShareStatistics }] });
    expect(await f.adapter.metrics(f.account, id, f.signal())).toMatchObject({ impressions: 100, engagements: 6 });
    const url = new URL(String(f.fetcher.mock.calls[3][0]));
    expect(url.searchParams.get("ugcPosts[0]")).toBe(id); expect(url.searchParams.has("shares")).toBe(false);
  });
  it("honors cancellation before any request or write fence", async () => {
    const f = publishingFixture(), controller = new AbortController(); controller.abort();
    expect(await f.adapter.publish(f.account, f.payload, "request", controller.signal)).toMatchObject({ state: "failed" });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it("holds successful writes with oversized read-back instead of accepting or resending", async () => {
    const f = publishingFixture(); f.replies[3] = Response.json({ ...f.post, other: "x".repeat(140000) });
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.journal.record).toHaveBeenCalledWith(expect.anything(), f.id);
  });
  it.each(["foreign-post", "foreign-company", "aggregate", "negative-likes", "empty", "denied"])("handles %s without inventing performance evidence", async kind => {
    const f = publishingFixture(); f.replies.splice(2, 2, f.post, f.stats);
    if (kind === "foreign-post") f.stats.elements[0].share = "urn:li:share:999";
    if (kind === "foreign-company") f.stats.elements[0].organizationalEntity = "urn:li:organization:999";
    if (kind === "aggregate") f.replies[3] = { elements: [{ organizationalEntity: f.account.externalAccountId, totalShareStatistics: f.stats.elements[0].totalShareStatistics }] };
    if (kind === "negative-likes") f.stats.elements[0].totalShareStatistics.likeCount = -1;
    if (kind === "empty") f.replies[3] = { elements: [] };
    if (kind === "denied") f.replies[3] = new Response("secret", { status: 403 });
    if (["negative-likes", "empty"].includes(kind)) expect(await f.adapter.metrics(f.account, f.id, f.signal())).toMatchObject({ engagements: null, impressions: kind === "empty" ? null : 100 });
    else await expect(f.adapter.metrics(f.account, f.id, f.signal())).rejects.toThrow("could not be verified");
  });
  it("requires independent configuration and never enables other destinations", () => {
    vi.stubEnv("LINKEDIN_PUBLISHING_ENABLED", "false"); expect(configuredSocialAdapters()).toEqual({});
    const f = publishingFixture(); for (const [key, value] of Object.entries({ SOCIAL_EXECUTION_ENABLED: "true", LINKEDIN_CONNECTIONS_ENABLED: "true", LINKEDIN_PUBLISHING_ENABLED: "true", LINKEDIN_CLIENT_ID: f.config.clientId, LINKEDIN_CLIENT_SECRET: f.config.clientSecret, LINKEDIN_API_VERSION: f.config.apiVersion, LINKEDIN_API_VERIFIED_UNTIL: f.config.verifiedUntil })) vi.stubEnv(key, value);
    expect(Object.keys(configuredSocialAdapters())).toEqual(["LinkedIn"]);
    vi.stubEnv("SOCIAL_EXECUTION_ENABLED", "false"); expect(configuredSocialAdapters()).toEqual({});
    vi.stubEnv("SOCIAL_EXECUTION_ENABLED", "true");
    vi.stubEnv("LINKEDIN_API_VERIFIED_UNTIL", "2020-01-01T00:00:00Z"); expect(configuredSocialAdapters()).toEqual({});
  });
});
