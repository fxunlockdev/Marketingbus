import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { assetStore, type AssetStore } from "../assets/storage";
import { lockBusiness } from "../production/service";
import { frozenCopy } from "./integrity";
import { assertPublicationMedia } from "./image-transfer";
import { withSubmissionContext, type SubmissionContext } from "./submission-journal";
import { fingerprint, instagramJpeg, instagramJpegVersion, type InstagramJpeg } from "./instagram-jpeg";
import { instagramVideo, instagramVideoVersion, type InstagramVideo } from "./instagram-video";
import { MAX_VIDEO_BYTES } from "../video/limits";

const TTL_MS = 15 * 60_000, MAX_READS = 12;
let activeDeliveries = 0;
const unavailable = () => Error("Media delivery is unavailable.");
export function instagramDeliveryOrigin(raw = process.env.APP_ORIGIN || "") {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname)) throw unavailable();
  return url.origin;
}
export function instagramDeliveryEnabled() {
  return process.env.SOCIAL_EXECUTION_ENABLED === "true" && process.env.INSTAGRAM_CONNECTIONS_ENABLED === "true" && process.env.INSTAGRAM_PUBLISHING_ENABLED === "true";
}
export interface InstagramDelivery { issue(context: SubmissionContext, jpeg: InstagramJpeg | InstagramVideo): Promise<string> }
export function createInstagramDelivery(origin = instagramDeliveryOrigin()): InstagramDelivery {
  const base = instagramDeliveryOrigin(origin);
  return { issue: async (ctx, jpeg) => {
    const video = !!ctx.payload.video;
    if (!instagramDeliveryEnabled() || ctx.account.provider !== "Instagram" ||
        video && process.env.INSTAGRAM_REELS_ENABLED !== "true" || jpeg.version !== (video ? instagramVideoVersion : instagramJpegVersion) ||
        fingerprint(jpeg.bytes) !== jpeg.sha256 || !jpeg.bytes.length || jpeg.bytes.length > (video ? MAX_VIDEO_BYTES : 4 * 1024 * 1024)) throw unavailable();
    const token = randomBytes(32).toString("hex");
    await withSubmissionContext(ctx, async (tx, post) => {
      if (post.status !== "SUBMITTING" || !post.leaseUntil || post.leaseUntil <= new Date() || post.submissionAdapterVersion || post.mediaTransferVersion !== ctx.adapterVersion || post.mediaDeliveryTokenHash || post.mediaExternalId) throw unavailable();
      await assertPublicationMedia(tx, { ...post, actorId: "instagram-delivery" }, post.revisionId, ctx.payload);
      if (video && (jpeg.sha256 !== ctx.payload.video!.sha256 || jpeg.bytes.length !== ctx.payload.video!.bytes)) throw unavailable();
      await tx.socialPublication.update({ where: { id: post.id }, data: {
        mediaDeliveryTokenHash: fingerprint(Buffer.from(token)), mediaDeliveryExpiresAt: new Date(Date.now() + TTL_MS),
        mediaDeliverySha256: jpeg.sha256, mediaDeliveryBytes: jpeg.bytes.length, mediaDeliveryVersion: jpeg.version,
        mediaDeliveryAuthorizationVersion: post.connection.authorizationVersion,
      } });
    });
    // Raw capability is returned once, never persisted. No bucket URL or provider token.
    return `${base}/api/social/media/${encodeURIComponent(ctx.requestId)}/${token}`;
  } };
}

async function current(tx: Prisma.TransactionClient, id: string, token: string, reserve: boolean) {
  if (!instagramDeliveryEnabled()) throw unavailable();
  const first = await tx.socialPublication.findUnique({ where: { id }, select: { businessId: true, organizationId: true } });
  if (!first) throw unavailable();
  await lockBusiness(tx, { ...first, actorId: "instagram-delivery" });
  const post = await tx.socialPublication.findUniqueOrThrow({ where: { id }, include: { connection: true } });
  const c = post.connection;
  if (!post.mediaDeliveryTokenHash || !timingSafeEqual(Buffer.from(post.mediaDeliveryTokenHash, "hex"), Buffer.from(fingerprint(Buffer.from(token)), "hex")) ||
      !post.mediaDeliveryExpiresAt || post.mediaDeliveryExpiresAt <= new Date() ||
      !["SUBMITTING", "SCHEDULED"].includes(post.status) || post.submissionAdapterVersion || post.candidatePostId ||
      (post.status === "SUBMITTING" && (!post.leaseUntil || post.leaseUntil <= new Date())) ||
      c.provider !== "Instagram" || c.status !== "CONNECTED" || !c.expiresAt || c.expiresAt <= new Date() ||
      c.authorizationVersion !== post.mediaDeliveryAuthorizationVersion || (reserve && post.mediaDeliveryReads >= MAX_READS)) throw unavailable();
  const payload = frozenCopy(post.payload, post.payloadHash, c.provider);
  if (post.mediaDeliveryVersion !== (payload.video ? instagramVideoVersion : instagramJpegVersion) || payload.video && process.env.INSTAGRAM_REELS_ENABLED !== "true") throw unavailable();
  const row = await assertPublicationMedia(tx, { ...first, actorId: "instagram-delivery" }, post.revisionId, payload);
  if (reserve) await tx.socialPublication.update({ where: { id }, data: { mediaDeliveryReads: { increment: 1 } } });
  return { post, row, payload };
}
// This deliberately uses a scoped capability instead of login cookies. Meta fetches server-to-server.
export async function readInstagramMediaDelivery(id: string, token: string, store: () => AssetStore = () => assetStore(MAX_VIDEO_BYTES), head = false) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !/^[a-f0-9]{64}$/.test(token) || !instagramDeliveryEnabled() || activeDeliveries >= 8) throw unavailable();
  activeDeliveries++;
  try {
    const first = await db.$transaction(tx => current(tx, id, token, true));
    if (head) {
      if (!first.payload.video) throw unavailable();
      if (first.post.mediaDeliverySha256 !== first.payload.video.sha256 || first.post.mediaDeliveryBytes !== first.payload.video.bytes) throw unavailable();
      return { bytes: null, length: first.payload.video.bytes, contentType: "video/mp4" as const };
    }
    const source = await store().get(first.row.objectKey);
    const jpeg = first.payload.video ? instagramVideo(source, first.payload.video) : await instagramJpeg(source, first.payload.image!);
    if (jpeg.sha256 !== first.post.mediaDeliverySha256 || jpeg.bytes.length !== first.post.mediaDeliveryBytes) throw unavailable();
    // No storage/CPU work while holding the business lock; recheck revocations before returning bytes.
    const last = await db.$transaction(tx => current(tx, id, token, false));
    if (last.post.mediaDeliverySha256 !== jpeg.sha256 || last.post.mediaDeliveryBytes !== jpeg.bytes.length) throw unavailable();
    return { bytes: jpeg.bytes, length: jpeg.bytes.length, contentType: first.payload.video ? "video/mp4" as const : "image/jpeg" as const };
  } finally { activeDeliveries--; }
}
export async function readInstagramDelivery(id: string, token: string, store?: () => AssetStore) {
  return (await readInstagramMediaDelivery(id, token, store)).bytes!;
}
export const mediaDeliveryHeaders = {
  "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};
