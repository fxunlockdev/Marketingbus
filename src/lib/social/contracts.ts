import { z } from "zod";
import { createLinkedInPublishingAdapter } from "./linkedin-publishing";
import { createFacebookPublishingAdapter } from "./facebook-publishing";
import { createInstagramPublishingAdapter } from "./instagram-publishing";
import { metaEnvironment } from "./meta-oauth";

export const socialProvider = z.enum(["Facebook", "Instagram", "LinkedIn"]);
export type SocialProvider = z.infer<typeof socialProvider>;
export const publicationImage = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(1).max(5 * 1024 * 1024),
  width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096),
  // Derived from the approved headline, not unreviewed new claims.
  altText: z.string().min(1).max(160),
}).strict();
export const publicationVideo = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(20 * 1024 * 1024),
  width: z.literal(720), height: z.literal(1280), durationMs: z.number().int().min(3000).max(30000),
  shareToFeed: z.boolean(),
}).strict();
export const publicationPayload = z
  .object({
    caption: z.string().min(1).max(3000),
    channel: socialProvider,
    format: z.string().min(1).max(40),
    // A private, immutable export ID, never a customer-supplied remote URL.
    mediaExportId: z.string().min(1).max(100).nullable(),
    image: publicationImage.optional(),
    video: publicationVideo.optional(),
  })
  .strict().refine(p => p.mediaExportId === null ? p.image === undefined && p.video === undefined :
    !!p.image && !p.video && p.format === "static" || !!p.video && !p.image && p.format === "video" && ["Instagram", "Facebook"].includes(p.channel), "Unsupported media binding")
  .refine(p => p.channel !== "Facebook" || !p.video || p.video.durationMs >= 4000 && !p.video.shareToFeed, "Facebook Reels require at least four seconds and cannot use Instagram feed placement.")
  .refine(p => p.channel !== "Facebook" || !p.image || p.image.bytes <= 4 * 1024 * 1024, "Facebook image exports must be 4 MB or smaller.")
  .refine(p => p.channel !== "Instagram" || p.caption.length <= 2200 && (!!p.video || p.image?.width === 1080 && [1080, 1350].includes(p.image.height)), "Instagram requires an approved image or Reel and a caption of 2,200 characters or fewer.");
export type PublicationPayload = z.infer<typeof publicationPayload>;
export function reelPublishingEnabled(provider: string) {
  return provider === "Instagram" ? process.env.INSTAGRAM_REELS_ENABLED === "true" : provider === "Facebook" && process.env.FACEBOOK_REELS_ENABLED === "true";
}
export const publishedReceipt = z
  .object({
    externalPostId: z.string().min(1).max(500),
    permalink: z.url().max(2000).nullable(),
    publishedAt: z.coerce.date(),
  })
  .strict();
export type PublishedReceipt = z.infer<typeof publishedReceipt>;
const metric = z.number().int().nonnegative().max(2_147_483_647).nullable();
export const metricReading = z
  .object({
    observedAt: z.coerce.date(),
    definitionVersion: z.string().min(1).max(100),
    impressions: metric,
    reach: metric,
    engagements: metric,
    clicks: metric,
    videoViews: metric,
    // Optional for existing providers; stored as NULL when unsupported, never renamed impressions.
    views: metric.optional(),
    uniqueViewers: metric.optional(),
    reactions: metric.optional(),
  })
  .strict();
export type MetricReading = z.infer<typeof metricReading>;
// Metrics describe this immutable creative, not whichever text happens to be at its URL now.
export const metricSubject = z.object({ payload: publicationPayload, publishedAt: z.date(), mediaExternalId: z.string().min(1).max(220).optional() }).strict()
  .refine(s => !s.mediaExternalId || (!!s.payload.image || s.payload.channel === "Instagram" && !!s.payload.video) && (s.payload.channel === "LinkedIn" ? /^urn:li:image:[A-Za-z0-9_-]{1,200}$/.test(s.mediaExternalId) : /^[1-9][0-9]{0,39}$/.test(s.mediaExternalId)), "Invalid provider media identity");
export type MetricSubject = z.infer<typeof metricSubject>;
export class MetricSourceChangedError extends Error {
  constructor() { super("Published creative changed; metrics cannot be attributed to the approved version."); }
}
export type Account = {
  id: string;
  externalAccountId: string;
  token: string;
  provider: SocialProvider;
};
export type PublishOutcome =
  | { state: "published"; receipt: PublishedReceipt }
  | { state: "processing"; retryAfterSeconds: number }
  | {
      state: "retryable";
      code: "RATE_LIMIT" | "PROVIDER_UNAVAILABLE";
      retryAfterSeconds: number;
    }
  | {
      state: "failed";
      code: "TOKEN_REVOKED" | "INVALID_MEDIA" | "PERMISSION_DENIED";
    }
  | { state: "uncertain" };
export interface SocialAdapter {
  imagePublishingAvailable?: boolean;
  videoPublishingAvailable?: boolean;
  // False means no certified mapping: do not schedule polling or fabricate empty observations.
  metricsAvailable?: boolean;
  // Video needs its own verified mapping; an image capability never opts it in.
  videoMetricsAvailable?: boolean;
  // Must honor aborts and bound response size. Retryable means definitively NOT submitted.
  publish(
    account: Account,
    payload: PublicationPayload,
    idempotencyKey: string,
    signal: AbortSignal
  ): Promise<PublishOutcome>;
  // Never create content here. Search/lookup only; unavailable lookup means uncertain.
  reconcile(
    account: Account,
    idempotencyKey: string,
    payload: PublicationPayload,
    signal: AbortSignal
  ): Promise<PublishedReceipt | null>;
  metrics(
    account: Account,
    externalPostId: string,
    signal: AbortSignal,
    subject: MetricSubject
  ): Promise<MetricReading>;
}
export type SocialAdapters = Partial<Record<SocialProvider, SocialAdapter>>;
export function supportsPublicationMetrics(adapter: SocialAdapter | undefined, payload: PublicationPayload) {
  return !!adapter && (payload.video ? adapter.videoMetricsAvailable === true : adapter.metricsAvailable !== false);
}
// No mock adapter is registered in application/worker runtime. Official adapters are a separate gate.
export function configuredSocialAdapters(): SocialAdapters {
  if (process.env.SOCIAL_EXECUTION_ENABLED !== "true") return {};
  const result: SocialAdapters = {};
  if (process.env.LINKEDIN_PUBLISHING_ENABLED === "true" && process.env.LINKEDIN_CONNECTIONS_ENABLED === "true") {
    try { result.LinkedIn = createLinkedInPublishingAdapter({ clientId: process.env.LINKEDIN_CLIENT_ID || "", clientSecret: process.env.LINKEDIN_CLIENT_SECRET || "", apiVersion: process.env.LINKEDIN_API_VERSION || "", verifiedUntil: process.env.LINKEDIN_API_VERIFIED_UNTIL || "" }); } catch { /* Disabled until completely configured/current. */ }
  }
  if (process.env.FACEBOOK_PUBLISHING_ENABLED === "true" && process.env.FACEBOOK_CONNECTIONS_ENABLED === "true") {
    try { result.Facebook = createFacebookPublishingAdapter(metaEnvironment()); } catch { /* Disabled until completely configured/current. */ }
  }
  if (process.env.INSTAGRAM_PUBLISHING_ENABLED === "true" && process.env.INSTAGRAM_CONNECTIONS_ENABLED === "true") {
    try { result.Instagram = createInstagramPublishingAdapter(metaEnvironment()); } catch { /* Requires current Meta configuration and an HTTPS delivery origin. */ }
  }
  return result;
}
