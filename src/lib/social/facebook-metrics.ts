import { z } from "zod";
import { assertMetaFresh, metaClient, metaId, type MetaSettings } from "./meta-oauth";
import { MetricSourceChangedError, metricReading, metricSubject, type Account, type MetricSubject, type SocialAdapter } from "./contracts";
import { validCandidateId } from "./integrity";

const count = z.number().int().nonnegative().max(2_147_483_647);
const names = ["post_media_view", "post_total_media_view_unique", "post_clicks", "post_reactions_by_type_total"] as const;
const reactionTypes = ["like", "love", "wow", "haha", "sorry", "anger"] as const;
const reactionCounts = z.partialRecord(z.enum(reactionTypes), count);
const metricRow = z.object({
  id: z.string().max(250), name: z.enum(names), period: z.literal("lifetime"),
  values: z.array(z.object({ value: z.union([count, reactionCounts]) })).max(1),
  total_value: z.never().optional(),
});

export function parseFacebookInsights(raw: unknown, postId: string) {
  if (!/^[1-9][0-9]{0,39}_[1-9][0-9]{0,39}$/.test(postId)) throw Error("Invalid Facebook post identity.");
  const response = z.object({ data: z.array(metricRow).max(4), paging: z.object({ next: z.string().optional() }).optional() }).parse(raw);
  if (response.paging?.next) throw Error("Unbounded Facebook insights response.");
  const values = new Map<string, number | null>();
  for (const row of response.data) {
    if (values.has(row.name) || row.id !== `${postId}/insights/${row.name}/lifetime`) throw Error("Facebook insight identity mismatch.");
    const value = row.values[0]?.value;
    let scalar: number | null = null;
    if (value !== undefined) {
      if (row.name === "post_reactions_by_type_total") {
        const parts = Object.values(reactionCounts.parse(value));
        // An empty breakdown is unavailable, not proof of zero reactions.
        scalar = parts.length ? count.parse(parts.reduce((sum, n) => sum + n, 0)) : null;
      } else scalar = count.parse(value);
    }
    values.set(row.name, scalar);
  }
  return { views: values.get(names[0]) ?? null, uniqueViewers: values.get(names[1]) ?? null, clicks: values.get(names[2]) ?? null, reactions: values.get(names[3]) ?? null };
}

export function facebookMetricReader(config: MetaSettings, fetcher: typeof fetch, authorize: (account: Account, signal: AbortSignal) => Promise<void>): SocialAdapter["metrics"] {
  async function checkSource(account: Account, id: string, subject: MetricSubject, signal: AbortSignal) {
    const graph = metaClient(config, fetcher, signal);
    const post = z.object({
      id: z.literal(id), from: z.object({ id: metaId }), message: z.string().max(10000).optional(),
      is_published: z.boolean(), is_hidden: z.boolean(), created_time: z.string().max(100),
      application: z.object({ id: metaId }).optional(), parent_id: z.string().max(100).optional(), object_id: metaId.optional(),
      attachments: z.object({ data: z.array(z.object({ type: z.string().max(80), target: z.object({ id: metaId }).optional(), subattachments: z.unknown().optional() })).max(2), paging: z.object({ next: z.string().optional() }).optional() }).optional(),
    }).parse(await graph(id, account.token, { fields: "id,from,message,is_published,is_hidden,created_time,application,attachments.limit(2){type,target,subattachments},object_id,parent_id" }));
    const time = new Date(post.created_time).getTime();
    if (!Number.isFinite(time) || time <= 0 || time > Date.now() + 60_000) throw Error("Invalid publication time.");
    if (post.from.id !== account.externalAccountId || post.message !== subject.payload.caption || !post.is_published || post.is_hidden || post.parent_id ||
      post.application && post.application.id !== config.appId || time !== subject.publishedAt.getTime()) throw new MetricSourceChangedError();
    if (post.attachments?.paging?.next) throw Error("Unbounded post attachments.");
    const attachments = post.attachments?.data ?? [];
    if (subject.payload.image) {
      if (attachments.length !== 1 || attachments[0].type !== "photo" || attachments[0].target?.id !== subject.mediaExternalId || attachments[0].subattachments !== undefined ||
        post.object_id && post.object_id !== subject.mediaExternalId) throw new MetricSourceChangedError();
      const photo = z.object({ id: z.literal(subject.mediaExternalId!), from: z.object({ id: metaId }), alt_text_custom: z.string().max(10000).optional() })
        .parse(await graph(subject.mediaExternalId!, account.token, { fields: "id,from,alt_text_custom" }));
      if (photo.from.id !== account.externalAccountId || photo.alt_text_custom !== subject.payload.image.altText) throw new MetricSourceChangedError();
    } else if (attachments.length || post.object_id) throw new MetricSourceChangedError();
  }
  return async (account, id, signal, rawSubject) => {
    try {
      if (process.env.FACEBOOK_METRICS_ENABLED !== "true") throw Error("Facebook metrics disabled.");
      const subject = metricSubject.parse(rawSubject);
      if (account.provider !== "Facebook" || subject.payload.channel !== "Facebook" || subject.payload.format !== "static" || !validCandidateId("Facebook", id, account.externalAccountId) ||
        subject.publishedAt.getTime() <= 0 || subject.publishedAt > new Date()) throw Error("Unsupported Facebook metric source.");
      metaId.parse(account.externalAccountId);
      if (subject.payload.image) metaId.parse(subject.mediaExternalId);
      await authorize(account, signal);
      await checkSource(account, id, subject, signal);
      const result = parseFacebookInsights(await metaClient(config, fetcher, signal)(`${id}/insights`, account.token, { metric: names.join(","), period: "lifetime" }), id);
      await checkSource(account, id, subject, signal);
      signal.throwIfAborted(); assertMetaFresh(config);
      if (process.env.FACEBOOK_METRICS_ENABLED !== "true") throw Error("Facebook metrics disabled.");
      return metricReading.parse({ observedAt: new Date(), definitionVersion: `facebook-post-views-unique-clicks-reactions-${config.apiVersion}-v1`, ...result,
        impressions: null, reach: null, engagements: null, videoViews: null });
    } catch (error) {
      if (error instanceof MetricSourceChangedError) throw error;
      throw Error("Facebook post metrics could not be verified.");
    }
  };
}
