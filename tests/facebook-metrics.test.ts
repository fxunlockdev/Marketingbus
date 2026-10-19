import { afterEach, describe, expect, it, vi } from "vitest";
import { facebookImageFixture, facebookPublishingFixture } from "./helpers/facebook-publishing";
import { facebookInsightRows } from "./helpers/facebook-metrics";
import { parseFacebookInsights } from "../src/lib/social/facebook-metrics";
import { MetricSourceChangedError } from "../src/lib/social/contracts";

describe("Facebook native per-post metrics", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  function fixture(image = false) {
    vi.stubEnv("FACEBOOK_METRICS_ENABLED", "true");
    const f = image ? facebookImageFixture() : facebookPublishingFixture();
    const publishedAt = new Date(Date.now() - 3600000); f.post.created_time = publishedAt.toISOString();
    const stats = facebookInsightRows(f.id), imageId = "imageId" in f && typeof f.imageId === "string" ? f.imageId : undefined, photo = "photo" in f ? f.photo : undefined;
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.capability, f.post, ...(photo ? [photo] : []), stats, f.post, ...(photo ? [photo] : []));
    const subject = { payload: f.payload, publishedAt, ...(imageId ? { mediaExternalId: imageId } : {}) };
    return { ...f, photo, stats, subject, read: () => f.adapter.metrics(f.account, f.id, f.signal(), subject) };
  }
  it.each([false, true])("reads only the exact approved post and native counters, image: %s", async image => {
    const f = fixture(image), value = await f.read();
    expect(value).toMatchObject({ views: 1200, uniqueViewers: 800, clicks: 0, reactions: 15, impressions: null, reach: null, engagements: null, videoViews: null });
    expect(value.definitionVersion).toBe(`facebook-post-views-unique-clicks-reactions-${f.config.apiVersion}-v1`);
    expect(f.adapter.metricsAvailable).toBe(true); expect(f.fetcher).toHaveBeenCalledTimes(image ? 7 : 5);
    const request = f.fetcher.mock.calls[image ? 4 : 3], url = new URL(String(request[0]));
    expect(url.pathname).toBe(`/${f.config.apiVersion}/${f.id}/insights`); expect(url.searchParams.get("period")).toBe("lifetime"); expect(url.searchParams.get("metric")).toBe("post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total");
    expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(f.journal.begin).not.toHaveBeenCalled();
  });
  it("keeps absent, empty and zero counters distinct", () => {
    expect(parseFacebookInsights({ data: [] }, "123_456")).toEqual({ views: null, uniqueViewers: null, clicks: null, reactions: null });
    const data: any = facebookInsightRows("123_456").data; data[0].values = []; data[1].values[0].value = 0; data[3].values[0].value = {};
    expect(parseFacebookInsights({ data }, "123_456")).toEqual({ views: null, uniqueViewers: 0, clicks: 0, reactions: null });
    data[3].values[0].value = { like: 0 }; expect(parseFacebookInsights({ data }, "123_456").reactions).toBe(0);
  });
  it.each(["duplicate", "foreign id", "name", "period", "negative", "fraction", "overflow", "string", "scalar breakdown", "object scalar", "unknown reaction", "sum overflow", "multiple values", "total_value", "pagination"])("refuses ambiguous or malformed %s", kind => {
    const r: any = facebookInsightRows("123_456");
    if (kind === "duplicate") r.data[1] = r.data[0];
    if (kind === "foreign id") r.data[0].id = "999_456/insights/post_media_view/lifetime";
    if (kind === "name") r.data[0].name = "post_impressions";
    if (kind === "period") r.data[0].period = "day";
    if (kind === "negative") r.data[0].values[0].value = -1;
    if (kind === "fraction") r.data[0].values[0].value = .5;
    if (kind === "overflow") r.data[0].values[0].value = 2147483648;
    if (kind === "string") r.data[0].values[0].value = "1200";
    if (kind === "scalar breakdown") r.data[3].values[0].value = 15;
    if (kind === "object scalar") r.data[0].values[0].value = { like: 1 };
    if (kind === "unknown reaction") r.data[3].values[0].value = { like: 1, unknown: 4 };
    if (kind === "sum overflow") r.data[3].values[0].value = { like: 2147483647, love: 1 };
    if (kind === "multiple values") r.data[0].values.push({ value: 5000 });
    if (kind === "total_value") r.data[0].total_value = { value: 1200 };
    if (kind === "pagination") r.paging = { next: "https://attacker.example" };
    expect(() => parseFacebookInsights(r, "123_456")).toThrow();
  });
  it.each(["message", "removed message", "owner", "time", "hidden", "unpublished", "application", "parent", "new attachment", "during read"])("invalidates a verified changed %s", async kind => {
    const f = fixture(), changed: any = structuredClone(f.post);
    if (kind === "message" || kind === "during read") changed.message = "Externally changed";
    if (kind === "removed message") delete changed.message;
    if (kind === "owner") changed.from.id = "999";
    if (kind === "time") changed.created_time = new Date(f.subject.publishedAt.getTime() - 1000).toISOString();
    if (kind === "hidden") changed.is_hidden = true;
    if (kind === "unpublished") changed.is_published = false;
    if (kind === "application") changed.application.id = "999";
    if (kind === "parent") changed.parent_id = "789_321";
    if (kind === "new attachment") changed.attachments = { data: [{ type: "photo", target: { id: "321" } }] };
    f.replies[kind === "during read" ? 4 : 2] = changed;
    await expect(f.read()).rejects.toBeInstanceOf(MetricSourceChangedError);
  });
  it.each(["alt text", "removed alt", "photo owner", "replacement", "multiple photos", "object id", "changed after metrics"])("invalidates image %s without a new upload", async kind => {
    const f = fixture(true), post: any = structuredClone(f.post), photo: any = structuredClone(f.photo);
    if (kind === "alt text" || kind === "changed after metrics") photo.alt_text_custom = "Different creative";
    if (kind === "removed alt") delete photo.alt_text_custom;
    if (kind === "photo owner") photo.from.id = "999";
    if (kind === "replacement") post.attachments.data[0].target.id = "999";
    if (kind === "multiple photos") post.attachments.data.push(post.attachments.data[0]);
    if (kind === "object id") post.object_id = "999";
    f.replies[2] = post; f.replies[kind === "changed after metrics" ? 6 : 3] = photo;
    await expect(f.read()).rejects.toBeInstanceOf(MetricSourceChangedError);
  });
  it.each(["permission", "rate limit", "network", "malformed", "foreign response", "bad date"])("does not mistake %s for a verified edit", async kind => {
    const f = fixture(); f.replies[2] = kind === "permission" ? new Response("private", { status: 403 }) : kind === "rate limit" ? new Response("", { status: 429 }) : kind === "network" ? Error("private URL token") : kind === "malformed" ? {} : kind === "bad date" ? { ...f.post, created_time: "bad" } : { ...f.post, id: "999_123" };
    const error = await f.read().catch(e => e); expect(error).not.toBeInstanceOf(MetricSourceChangedError); expect(error.message).toBe("Facebook post metrics could not be verified.");
  });
  it.each(["disabled", "wrong account", "foreign post", "future", "expired"])("refuses %s before HTTP", async kind => {
    const f = fixture();
    if (kind === "disabled") vi.stubEnv("FACEBOOK_METRICS_ENABLED", "false");
    if (kind === "wrong account") f.account.provider = "Instagram";
    if (kind === "foreign post") f.account.externalAccountId = "999";
    if (kind === "future") f.subject.publishedAt = new Date(Date.now() + 3600000);
    if (kind === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.config.verifiedUntil) + 1);
    await expect(f.read()).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("refuses aborted reads and an activation revoked during the last response", async () => {
    const f = fixture(), abort = new AbortController(); abort.abort();
    await expect(f.adapter.metrics(f.account, f.id, abort.signal, f.subject)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    const original = f.fetcher.getMockImplementation()!; let calls = 0;
    f.fetcher.mockImplementation(async (...args) => { const result = await original(...args); if (++calls === 5) vi.stubEnv("FACEBOOK_METRICS_ENABLED", "false"); return result; });
    await expect(f.read()).rejects.toThrow("could not be verified");
  });
});
