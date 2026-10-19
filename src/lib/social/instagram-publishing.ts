import { createHmac } from "node:crypto";
import { z } from "zod";
import { assertMetaFresh, createMetaOAuthAdapter, META_SCOPES, metaClient, metaId, metaSettings, verifyMetaToken, type MetaSettings } from "./meta-oauth";
import { SocialReadError, socialJson } from "./provider-http";
import { publicationPayload, type Account, type PublicationPayload, type PublishedReceipt, type SocialAdapter } from "./contracts";
import { safeSocialPermalink } from "./permalink";
import { submissionJournal, type SubmissionContext, type SubmissionJournal } from "./submission-journal";
import { createImageTransfer, type SocialImageTransfer } from "./image-transfer";
import { createInstagramDelivery, type InstagramDelivery } from "./instagram-delivery";
import { instagramJpeg } from "./instagram-jpeg";
import { instagramVideo } from "./instagram-video";
import { instagramMetricReader } from "./instagram-metrics";

const failure = () => Error("Instagram publication could not be verified.");
export function createInstagramPublishingAdapter(raw: MetaSettings, fetcher: typeof fetch = fetch, journal: SubmissionJournal = submissionJournal,
  transfer: SocialImageTransfer = createImageTransfer(), delivery: InstagramDelivery = createInstagramDelivery()): SocialAdapter {
  const config = metaSettings.parse(raw);
  const version = createMetaOAuthAdapter("Instagram", config).config.version;
  const context = (account: Account, payload: PublicationPayload, requestId: string): SubmissionContext => ({ account, payload, requestId, adapterVersion: `${version}:${payload.video ? "reel-v1" : "image-v1"}` });
  function validate(account: Account, payload: PublicationPayload) {
    publicationPayload.parse(payload); metaId.parse(account.externalAccountId);
    if (account.provider !== "Instagram" || payload.channel !== "Instagram" ||
        !(payload.image && payload.format === "static" || payload.video && payload.format === "video" && process.env.INSTAGRAM_REELS_ENABLED === "true")) throw failure();
  }
  async function authorize(account: Account, signal: AbortSignal) {
    const grant = await verifyMetaToken(config, fetcher, account.token, "Instagram", signal, "PAGE");
    const pageId = metaId.parse(grant.profile_id);
    if ((grant.granular_scopes ?? []).some(p => META_SCOPES.Instagram.includes(p.scope) && p.target_ids && !p.target_ids.some(id => id === pageId || id === account.externalAccountId))) throw failure();
    z.object({ id: z.literal(pageId), instagram_business_account: z.object({ id: z.literal(account.externalAccountId) }) }).parse(
      await metaClient(config, fetcher, signal)("me", account.token, { fields: "id,instagram_business_account" }));
  }
  async function readPost(ctx: SubmissionContext, id: string, signal: AbortSignal): Promise<PublishedReceipt> {
    metaId.parse(id);
    const post = z.object({ id: z.literal(id), owner: z.object({ id: z.literal(ctx.account.externalAccountId) }),
      caption: z.literal(ctx.payload.caption), ...(ctx.payload.image ? { alt_text: z.literal(ctx.payload.image.altText) } : {}),
      media_type: z.literal(ctx.payload.video ? "VIDEO" : "IMAGE"), media_product_type: z.literal(ctx.payload.video ? "REELS" : "FEED"), timestamp: z.string().max(100), permalink: z.string().max(2000).optional(),
    }).parse(await metaClient(config, fetcher, signal)(id, ctx.account.token, { fields: `id,owner,caption,${ctx.payload.image ? "alt_text," : ""}media_type,media_product_type,timestamp,permalink` }));
    const publishedAt = new Date(post.timestamp);
    if (!Number.isFinite(publishedAt.getTime()) || publishedAt.getTime() <= 0 || publishedAt.getTime() > Date.now() + 60_000) throw failure();
    assertMetaFresh(config); signal.throwIfAborted();
    return { externalPostId: id, publishedAt, permalink: safeSocialPermalink(post.permalink, "Instagram") };
  }
  async function write(ctx: SubmissionContext, edge: "media" | "media_publish", fields: Record<string, string>, signal: AbortSignal) {
    assertMetaFresh(config); signal.throwIfAborted();
    return z.object({ id: metaId }).strict().parse(await socialJson(fetcher, `https://graph.facebook.com/${config.apiVersion}/${ctx.account.externalAccountId}/${edge}`, {
      method: "POST", headers: { Authorization: `Bearer ${ctx.account.token}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...fields, appsecret_proof: createHmac("sha256", config.appSecret).update(ctx.account.token).digest("hex") }),
    }, signal)).id;
  }
  return {
    imagePublishingAvailable: true, videoPublishingAvailable: process.env.INSTAGRAM_REELS_ENABLED === "true", metricsAvailable: process.env.INSTAGRAM_METRICS_ENABLED === "true",
    metrics: instagramMetricReader(config, fetcher, authorize),
    async publish(account, payload, requestId, signal) {
      try { validate(account, payload); } catch { return { state: "failed", code: "INVALID_MEDIA" }; }
      try { await authorize(account, signal); } catch (error) {
        if (error instanceof SocialReadError && error.status === 401) return { state: "failed", code: "TOKEN_REVOKED" };
        if (error instanceof SocialReadError && [429, 500, 502, 503, 504].includes(error.status ?? 0)) return { state: "retryable", code: error.status === 429 ? "RATE_LIMIT" : "PROVIDER_UNAVAILABLE", retryAfterSeconds: 60 };
        return { state: "failed", code: "PERMISSION_DENIED" };
      }
      const ctx = context(account, payload, requestId);
      try {
        let state = await transfer.inspect(ctx);
        if (!state.started) {
          const bytes = await transfer.read(ctx);
          const media = payload.video ? instagramVideo(bytes, payload.video) : await instagramJpeg(bytes, payload.image!);
          if (!await transfer.begin(ctx)) return { state: "uncertain" };
          const mediaUrl = await delivery.issue(ctx, media);
          await transfer.check(ctx);
          // Exactly one container creation after a durable fence, never retry an unknown write.
          const fields: Record<string, string> = payload.video
            ? { media_type: "REELS", video_url: mediaUrl, caption: payload.caption, share_to_feed: String(payload.video.shareToFeed) }
            : { image_url: mediaUrl, caption: payload.caption, alt_text: payload.image!.altText };
          const containerId = await write(ctx, "media", fields, signal);
          await transfer.record(ctx, containerId);
          // For Instagram this records container acknowledgement, NOT processing completion.
          await transfer.uploaded(ctx, containerId);
          state = await transfer.inspect(ctx);
        }
        if (!state.uploaded || !state.externalId) return { state: "uncertain" };
        const containerId = metaId.parse(state.externalId);
        await transfer.check(ctx);
        const ready = z.object({ id: z.literal(containerId), status_code: z.enum(["IN_PROGRESS", "FINISHED", "ERROR", "EXPIRED", "PUBLISHED"]) }).parse(
          await metaClient(config, fetcher, signal)(containerId, account.token, { fields: "id,status_code" }));
        if (ready.status_code === "IN_PROGRESS") return payload.video ? { state: "processing", retryAfterSeconds: 60 } : { state: "retryable", code: "PROVIDER_UNAVAILABLE", retryAfterSeconds: 60 };
        if (["ERROR", "EXPIRED"].includes(ready.status_code)) return { state: "failed", code: "INVALID_MEDIA" };
        if (ready.status_code !== "FINISHED" || !await journal.begin(ctx)) return { state: "uncertain" };
        const id = await write(ctx, "media_publish", { creation_id: containerId }, signal);
        await journal.record(ctx, id);
        return { state: "published", receipt: await readPost(ctx, id, signal) };
      } catch { return { state: "uncertain" }; }
    },
    async reconcile(account, requestId, payload, signal) {
      try {
        validate(account, payload);
        const ctx = context(account, payload, requestId), id = await journal.candidate(ctx);
        if (!id) return null;
        const state = await transfer.inspect(ctx);
        if (!state.started || !state.uploaded || !metaId.safeParse(state.externalId).success) return null;
        await authorize(account, signal);
        return await readPost(ctx, id, signal);
      } catch { return null; }
    },
  };
}
