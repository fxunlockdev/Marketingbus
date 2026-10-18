import type { SocialProvider } from "./contracts";

// Keep this helper free of runtime registry imports: adapters use it during read-back.
export function safeSocialPermalink(raw: string | undefined, provider: SocialProvider): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw), domains = { Facebook: ["facebook.com", "www.facebook.com", "m.facebook.com"], Instagram: ["instagram.com", "www.instagram.com"], LinkedIn: ["linkedin.com", "www.linkedin.com"] };
    if (raw.length > 2000 || url.protocol !== "https:" || !domains[provider].includes(url.hostname) || url.username || url.password || url.port || [...url.searchParams.keys()].some(k => /token|secret|code|authorization/i.test(k))) return null;
    url.hash = ""; return url.href;
  } catch { return null; }
}
