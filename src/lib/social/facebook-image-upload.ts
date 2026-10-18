import { createHmac } from "node:crypto";
import { z } from "zod";
import { facebookImageId, type SocialImageTransfer } from "./image-transfer";
import { assertMetaFresh, metaClient, type MetaSettings } from "./meta-oauth";
import type { SubmissionContext } from "./submission-journal";
import { socialJson } from "./provider-http";

export async function readFacebookImage(context: SubmissionContext, id: string, signal: AbortSignal, config: MetaSettings, fetcher: typeof fetch) {
  facebookImageId.parse(id);
  if (!context.payload.image) throw Error("Approved image binding required.");
  z.object({ id: z.literal(id), from: z.object({ id: z.literal(context.account.externalAccountId) }), alt_text_custom: z.literal(context.payload.image.altText) })
    .parse(await metaClient(config, fetcher, signal)(id, context.account.token, { fields: "id,from,alt_text_custom" }));
}

export async function prepareFacebookImage(context: SubmissionContext, signal: AbortSignal, config: MetaSettings, fetcher: typeof fetch, transfer: SocialImageTransfer): Promise<string> {
  const state = await transfer.inspect(context);
  let id = state.externalId;
  if (!state.started) {
    const bytes = await transfer.read(context);
    signal.throwIfAborted(); assertMetaFresh(config);
    if (!await transfer.begin(context)) throw Error("Image upload already attempted.");
    const body = new FormData();
    body.set("source", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "approved-image.png");
    body.set("published", "false");
    body.set("alt_text_custom", context.payload.image!.altText);
    body.set("appsecret_proof", createHmac("sha256", config.appSecret).update(context.account.token).digest("hex"));
    await transfer.check(context);
    // One fixed-host multipart write. No public URL, remote scheduling, caption or CDN credentials.
    const result = z.object({ id: facebookImageId, post_id: z.unknown().optional() }).parse(await socialJson(fetcher,
      `https://graph.facebook.com/${config.apiVersion}/${context.account.externalAccountId}/photos`, {
        method: "POST", headers: { Authorization: `Bearer ${context.account.token}`, Accept: "application/json" }, body,
      }, signal));
    id = result.id;
    await transfer.record(context, id);
    if (result.post_id !== undefined) throw Error("Unexpected published photo response requires investigation.");
    await transfer.uploaded(context, id);
  } else if (!id || !state.uploaded) {
    // Lost upload/acknowledgement never grants a second upload, even when no post was attempted.
    throw Error("Image upload outcome requires investigation.");
  }
  facebookImageId.parse(id);
  await transfer.check(context);
  await readFacebookImage(context, id!, signal, config, fetcher);
  await transfer.check(context);
  return id!;
}
