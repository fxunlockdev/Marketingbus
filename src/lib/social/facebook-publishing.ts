import { createHmac } from "node:crypto";
import { z } from "zod";
import { assertMetaFresh, createMetaOAuthAdapter, META_SCOPES, metaClient, metaId, metaSettings, verifyMetaToken, type MetaSettings } from "./meta-oauth";
import { SocialReadError, socialJson } from "./provider-http";
import { publicationPayload, type Account, type PublicationPayload, type PublishedReceipt, type SocialAdapter } from "./contracts";
import { safeSocialPermalink } from "./permalink";
import { submissionJournal, type SubmissionContext, type SubmissionJournal } from "./submission-journal";
import { validCandidateId } from "./integrity";
import { createImageTransfer, facebookImageId, type SocialImageTransfer } from "./image-transfer";
import { prepareFacebookImage, readFacebookImage } from "./facebook-image-upload";
import { facebookMetricReader } from "./facebook-metrics";

const failure = () => Error("Facebook publication could not be verified.");
export function createFacebookPublishingAdapter(raw: MetaSettings, fetcher: typeof fetch = fetch, journal: SubmissionJournal = submissionJournal, images: { enabled: boolean; transfer?: SocialImageTransfer } = { enabled: process.env.FACEBOOK_IMAGE_PUBLISHING_ENABLED === "true" }): SocialAdapter {
  const config = metaSettings.parse(raw);
  const version = `${createMetaOAuthAdapter("Facebook", config).config.version}:publish-v1`;
  const transfer = images.transfer ?? createImageTransfer();
  const context = (account: Account, payload: PublicationPayload, requestId: string): SubmissionContext => ({ account, payload, requestId, adapterVersion: payload.image ? `${version}:image-v1` : version });
  function validatePayload(account: Account, payload: PublicationPayload) {
    publicationPayload.parse(payload); metaId.parse(account.externalAccountId);
    if (account.provider !== "Facebook" || payload.channel !== "Facebook" || payload.format !== "static" || payload.image && !images.enabled) throw failure();
  }
  async function authorize(account: Account, signal: AbortSignal) {
    if (account.provider !== "Facebook") throw failure();
    const id = metaId.parse(account.externalAccountId);
    const grant = await verifyMetaToken(config, fetcher, account.token, "Facebook", signal, "PAGE");
    if (grant.profile_id !== id || (grant.granular_scopes ?? []).some(p => META_SCOPES.Facebook.includes(p.scope) && p.target_ids && !p.target_ids.includes(id))) throw failure();
    // A still-valid token is insufficient: confirm this Page and its current posting capability.
    z.object({ id: z.literal(id), can_post: z.literal(true) }).parse(await metaClient(config, fetcher, signal)("me", account.token, { fields: "id,can_post" }));
  }
  async function readPost(ctx: SubmissionContext, id: string, signal: AbortSignal, imageId?: string): Promise<PublishedReceipt> {
    const { account, payload } = ctx;
    if (!validCandidateId("Facebook", id, account.externalAccountId)) throw failure();
    const post = z.object({
      id: z.literal(id), from: z.object({ id: z.literal(account.externalAccountId) }),
      message: z.literal(payload.caption), is_published: z.literal(true), is_hidden: z.literal(false),
      created_time: z.string().max(100), permalink_url: z.string().max(2000).optional(),
      application: z.object({ id: z.literal(config.appId) }).optional(),
      attachments: imageId ? z.object({ data: z.array(z.object({ type: z.literal("photo"), target: z.object({ id: z.literal(imageId) }), subattachments: z.never().optional() })).length(1), paging: z.object({ next: z.never().optional() }).optional() }) : z.object({ data: z.array(z.unknown()).length(0) }).optional(),
      object_id: imageId ? z.literal(imageId).optional() : z.never().optional(),
      parent_id: z.never().optional(),
    }).parse(await metaClient(config, fetcher, signal)(id, account.token, { fields: `id,from,message,is_published,is_hidden,created_time,permalink_url,application,${imageId ? "attachments.limit(2){type,target,subattachments},object_id" : "attachments.limit(1){type}"},parent_id` }));
    const publishedAt = new Date(post.created_time);
    if (!Number.isFinite(publishedAt.getTime()) || publishedAt.getTime() <= 0 || publishedAt.getTime() > Date.now() + 60000) throw failure();
    if (imageId) await readFacebookImage(ctx, imageId, signal, config, fetcher);
    signal.throwIfAborted(); assertMetaFresh(config);
    return { externalPostId: id, publishedAt, permalink: safeSocialPermalink(post.permalink_url, "Facebook") };
  }
  return {
    imagePublishingAvailable: images.enabled,
    metricsAvailable: process.env.FACEBOOK_METRICS_ENABLED === "true",
    metrics: facebookMetricReader(config, fetcher, authorize),
    async publish(account, payload, requestId, signal) {
      try { validatePayload(account, payload); } catch { return { state: "failed", code: "INVALID_MEDIA" }; }
      try { await authorize(account, signal); }
      catch (error) {
        if (error instanceof SocialReadError && error.status === 401) return { state: "failed", code: "TOKEN_REVOKED" };
        if (error instanceof SocialReadError && [429, 500, 502, 503, 504].includes(error.status ?? 0)) return { state: "retryable", code: error.status === 429 ? "RATE_LIMIT" : "PROVIDER_UNAVAILABLE", retryAfterSeconds: 3600 };
        return { state: "failed", code: "PERMISSION_DENIED" };
      }
      const ctx = context(account, payload, requestId);
      try {
        const imageId = payload.image ? await prepareFacebookImage(ctx, signal, config, fetcher, transfer) : undefined;
        if (!await journal.begin(ctx)) return { state: "uncertain" };
        signal.throwIfAborted(); assertMetaFresh(config);
        const body = new URLSearchParams({ message: payload.caption, published: "true", appsecret_proof: createHmac("sha256", config.appSecret).update(account.token).digest("hex") });
        if (imageId) body.set("attached_media", JSON.stringify([{ media_fbid: imageId }]));
        // Exactly one post after its own durable fence; no remote scheduling or arbitrary links.
        const result = z.object({ id: z.string().max(100) }).parse(await socialJson(fetcher, `https://graph.facebook.com/${config.apiVersion}/${account.externalAccountId}/feed`, {
          method: "POST", headers: { Authorization: `Bearer ${account.token}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body,
        }, signal));
        if (!validCandidateId("Facebook", result.id, account.externalAccountId)) return { state: "uncertain" };
        await journal.record(ctx, result.id);
        return { state: "published", receipt: await readPost(ctx, result.id, signal, imageId) };
      } catch { return { state: "uncertain" }; }
    },
    async reconcile(account, requestId, payload, signal) {
      try {
        validatePayload(account, payload);
        const ctx = context(account, payload, requestId), id = await journal.candidate(ctx);
        if (!id) return null;
        let imageId: string | undefined;
        if (payload.image) {
          const state = await transfer.inspect(ctx);
          if (!state.started || !state.uploaded) return null;
          imageId = facebookImageId.parse(state.externalId);
        }
        await authorize(account, signal);
        return await readPost(ctx, id, signal, imageId);
      } catch { return null; }
    },
  };
}
