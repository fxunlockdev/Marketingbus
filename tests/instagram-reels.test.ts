import { afterEach, describe, expect, it, vi } from "vitest";
import { instagramFixture } from "./helpers/instagram-publishing";
import { createInstagramPublishingAdapter } from "../src/lib/social/instagram-publishing";
import { fingerprint } from "../src/lib/social/instagram-jpeg";
import { instagramVideo, reelRange } from "../src/lib/social/instagram-video";
import { publicationPayload } from "../src/lib/social/contracts";

// Transport-only synthetic MP4 header. Real playable output is exercised separately.
const bytes = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex");
async function fixture() {
  vi.stubEnv("INSTAGRAM_REELS_ENABLED", "true");
  const f = await instagramFixture();
  delete f.payload.image;
  f.payload.format = "video";
  f.payload.video = { sha256: fingerprint(bytes), bytes: bytes.length, width: 720, height: 1280, durationMs: 5000, shareToFeed: false };
  vi.mocked(f.transfer.read).mockResolvedValue(bytes);
  f.post.media_type = "VIDEO"; f.post.media_product_type = "REELS";
  return { ...f, adapter: createInstagramPublishingAdapter(f.config, f.fetcher, f.journal, f.transfer, f.delivery) };
}
describe("Instagram approved Reel transport", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([false, true])("publishes the frozen Reel with explicit feed choice %s", async share => {
    const f = await fixture(); f.payload.video!.shareToFeed = share;
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published", receipt: { externalPostId: f.id } });
    const form = new URLSearchParams(String(f.fetcher.mock.calls[2][1]!.body));
    expect(form.get("media_type")).toBe("REELS"); expect(form.get("share_to_feed")).toBe(String(share));
    expect(form.get("video_url")).toContain("/api/social/media/"); expect(form.has("image_url")).toBe(false); expect(form.has("alt_text")).toBe(false);
    expect(vi.mocked(f.delivery.issue).mock.calls[0][1].bytes).toEqual(bytes);
    expect(vi.mocked(f.journal.begin).mock.calls[0][0].adapterVersion).toMatch(/:reel-v1$/);
    expect(String(f.fetcher.mock.calls[5][0])).not.toContain("alt_text");
  });
  it("waits for known processing containers without renewing media delivery", async () => {
    const f = await fixture(); f.ready.status_code = "IN_PROGRESS";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "processing", retryAfterSeconds: 60 });
    expect(f.journal.begin).not.toHaveBeenCalled();
    f.ready.status_code = "FINISHED";
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, f.ready, { id: f.id }, f.post);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published" });
    expect(f.delivery.issue).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it.each(["disabled", "wrong destination", "too short", "too long", "landscape", "too large", "mixed media", "wrong format"])("rejects %s before HTTP", async kind => {
    const f = await fixture();
    if (kind === "disabled") vi.stubEnv("INSTAGRAM_REELS_ENABLED", "false");
    if (kind === "wrong destination") f.payload.channel = "Facebook";
    if (kind === "too short") f.payload.video!.durationMs = 2999;
    if (kind === "too long") f.payload.video!.durationMs = 30001;
    if (kind === "landscape") Object.assign(f.payload.video!, { width: 1280, height: 720 });
    if (kind === "too large") f.payload.video!.bytes = 20 * 1024 * 1024 + 1;
    if (kind === "mixed media") f.payload.image = (await instagramFixture()).payload.image;
    if (kind === "wrong format") f.payload.format = "static";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "failed", code: "INVALID_MEDIA" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([2, 4])("never repeats ambiguous write %s", async step => {
    const f = await fixture(); f.replies[step] = Error("lost acknowledgement");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toBeNull();
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, f.ready);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(step === 2 ? 1 : 2);
  });
  it.each(["owner", "caption", "type", "product", "timestamp"])("holds unverified readback %s", async kind => {
    const f = await fixture();
    if (kind === "owner") f.post.owner.id = "123";
    if (kind === "caption") f.post.caption = "Changed";
    if (kind === "type") f.post.media_type = "IMAGE";
    if (kind === "product") f.post.media_product_type = "FEED";
    if (kind === "timestamp") f.post.timestamp = "invalid";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.journal.record).toHaveBeenCalledOnce();
  });
  it("reconciles only a persisted post ID through readback", async () => {
    const f = await fixture(); f.replies[5] = Error("read lost");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    f.replies.push({ data: f.inspectedPage }, f.identity, f.post);
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toMatchObject({ externalPostId: f.id });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it("requires exact MP4 bytes, hash and length", async () => {
    const f = await fixture(), expected = f.payload.video!;
    expect(publicationPayload.parse(f.payload)).toEqual(f.payload);
    expect(instagramVideo(bytes, expected).bytes).toEqual(bytes);
    expect(() => instagramVideo(bytes, { ...expected, sha256: "a".repeat(64) })).toThrow();
    expect(() => instagramVideo(bytes, { ...expected, bytes: bytes.length + 1 })).toThrow();
    const wrong = Buffer.from(bytes); wrong[4] = 0;
    expect(() => instagramVideo(wrong, { ...expected, sha256: fingerprint(wrong) })).toThrow();
  });
});
describe("bounded single byte range", () => {
  it.each([["bytes=0-9", 0, 9], ["bytes=90-", 90, 99], ["bytes=-10", 90, 99], ["bytes=0-200", 0, 99], ["bytes=-200", 0, 99]])("parses %s", (range, start, end) => expect(reelRange(String(range), 100)).toEqual({ start, end }));
  it("uses full content without a Range", () => expect(reelRange(null, 100)).toBeNull());
  it.each(["bytes=100-", "bytes=4-3", "bytes=-0", "bytes=-", "items=0-1", "bytes=0-1,3-4", "bytes=9007199254740993-", "bytes=1.2-5", "bytes=0--1"])("rejects %s", range => expect(() => reelRange(range, 100)).toThrow());
});
