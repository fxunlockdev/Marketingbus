import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, type Scope } from "../production/service";
import type { MetricReading } from "./contracts";
import { experimentCandidate, learningRows, validLearningEvidence } from "./learning-evidence";
export { experimentCandidate } from "./learning-evidence";

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
  return db.$transaction(async (tx) => {
    const business = await lockBusiness(tx, scope);
    const member = await tx.membership.findFirst({ where: { organizationId: scope.organizationId, userId: scope.actorId, role: { in: ["OWNER", "ADMIN", "EDITOR"] } } });
    if (!member) throw new AppError(403, "Your current workspace role cannot manage experiments.");
    if (input.action === "evaluate") {
      if (!business.confirmedAt) throw new AppError(409, "Confirm the current brand before evaluating experiments.");
      const now = new Date(), candidate = experimentCandidate(await learningRows(tx, scope, business.version, now), now);
      if (!candidate)
        throw new AppError(
          409,
          "Insufficient comparable evidence. Each format needs five current-brand posts and 1,000 impressions on the same account and metric definition, observed at 72–96 hours. Lifetime totals are not comparable evidence."
        );
      const duplicate = await tx.learningProposal.findFirst({
        where: {
          businessId: scope.businessId,
          brandVersion: business.version,
          hypothesis: candidate.hypothesis,
          status: { in: ["PROPOSED", "PROMOTED"] },
        },
      });
      if (duplicate && await validLearningEvidence(tx, scope, business.version, duplicate.evidence, duplicate.hypothesis)) return { ok: true, id: duplicate.id };
      if (duplicate?.status === "PROPOSED") await tx.learningProposal.update({ where: { id: duplicate.id }, data: { status: "EXPIRED" } });
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
      if (!await validLearningEvidence(tx, scope, business.version, proposal.evidence, proposal.hypothesis)) throw new AppError(409, "Experiment evidence is missing, changed or expired. Evaluate current evidence again; legacy proposals cannot be promoted.");
      if (await tx.learningProposal.count({ where: { businessId: scope.businessId, status: "PROMOTED" } }) >= 20) throw new AppError(409, "Revert an existing experiment before approving another.");
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
