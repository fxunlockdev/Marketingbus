import type { Creative } from "./content";
import type { BrandInput } from "../brand";

export const QUALITY_VERSION = "grounding-2026-10-20.1";
export type QualityContext = { facts: string; feedback?: string; previous?: Creative | null };
export function approvedFactText(brand: Pick<BrandInput, "name" | "offering" | "difference" | "proof" | "website">) {
  // Restrictions, instructions and examples are NEVER evidence for a claim.
  return [brand.name, brand.offering, brand.difference, brand.proof, brand.website].join("\n");
}
const normalize = (s: string) => s.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
const normalizeCompound = (s: string) => normalize(s).replace(/\.$/, "");
const gap = "[ \\t]+", optionalGap = "[ \\t]*";
const currency = "(?:USD|AED|GBP|EUR|INR|SAR|CAD|AUD|NZD|SGD|HKD|JPY|CNY|CHF|QAR|BHD|KWD|OMR|ZAR|[$€£¥₹])";
const amount = "[+-]?\\d+(?:[.,]\\d+)*";
const month = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\\.?";
const day = "\\d{1,2}(?:st|nd|rd|th)?";
const year = `(?:(?:${optionalGap},${optionalGap}|${gap})\\d{4})?`;
const weekday = `(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:${optionalGap},${optionalGap}|${gap}))?`;
// Whole spans, not independently matching their components. Horizontal whitespace
// only: one brand field ending in "USD" must not join the next field's "100".
const compounds = [
  new RegExp(`(?<![\\p{L}\\p{N}])[+-]?${currency}${optionalGap}${amount}(?![\\p{L}\\p{N}]|[.,]\\d)`, "giu"),
  new RegExp(`(?<![\\p{L}\\p{N}])${amount}${optionalGap}${currency}(?![\\p{L}\\p{N}_-])`, "giu"),
  new RegExp(`(?<![\\p{L}\\p{N}])${weekday}${month}${gap}${day}${year}(?![\\p{L}\\p{N}])`, "giu"),
  new RegExp(`(?<![\\p{L}\\p{N}])${weekday}${day}${gap}${month}${year}(?![\\p{L}\\p{N}])`, "giu"),
];
const risks = [
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi,
  /\b(?:today|tomorrow|tonight|this weekend|next weekend|this week|next week)\b/gi,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
  /\b\d+(?:[.,:/-]\d+)*(?:st|nd|rd|th)?(?:\s?(?:%|percent|am|pm|aed|usd|gbp|eur))?/gi,
  /(?:https?:\/\/|www\.)[^\s)]+/gi,
  /\b(?:guaranteed|guarantee|award-winning|clinically proven|certified|best-selling|number one|no\. 1)\b/gi,
];
/** Conservative lexical guard, NOT semantic entailment or a guarantee of factual accuracy. */
export function evaluateCreative(content: Creative, context: QualityContext) {
  const text = [content.headline, content.caption, content.cta].join("\n").normalize("NFKC");
  const facts = normalize(context.facts);
  const defects: { code: string; detail: string }[] = [];
  for (const pattern of compounds) {
    const supported = new Set([...context.facts.normalize("NFKC").matchAll(pattern)].map(match => normalizeCompound(match[0])));
    for (const match of text.matchAll(pattern)) if (!supported.has(normalizeCompound(match[0]))) {
      defects.push({ code: "UNSUPPORTED_SPECIFIC", detail: `Confirm the complete price or date, or remove: ${match[0]}` });
    }
  }
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
    humanReviewRequired: true, limits: "Lexical date/number/claim checks, contiguous currency/date evidence and explicit revision rules; not semantic fact verification or agency-quality certification." };
}
