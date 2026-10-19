import type { PrismaClient } from "@prisma/client";
import { payloadHash } from "../../src/lib/social/integrity";
// Synthetic observations only in the explicitly local test database; not provider output.
export async function seedLearningEvidence(db: PrismaClient, context: { businessId: string; organizationId: string; connectionId: string; planId: string }, now = new Date()) {
  if (!process.env.TEST_DATABASE_URL || process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname)) throw Error("Local learning fixtures only");
  const publishedAt = new Date(now.getTime() - 5 * 86400000), observedAt = new Date(publishedAt.getTime() + 80 * 3600000);
  // The implemented impression policy supports LinkedIn; native Facebook views must not be forged into impressions.
  await db.socialConnection.update({ where: { id: context.connectionId }, data: { provider: "LinkedIn" } });
  const result = [];
  for (const format of ["static", "video"]) for (let n = 0; n < 5; n++) {
    const item = await db.productionItem.create({ data: { planId: context.planId, organizationId: context.organizationId, title: `Learning fixture ${format} ${n}`, channel: "LinkedIn", format, brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: {} } } }, include: { revisions: true } });
    const payload = { caption: "Fixture only", channel: "LinkedIn", format, mediaExportId: null };
    const post = await db.socialPublication.create({ data: { businessId: context.businessId, organizationId: context.organizationId, connectionId: context.connectionId, revisionId: item.revisions[0].id, brandVersion: 1, payload, payloadHash: payloadHash(payload), scheduledFor: publishedAt, timezone: "UTC", status: "PUBLISHED", publishedAt, externalPostId: crypto.randomUUID() } });
    const metric = await db.metricSnapshot.create({ data: { publicationId: post.id, businessId: context.businessId, organizationId: context.organizationId, observedAt, definitionVersion: "linkedin-organic-post-likes-comments-shares-202610-v2", impressions: 1000, engagements: format === "static" ? 50 : 15 } });
    result.push({ post, metric, item });
  }
  return result;
}
