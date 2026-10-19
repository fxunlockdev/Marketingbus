import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { instagramFixture } from "./helpers/instagram-publishing";
import { configuredSocialAdapters } from "../src/lib/social/contracts";
import { instagramJpeg, fingerprint } from "../src/lib/social/instagram-jpeg";
import { instagramDeliveryOrigin } from "../src/lib/social/instagram-delivery";
import { GET, HEAD, POST } from "../src/app/api/social/media/[publicationId]/[token]/route";
describe("Instagram approved single-image publishing", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("converts a verified PNG, creates one container and verifies the exact image post", async () => {
    const f = await instagramFixture();
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published", receipt: { externalPostId: f.id } });
    const container = new URLSearchParams(String(f.fetcher.mock.calls[2][1]!.body));
    expect(container.get("image_url")).toContain("/api/social/media/"); expect(container.get("caption")).toBe(f.payload.caption); expect(container.get("alt_text")).toBe(f.payload.image!.altText);
    expect(container.has("access_token")).toBe(false);
    expect(new URLSearchParams(String(f.fetcher.mock.calls[4][1]!.body)).get("creation_id")).toBe(f.containerId);
    const jpeg = vi.mocked(f.delivery.issue).mock.calls[0][1];
    expect(await sharp(jpeg.bytes).metadata()).toMatchObject({ format: "jpeg", width: 1080, height: 1080 });
    expect(jpeg.sha256).toBe(fingerprint(jpeg.bytes)); expect(f.adapter.metricsAvailable).toBe(false);
  });
  it.each(["no image", "long caption", "landscape", "wrong account", "wrong provider"])("refuses %s before HTTP", async kind => {
    const f = await instagramFixture();
    if (kind === "no image") { f.payload.mediaExportId = null; delete f.payload.image; }
    if (kind === "long caption") f.payload.caption = "a".repeat(2201);
    if (kind === "landscape") f.payload.image!.width = 1200;
    if (kind === "wrong account") f.account.externalAccountId = "../me";
    if (kind === "wrong provider") f.account.provider = "Facebook";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "failed", code: "INVALID_MEDIA" }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["page", "linked account", "scope target", "revoked"])("rejects changed authorization: %s", async kind => {
    const f = await instagramFixture();
    if (kind === "page") f.identity.id = "999";
    if (kind === "linked account") f.identity.instagram_business_account.id = "999";
    if (kind === "scope target") f.replies[0] = { data: { ...f.inspectedPage, granular_scopes: [{ scope: "instagram_content_publish", target_ids: ["999"] }] } };
    if (kind === "revoked") f.replies[0] = new Response("", { status: 401 });
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "failed" }); expect(f.transfer.begin).not.toHaveBeenCalled();
  });
  it.each([2, 4])("never repeats ambiguous write at step %s", async step => {
    const f = await instagramFixture(); f.replies[step] = Error("lost acknowledgement");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    const calls = f.fetcher.mock.calls.length;
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toBeNull(); expect(f.fetcher).toHaveBeenCalledTimes(calls);
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, f.ready);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(step === 2 ? 1 : 2);
  });
  it.each([{}, { id: "7654321", post_id: "1234567" }])("holds an invalid or unexpectedly published container response", async response => {
    const f = await instagramFixture(); f.replies[2] = response;
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.journal.begin).not.toHaveBeenCalled(); expect(f.transfer.record).not.toHaveBeenCalled();
  });
  it("polls a known processing container without renewing delivery or creating another container", async () => {
    const f = await instagramFixture(); f.ready.status_code = "IN_PROGRESS";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "retryable", retryAfterSeconds: 60 });
    expect(f.journal.begin).not.toHaveBeenCalled(); f.ready.status_code = "FINISHED";
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, f.ready, { id: f.id }, f.post);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published" });
    expect(f.delivery.issue).toHaveBeenCalledOnce(); expect(f.transfer.begin).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it.each(["ERROR", "EXPIRED", "PUBLISHED", "UNKNOWN"])("does not publish a container in %s", async status => {
    const f = await instagramFixture(); f.ready.status_code = status;
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: ["ERROR", "EXPIRED"].includes(status) ? "failed" : "uncertain" }); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it.each(["owner", "caption", "alt text", "type", "product", "date"])("holds incorrect read-back %s", async kind => {
    const f = await instagramFixture();
    if (kind === "owner") f.post.owner.id = "999";
    if (kind === "caption") f.post.caption = "Unapproved copy";
    if (kind === "alt text") f.post.alt_text = "Unapproved alt";
    if (kind === "type") f.post.media_type = "VIDEO";
    if (kind === "product") f.post.media_product_type = "STORY";
    if (kind === "date") f.post.timestamp = "invalid";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" }); expect(f.journal.record).toHaveBeenCalledWith(expect.anything(), f.id);
  });
  it("reconciles the known candidate through reads only", async () => {
    const f = await instagramFixture(); f.replies[5] = Error("read lost");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    f.replies.push({ data: f.inspectedPage }, f.identity, f.post);
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toMatchObject({ externalPostId: f.id });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it("uses deterministic bounded JPEG conversion and rejects changed bytes or geometry", async () => {
    const f = await instagramFixture(), first = await instagramJpeg(f.bytes, f.payload.image!);
    expect(await instagramJpeg(f.bytes, f.payload.image!)).toEqual(first);
    await expect(instagramJpeg(new Uint8Array([1]), f.payload.image!)).rejects.toThrow();
    await expect(instagramJpeg(f.bytes, { ...f.payload.image!, height: 1350 })).rejects.toThrow();
  });
  it("requires explicit activation and a public HTTPS delivery origin", async () => {
    const f = await instagramFixture();
    for (const [key, value] of Object.entries({ SOCIAL_EXECUTION_ENABLED: "true", INSTAGRAM_CONNECTIONS_ENABLED: "true", INSTAGRAM_PUBLISHING_ENABLED: "true", APP_ORIGIN: "https://studio.marketingbus.com", META_APP_ID: f.config.appId, META_APP_SECRET: f.config.appSecret, META_API_VERSION: f.config.apiVersion, META_API_VERIFIED_UNTIL: f.config.verifiedUntil })) vi.stubEnv(key, value);
    expect(configuredSocialAdapters().Instagram?.imagePublishingAvailable).toBe(true);
    vi.stubEnv("APP_ORIGIN", "http://localhost:3000"); expect(configuredSocialAdapters().Instagram).toBeUndefined();
    for (const url of ["https://127.0.0.1", "https://localhost", "https://service.internal", "https://host.com/path", "https://a:b@host.com", "https://host.com?x=y"]) expect(() => instagramDeliveryOrigin(url)).toThrow();
  });
  it("responds uniformly to disabled, invalid and HEAD delivery without cache or secret reflection", async () => {
    vi.stubEnv("INSTAGRAM_PUBLISHING_ENABLED", "false");
    const response = await GET(new Request("https://studio.marketingbus.com/"), { params: Promise.resolve({ publicationId: "missing", token: "a".repeat(64) }) });
    expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toContain("no-store"); expect(await response.text()).toBe("");
    expect((await HEAD(new Request("https://studio.marketingbus.com/", { method: "HEAD" }), { params: Promise.resolve({ publicationId: "missing", token: "a".repeat(64) }) })).status).toBe(404); expect(POST().status).toBe(405);
  });
});
