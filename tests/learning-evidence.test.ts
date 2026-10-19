import { describe, expect, it } from "vitest";
import { experimentCandidate, type LearningRow } from "../src/lib/social/learning-evidence";
const now = new Date("2026-10-17T00:00:00Z"), day = 86400000;
function rows(): LearningRow[] {
  return ["static", "video"].flatMap(format => Array.from({ length: 5 }, (_, i) => ({ id: `${format}${i}`, snapshotId: `metric-${format}${i}`, connectionId: "one", provider: "Facebook", format, publishedAt: new Date(now.getTime() - 5 * day), reading: { observedAt: new Date(now.getTime() - 5 * day + 80 * 3600000), definitionVersion: "fixture-v1", impressions: 1000, engagements: format === "static" ? 50 : 15, reach: null, clicks: null, videoViews: null } })));
}
describe("reproducible observational experiment policy", () => {
  it("freezes actual snapshot counts, age window and deterministic ordering", () => {
    const input = rows(), a = experimentCandidate(input, now)!;
    expect(a).toEqual(experimentCandidate(input.reverse(), now));
    expect(a.evidence.kind).toBe("OBSERVATIONAL_V2"); expect(a.evidence.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    if (a.evidence.kind !== "OBSERVATIONAL_V2") throw Error("Expected impression evidence");
    expect(a.evidence.cohorts.map(c => c.impressions)).toEqual([5000, 5000]);
    expect(a.evidence.warning).toContain("Non-randomized");
  });
  it.each(["account", "provider", "definition", "lifetime", "young", "future", "old", "timing", "one-outlier"])("does not suggest an experiment from %s-confounded evidence", reason => {
    const input = rows();
    for (const r of input.filter(r => r.format === "video")) {
      if (reason === "account") r.connectionId = "other";
      if (reason === "provider") r.provider = "LinkedIn";
      if (reason === "definition") r.reading!.definitionVersion = "other-v1";
      if (reason === "lifetime") r.reading!.observedAt = now;
      if (reason === "young") r.reading!.observedAt = new Date(r.publishedAt.getTime() + 2 * day);
      if (reason === "future") r.reading!.observedAt = new Date(now.getTime() + day);
      if (reason === "old" || reason === "timing") { r.publishedAt = new Date(r.publishedAt.getTime() - (reason === "old" ? 50 : 10) * day); r.reading!.observedAt = new Date(r.publishedAt.getTime() + 80 * 3600000); }
    }
    if (reason === "one-outlier") input[0].reading!.impressions = 100000;
    expect(experimentCandidate(input, now)).toBeNull();
  });
  it("refuses repeated publications or snapshots instead of inflating sample size", () => {
    const a = rows(); expect(experimentCandidate([...a, a[0]], now)).toBeNull();
    a[1].snapshotId = a[0].snapshotId; expect(experimentCandidate(a, now)).toBeNull();
  });
  it("limits each format to twenty recent posts without comparing thin cohorts", () => {
    const a = rows(); expect(experimentCandidate(a.slice(1), now)).toBeNull();
    const many = Array.from({ length: 6 }, (_, i) => rows().map(r => ({ ...r, id: `${r.id}-${i}`, snapshotId: `${r.snapshotId}-${i}` }))).flat();
    expect(experimentCandidate(many, now)!.evidence.cohorts.map(c => c.points.length)).toEqual([20, 20]);
  });
});
