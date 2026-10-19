import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Scope } from "../production/service";
import { publicationPayload, type MetricReading } from "./contracts";
import { payloadHash } from "./integrity";
import { validSkillMemories } from "../harness/learning";

const DAY = 86400000;
const ref = z.string().min(1).max(200);
const point = z.object({ publicationId: ref, snapshotId: ref, publishedAt: z.iso.datetime(), observedAt: z.iso.datetime(), impressions: z.number().int().min(100).max(2147483647), engagements: z.number().int().nonnegative().max(2147483647) }).strict();
const cohort = z.object({ format: z.enum(["static", "video"]), points: z.array(point).min(5).max(20), impressions: z.number().int().positive(), engagements: z.number().int().nonnegative() }).strict();
export const learningEvidence = z.object({ kind: z.literal("OBSERVATIONAL_V2"), policy: z.literal("MATCHED_72_96_HOURS_V1"), evaluatedAt: z.iso.datetime(), connectionId: ref, provider: z.enum(["Facebook", "Instagram", "LinkedIn"]), definitionVersion: z.string().min(1).max(100), cohorts: z.tuple([cohort, cohort]), warning: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type LearningRow = { id: string; snapshotId: string; connectionId: string; provider: string; format: string; publishedAt: Date; reading: MetricReading | null };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Conservative observation policy, not a significance test or causal inference.
export function experimentCandidate(rows: LearningRow[], now = new Date()) {
  if (rows.length > 500 || new Set(rows.map(r => r.id)).size !== rows.length || new Set(rows.map(r => r.snapshotId)).size !== rows.length) return null;
  const groups = new Map<string, LearningRow[]>();
  for (const row of rows) {
    const r = row.reading, age = r ? r.observedAt.getTime() - row.publishedAt.getTime() : 0;
    if (!r || !["static", "video"].includes(row.format) || !["Facebook", "Instagram", "LinkedIn"].includes(row.provider) || r.impressions === null || r.engagements === null || !Number.isSafeInteger(r.impressions) || !Number.isSafeInteger(r.engagements) || r.impressions < 100 || r.engagements < 0 || r.impressions > 2147483647 || r.engagements > 2147483647 || age < 3 * DAY || age > 4 * DAY || r.observedAt > now || row.publishedAt.getTime() < now.getTime() - 45 * DAY) continue;
    const key = JSON.stringify([row.connectionId, row.provider, r.definitionVersion, row.format]);
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  const cohorts = [...groups.values()].map(g => g.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || a.id.localeCompare(b.id)).slice(0, 20)).filter(g => {
    const total = g.reduce((n, r) => n + r.reading!.impressions!, 0);
    return g.length >= 5 && total >= 1000 && g.every(r => r.reading!.impressions! / total <= .4);
  }).sort((a, b) => JSON.stringify([a[0].connectionId, a[0].provider, a[0].reading!.definitionVersion, a[0].format]).localeCompare(JSON.stringify([b[0].connectionId, b[0].provider, b[0].reading!.definitionVersion, b[0].format])));
  for (const a of cohorts) for (const b of cohorts) {
    if (a === b || a[0].connectionId !== b[0].connectionId || a[0].provider !== b[0].provider || a[0].reading!.definitionVersion !== b[0].reading!.definitionVersion || a[0].format === b[0].format) continue;
    const mean = (g: LearningRow[], f: (r: LearningRow) => number) => g.reduce((n, r) => n + f(r), 0) / g.length;
    if (Math.abs(mean(a, r => r.publishedAt.getTime()) - mean(b, r => r.publishedAt.getTime())) > 7 * DAY || Math.abs(mean(a, r => r.reading!.observedAt.getTime() - r.publishedAt.getTime()) - mean(b, r => r.reading!.observedAt.getTime() - r.publishedAt.getTime())) > DAY / 2) continue;
    const rate = (g: LearningRow[]) => g.reduce((n, r) => n + r.reading!.engagements!, 0) / g.reduce((n, r) => n + r.reading!.impressions!, 0);
    if (!(rate(a) > rate(b) * 1.1 && rate(a) > rate(b) + .001)) continue;
    const unsigned = {
      kind: "OBSERVATIONAL_V2" as const, policy: "MATCHED_72_96_HOURS_V1" as const, evaluatedAt: now.toISOString(), connectionId: a[0].connectionId, provider: a[0].provider, definitionVersion: a[0].reading!.definitionVersion,
      cohorts: [a, b].map(g => ({ format: g[0].format, points: g.map(r => ({ publicationId: r.id, snapshotId: r.snapshotId, publishedAt: r.publishedAt.toISOString(), observedAt: r.reading!.observedAt.toISOString(), impressions: r.reading!.impressions!, engagements: r.reading!.engagements! })), impressions: g.reduce((n, r) => n + r.reading!.impressions!, 0), engagements: g.reduce((n, r) => n + r.reading!.engagements!, 0) })),
      warning: "Non-randomized observations, not a proven preference or causal result. Topic, audience, paid distribution and timing may confound this comparison. Approve only as a reversible experiment.",
    };
    return { hypothesis: `Test more ${a[0].format} against ${b[0].format} on ${a[0].provider}. Matched-age engagement per impression was higher; this is an experiment hypothesis, not a proven preference or causal finding.`, evidence: learningEvidence.parse({ ...unsigned, fingerprint: digest(unsigned) }) };
  }
  return null;
}

type StoredRow = { id: string; snapshotId: string; connectionId: string; provider: string; payload: unknown; payloadHash: string; publishedAt: Date; observedAt: Date; definitionVersion: string; impressions: number | null; engagements: number | null };
export async function learningRows(tx: Prisma.TransactionClient, scope: Scope, brandVersion: number, at: Date, snapshotIds: string[] | null = null): Promise<LearningRow[]> {
  // Exact observation-age window in SQL avoids fetching unbounded lifetime histories.
  const records = await tx.$queryRaw<StoredRow[]>`
    SELECT p.id, m.id AS "snapshotId", p."connectionId", c.provider, p.payload, p."payloadHash", p."publishedAt", m."observedAt", m."definitionVersion", m.impressions, m.engagements
    FROM "MetricSnapshot" m JOIN "SocialPublication" p ON p.id=m."publicationId" AND p."businessId"=m."businessId" AND p."organizationId"=m."organizationId"
    JOIN "SocialConnection" c ON c.id=p."connectionId" AND c."businessId"=p."businessId" AND c."organizationId"=p."organizationId"
    JOIN "CreativeRevision" r ON r.id=p."revisionId" JOIN "ProductionItem" i ON i.id=r."itemId" JOIN "ProductionPlan" plan ON plan.id=i."planId"
    WHERE p."businessId"=${scope.businessId} AND p."organizationId"=${scope.organizationId} AND plan."brandVersion"=${brandVersion}
      AND plan."businessId"=p."businessId" AND plan."organizationId"=p."organizationId" AND r."organizationId"=p."organizationId"
      AND p.status='PUBLISHED' AND p."brandVersion"=${brandVersion} AND p."externalPostId" IS NOT NULL AND c.status='CONNECTED'
      AND p."metricsInvalidatedAt" IS NULL
      AND c.provider <> 'Facebook'
      AND (c.provider <> 'LinkedIn' OR m."definitionVersion" ~ '^linkedin-organic-post-likes-comments-shares-[0-9]{6}-v2$')
      AND (c.provider <> 'Instagram' OR m."definitionVersion" ~ '^instagram-feed-views-reach-total-interactions-v[1-9][0-9]?[.]0-v1$')
      AND p."publishedAt">=${new Date(at.getTime() - 45 * DAY)} AND m."observedAt"<=${at}
      AND m."observedAt">=p."publishedAt" + INTERVAL '72 hours' AND m."observedAt"<=p."publishedAt" + INTERVAL '96 hours'
      AND (${snapshotIds === null} OR m.id=ANY(${snapshotIds ?? []}::text[]))
    ORDER BY m."observedAt" ASC, m.id ASC LIMIT 1001`;
  if (records.length > 1000) return [];
  const used = new Set<string>(), result: LearningRow[] = [];
  for (const row of records) {
    const parsed = publicationPayload.safeParse(row.payload);
    if (!parsed.success || parsed.data.channel !== row.provider || payloadHash(parsed.data) !== row.payloadHash) continue;
    // One earliest age-matched snapshot per post. A post cannot inflate the sample.
    if (used.has(row.id)) continue;
    used.add(row.id);
    result.push({ ...row, format: parsed.data.format, reading: { observedAt: row.observedAt, definitionVersion: row.definitionVersion, impressions: row.impressions, engagements: row.engagements, reach: null, clicks: null, videoViews: null } });
  }
  return result;
}

export async function validLearningEvidence(tx: Prisma.TransactionClient, scope: Scope, brandVersion: number, raw: unknown, hypothesis: string, now = new Date(), maxAgeDays = 7) {
  const parsed = learningEvidence.safeParse(raw);
  if (!parsed.success) return false;
  const evidence = parsed.data, evaluated = new Date(evidence.evaluatedAt);
  if (evaluated > now || now.getTime() - evaluated.getTime() > maxAgeDays * DAY) return false;
  const points = evidence.cohorts.flatMap(c => c.points);
  if (new Set(points.map(p => p.publicationId)).size !== points.length || new Set(points.map(p => p.snapshotId)).size !== points.length) return false;
  const rows = await learningRows(tx, scope, brandVersion, evaluated, points.map(p => p.snapshotId));
  if (rows.length !== points.length) return false;
  const rebuilt = experimentCandidate(rows, evaluated);
  return !!rebuilt && rebuilt.hypothesis === hypothesis && JSON.stringify(rebuilt.evidence) === JSON.stringify(evidence);
}

export async function productionMemories(tx: Prisma.TransactionClient, scope: Scope, brandVersion: number, now = new Date()) {
  const stored = await tx.memory.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId }, orderBy: { id: "asc" }, take: 100 });
  const validSkills = stored.some(m => m.kind === "APPROVED_SKILL") ? await validSkillMemories(tx, scope, brandVersion, stored) : new Set<string>();
  const memories = stored.filter(m => m.kind !== "APPROVED_SKILL" || validSkills.has(m.id));
  const experiments = memories.filter(m => m.kind === "APPROVED_EXPERIMENT");
  if (!experiments.length) return memories;
  const proposals = await tx.learningProposal.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, brandVersion, status: "PROMOTED", memoryId: { in: experiments.map(m => m.id) } }, take: 21 });
  const eligible = new Set<string>();
  if (proposals.length <= 20) for (const proposal of proposals) {
    if (experiments.find(m => m.id === proposal.memoryId)?.text === proposal.hypothesis && await validLearningEvidence(tx, scope, brandVersion, proposal.evidence, proposal.hypothesis, now, 30)) eligible.add(proposal.memoryId!);
  }
  return memories.filter(m => m.kind !== "APPROVED_EXPERIMENT" || eligible.has(m.id));
}
export const preferenceFingerprint = (memories: { id: string; kind: string; text: string }[]) => digest(memories.map(m => ({ id: m.id, kind: m.kind, text: m.text })));
