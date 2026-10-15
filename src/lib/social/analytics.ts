import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, type Scope } from "../production/service";
import type { MetricReading } from "./contracts";

type Row = {
  id: string;
  connectionId: string;
  provider: string;
  format: string;
  publishedAt: Date;
  reading: MetricReading | null;
};
const names = [
  "impressions",
  "reach",
  "engagements",
  "clicks",
  "videoViews",
] as const;
export function summarizePerformance(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    // Do not compare accounts or metric definitions as though they measure the same population.
    const key = `${row.connectionId}:${
      row.reading?.definitionVersion ?? "unavailable"
    }`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    provider: group[0].provider,
    connectionId: group[0].connectionId,
    definitionVersion: group[0].reading?.definitionVersion ?? null,
    posts: group.length,
    latestObservation: group.reduce<Date | null>(
      (date, row) =>
        row.reading && (!date || row.reading.observedAt > date)
          ? row.reading.observedAt
          : date,
      null
    ),
    metrics: Object.fromEntries(
      names.map((name) => {
        const supported = group.filter((row) => row.reading?.[name] != null);
        return [
          name,
          {
            value: supported.length
              ? supported.reduce((n, row) => n + row.reading![name]!, 0)
              : null,
            coveredPosts: supported.length,
          },
        ];
      })
    ),
    // Reach is deliberately not presented as distinct people across posts.
    note: "Totals cover observed posts only. Reach is summed post reach, not unique audience. Engagement is not a conversion or causal result.",
  }));
}
export function experimentCandidate(rows: Row[], now = new Date()) {
  const eligible = rows.filter(
    (r) =>
      r.reading &&
      r.reading.impressions != null &&
      r.reading.engagements != null &&
      r.reading.impressions >= 100 &&
      r.publishedAt.getTime() <= now.getTime() - 72 * 3600000 &&
      r.reading.observedAt.getTime() >=
        r.publishedAt.getTime() + 72 * 3600000 &&
      r.reading.observedAt <= now
  );
  const cohorts = new Map<string, Row[]>();
  for (const row of eligible) {
    const key = `${row.connectionId}:${row.reading!.definitionVersion}:${
      row.format
    }`;
    cohorts.set(key, [...(cohorts.get(key) ?? []), row]);
  }
  const comparisons = [...cohorts.values()].filter(
    (g) =>
      g.length >= 5 &&
      g.reduce((n, r) => n + r.reading!.impressions!, 0) >= 1000
  );
  for (const a of comparisons)
    for (const b of comparisons) {
      if (
        a === b ||
        a[0].connectionId !== b[0].connectionId ||
        a[0].reading!.definitionVersion !== b[0].reading!.definitionVersion ||
        a[0].format === b[0].format
      )
        continue;
      const rate = (g: Row[]) =>
        g.reduce((n, r) => n + r.reading!.engagements!, 0) /
        g.reduce((n, r) => n + r.reading!.impressions!, 0);
      if (rate(a) > rate(b) * 1.1 && rate(a) > rate(b) + 0.001)
        return {
          hypothesis: `Test more ${a[0].format} against ${b[0].format} on ${a[0].provider}. Observed engagement per impression was higher; this is an experiment hypothesis, not a proven preference or causal finding.`,
          evidence: {
            kind: "OBSERVATIONAL_V1",
            connectionId: a[0].connectionId,
            definitionVersion: a[0].reading!.definitionVersion,
            cohorts: [a, b].map((g) => ({
              format: g[0].format,
              posts: g.map((r) => r.id),
              observations: g.map((r) => r.reading!.observedAt.toISOString()),
              impressions: g.reduce((n, r) => n + r.reading!.impressions!, 0),
              engagements: g.reduce((n, r) => n + r.reading!.engagements!, 0),
            })),
            warning:
              "Non-randomized data; audience, topic, age and timing may confound the comparison. Human confirmation required.",
          },
        };
    }
  return null;
}
async function performanceRows(scope: Scope) {
  const posts = await db.socialPublication.findMany({
    where: {
      businessId: scope.businessId,
      organizationId: scope.organizationId,
      status: "PUBLISHED",
    },
    take: 500,
    orderBy: { publishedAt: "desc" },
    include: {
      connection: { select: { provider: true } },
      revision: { include: { item: { select: { format: true } } } },
      metrics: { orderBy: [{ observedAt: "desc" }, { id: "desc" }], take: 1 },
    },
  });
  return posts.map((p) => ({
    id: p.id,
    connectionId: p.connectionId,
    provider: p.connection.provider,
    format: p.revision.item.format,
    publishedAt: p.publishedAt!,
    reading: p.metrics[0] ?? null,
  }));
}
export async function readSocialDashboard(scope: Scope) {
  const [connections, publications, proposals, rows] = await Promise.all([
    db.socialConnection.findMany({
      where: {
        businessId: scope.businessId,
        organizationId: scope.organizationId,
      },
      select: {
        id: true,
        label: true,
        provider: true,
        status: true,
        expiresAt: true,
      },
    }),
    db.socialPublication.findMany({
      where: {
        businessId: scope.businessId,
        organizationId: scope.organizationId,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        status: true,
        scheduledFor: true,
        publishedAt: true,
        permalink: true,
        externalPostId: true,
        errorCode: true,
        reconciliationAttempts: true,
        nextReconciliationAt: true,
        metricsFailures: true,
        nextMetricsAt: true,
        connection: { select: { label: true, provider: true } },
        revision: {
          select: { version: true, item: { select: { title: true } } },
        },
      },
    }),
    db.learningProposal.findMany({
      where: {
        businessId: scope.businessId,
        organizationId: scope.organizationId,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    performanceRows(scope),
  ]);
  return {
    connections,
    publications,
    proposals,
    summary: summarizePerformance(rows),
    window:
      "Latest 500 published posts; latest lifetime snapshot per post. Not a date-range delta.",
  };
}
export async function manageLearning(scope: Scope, raw: unknown) {
  const input = z
    .discriminatedUnion("action", [
      z.object({ action: z.literal("evaluate") }).strict(),
      z
        .object({
          action: z.enum(["promote", "reject", "revert"]),
          proposalId: z.string().min(1),
        })
        .strict(),
    ])
    .parse(raw);
  const candidate =
    input.action === "evaluate"
      ? experimentCandidate(await performanceRows(scope))
      : null;
  return db.$transaction(async (tx) => {
    const business = await lockBusiness(tx, scope);
    if (input.action === "evaluate") {
      if (!candidate)
        throw new AppError(
          409,
          "Insufficient comparable evidence. Each format needs at least five mature posts and 1,000 observed impressions on the same account and metric definition."
        );
      const duplicate = await tx.learningProposal.findFirst({
        where: {
          businessId: scope.businessId,
          brandVersion: business.version,
          hypothesis: candidate.hypothesis,
          status: { in: ["PROPOSED", "PROMOTED"] },
        },
      });
      if (duplicate) return { ok: true, id: duplicate.id };
      if (
        (await tx.learningProposal.count({
          where: { businessId: scope.businessId, status: "PROPOSED" },
        })) >= 20
      )
        throw new AppError(409, "Review existing experiments first.");
      const proposal = await tx.learningProposal.create({
        data: {
          businessId: scope.businessId,
          organizationId: scope.organizationId,
          brandVersion: business.version,
          ...candidate,
        },
      });
      return { ok: true, id: proposal.id };
    }
    const proposal = await tx.learningProposal.findFirst({
      where: {
        id: input.proposalId,
        businessId: scope.businessId,
        organizationId: scope.organizationId,
      },
    });
    if (!proposal) throw new AppError(404, "Experiment not found.");
    if (input.action === "promote") {
      if (
        proposal.status !== "PROPOSED" ||
        proposal.brandVersion !== business.version ||
        !business.confirmedAt
      )
        throw new AppError(
          409,
          "Only a current-brand proposal can be promoted."
        );
      if (
        (await tx.memory.count({ where: { businessId: scope.businessId } })) >=
        100
      )
        throw new AppError(409, "Remove an unused preference first.");
      const memory = await tx.memory.create({
        data: {
          businessId: scope.businessId,
          organizationId: scope.organizationId,
          kind: "APPROVED_EXPERIMENT",
          text: proposal.hypothesis,
        },
      });
      await tx.learningProposal.update({
        where: { id: proposal.id },
        data: { status: "PROMOTED", memoryId: memory.id },
      });
    } else if (input.action === "revert") {
      if (proposal.status !== "PROMOTED")
        throw new AppError(409, "Only a promoted experiment can be reverted.");
      if (proposal.memoryId)
        await tx.memory.deleteMany({
          where: {
            id: proposal.memoryId,
            businessId: scope.businessId,
            organizationId: scope.organizationId,
            kind: "APPROVED_EXPERIMENT",
          },
        });
      await tx.learningProposal.update({
        where: { id: proposal.id },
        data: { status: "REVERTED", memoryId: null },
      });
    } else {
      if (proposal.status !== "PROPOSED")
        throw new AppError(409, "Only a proposed experiment can be rejected.");
      await tx.learningProposal.update({
        where: { id: proposal.id },
        data: { status: "REJECTED" },
      });
    }
    await tx.generationQuote.updateMany({
      where: { businessId: scope.businessId, status: "OFFERED" },
      data: { status: "SUPERSEDED" },
    });
    await tx.auditEvent.create({
      data: {
        ...scope,
        action: `EXPERIMENT_${input.action.toUpperCase()}`,
        detail: `Experiment ${proposal.id}: explicit human decision. No autonomous model training or publishing.`,
      },
    });
    return { ok: true };
  });
}
