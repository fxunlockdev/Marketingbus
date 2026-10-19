import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { reelPublishingEnabled, type PublishedReceipt } from "./contracts";
import { facebookImageId, type SocialImageTransfer } from "./image-transfer";
import { validCandidateId } from "./integrity";
import { assertMetaFresh, metaClient, type MetaSettings } from "./meta-oauth";
import { safeSocialPermalink } from "./permalink";
import { socialJson } from "./provider-http";
import type { SubmissionContext, SubmissionJournal } from "./submission-journal";

// Separate durable upload and publication fences. Neither Meta acknowledgement
// proves publication. Only the exact recorded video and its returned post are read.
export function facebookReels(config: MetaSettings, fetcher: typeof fetch, transfer: SocialImageTransfer, journal: SubmissionJournal) {
  function current(signal: AbortSignal) {
    signal.throwIfAborted(); assertMetaFresh(config);
    if (!reelPublishingEnabled("Facebook")) throw Error("Facebook Reels are disabled.");
  }
  async function phase(ctx: SubmissionContext, fields: Record<string, string>, signal: AbortSignal) {
    current(signal);
    const body = new URLSearchParams({ ...fields, appsecret_proof: createHmac("sha256", config.appSecret).update(ctx.account.token).digest("hex") });
    return socialJson(fetcher, `https://graph.facebook.com/${config.apiVersion}/${ctx.account.externalAccountId}/video_reels`, {
      method: "POST", headers: { Authorization: `Bearer ${ctx.account.token}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body,
    }, signal);
  }
  async function receipt(ctx: SubmissionContext, signal: AbortSignal): Promise<PublishedReceipt | null> {
    current(signal);
    if (!ctx.payload.video || !await journal.started?.(ctx)) return null;
    const state = await transfer.inspect(ctx);
    if (!state.started || !state.uploaded) return null;
    const videoId = facebookImageId.parse(state.externalId), read = metaClient(config, fetcher, signal);
    const video = z.object({ id: z.literal(videoId), from: z.object({ id: z.literal(ctx.account.externalAccountId) }),
      description: z.literal(ctx.payload.caption), published: z.literal(true),
      status: z.object({ video_status: z.literal("ready"), publishing_phase: z.object({ status: z.literal("complete") }) }),
      post_id: z.string().max(100),
    }).parse(await read(videoId, ctx.account.token, { fields: "id,from,description,published,status,post_id" }));
    if (!validCandidateId("Facebook", video.post_id, ctx.account.externalAccountId)) return null;
    const candidate = await journal.candidate(ctx);
    if (candidate && candidate !== video.post_id) return null;
    await journal.record(ctx, video.post_id);
    const post = z.object({ id: z.literal(video.post_id), from: z.object({ id: z.literal(ctx.account.externalAccountId) }),
      object_id: z.literal(videoId), message: z.literal(ctx.payload.caption).optional(),
      is_published: z.literal(true), is_hidden: z.literal(false), created_time: z.string().max(100),
      permalink_url: z.string().max(2000).optional(),
    }).parse(await read(video.post_id, ctx.account.token, { fields: "id,from,object_id,message,is_published,is_hidden,created_time,permalink_url" }));
    const publishedAt = new Date(post.created_time);
    if (!Number.isFinite(publishedAt.getTime()) || publishedAt.getTime() <= 0 || publishedAt.getTime() > Date.now() + 60000) return null;
    current(signal);
    return { externalPostId: post.id, publishedAt, permalink: safeSocialPermalink(post.permalink_url, "Facebook") };
  }
  return {
    receipt,
    async publish(ctx: SubmissionContext, signal: AbortSignal) {
      current(signal);
      // Calling publish twice must not repeat any remote write, even after a lost finish response.
      if (await journal.started?.(ctx)) return null;
      const state = await transfer.inspect(ctx);
      let videoId = state.externalId;
      if (!state.started) {
        const expected = ctx.payload.video!, bytes = await transfer.read(ctx);
        if (bytes.length < 12 || bytes.length > 20 * 1024 * 1024 || bytes.length !== expected.bytes ||
            Buffer.from(bytes).toString("ascii", 4, 8) !== "ftyp" || createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
          throw Error("Approved Reel bytes changed.");
        current(signal);
        if (!await transfer.begin(ctx)) return null;
        await transfer.check(ctx);
        const started = z.object({ video_id: facebookImageId, upload_url: z.string().max(2000).optional() })
          .parse(await phase(ctx, { upload_phase: "start" }, signal));
        videoId = started.video_id;
        await transfer.record(ctx, videoId);
        // Never send a Page token or private media to a provider-supplied arbitrary URL.
        const uploadUrl = `https://rupload.facebook.com/video-upload/${config.apiVersion}/${videoId}`;
        if (started.upload_url !== undefined && started.upload_url !== uploadUrl) throw Error("Unexpected Reel upload destination.");
        await transfer.check(ctx); current(signal);
        z.object({ success: z.literal(true) }).parse(await socialJson(fetcher, uploadUrl, {
          method: "POST", headers: { Authorization: `OAuth ${ctx.account.token}`, offset: "0", file_size: String(bytes.length), "Content-Type": "application/octet-stream", Accept: "application/json" },
          body: new Uint8Array(bytes),
        }, signal));
        await transfer.uploaded(ctx, videoId);
      } else if (!state.uploaded || !videoId) {
        throw Error("Reel upload outcome requires investigation.");
      }
      facebookImageId.parse(videoId);
      await transfer.check(ctx); current(signal);
      if (!await journal.begin(ctx)) return null;
      z.object({ success: z.literal(true) }).parse(await phase(ctx, {
        upload_phase: "finish", video_id: videoId!, video_state: "PUBLISHED", description: ctx.payload.caption,
      }, signal));
      return receipt(ctx, signal);
    },
  };
}
