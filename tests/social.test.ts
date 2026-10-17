import { describe, expect, it } from "vitest";
import {
  experimentCandidate,
  summarizePerformance,
} from "../src/lib/social/analytics";
import { metricReading } from "../src/lib/social/contracts";
import { safePermalink } from "../src/lib/social/worker";
const now = new Date("2026-10-15T12:00:00Z");
const reading = {
  observedAt: now,
  definitionVersion: "fixture-v1",
  impressions: 1000,
  engagements: 50,
  reach: null,
  clicks: null,
  videoViews: null,
};
const row = {
  id: "one",
  snapshotId: "metric-one",
  connectionId: "account",
  provider: "Facebook",
  format: "static",
  publishedAt: new Date("2026-10-12T04:00:00Z"),
  reading,
};
describe("honest performance reporting", () => {
  it("preserves unknowns, coverage and definition boundaries", () => {
    const summary = summarizePerformance([
      row,
      { ...row, id: "two", reading: { ...reading, impressions: null } },
      { ...row, id: "other", reading: { ...reading, definitionVersion: "v2" } },
    ]);
    expect(summary).toHaveLength(2);
    expect(summary[0].metrics.impressions).toEqual({
      value: 1000,
      coveredPosts: 1,
    });
    expect(summary[0].metrics.clicks).toEqual({ value: null, coveredPosts: 0 });
  });
  it("does not learn from missing or thin data", () => {
    expect(experimentCandidate([row], now)).toBeNull();
    expect(
      experimentCandidate(
        Array.from({ length: 12 }, (_, i) => ({
          ...row,
          id: String(i),
          reading: null,
        })),
        now
      )
    ).toBeNull();
  });
  it("requires comparable accounts, mature measurements, and enough posts", () => {
    const a = Array.from({ length: 5 }, (_, i) => ({ ...row, id: `a-${i}`, snapshotId: `metric-a-${i}` }));
    const b = a.map((r) => ({
      ...r,
      id: `b-${r.id}`,
      snapshotId: `metric-b-${r.id}`,
      format: "video",
      reading: { ...reading, engagements: 15 },
    }));
    expect(experimentCandidate([...a, ...b], now)?.hypothesis).toContain(
      "experiment hypothesis"
    );
    expect(
      experimentCandidate(
        [...a, ...b.map((r) => ({ ...r, connectionId: "other" }))],
        now
      )
    ).toBeNull();
    expect(
      experimentCandidate(
        [
          ...a,
          ...b.map((r) => ({
            ...r,
            reading: { ...r.reading, observedAt: r.publishedAt },
          })),
        ],
        now
      )
    ).toBeNull();
  });
  it("rejects negative or oversized metrics and unsafe provider links", () => {
    expect(() => metricReading.parse({ ...reading, clicks: -1 })).toThrow();
    expect(() =>
      metricReading.parse({ ...reading, impressions: 1e12 })
    ).toThrow();
    for (const link of [
      "javascript:alert(1)",
      "https://facebook.com.evil.test/post",
      "https://user:pass@facebook.com/post",
      "http://facebook.com/post",
    ])
      expect(() => safePermalink("Facebook", link)).toThrow();
    expect(
      safePermalink("Facebook", "https://www.facebook.com/posts/123")
    ).toContain("facebook.com");
  });
});
