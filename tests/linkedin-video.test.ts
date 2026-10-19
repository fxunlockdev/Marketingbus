import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkedInVideoFixture } from "./helpers/linkedin-video";
import { MetricSourceChangedError, supportsPublicationMetrics } from "../src/lib/social/contracts";

describe("LinkedIn approved multipart video transport", () => {
  beforeEach(() => vi.stubEnv("LINKEDIN_VIDEO_PUBLISHING_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());
  it("uploads exact contiguous parts, finalizes once, and verifies the exact post", async () => {
    const f = linkedInVideoFixture();
    expect(f.adapter.imagePublishingAvailable).toBe(false); expect(f.adapter.videoPublishingAvailable).toBe(true);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published", receipt: { externalPostId: f.id } });
    const parts = f.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(parts).toHaveLength(2);
    expect(Buffer.concat(parts.map(([, init]) => Buffer.from(init!.body as Uint8Array)))).toEqual(f.bytes);
    for (const [, init] of parts) expect(init).toMatchObject({ headers: { "Content-Type": "application/octet-stream" }, redirect: "error", cache: "no-store", credentials: "omit" });
    for (const [, init] of parts) expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(f.fetcher.mock.calls[5][1]!.body))).toEqual({ finalizeUploadRequest: { video: f.videoId, uploadToken: "private-upload-token", uploadedPartIds: ["part-1", "part-2"] } });
    expect(JSON.parse(String(f.fetcher.mock.calls[7][1]!.body)).content).toEqual({ media: { id: f.videoId } });
    expect(f.state.uploaded).toBe(true); expect(supportsPublicationMetrics(f.adapter, f.payload)).toBe(true);
  });
  it.each(["disabled", "short", "long", "too small", "too large", "dimensions", "feed placement", "wrong channel", "wrong format"])("rejects %s before HTTP", async kind => {
    const f = linkedInVideoFixture(), video = f.payload.video!;
    if (kind === "disabled") vi.stubEnv("LINKEDIN_VIDEO_PUBLISHING_ENABLED", "false");
    if (kind === "short") video.durationMs = 2999;
    if (kind === "long") video.durationMs = 30001;
    if (kind === "too small") video.bytes = 75000;
    if (kind === "too large") video.bytes = 20 * 1024 * 1024 + 1;
    if (kind === "dimensions") video.width = 721;
    if (kind === "feed placement") video.shareToFeed = true;
    if (kind === "wrong channel") f.payload.channel = "Facebook";
    if (kind === "wrong format") f.payload.format = "static";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "failed", code: "INVALID_MEDIA" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([[720, 720], [720, 900], [1280, 720]])("supports approved %s×%s exports", async (width, height) => {
    const f = linkedInVideoFixture(); Object.assign(f.payload.video!, { width, height });
    Object.assign(f.video, { aspectRatioWidth: width, aspectRatioHeight: height });
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published" });
  });
  it.each(["hash", "bytes", "signature"])("rejects changed %s before registration", async kind => {
    const f = linkedInVideoFixture();
    if (kind === "hash") f.payload.video!.sha256 = "a".repeat(64);
    if (kind === "bytes") f.payload.video!.bytes++;
    if (kind === "signature") f.bytes.write("nope", 4);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.transfer.begin).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([2, 3, 4, 5, 7])("does not repeat writes after an uncertain response at request %s", async index => {
    const f = linkedInVideoFixture(); f.replies[index] = Error("lost response containing private data");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    const writesBefore = f.fetcher.mock.calls.filter(([url, init]) => init?.method && !String(url).endsWith("introspectToken")).length;
    f.replies.splice(0, f.replies.length, f.introspection, f.acl, f.video);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls.filter(([url, init]) => init?.method && !String(url).endsWith("introspectToken"))).toHaveLength(writesBefore);
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toBeNull();
  });
  it.each(["gap", "overlap", "reversed", "incomplete", "oversized", "empty", "expiry", "foreign url", "wrong asset", "redirect", "bad etag", "duplicate etag", "finalize error"])("holds malformed %s without publishing", async kind => {
    const f = linkedInVideoFixture(), value = f.initialized.value;
    if (kind === "gap") value.uploadInstructions[1].firstByte++;
    if (kind === "overlap") value.uploadInstructions[1].firstByte--;
    if (kind === "reversed") value.uploadInstructions.reverse();
    if (kind === "incomplete") value.uploadInstructions.pop();
    if (kind === "oversized") value.uploadInstructions[0].lastByte = 99999999;
    if (kind === "empty") value.uploadInstructions = [];
    if (kind === "expiry") value.uploadUrlsExpireAt = Date.now() + 100;
    if (kind === "foreign url") value.uploadInstructions[0].uploadUrl = "https://www.linkedin.com.evil.test/upload";
    if (kind === "wrong asset") value.uploadInstructions[0].uploadUrl = "https://www.linkedin.com/dms-uploads/other/uploadedVideo";
    if (kind === "redirect") f.replies[3] = new Response(null, { status: 302, headers: { location: "https://evil.test" } });
    if (kind === "bad etag") f.replies[3] = new Response(null, { status: 200 });
    if (kind === "duplicate etag") f.replies[4] = f.uploadReply(1);
    if (kind === "finalize error") f.replies[5] = new Response(null, { status: 500 });
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.journal.begin).not.toHaveBeenCalled(); expect(f.state.uploaded).toBe(false);
  });
  it.each(["owner", "duration", "ratio", "missing metadata", "identity"])("does not post mismatched processed %s", async kind => {
    const f = linkedInVideoFixture();
    if (kind === "owner") f.video.owner = "urn:li:organization:999";
    if (kind === "duration") f.video.duration += 1000;
    if (kind === "ratio") f.video.aspectRatioWidth = 16;
    if (kind === "missing metadata") f.replies[6] = { id: f.videoId, owner: f.video.owner, status: "AVAILABLE" };
    if (kind === "identity") f.video.id = "urn:li:video:other";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it("polls processing without repeating registration, parts or finalization", async () => {
    const f = linkedInVideoFixture(); f.video.status = "PROCESSING";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "processing", retryAfterSeconds: 60 });
    f.video.status = "AVAILABLE";
    f.replies.splice(0, f.replies.length, f.introspection, f.acl, f.video, new Response(null, { status: 201, headers: { "x-restli-id": f.id } }), f.post);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published" });
    expect(f.transfer.read).toHaveBeenCalledOnce(); expect(f.transfer.begin).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
  });
  it("reports a definite processing failure without posting", async () => {
    const f = linkedInVideoFixture(); f.video.status = "PROCESSING_FAILED";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "failed", code: "INVALID_MEDIA" });
    expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it("revalidates approval between parts and stops when revoked", async () => {
    const f = linkedInVideoFixture(); vi.mocked(f.transfer.check).mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(Error("approval changed"));
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it("recovers a known post using read-back only", async () => {
    const f = linkedInVideoFixture(); f.replies[8] = Error("read timeout");
    await f.adapter.publish(f.account, f.payload, "request", f.signal());
    f.replies.push(f.introspection, f.acl, f.post);
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toMatchObject({ externalPostId: f.id });
    expect(f.fetcher.mock.calls.filter(([url]) => String(url) === "https://api.linkedin.com/rest/posts")).toHaveLength(1);
  });
  it("binds organic post metrics to the exact video and does not invent video views", async () => {
    const f = linkedInVideoFixture(); f.replies.splice(2, f.replies.length, f.post, f.stats, f.post);
    expect(await f.adapter.metrics(f.account, f.id, f.signal(), { payload: f.payload, mediaExternalId: f.videoId, publishedAt: new Date(f.post.publishedAt) })).toMatchObject({ impressions: 100, engagements: 6, videoViews: null });
  });
  it.each(["before", "after"])("invalidates a swapped video %s metric retrieval", async when => {
    const f = linkedInVideoFixture(), changed = { ...f.post, content: { media: { id: "urn:li:video:changed" } } };
    f.replies.splice(2, f.replies.length, when === "before" ? changed : f.post, f.stats, when === "after" ? changed : f.post);
    await expect(f.adapter.metrics(f.account, f.id, f.signal(), { payload: f.payload, mediaExternalId: f.videoId, publishedAt: new Date(f.post.publishedAt) })).rejects.toBeInstanceOf(MetricSourceChangedError);
  });
});
