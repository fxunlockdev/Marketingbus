import { AppError } from "../http";

export type WebsiteScraper = "firecrawl" | "crawl4ai";
export function websiteScraper(): WebsiteScraper {
  const value = process.env.WEBSITE_SCRAPER || "firecrawl";
  if (value !== "firecrawl" && value !== "crawl4ai") throw new AppError(503, "Invalid scraper configuration.");
  return value;
}
export function scraperBase(provider = websiteScraper()) {
  const prefix = provider === "crawl4ai" ? "CRAWL4AI" : "FIRECRAWL";
  const value = process.env[`${prefix}_SELF_HOSTED_URL`];
  if (process.env.WEBSITE_EXTRACTION_ENABLED !== "true" || !value) throw new AppError(503, "Website reading is not configured yet. You can upload a document instead.");
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(503, "Invalid scraper configuration."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !["http:", "https:"].includes(url.protocol)) throw new AppError(503, "Invalid scraper configuration.");
  if (!url.hostname.endsWith(".railway.internal") && !(process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new AppError(503, "The scraper must use its private service address.");
  // Initial DNS validation is not isolation: redirects, subresources and DNS rebinding also need enforcement.
  if (process.env[`${prefix}_EGRESS_RESTRICTED`] !== "true") throw new AppError(503, "Scraper network isolation must be verified before importing websites.");
  return url;
}
