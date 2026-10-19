import { createHash } from "node:crypto";
import { z } from "zod";
import type { LearningRow } from "./learning-evidence";

const DAY = 86400000;
const count = z.number().int().nonnegative().max(2147483647);
const point = z.object({ publicationId: z.string().min(1), snapshotId: z.string().min(1), publishedAt: z.iso.datetime(), observedAt: z.iso.datetime(), views: count.min(100), interactions: count }).strict();
const cohort = z.object({ format: z.enum(["static", "video"]), definitionVersion: z.string(), points: z.array(point).min(5).max(20), views: z.number().int().positive(), interactions: z.number().int().nonnegative() }).strict();
export const viewLearningEvidence = z.object({
  kind: z.literal("OBSERVATIONAL_VIEWS_V1"), policy: z.literal("INSTAGRAM_NATIVE_VIEWS_72_96_HOURS_V1"),
  evaluatedAt: z.iso.datetime(), connectionId: z.string().min(1), provider: z.literal("Instagram"),
  apiVersion: z.string().regex(/^v[1-9][0-9]?\.0$/), basis: z.literal("total_interactions_per_native_view"),
  cohorts: z.tuple([cohort, cohort]), warning: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Native views only. Feed displays and Reel plays are different exposures: this
 * creates a reversible format-test suggestion, never an interchangeable metric,
 * causal result, conversion rate, or customer-preference claim. */
export function viewExperimentCandidate(rows: LearningRow[], now = new Date()) {
  if (!Number.isFinite(now.getTime()) || rows.length > 500 || new Set(rows.map(r => r.id)).size !== rows.length || new Set(rows.map(r => r.snapshotId)).size !== rows.length) return null;
  const groups = new Map<string, LearningRow[]>();
  for (const row of rows) {
    const r = row.reading;
    const definition = r?.definitionVersion.match(/^instagram-(feed|reel)-views-reach-total-interactions-(v[1-9][0-9]?\.0)-v1$/);
    if (row.provider !== "Instagram" || !r || !definition || row.format !== (definition[1] === "feed" ? "static" : "video") || r.impressions !== null) continue;
    const age = r.observedAt.getTime() - row.publishedAt.getTime();
    if (!Number.isFinite(age) || r.observedAt > now || row.publishedAt.getTime() < now.getTime() - 45 * DAY || age < 3 * DAY || age > 4 * DAY ||
      !count.min(100).safeParse(r.views).success || !count.safeParse(r.engagements).success) continue;
    const key = JSON.stringify([row.connectionId, definition[2], row.format]);
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  const cohorts = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => rows.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || a.id.localeCompare(b.id)).slice(0, 20)).filter(rows => {
    const total = rows.reduce((n, r) => n + r.reading!.views!, 0);
    return rows.length >= 5 && total >= 1000 && rows.every(r => r.reading!.views! / total <= .4);
  });
  const mean = (rows: LearningRow[], f: (r: LearningRow) => number) => rows.reduce((n, r) => n + f(r), 0) / rows.length;
  const version = (r: LearningRow) => r.reading!.definitionVersion.match(/-(v[1-9][0-9]?\.0)-v1$/)![1];
  const rate = (rows: LearningRow[]) => rows.reduce((n, r) => n + r.reading!.engagements!, 0) / rows.reduce((n, r) => n + r.reading!.views!, 0);
  for (const a of cohorts) for (const b of cohorts) {
    if (a === b || a[0].connectionId !== b[0].connectionId || version(a[0]) !== version(b[0]) || a[0].format === b[0].format ||
      Math.abs(mean(a, r => r.publishedAt.getTime()) - mean(b, r => r.publishedAt.getTime())) > 7 * DAY ||
      Math.abs(mean(a, r => r.reading!.observedAt.getTime() - r.publishedAt.getTime()) - mean(b, r => r.reading!.observedAt.getTime() - r.publishedAt.getTime())) > DAY / 2 ||
      !(rate(a) > rate(b) * 1.1 && rate(a) > rate(b) + .001)) continue;
    const unsigned = {
      kind: "OBSERVATIONAL_VIEWS_V1", policy: "INSTAGRAM_NATIVE_VIEWS_72_96_HOURS_V1", evaluatedAt: now.toISOString(),
      connectionId: a[0].connectionId, provider: "Instagram", apiVersion: version(a[0]), basis: "total_interactions_per_native_view",
      cohorts: [a, b].map(rows => ({ format: rows[0].format, definitionVersion: rows[0].reading!.definitionVersion,
        points: rows.map(r => ({ publicationId: r.id, snapshotId: r.snapshotId, publishedAt: r.publishedAt.toISOString(), observedAt: r.reading!.observedAt.toISOString(), views: r.reading!.views!, interactions: r.reading!.engagements! })),
        views: rows.reduce((n, r) => n + r.reading!.views!, 0), interactions: rows.reduce((n, r) => n + r.reading!.engagements!, 0) })),
      warning: "Non-randomized observations. Feed views and Reel views have different display/play semantics and can include repeat exposure; they are not impressions, unique people, conversions or completed playback. Topic, audience, paid distribution and timing may confound this comparison. Use only to propose a reversible format experiment, not a causal improvement or proven preference.",
    };
    return { hypothesis: `Test more ${a[0].format} against ${b[0].format} on Instagram. Matched-age total interactions per native view were higher. Feed displays and Reel plays differ; this is a reversible experiment, not a proven preference or causal finding.`,
      evidence: viewLearningEvidence.parse({ ...unsigned, fingerprint: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") }) };
  }
  return null;
}
