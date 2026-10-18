import { z } from "zod";
import { linkedInImageId, type SocialImageTransfer } from "./image-transfer";
import type { SubmissionContext } from "./submission-journal";
import { socialJson } from "./provider-http";
import type { PublishOutcome } from "./contracts";

// Deliberately narrower than arbitrary provider URLs: never forward an OAuth token to a CDN,
// redirect, customer URL, alternate port or a hostname merely ending in "linkedin.com".
export function linkedInUploadUrl(raw: string, id: string) {
  const url = new URL(raw), key = linkedInImageId.parse(id).slice("urn:li:image:".length);
  if (url.protocol !== "https:" || url.hostname !== "www.linkedin.com" || url.port || url.username || url.password || url.hash ||
    url.pathname !== `/dms-uploads/${key}/uploaded-image/0` || raw.length > 8000) throw Error("Unsupported LinkedIn image upload destination.");
  return url.href;
}
export async function prepareLinkedInImage(context: SubmissionContext, signal: AbortSignal, fetcher: typeof fetch, transfer: SocialImageTransfer, headers: Record<string, string>): Promise<{ id: string } | { outcome: PublishOutcome }> {
  const state = await transfer.inspect(context);
  let id = state.externalId;
  if (!state.started) {
    const bytes = await transfer.read(context);
    signal.throwIfAborted();
    if (!await transfer.begin(context)) return { outcome: { state: "uncertain" } };
    const result = z.object({ value: z.object({ image: linkedInImageId, uploadUrl: z.string().max(8000), uploadUrlExpiresAt: z.number().int().positive().safe() }) }).parse(await socialJson(fetcher, "https://api.linkedin.com/rest/images?action=initializeUpload", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ initializeUploadRequest: { owner: context.account.externalAccountId } }),
    }, signal));
    id = result.value.image;
    const url = linkedInUploadUrl(result.value.uploadUrl, id);
    if (result.value.uploadUrlExpiresAt <= Date.now() + 30000) throw Error("Image upload URL expires too soon.");
    // Record the exact remote asset before attempting the one binary upload. Never persist its URL.
    await transfer.record(context, id);
    await transfer.check(context);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]); bounded.throwIfAborted();
    const response = await fetcher(url, { method: "PUT", headers: { Authorization: headers.Authorization, "Content-Type": "image/png" }, body: new Uint8Array(bytes), signal: bounded, redirect: "error", cache: "no-store", credentials: "omit" });
    await response.body?.cancel().catch(() => {});
    if (![200, 201, 204].includes(response.status)) throw Error("Image upload acknowledgement unavailable.");
    await transfer.uploaded(context, id);
  } else if (!id || !state.uploaded) {
    // An interrupted registration/upload never authorizes another registration or upload.
    return { outcome: { state: "uncertain" } };
  }
  linkedInImageId.parse(id);
  await transfer.check(context);
  const result = z.object({ id: z.literal(id!), owner: z.literal(context.account.externalAccountId), status: z.enum(["WAITING_UPLOAD", "PROCESSING", "AVAILABLE", "PROCESSING_FAILED"]) }).parse(await socialJson(fetcher, `https://api.linkedin.com/rest/images/${encodeURIComponent(id!)}`, { headers }, signal));
  if (result.status === "PROCESSING" || result.status === "WAITING_UPLOAD") return { outcome: { state: "retryable", code: "PROVIDER_UNAVAILABLE", retryAfterSeconds: 60 } };
  if (result.status === "PROCESSING_FAILED") return { outcome: { state: "failed", code: "INVALID_MEDIA" } };
  await transfer.check(context);
  return { id: id! };
}
