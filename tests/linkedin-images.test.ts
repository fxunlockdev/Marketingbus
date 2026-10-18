import { describe, expect, it, vi } from "vitest";
import { publishingFixture } from "./helpers/linkedin-publishing";
import { createLinkedInPublishingAdapter } from "../src/lib/social/linkedin-publishing";
import { linkedInUploadUrl } from "../src/lib/social/linkedin-image-upload";
import { MetricSourceChangedError } from "../src/lib/social/contracts";
import type { SocialImageTransfer } from "../src/lib/social/image-transfer";

function imageFixture() {
  const f = publishingFixture(), imageId = "urn:li:image:LOCAL_image-1", bytes = new Uint8Array([1, 2, 3]);
  const payload = { ...f.payload, mediaExportId: "approved-export", image: { sha256: "a".repeat(64), bytes: 3, width: 1080, height: 1080, altText: "Approved headline" } };
  let started = false, externalId: string | null = null, uploaded = false;
  const transfer: SocialImageTransfer = {
    inspect: vi.fn(async () => ({ started, externalId, uploaded })), read: vi.fn(async () => bytes), check: vi.fn(async () => {}),
    begin: vi.fn(async () => { if (started) return false; started = true; return true; }),
    record: vi.fn(async (_ctx, id) => { externalId = id; }), uploaded: vi.fn(async () => { uploaded = true; }),
  };
  const uploadUrl = "https://www.linkedin.com/dms-uploads/LOCAL_image-1/uploaded-image/0?ut=private-fixture";
  const registration = { value: { image: imageId, uploadUrl, uploadUrlExpiresAt: Date.now() + 3600000 } };
  const ready = { id: imageId, owner: f.account.externalAccountId, status: "AVAILABLE" };
  const post = { ...f.post, content: { media: { id: imageId, altText: payload.image.altText } } };
  f.replies.splice(2, 2, registration, new Response(null, { status: 201 }), ready, new Response(null, { status: 201, headers: { "x-restli-id": f.id } }), post);
  return { ...f, imageId, bytes, payload, transfer, uploadUrl, registration, ready, post, adapter: createLinkedInPublishingAdapter(f.config, f.fetcher, f.journal, { enabled: true, transfer }) };
}
describe("LinkedIn immutable image publication", () => {
  it("uploads once to the exact validated URL, verifies ownership/readiness, publishes and binds the image on read-back", async () => {
    const f = imageFixture();
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published", receipt: { externalPostId: f.id } });
    expect(f.transfer.begin).toHaveBeenCalledOnce(); expect(f.transfer.record).toHaveBeenCalledWith(expect.anything(), f.imageId);
    expect(f.transfer.uploaded).toHaveBeenCalledOnce(); expect(f.journal.begin).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[3]).toEqual([f.uploadUrl, expect.objectContaining({ method: "PUT", body: f.bytes, redirect: "error", credentials: "omit", cache: "no-store" })]);
    expect(JSON.parse(String(f.fetcher.mock.calls[5][1]?.body))).toMatchObject({ content: { media: { id: f.imageId, altText: f.payload.image.altText } } });
  });
  it("waits for asynchronous processing, then reuses the same image without another upload", async () => {
    const f = imageFixture(); f.replies.splice(4, 3, { ...f.ready, status: "PROCESSING" });
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "retryable", retryAfterSeconds: 60 });
    expect(f.journal.begin).not.toHaveBeenCalled();
    f.replies.push(f.introspection, f.acl, f.ready, new Response(null, { status: 201, headers: { "x-restli-id": f.id } }), f.post);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toMatchObject({ state: "published" });
    expect(f.transfer.begin).toHaveBeenCalledOnce(); expect(f.fetcher.mock.calls.filter(([, i]) => i?.method === "PUT")).toHaveLength(1);
    expect(f.fetcher.mock.calls.filter(([u]) => String(u).includes("initializeUpload"))).toHaveLength(1);
  });
  it.each(["registration", "upload", "record", "acknowledgement"])("never repeats a write after an uncertain %s", async stage => {
    const f = imageFixture();
    if (stage === "registration") f.replies[2] = Error("private remote failure");
    if (stage === "upload") f.replies[3] = Error("private upload timeout");
    if (stage === "record") vi.mocked(f.transfer.record).mockRejectedValue(Error("database lost"));
    if (stage === "acknowledgement") vi.mocked(f.transfer.uploaded).mockRejectedValue(Error("database lost"));
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    const writes = f.fetcher.mock.calls.filter(([, i]) => ["POST", "PUT"].includes(i?.method ?? "")).length;
    f.replies.splice(0, f.replies.length, f.introspection, f.acl);
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    // One additional read-only introspection POST; no registration/upload/publication repeated.
    expect(f.fetcher.mock.calls.filter(([, i]) => ["POST", "PUT"].includes(i?.method ?? "")).length).toBe(writes + 1);
    expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it.each(["http://www.linkedin.com/dms-uploads/LOCAL_image-1/uploaded-image/0", "https://evil.example/dms-uploads/LOCAL_image-1/uploaded-image/0", "https://www.linkedin.com.evil.example/dms-uploads/LOCAL_image-1/uploaded-image/0", "https://www.linkedin.com:444/dms-uploads/LOCAL_image-1/uploaded-image/0", "https://user:secret@www.linkedin.com/dms-uploads/LOCAL_image-1/uploaded-image/0", "https://www.linkedin.com/dms-uploads/other/uploaded-image/0", "https://www.linkedin.com/dms-uploads/LOCAL_image-1/uploaded-image/0#secret", "https://www.linkedin.com/other"])("rejects unsafe upload destination %s", async url => {
    const f = imageFixture(); f.registration.value.uploadUrl = url;
    expect(() => linkedInUploadUrl(url, f.imageId)).toThrow();
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    expect(f.fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false); expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it.each(["owner", "id", "expired", "failed", "changed approval"])("does not publish with %s", async change => {
    const f = imageFixture();
    if (change === "owner") f.ready.owner = "urn:li:organization:999";
    if (change === "id") f.ready.id = "urn:li:image:other";
    if (change === "expired") f.registration.value.uploadUrlExpiresAt = Date.now();
    if (change === "failed") f.ready.status = "PROCESSING_FAILED";
    if (change === "changed approval") vi.mocked(f.transfer.check).mockRejectedValue(Error("Approval changed"));
    const result = await f.adapter.publish(f.account, f.payload, "request", f.signal());
    expect(result.state).toBe(change === "failed" ? "failed" : "uncertain"); expect(f.journal.begin).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.some(([u]) => u === "https://api.linkedin.com/rest/posts")).toBe(false);
  });
  it("reads a known post after lost confirmation, without uploading or posting again", async () => {
    const f = imageFixture(); f.replies[6] = Error("lost read-back");
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    f.replies.push(f.introspection, f.acl, f.post);
    expect(await f.adapter.reconcile(f.account, "request", f.payload, f.signal())).toMatchObject({ externalPostId: f.id });
    expect(f.transfer.read).toHaveBeenCalledOnce(); expect(f.journal.begin).toHaveBeenCalledOnce();
  });
  it.each(["image", "description"])("rejects changed %s on publication read-back and metric observations", async change => {
    const f = imageFixture();
    if (change === "image") f.post.content.media.id = "urn:li:image:other";
    else f.post.content.media.altText = "Unapproved claim";
    expect(await f.adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "uncertain" });
    f.replies.push(f.introspection, f.acl, f.post);
    await expect(f.adapter.metrics(f.account, f.id, f.signal(), { payload: f.payload, publishedAt: new Date(f.post.publishedAt), mediaExternalId: f.imageId })).rejects.toBeInstanceOf(MetricSourceChangedError);
  });
  it("requires the saved image identity for metrics and checks it on both sides of the observation", async () => {
    const f = imageFixture(); f.replies.splice(0, f.replies.length, f.introspection, f.acl, f.post, f.stats, f.post);
    await expect(f.adapter.metrics(f.account, f.id, f.signal(), { payload: f.payload, publishedAt: new Date(f.post.publishedAt) })).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(await f.adapter.metrics(f.account, f.id, f.signal(), { payload: f.payload, publishedAt: new Date(f.post.publishedAt), mediaExternalId: f.imageId })).toMatchObject({ impressions: 100, engagements: 6 });
    expect(f.fetcher.mock.calls.filter(([u]) => String(u).includes("posts/"))).toHaveLength(2);
  });
  it("keeps image transfer independently disabled even when text publishing is configured", async () => {
    const f = imageFixture(), adapter = createLinkedInPublishingAdapter(f.config, f.fetcher, f.journal, { enabled: false, transfer: f.transfer });
    expect(adapter.imagePublishingAvailable).toBe(false);
    expect(await adapter.publish(f.account, f.payload, "request", f.signal())).toEqual({ state: "failed", code: "INVALID_MEDIA" }); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
