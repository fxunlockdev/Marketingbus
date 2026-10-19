import { describe, expect, it } from "vitest";
import { experimentCandidate, type LearningRow } from "../src/lib/social/learning-evidence";
import { viewExperimentCandidate } from "../src/lib/social/view-learning";
const now = new Date("2026-10-20T00:00:00Z"), DAY = 86400000;
function rows(): LearningRow[] {
  return ["static", "video"].flatMap(format => Array.from({ length: 5 }, (_, i) => ({ id: `${format}-${i}`, snapshotId: `m-${format}-${i}`, connectionId: "account", provider: "Instagram", format,
    publishedAt: new Date(now.getTime() - 5 * DAY), reading: { observedAt: new Date(now.getTime() - 5 * DAY + 80 * 3600000),
      definitionVersion: `instagram-${format === "static" ? "feed" : "reel"}-views-reach-total-interactions-v24.0-v1`,
      views: 1000, engagements: format === "static" ? 50 : 15, impressions: null, reach: null, clicks: null, videoViews: null } })));
}
describe("native-view experiment policy", () => {
  it("keeps native counters and definition provenance without inventing impressions", () => {
    const input = rows(), result = experimentCandidate(input, now)!;
    expect(result).toEqual(experimentCandidate([...input].reverse(), now));
    expect(result.evidence.kind).toBe("OBSERVATIONAL_VIEWS_V1");
    if (result.evidence.kind !== "OBSERVATIONAL_VIEWS_V1") throw Error("Wrong policy");
    expect(result.evidence.cohorts.map(c => c.views)).toEqual([5000, 5000]);
    expect(result.evidence.cohorts.map(c => c.interactions)).toEqual([250, 75]);
    expect(result.evidence.cohorts[0].points[0]).not.toHaveProperty("impressions");
    expect(result.evidence.warning).toContain("different display/play semantics");
    expect(result.hypothesis).toContain("not a proven preference");
  });
  it.each(["account", "provider", "version", "definition", "wrong-format", "legacy-impressions", "missing-views", "missing-interactions", "negative", "nan", "fraction", "thin", "outlier", "old", "future", "young", "lifetime", "timing"])("rejects %s evidence", reason => {
    const input = rows();
    for (const row of input.filter(r => r.format === "video")) {
      if (reason === "account") row.connectionId = "other";
      if (reason === "provider") row.provider = "Facebook";
      if (reason === "version") row.reading!.definitionVersion = row.reading!.definitionVersion.replace("v24.0", "v25.0");
      if (reason === "definition") row.reading!.definitionVersion = "unverified";
      if (reason === "wrong-format") row.reading!.definitionVersion = row.reading!.definitionVersion.replace("reel", "feed");
      if (reason === "legacy-impressions") row.reading!.impressions = 1000;
      if (reason === "missing-views") row.reading!.views = null;
      if (reason === "missing-interactions") row.reading!.engagements = null;
      if (reason === "negative") row.reading!.engagements = -1;
      if (reason === "nan") row.reading!.views = NaN;
      if (reason === "fraction") row.reading!.views = 1000.5;
      if (reason === "young") row.reading!.observedAt = new Date(row.publishedAt.getTime() + 2 * DAY);
      if (reason === "lifetime") row.reading!.observedAt = now;
      if (reason === "future") row.reading!.observedAt = new Date(now.getTime() + DAY);
      if (reason === "old" || reason === "timing") { row.publishedAt = new Date(row.publishedAt.getTime() - (reason === "old" ? 50 : 10) * DAY); row.reading!.observedAt = new Date(row.publishedAt.getTime() + 80 * 3600000); }
    }
    if (reason === "thin") input.pop();
    if (reason === "outlier") input[0].reading!.views = 100000;
    expect(experimentCandidate(input, now)).toBeNull();
  });
  it("requires independent publications and snapshots and bounds cohorts", () => {
    const input = rows(); expect(viewExperimentCandidate([...input, input[0]], now)).toBeNull();
    input[1].snapshotId = input[0].snapshotId; expect(viewExperimentCandidate(input, now)).toBeNull();
    const many = Array.from({ length: 6 }, (_, n) => rows().map(r => ({ ...r, id: `${n}-${r.id}`, snapshotId: `${n}-${r.snapshotId}` }))).flat();
    expect(viewExperimentCandidate(many, now)!.evidence.cohorts.map(c => c.points.length)).toEqual([20, 20]);
  });
  it("keeps zero interaction observations and refuses no meaningful difference", () => {
    const input = rows(); for (const row of input) row.reading!.engagements = row.format === "video" ? 0 : 50;
    expect(viewExperimentCandidate(input, now)?.evidence.cohorts[1].interactions).toBe(0);
    for (const row of input) row.reading!.engagements = 20;
    expect(viewExperimentCandidate(input, now)).toBeNull();
  });
});
