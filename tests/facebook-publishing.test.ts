import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { facebookPublishingFixture as fixture } from "./helpers/facebook-publishing";
import { configuredSocialAdapters } from "../src/lib/social/contracts";
import { validCandidateId } from "../src/lib/social/integrity";
describe("Facebook Page text publishing transport", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("submits once with the exact message and verifies Page, caption, visibility and candidate ID", async () => {
    const f = fixture();
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published", receipt: { externalPostId: f.id, permalink: f.post.permalink_url } });
    expect(f.journal.begin).toHaveBeenCalledOnce(); expect(f.journal.record).toHaveBeenCalledWith(expect.anything(), f.id);
    const [url, init] = f.fetcher.mock.calls[2];
    expect(url).toBe(`https://graph.facebook.com/${f.config.apiVersion}/789/feed`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit", headers: { Authorization: `Bearer ${f.account.token}` } });
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toEqual({ message: f.payload.caption, published: "true", appsecret_proof: createHmac("sha256", f.config.appSecret).update(f.account.token).digest("hex") });
    expect(body.has("access_token")).toBe(false); expect(body.has("link")).toBe(false); expect(body.has("scheduled_publish_time")).toBe(false);
    expect(new URL(String(f.fetcher.mock.calls[3][0])).pathname).toBe(`/${f.config.apiVersion}/${f.id}`);
  });
  it.each(["provider", "channel", "media", "format", "account"])("rejects unsupported %s before HTTP", async kind => {
    const f = fixture();
    if (kind === "provider") f.account.provider = "Instagram";
    if (kind === "channel") f.payload.channel = "LinkedIn";
    if (kind === "media") f.payload.mediaExportId = "export";
    if (kind === "format") f.payload.format = "reel";
    if (kind === "account") f.account.externalAccountId = "789/../feed";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "failed", code: "INVALID_MEDIA" }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["app", "token", "type", "profile", "scope", "granular", "expiry", "page", "capability"])("rejects %s denial before a write fence", async kind => {
    const f = fixture();
    if (kind === "app") f.inspectedPage.app_id = "999";
    if (kind === "token") f.inspectedPage.is_valid = false;
    if (kind === "type") f.inspectedPage.type = "USER";
    if (kind === "profile") f.inspectedPage.profile_id = "999";
    if (kind === "scope") f.inspectedPage.scopes = [];
    if (kind === "granular") f.replies[0] = { data: { ...f.inspectedPage, granular_scopes: [{ scope: "pages_manage_posts", target_ids: ["999"] }] } };
    if (kind === "expiry") f.inspectedPage.data_access_expires_at = 1;
    if (kind === "page") f.capability.id = "999";
    if (kind === "capability") f.capability.can_post = false;
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "failed" }); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it.each([429, 500, 503])("retries HTTP %s only before the write fence", async status => {
    const f = fixture(); f.replies[0] = new Response("private", { status });
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "retryable" }); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 429, 500, 503])("never retries HTTP %s after attempting publication", async status => {
    const f = fixture(); f.replies[2] = new Response("private", { status });
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" }); expect(f.journal.record).not.toHaveBeenCalled();
  });
  it.each(["network", "missing-id", "foreign-id", "non-json", "oversized"])("holds ambiguous submission: %s", async kind => {
    const f = fixture();
    if (kind === "network") f.replies[2] = Error("private timeout");
    if (kind === "missing-id") f.replies[2] = {};
    if (kind === "foreign-id") f.replies[2] = { id: "999_123" };
    if (kind === "non-json") f.replies[2] = new Response("private");
    if (kind === "oversized") f.replies[2] = Response.json({ id: f.id, other: "x".repeat(140000) });
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" }); expect(f.journal.record).not.toHaveBeenCalled();
    const count = f.fetcher.mock.calls.length;
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toBeNull(); expect(f.fetcher).toHaveBeenCalledTimes(count);
  });
  it.each(["id", "owner", "caption", "unpublished", "hidden", "date", "future", "app", "attachments", "reshare"])("rejects %s read-back without losing the candidate", async kind => {
    const f = fixture();
    if (kind === "id") f.post.id = "789_456";
    if (kind === "owner") f.post.from.id = "999";
    if (kind === "caption") f.post.message = "Changed";
    if (kind === "unpublished") f.post.is_published = false;
    if (kind === "hidden") f.post.is_hidden = true;
    if (kind === "date") f.post.created_time = "not-a-date";
    if (kind === "future") f.post.created_time = "2099-01-01T00:00:00Z";
    if (kind === "app") f.post.application.id = "999";
    if (kind === "attachments") f.post.attachments.data = [{ type: "photo" }];
    if (kind === "reshare") f.replies[3] = { ...f.post, parent_id: "789_111" };
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" }); expect(f.journal.record).toHaveBeenCalledWith(expect.anything(), f.id);
  });
  it("reconciles a saved ID with reads only, never repeats POST", async () => {
    const f = fixture(); f.replies[3] = Error("read timeout");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    f.replies.push({ data: f.inspectedPage }, f.capability, f.post);
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toMatchObject({ externalPostId: f.id });
    f.replies.push({ data: f.inspectedPage }, f.capability);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("has no metrics mapping, makes no metrics requests and invents no snapshot", async () => {
    const f = fixture(); expect(f.adapter.metricsAvailable).toBe(false);
    await expect(f.adapter.metrics(f.account, f.id, f.signal())).rejects.toThrow("not implemented"); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("omits unsafe permalinks without disguising a verified publication as missing", async () => {
    const f = fixture(); f.post.permalink_url = "https://attacker.example/secret";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published", receipt: { permalink: null } });
  });
  it("honors cancellation and journal failures without sending", async () => {
    const f = fixture(), c = new AbortController(); c.abort();
    expect(await f.adapter.publish(f.account, f.payload, "request", c.signal)).toMatchObject({ state: "failed" }); expect(f.fetcher).not.toHaveBeenCalled();
    vi.mocked(f.journal.begin).mockRejectedValue(Error("database offline"));
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" }); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("registers only explicitly enabled, current publishers", () => {
    const f = fixture();
    for (const [key, value] of Object.entries({ SOCIAL_EXECUTION_ENABLED: "true", FACEBOOK_CONNECTIONS_ENABLED: "true", FACEBOOK_PUBLISHING_ENABLED: "true", LINKEDIN_PUBLISHING_ENABLED: "false", META_APP_ID: f.config.appId, META_APP_SECRET: f.config.appSecret, META_API_VERSION: f.config.apiVersion, META_API_VERIFIED_UNTIL: f.config.verifiedUntil })) vi.stubEnv(key, value);
    expect(Object.keys(configuredSocialAdapters())).toEqual(["Facebook"]);
    vi.stubEnv("FACEBOOK_PUBLISHING_ENABLED", "false"); expect(configuredSocialAdapters()).toEqual({});
    vi.stubEnv("FACEBOOK_PUBLISHING_ENABLED", "true"); vi.stubEnv("SOCIAL_EXECUTION_ENABLED", "false"); expect(configuredSocialAdapters()).toEqual({});
    vi.stubEnv("SOCIAL_EXECUTION_ENABLED", "true"); vi.stubEnv("META_API_VERIFIED_UNTIL", "2020-01-01T00:00:00Z"); expect(configuredSocialAdapters()).toEqual({});
  });
  it("binds candidate IDs to their provider and Page without broadening Instagram", () => {
    expect(validCandidateId("Facebook", "789_123", "789")).toBe(true);
    expect(validCandidateId("Facebook", "789_123", "78")).toBe(false);
    expect(validCandidateId("Facebook", "urn:li:share:123", "789")).toBe(false);
    expect(validCandidateId("LinkedIn", "789_123", "789")).toBe(false);
    expect(validCandidateId("Instagram", "789_123", "789")).toBe(false);
  });
});
