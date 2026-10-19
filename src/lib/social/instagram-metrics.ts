import { z } from "zod";
import { assertMetaFresh, metaClient, metaId, type MetaSettings } from "./meta-oauth";
import { MetricSourceChangedError, metricReading, metricSubject, type Account, type MetricSubject, type SocialAdapter } from "./contracts";

const count = z.number().int().nonnegative().max(2_147_483_647);
const names = ["views", "reach", "total_interactions"] as const;
const metricRow = z.object({
  id: z.string().max(200), name: z.enum(names), period: z.literal("lifetime"),
  values: z.array(z.object({ value: count })).max(1).optional(),
  total_value: z.object({ value: count }).strict().optional(),
}).refine(r => (r.values !== undefined) !== (r.total_value !== undefined), "Ambiguous metric representation");

// Each scalar is the provider's native lifetime metric. Views are NOT impressions,
// reach is not distinct people across posts, and interactions are not conversions.
export function parseInstagramInsights(raw: unknown, mediaId: string) {
  metaId.parse(mediaId);
  const result = z.object({ data: z.array(metricRow).max(3), paging: z.object({ next: z.string().optional() }).optional() }).parse(raw);
  if (result.paging?.next) throw Error("Unbounded Instagram metrics response.");
  const values = new Map<string, number | null>();
  for (const row of result.data) {
    if (values.has(row.name) || row.id !== `${mediaId}/insights/${row.name}/lifetime`) throw Error("Instagram metric identity mismatch.");
    values.set(row.name, row.values?.[0]?.value ?? row.total_value?.value ?? null);
  }
  return { views: values.get("views") ?? null, reach: values.get("reach") ?? null, engagements: values.get("total_interactions") ?? null };
}

export function instagramMetricReader(config: MetaSettings, fetcher: typeof fetch, authorize: (account: Account, signal: AbortSignal) => Promise<void>): SocialAdapter["metrics"] {
  async function checkSource(account: Account, id: string, subject: MetricSubject, signal: AbortSignal) {
    const post = z.object({ id: z.literal(id), owner: z.object({ id: metaId }), caption: z.string().max(10000).optional(),
      alt_text: z.string().max(10000), media_type: z.string().max(30), media_product_type: z.string().max(30), timestamp: z.string().max(100),
    }).parse(await metaClient(config, fetcher, signal)(id, account.token, { fields: "id,owner,caption,alt_text,media_type,media_product_type,timestamp" }));
    const time = new Date(post.timestamp).getTime();
    if (!Number.isFinite(time) || time <= 0 || time > Date.now() + 60_000) throw Error("Invalid Instagram publication time.");
    if (post.owner.id !== account.externalAccountId || post.caption !== subject.payload.caption || post.alt_text !== subject.payload.image!.altText ||
      post.media_type !== "IMAGE" || post.media_product_type !== "FEED" || time !== subject.publishedAt.getTime()) throw new MetricSourceChangedError();
  }
  return async (account, id, signal, rawSubject) => {
    try {
      if (process.env.INSTAGRAM_METRICS_ENABLED !== "true") throw Error("Instagram metrics disabled.");
      const subject = metricSubject.parse(rawSubject);
      metaId.parse(id); metaId.parse(account.externalAccountId); metaId.parse(subject.mediaExternalId);
      if (account.provider !== "Instagram" || subject.payload.channel !== "Instagram" || !subject.payload.image || subject.payload.format !== "static" || subject.publishedAt.getTime() <= 0 || subject.publishedAt > new Date()) throw Error("Unsupported Instagram metric source.");
      await authorize(account, signal);
      await checkSource(account, id, subject, signal);
      const metrics = parseInstagramInsights(await metaClient(config, fetcher, signal)(`${id}/insights`, account.token, { metric: names.join(","), period: "lifetime" }), id);
      // A valid response cannot attach measurements to copy edited during the read.
      await checkSource(account, id, subject, signal);
      signal.throwIfAborted(); assertMetaFresh(config);
      if (process.env.INSTAGRAM_METRICS_ENABLED !== "true") throw Error("Instagram metrics disabled.");
      return metricReading.parse({ observedAt: new Date(), definitionVersion: `instagram-feed-views-reach-total-interactions-${config.apiVersion}-v1`,
        ...metrics, impressions: null, clicks: null, videoViews: null });
    } catch (error) {
      if (error instanceof MetricSourceChangedError) throw error;
      // Provider bodies and token-bearing URLs must not escape into logs or the UI.
      throw Error("Instagram post metrics could not be verified.");
    }
  };
}
