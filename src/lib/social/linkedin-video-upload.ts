import { createHash } from "node:crypto";
import { z } from "zod";
import { linkedInVideoId, type SocialImageTransfer } from "./image-transfer";
import type { SubmissionContext } from "./submission-journal";
import { reelPublishingEnabled, type PublishOutcome } from "./contracts";
import { socialJson } from "./provider-http";

const PART_BYTES = 4 * 1024 * 1024;
const instruction = z.object({ firstByte: z.number().int().nonnegative(), lastByte: z.number().int().nonnegative(), uploadUrl: z.string().max(8000) });
export function linkedInVideoUploadUrl(raw: string, id: string) {
  const url = new URL(raw), key = linkedInVideoId.parse(id).slice("urn:li:video:".length);
  if (raw.length > 8000 || url.protocol !== "https:" || url.hostname !== "www.linkedin.com" || url.port || url.username || url.password || url.hash || url.pathname !== `/dms-uploads/${key}/uploadedVideo`)
    throw Error("Unsupported LinkedIn video upload destination.");
  return url.href;
}
const current = (signal: AbortSignal) => {
  signal.throwIfAborted();
  if (!reelPublishingEnabled("LinkedIn")) throw Error("LinkedIn video publishing is paused.");
};

// Registration is durably fenced before any remote write. The short-lived upload
// URLs/token and part acknowledgements stay in memory, never in logs or customer data.
// Interrupted uploads are held, not blindly restarted. Acknowledged finalization
// may be polled using only the durable video ID; publication has a separate fence.
export async function prepareLinkedInVideo(ctx: SubmissionContext, signal: AbortSignal, fetcher: typeof fetch, transfer: SocialImageTransfer, headers: Record<string, string>): Promise<{ id: string } | { outcome: PublishOutcome }> {
  current(signal);
  const state = await transfer.inspect(ctx), expected = ctx.payload.video!;
  let id = state.externalId;
  if (!state.started) {
    const bytes = await transfer.read(ctx);
    if (bytes.length !== expected.bytes || bytes.length < 75 * 1024 || bytes.length > 20 * 1024 * 1024 || Buffer.from(bytes).toString("ascii", 4, 8) !== "ftyp" || createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
      throw Error("Approved video bytes changed.");
    current(signal);
    if (!await transfer.begin(ctx)) return { outcome: { state: "uncertain" } };
    await transfer.check(ctx);
    const { value } = z.object({ value: z.object({ video: linkedInVideoId, uploadToken: z.string().max(8000), uploadUrlsExpireAt: z.number().int().positive().safe(), uploadInstructions: z.array(instruction).min(1).max(5) }) }).parse(await socialJson(fetcher, "https://api.linkedin.com/rest/videos?action=initializeUpload", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ initializeUploadRequest: { owner: ctx.account.externalAccountId, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } }),
    }, signal));
    id = value.video;
    await transfer.record(ctx, id);
    let offset = 0;
    const parts = value.uploadInstructions.map(part => {
      if (part.firstByte !== offset || part.lastByte < part.firstByte || part.lastByte >= bytes.length || part.lastByte - part.firstByte + 1 > PART_BYTES) throw Error("Invalid video part boundaries.");
      offset = part.lastByte + 1;
      return { ...part, uploadUrl: linkedInVideoUploadUrl(part.uploadUrl, id!) };
    });
    if (offset !== bytes.length) throw Error("Incomplete video part boundaries.");
    const uploadedPartIds: string[] = [];
    for (const part of parts) {
      current(signal); await transfer.check(ctx);
      if (value.uploadUrlsExpireAt <= Date.now() + 30000) throw Error("Video upload URL expires too soon.");
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]); bounded.throwIfAborted();
      // Signed upload URL supplies its own authority. Never forward the OAuth token.
      const response = await fetcher(part.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes.slice(part.firstByte, part.lastByte + 1)), signal: bounded, redirect: "error", cache: "no-store", credentials: "omit" });
      const etag = response.headers.get("etag");
      await response.body?.cancel().catch(() => {});
      if (response.status !== 200 || !etag || etag.length > 8000 || /[\x00-\x20\x7f]/.test(etag) || etag.startsWith("W/")) throw Error("Video part acknowledgement unavailable.");
      const partId = etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
      if (!partId || partId.includes('"') || uploadedPartIds.includes(partId)) throw Error("Invalid video part acknowledgement.");
      uploadedPartIds.push(partId);
    }
    current(signal); await transfer.check(ctx);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]); bounded.throwIfAborted();
    const response = await fetcher("https://api.linkedin.com/rest/videos?action=finalizeUpload", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ finalizeUploadRequest: { video: id, uploadToken: value.uploadToken, uploadedPartIds } }), signal: bounded, redirect: "error", cache: "no-store", credentials: "omit" });
    await response.body?.cancel().catch(() => {});
    if (response.status !== 200) throw Error("Video finalization acknowledgement unavailable.");
    await transfer.uploaded(ctx, id);
  } else if (!id || !state.uploaded) return { outcome: { state: "uncertain" } };
  linkedInVideoId.parse(id); current(signal); await transfer.check(ctx);
  const video = z.object({ id: z.literal(id!), owner: z.literal(ctx.account.externalAccountId), status: z.enum(["WAITING_UPLOAD", "PROCESSING", "AVAILABLE", "PROCESSING_FAILED"]), duration: z.number().positive().nullish(), aspectRatioWidth: z.number().positive().nullish(), aspectRatioHeight: z.number().positive().nullish() }).parse(await socialJson(fetcher, `https://api.linkedin.com/rest/videos/${encodeURIComponent(id!)}`, { headers }, signal));
  if (video.status === "WAITING_UPLOAD" || video.status === "PROCESSING") return { outcome: { state: "processing", retryAfterSeconds: 60 } };
  if (video.status === "PROCESSING_FAILED") return { outcome: { state: "failed", code: "INVALID_MEDIA" } };
  if (video.duration == null || Math.abs(video.duration - expected.durationMs) > 100 || !video.aspectRatioWidth || !video.aspectRatioHeight || Math.abs(video.aspectRatioWidth / video.aspectRatioHeight - expected.width / expected.height) > 0.01)
    throw Error("Processed video metadata differs from the approved export.");
  current(signal); await transfer.check(ctx);
  return { id: id! };
}
