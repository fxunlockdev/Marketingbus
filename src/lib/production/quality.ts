import type { Creative } from "./content";
import type { BrandInput } from "../brand";

export const QUALITY_VERSION = "grounding-2026-10-14.2";
export type QualityContext = { facts: string; feedback?: string; previous?: Creative | null };
export function approvedFactText(brand: Pick<BrandInput, "name" | "offering" | "difference" | "proof" | "website">) {
  // Restrictions, instructions and examples are NEVER evidence for a claim.
  return [brand.name, brand.offering, brand.difference, brand.proof, brand.website].join("\n");
}
const normalize = (s: string) => s.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
const risks = [
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi,
  /\b(?:today|tomorrow|tonight|this weekend|next weekend|this week|next week)\b/gi,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
  /\b\d+(?:[.,:/-]\d+)*(?:\s?(?:%|percent|am|pm|aed|usd|gbp|eur))?/gi,
  /(?:https?:\/\/|www\.)[^\s)]+/gi,
  /\b(?:guaranteed|guarantee|award-winning|clinically proven|certified|best-selling|number one|no\. 1)\b/gi,
];
/** Conservative lexical guard, NOT semantic entailment or a guarantee of factual accuracy. */
export function evaluateCreative(content: Creative, context: QualityContext) {
  const text = [content.headline, content.caption, content.cta].join("\n");
  const facts = normalize(context.facts);
  const defects: { code: string; detail: string }[] = [];
  for (const pattern of risks) for (const match of text.matchAll(pattern)) {
    const phrase = normalize(match[0]);
    // Boundary matching prevents 10 from being "supported" by 100.
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(facts)) {
      defects.push({ code: "UNSUPPORTED_SPECIFIC", detail: `Confirm or remove: ${match[0]}` });
    }
  }
  const feedback = normalize(context.feedback || "");
  if (/\b(?:no|avoid|remove|without) hashtags\b/.test(feedback) && /#[\p{L}\p{N}_]/u.test(content.caption)) defects.push({ code: "REVISION_HASHTAGS", detail: "Requested removal of hashtags was not followed." });
  if (/\b(?:shorter|shorten)\b/.test(feedback) && context.previous && content.caption.length >= context.previous.caption.length) defects.push({ code: "REVISION_LENGTH", detail: "Requested shorter caption was not delivered." });
  const opening = (context.feedback || "").match(/(?:start|open|begin|lead)\s+(?:(?:the\s+)?caption\s+)?with\s+["“]([^"”]{1,120})["”]/i)?.[1];
  if (opening && !normalize(content.caption).startsWith(normalize(opening))) defects.push({ code: "REVISION_OPENING", detail: "Caption does not begin with the requested exact opening." });
  return { version: QUALITY_VERSION, eligible: defects.length === 0, defects: [...new Map(defects.map(d => [d.code + d.detail, d])).values()],
    humanReviewRequired: true, limits: "Lexical date/number/claim checks and explicit revision rules; not semantic fact verification or agency-quality certification." };
}
