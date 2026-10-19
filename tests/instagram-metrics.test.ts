import { afterEach, describe, expect, it, vi } from "vitest";
import { instagramFixture } from "./helpers/instagram-publishing";
import { parseInstagramInsights } from "../src/lib/social/instagram-metrics";
import { MetricSourceChangedError, metricSubject, supportsPublicationMetrics } from "../src/lib/social/contracts";

const rows = (id: string) => ({ data: ["views", "reach", "total_interactions"].map((name, i) => ({ id: `${id}/insights/${name}/lifetime`, name, period: "lifetime", values: [{ value: [1200, 800, 72][i] }] })) });
describe.each(["feed", "reel"] as const)("Instagram native lifetime %s metrics", kind => {
  const reel = kind === "reel", gate = reel ? "INSTAGRAM_REELS_METRICS_ENABLED" : "INSTAGRAM_METRICS_ENABLED";
  afterEach(() => vi.unstubAllEnvs());
  async function fixture() {
    vi.stubEnv("INSTAGRAM_METRICS_ENABLED", reel ? "false" : "true");
    vi.stubEnv("INSTAGRAM_REELS_METRICS_ENABLED", reel ? "true" : "false");
    const f = await instagramFixture(), publishedAt = new Date(Date.now() - 3600000);
    if (reel) {
      delete f.payload.image;
      f.payload.format = "video";
      f.payload.video = { sha256: "a".repeat(64), bytes: 1000, width: 720, height: 1280, durationMs: 6000, shareToFeed: false };
      f.post.media_type = "VIDEO"; f.post.media_product_type = "REELS";
      delete (f.post as { alt_text?: string }).alt_text;
    }
    f.post.timestamp = publishedAt.toISOString();
    const stats = rows(f.id);
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, f.post, stats, f.post);
    const subject = { payload: f.payload, publishedAt, mediaExternalId: f.containerId };
    return { ...f, stats, subject, read: () => f.adapter.metrics(f.account, f.id, f.signal(), subject) };
  }
  it("uses only bounded authenticated reads and preserves views separately from impressions", async () => {
    const f = await fixture();
    expect(supportsPublicationMetrics(f.adapter, f.payload)).toBe(true);
    expect(f.adapter.metricsAvailable).toBe(!reel); expect(f.adapter.videoMetricsAvailable).toBe(reel);
    expect(await f.read()).toMatchObject({ definitionVersion: `instagram-${kind}-views-reach-total-interactions-${f.config.apiVersion}-v1`, views: 1200, reach: 800, engagements: 72, impressions: null, clicks: null, videoViews: null });
    expect(f.fetcher).toHaveBeenCalledTimes(5);
    const url = new URL(String(f.fetcher.mock.calls[3][0]));
    expect(url.hostname).toBe("graph.facebook.com"); expect(url.pathname).toBe(`/${f.config.apiVersion}/${f.id}/insights`);
    expect(url.searchParams.get("metric")).toBe("views,reach,total_interactions"); expect(url.searchParams.get("period")).toBe("lifetime"); expect(url.searchParams.has("access_token")).toBe(false);
    expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(f.journal.begin).not.toHaveBeenCalled(); expect(f.transfer.read).not.toHaveBeenCalled(); expect(f.delivery.issue).not.toHaveBeenCalled();
    expect(new URL(String(f.fetcher.mock.calls[2][0])).searchParams.get("fields")?.includes("alt_text")).toBe(!reel);
  });
  it("preserves unavailable and zero readings and accepts an unambiguous scalar total", () => {
    expect(parseInstagramInsights({ data: [] }, "123")).toEqual({ views: null, reach: null, engagements: null });
    const data = rows("123").data; data[0].values = []; data[1].values[0].value = 0;
    expect(parseInstagramInsights({ data: [data[0], data[1], { id: data[2].id, name: data[2].name, period: "lifetime", total_value: { value: 4 } }] }, "123")).toEqual({ views: null, reach: 0, engagements: 4 });
  });
  it.each(["duplicate", "foreign id", "wrong name", "wrong period", "negative", "fraction", "overflow", "numeric string", "ambiguous", "breakdown", "series", "pagination"])("rejects %s instead of manufacturing a metric", kind => {
    const result: any = rows("123");
    if (kind === "duplicate") result.data[1] = result.data[0];
    if (kind === "foreign id") result.data[0].id = "999/insights/views/lifetime";
    if (kind === "wrong name") result.data[0].name = "impressions";
    if (kind === "wrong period") result.data[0].period = "day";
    if (kind === "negative") result.data[0].values[0].value = -1;
    if (kind === "fraction") result.data[0].values[0].value = 1.2;
    if (kind === "overflow") result.data[0].values[0].value = 2147483648;
    if (kind === "numeric string") result.data[0].values[0].value = "1200";
    if (kind === "ambiguous") result.data[0].total_value = { value: 1200 };
    if (kind === "breakdown") { delete result.data[0].values; result.data[0].total_value = { value: 1200, breakdowns: [] }; }
    if (kind === "series") result.data[0].values.push({ value: 2000 });
    if (kind === "pagination") result.paging = { next: "https://attacker.example" };
    expect(() => parseInstagramInsights(result, "123")).toThrow();
  });
  it.each(["caption", "removed caption", "owner", ...(!reel ? ["alt"] : []), "type", "product", "timestamp", "during read"])("invalidates verified changed source: %s", async kind => {
    const f = await fixture(), changed = structuredClone(f.post);
    if (kind === "caption" || kind === "during read") changed.caption = "Edited outside the app";
    if (kind === "removed caption") delete (changed as any).caption;
    if (kind === "owner") changed.owner.id = "999";
    if (kind === "alt") changed.alt_text = "Changed alt text";
    if (kind === "type") changed.media_type = reel ? "IMAGE" : "VIDEO";
    if (kind === "product") changed.media_product_type = "STORY";
    if (kind === "timestamp") changed.timestamp = new Date(f.subject.publishedAt.getTime() - 1000).toISOString();
    f.replies[kind === "during read" ? 4 : 2] = changed;
    await expect(f.read()).rejects.toBeInstanceOf(MetricSourceChangedError);
    expect(f.fetcher).toHaveBeenCalledTimes(kind === "during read" ? 5 : 3);
  });
  it.each(["permission", "malformed", "foreign response", "rate limit", "network", "bad date"])("does not report an edit for an unverified %s response", async kind => {
    const f = await fixture();
    f.replies[2] = kind === "permission" ? new Response("private upstream detail", { status: 403 }) : kind === "rate limit" ? new Response("", { status: 429 }) : kind === "network" ? Error("private token URL") : kind === "malformed" ? {} : kind === "bad date" ? { ...f.post, timestamp: "invalid" } : { ...f.post, id: "999" };
    const error = await f.read().catch(e => e);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(MetricSourceChangedError); expect(error.message).toBe("Instagram post metrics could not be verified.");
  });
  it.each(["gate", "wrong account", "foreign container", "future", "expired config"])("refuses %s before reading post metrics", async kind => {
    const f = await fixture();
    if (kind === "gate") { vi.stubEnv(gate, "false"); vi.stubEnv(reel ? "INSTAGRAM_METRICS_ENABLED" : "INSTAGRAM_REELS_METRICS_ENABLED", "true"); }
    if (kind === "wrong account") f.account.provider = "Facebook";
    if (kind === "foreign container") f.subject.mediaExternalId = "urn:li:image:wrong";
    if (kind === "future") f.subject.publishedAt = new Date(Date.now() + 3600000);
    if (kind === "expired config") vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.config.verifiedUntil) + 1);
    try { await expect(f.read()).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); }
  });
  it("rechecks abort after the final read", async () => {
    const f = await fixture(), abort = new AbortController(); abort.abort();
    await expect(f.adapter.metrics(f.account, f.id, abort.signal, f.subject)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rejects metrics when its gate changes during the read", async () => {
    const f = await fixture();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (f.fetcher.mock.calls.length === 5) vi.stubEnv(gate, "false");
      return response;
    });
    await expect(f.read()).rejects.toThrow("could not be verified");
    expect(f.fetcher).toHaveBeenCalledTimes(5);
  });
  it("does not infer video metric support from an image adapter", async () => {
    const f = await fixture();
    expect(supportsPublicationMetrics(undefined, f.payload)).toBe(false);
    expect(supportsPublicationMetrics({ ...f.adapter, metricsAvailable: true, videoMetricsAvailable: undefined }, f.payload)).toBe(!reel);
  });
  it("keeps provider media identifiers disjoint", async () => {
    const f = await fixture(); expect(metricSubject.safeParse(f.subject).success).toBe(true);
    expect(metricSubject.safeParse({ ...f.subject, mediaExternalId: "urn:li:image:foreign" }).success).toBe(false);
    expect(metricSubject.safeParse({ ...f.subject, payload: { ...f.payload, channel: "LinkedIn" } }).success).toBe(false);
  });
});
