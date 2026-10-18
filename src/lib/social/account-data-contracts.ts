import { z } from "zod";
import { socialProvider, type Account, type SocialProvider } from "./contracts";
export const socialCount = z.number().int().nonnegative().safe().max(1_000_000_000_000);
const count = socialCount.nullable();
export function safeSocialPermalink(raw: string | undefined, provider: SocialProvider): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw), domains = { Facebook: ["facebook.com", "www.facebook.com", "m.facebook.com"], Instagram: ["instagram.com", "www.instagram.com"], LinkedIn: ["linkedin.com", "www.linkedin.com"] };
    if (raw.length > 2000 || url.protocol !== "https:" || !domains[provider].includes(url.hostname) || url.username || url.password || url.port || [...url.searchParams.keys()].some(k => /token|secret|code|authorization/i.test(k))) return null;
    url.hash = ""; return url.href;
  } catch { return null; }
}
export const accountSnapshot = z.object({
  provider: socialProvider, externalAccountId: z.string().min(1).max(200), observedAt: z.iso.datetime(), definitionVersion: z.string().min(1).max(100),
  profile: z.object({ name: z.string().min(1).max(120), followers: count, likes: count, mediaCount: count }).strict(),
  lifetimeOrganic: z.object({ available: z.boolean(), impressions: count, uniqueImpressions: count, clicks: count, likes: count, comments: count, shares: count }).strict(),
  posts: z.array(z.object({ externalId: z.string().min(1).max(200), text: z.string().max(5000), textTruncated: z.boolean(), publishedAt: z.iso.datetime(), permalink: z.string().max(2000).nullable(), format: z.string().min(1).max(40), likes: count, comments: count, sponsored: z.boolean().nullable() }).strict()).max(20),
  hasMore: z.boolean(),
}).strict().superRefine((snapshot, context) => {
  if (new Set(snapshot.posts.map(p => p.externalId)).size !== snapshot.posts.length) context.addIssue({ code: "custom", message: "Duplicate provider posts." });
  for (const p of snapshot.posts) if (p.permalink && safeSocialPermalink(p.permalink, snapshot.provider) !== p.permalink) context.addIssue({ code: "custom", message: "Unsafe provider link." });
  if (!snapshot.lifetimeOrganic.available && Object.entries(snapshot.lifetimeOrganic).some(([key, value]) => key !== "available" && value !== null)) context.addIssue({ code: "custom", message: "Unavailable metrics must remain null." });
});
export type AccountSnapshot = z.infer<typeof accountSnapshot>;
export const unavailableOrganic = () => ({ available: false, impressions: null, uniqueImpressions: null, clicks: null, likes: null, comments: null, shares: null });
export interface SocialDataAdapter { version: string; read(account: Account, signal: AbortSignal): Promise<AccountSnapshot>; }
export type SocialDataAdapters = Partial<Record<SocialProvider, SocialDataAdapter>>;
