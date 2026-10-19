import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { facebookReelFixture } from "./helpers/facebook-reels";
import { supportsPublicationMetrics } from "../src/lib/social/contracts";

describe("Facebook approved Reel transport", () => {
  beforeEach(() => vi.stubEnv("FACEBOOK_REELS_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());
  it("uploads private bytes once and verifies the returned post, independently of image publishing", async () => {
    const f = facebookReelFixture();
    expect(f.adapter.videoPublishingAvailable).toBe(true); expect(f.adapter.imagePublishingAvailable).toBe(false);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published", receipt: { externalPostId: f.id } });
    const writes = f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(3);
    expect(new URLSearchParams(String(writes[0][1]!.body)).get("upload_phase")).toBe("start");
    expect(writes[1][0]).toBe(f.uploadUrl);
    expect(writes[1][1]).toMatchObject({ body: new Uint8Array(f.bytes), redirect: "error", credentials: "omit", headers: { offset: "0", file_size: String(f.bytes.length), Authorization: `OAuth ${f.account.token}` } });
    const finish = new URLSearchParams(String(writes[2][1]!.body));
    expect(Object.fromEntries(finish)).toMatchObject({ upload_phase: "finish", video_id: f.videoId, video_state: "PUBLISHED", description: f.payload.caption });
    for (const key of ["file_url", "video_url", "scheduled_publish_time", "share_to_feed", "access_token"]) expect(finish.has(key)).toBe(false);
    expect(vi.mocked(f.journal.begin).mock.calls[0][0].adapterVersion).toMatch(/:reel-v1$/);
    expect(supportsPublicationMetrics(f.adapter, f.payload)).toBe(false);
  });
  it.each(["disabled", "short", "long", "landscape", "feed placement", "wrong platform", "wrong format", "large"])("rejects %s before HTTP", async kind => {
    const f = facebookReelFixture();
    if (kind === "disabled") vi.stubEnv("FACEBOOK_REELS_ENABLED", "false");
    if (kind === "short") f.payload.video!.durationMs = 3999;
    if (kind === "long") f.payload.video!.durationMs = 30001;
    if (kind === "landscape") Object.assign(f.payload.video!, { width: 1280, height: 720 });
    if (kind === "feed placement") f.payload.video!.shareToFeed = true;
    if (kind === "wrong platform") f.payload.channel = "Instagram";
    if (kind === "wrong format") f.payload.format = "static";
    if (kind === "large") f.payload.video!.bytes = 20 * 1024 * 1024 + 1;
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "failed", code: "INVALID_MEDIA" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["hash", "length", "signature"])("rejects changed %s before allocating provider media", async kind => {
    const f = facebookReelFixture();
    if (kind === "hash") f.payload.video!.sha256 = "a".repeat(64);
    if (kind === "length") f.payload.video!.bytes++;
    if (kind === "signature") vi.mocked(f.transfer.read).mockResolvedValue(new Uint8Array(f.bytes.length));
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.transfer.begin).not.toHaveBeenCalled(); expect(f.journal.begin).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls).toHaveLength(2);
  });
  it.each([2, 3, 4])("never repeats an ambiguous write at step %s", async step => {
    const f = facebookReelFixture(); f.replies[step] = Error("lost provider response with private credentials");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.capability);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(step - 1);
    if (step < 4) {
      const before = f.fetcher.mock.calls.length;
      expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toBeNull();
      expect(f.fetcher.mock.calls).toHaveLength(before);
    }
  });
  it.each(["processing", "finish response lost", "post read lost"])("recovers %s using only the known video and post", async kind => {
    const f = facebookReelFixture();
    if (kind === "processing") f.video.status.publishing_phase.status = "in_progress";
    if (kind === "finish response lost") f.replies[4] = Error("timeout");
    if (kind === "post read lost") f.replies[6] = Error("timeout");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    f.video.status.publishing_phase.status = "complete";
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.capability, f.video, f.post);
    const before = f.fetcher.mock.calls.length;
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toMatchObject({ externalPostId: f.id });
    expect(f.fetcher.mock.calls.slice(before).every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
  });
  it.each(["http://rupload.facebook.com/video-upload/v26.0/456789", "https://evil.test/upload", "https://rupload.facebook.com/video-upload/v26.0/456789?access_token=x", "https://rupload.facebook.com/video-upload/v26.0/111"])("never follows unexpected upload destination %s", async url => {
    const f = facebookReelFixture(); f.replies[2] = { video_id: f.videoId, upload_url: url };
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls).toHaveLength(3); expect(f.state.externalId).toBe(f.videoId); expect(f.state.uploaded).toBe(false);
  });
  it.each(["owner", "caption", "unpublished", "failed", "post id", "post owner", "post video", "hidden", "date", "post caption"])("holds unverified receipt: %s", async kind => {
    const f = facebookReelFixture();
    if (kind === "owner") f.video.from.id = "999";
    if (kind === "caption") f.video.description = "Changed";
    if (kind === "unpublished") f.video.published = false;
    if (kind === "failed") f.video.status.video_status = "error";
    if (kind === "post id") f.video.post_id = "999_123";
    if (kind === "post owner") f.post.from = { id: "999" };
    if (kind === "post video") f.post.object_id = "111";
    if (kind === "hidden") f.post.is_hidden = true;
    if (kind === "date") f.post.created_time = "invalid";
    if (kind === "post caption") f.post.message = "Changed";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
  });
  it("does not accept a changed post candidate during reconciliation", async () => {
    const f = facebookReelFixture(); f.replies[6] = Error("read lost");
    await f.adapter.publish(f.account, f.payload, "request", f.signal());
    f.video.post_id = "789_555"; f.replies.push({ data: f.inspectedPage }, f.capability, f.video);
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toBeNull();
    expect(await f.journal.candidate({} as never)).toBe(f.id);
  });
  it("checks approval again between session creation and binary upload", async () => {
    const f = facebookReelFixture(); vi.mocked(f.transfer.check).mockResolvedValueOnce().mockRejectedValueOnce(Error("revoked"));
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(f.journal.begin).not.toHaveBeenCalled();
  });
});
