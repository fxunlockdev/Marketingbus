import { z } from "zod";

export const socialProvider = z.enum(["Facebook", "Instagram", "LinkedIn"]);
export type SocialProvider = z.infer<typeof socialProvider>;
export const publicationPayload = z
  .object({
    caption: z.string().min(1).max(3000),
    channel: socialProvider,
    format: z.string().min(1).max(40),
    // A private, immutable export ID, never a customer-supplied remote URL.
    mediaExportId: z.string().min(1).max(100).nullable(),
  })
  .strict();
export type PublicationPayload = z.infer<typeof publicationPayload>;
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
  })
  .strict();
export type MetricReading = z.infer<typeof metricReading>;
export type Account = {
  id: string;
  externalAccountId: string;
  token: string;
  provider: SocialProvider;
};
export type PublishOutcome =
  | { state: "published"; receipt: PublishedReceipt }
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
    signal: AbortSignal
  ): Promise<MetricReading>;
}
export type SocialAdapters = Partial<Record<SocialProvider, SocialAdapter>>;
// No mock adapter is registered in application/worker runtime. Official adapters are a separate gate.
export function configuredSocialAdapters(): SocialAdapters {
  return {};
}
