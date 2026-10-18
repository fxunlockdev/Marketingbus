import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { facebookImageFixture as fixture } from "./helpers/facebook-publishing";
import { createFacebookPublishingAdapter } from "../src/lib/social/facebook-publishing";
import { configuredSocialAdapters, publicationPayload } from "../src/lib/social/contracts";
import { frozenCopy, payloadHash } from "../src/lib/social/integrity";

describe("Facebook single approved PNG transport", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("privately uploads exact bytes once, then attaches the exact photo with approved caption and alt text", async () => {
    const f = fixture();
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published", receipt: { externalPostId: f.id } });
    const [url, init] = f.fetcher.mock.calls[2], body = init!.body as FormData;
    expect(url).toBe(`https://graph.facebook.com/${f.config.apiVersion}/789/photos`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit", headers: { Authorization: `Bearer ${f.account.token}` } });
    expect(Object.keys(init!.headers!)).not.toContain("Content-Type");
    expect([...body.keys()].sort()).toEqual(["alt_text_custom", "appsecret_proof", "published", "source"]);
    expect(body.get("published")).toBe("false"); expect(body.get("alt_text_custom")).toBe(f.payload.image!.altText);
    expect(body.get("appsecret_proof")).toBe(createHmac("sha256", f.config.appSecret).update(f.account.token).digest("hex"));
    const file = body.get("source") as File; expect(file.name).toBe("approved-image.png"); expect(file.type).toBe("image/png"); expect(new Uint8Array(await file.arrayBuffer())).toEqual(f.bytes);
    const post = new URLSearchParams(String(f.fetcher.mock.calls[4][1]!.body));
    expect(JSON.parse(post.get("attached_media")!)).toEqual([{ media_fbid: f.imageId }]); expect(post.get("message")).toBe(f.payload.caption);
    expect(f.transfer.begin).toHaveBeenCalledOnce(); expect(f.journal.begin).toHaveBeenCalledOnce();
    expect(f.transfer.uploaded).toHaveBeenCalledWith(expect.objectContaining({ adapterVersion: expect.stringContaining(":image-v1") }), f.imageId);
    expect(f.adapter.metricsAvailable).toBe(false);
  });
  it.each(["disabled", "too large", "Instagram", "no fingerprint", "wrong account"])("refuses %s before HTTP or either fence", async kind => {
    const f = fixture();
    if (kind === "disabled") f.adapter = createFacebookPublishingAdapter(f.config, f.fetcher, f.journal, { enabled: false, transfer: f.transfer });
    if (kind === "too large") f.payload.image!.bytes = 4 * 1024 * 1024 + 1;
    if (kind === "Instagram") f.payload.channel = "Instagram";
    if (kind === "no fingerprint") delete f.payload.image;
    if (kind === "wrong account") f.account.externalAccountId = "789/../feed";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "failed", code: "INVALID_MEDIA" });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.transfer.begin).not.toHaveBeenCalled(); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it.each(["lost response", "429", "500", "missing id", "foreign id syntax", "unexpected published post"])("never repeats an ambiguous upload: %s", async kind => {
    const f = fixture();
    f.replies[2] = kind === "lost response" ? Error("timeout") : kind === "429" || kind === "500" ? new Response("private", { status: Number(kind) }) : kind === "missing id" ? {} : kind === "foreign id syntax" ? { id: "urn:li:image:123" } : { id: f.imageId, post_id: f.id };
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.journal.begin).not.toHaveBeenCalled(); expect(f.transfer.uploaded).not.toHaveBeenCalled();
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toBeNull();
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.capability);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it.each(["owner", "id", "alt text"])("holds an uploaded photo with changed %s before publication", async kind => {
    const f = fixture();
    if (kind === "owner") f.photo.from.id = "999";
    if (kind === "id") f.photo.id = "999";
    if (kind === "alt text") f.photo.alt_text_custom = "Unapproved claim";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.journal.begin).not.toHaveBeenCalled(); expect(f.state).toMatchObject({ externalId: f.imageId, uploaded: true });
  });
  it.each(["attachment id", "object id", "type", "extra attachment", "subattachments", "pagination", "missing attachments", "late alt text"])("does not certify mismatched read-back: %s", async kind => {
    const f = fixture();
    if (kind === "attachment id") f.post.attachments.data[0].target.id = "999";
    if (kind === "object id") f.post.object_id = "999";
    if (kind === "type") f.post.attachments.data[0].type = "video";
    if (kind === "extra attachment") f.post.attachments.data.push({ type: "photo", target: { id: "999" } });
    if (kind === "subattachments") f.replies[5] = { ...f.post, attachments: { data: [{ ...f.post.attachments.data[0], subattachments: { data: [] } }] } };
    if (kind === "pagination") f.replies[5] = { ...f.post, attachments: { ...f.post.attachments, paging: { next: "https://graph.facebook.com/more" } } };
    if (kind === "missing attachments") f.replies[5] = { ...f.post, attachments: undefined };
    if (kind === "late alt text") f.replies[6] = { ...f.photo, alt_text_custom: "Changed later" };
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" }); expect(f.journal.record).toHaveBeenCalledWith(expect.anything(), f.id);
  });
  it("recovers a known candidate with only reads and does not upload or publish again", async () => {
    const f = fixture(); f.replies[5] = Error("read timeout");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.capability, f.post, f.photo);
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toMatchObject({ externalPostId: f.id });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    f.state.uploaded = false;
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toBeNull();
  });
  it.each(["read", "begin", "check", "record", "uploaded"])("stops safely on %s failure", async key => {
    const f = fixture(); vi.mocked(f.transfer[key as "read"]).mockRejectedValue(Error("Authority changed"));
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" }); expect(f.journal.begin).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/feed"))).toBe(false);
  });
  it("requires a separately enabled image capability without changing legacy text versions", async () => {
    const f = fixture();
    for (const [key, value] of Object.entries({ SOCIAL_EXECUTION_ENABLED: "true", FACEBOOK_CONNECTIONS_ENABLED: "true", FACEBOOK_PUBLISHING_ENABLED: "true", FACEBOOK_IMAGE_PUBLISHING_ENABLED: "false", LINKEDIN_PUBLISHING_ENABLED: "false", META_APP_ID: f.config.appId, META_APP_SECRET: f.config.appSecret, META_API_VERSION: f.config.apiVersion, META_API_VERIFIED_UNTIL: f.config.verifiedUntil })) vi.stubEnv(key, value);
    expect(configuredSocialAdapters().Facebook?.imagePublishingAvailable).toBe(false);
    vi.stubEnv("FACEBOOK_IMAGE_PUBLISHING_ENABLED", "true"); expect(configuredSocialAdapters().Facebook?.imagePublishingAvailable).toBe(true);
    vi.stubEnv("FACEBOOK_PUBLISHING_ENABLED", "false"); expect(configuredSocialAdapters().Facebook).toBeUndefined();
    expect(frozenCopy(f.payload, payloadHash(f.payload), "Facebook")).toEqual(f.payload);
    expect(publicationPayload.safeParse({ ...f.payload, channel: "Instagram" }).success).toBe(false);
  });
});
