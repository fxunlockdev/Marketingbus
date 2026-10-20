import type { Evidence } from "./grounding";

// Shared with the review UI; keep this module free of server credentials/imports.
export const ANALYSIS_EVIDENCE_BYTES = 24000;
export const ANALYSIS_EVIDENCE_VERSION = "source-prefix-v1";
const encoder = new TextEncoder();

export function boundedAnalysisEvidence(sources: Evidence[]): Evidence[] {
  if (!sources.length || sources.length > 3 || new Set(sources.map(s => s.id)).size !== sources.length) {
    throw Error("Choose one to three different sources.");
  }
  const sized = sources.map(source => ({ source, bytes: encoder.encode(source.body).length }));
  if (sized.some(s => s.bytes > 80000)) throw Error("An imported source exceeds the supported page size.");
  // Small documents keep all their text. Divide the remaining allowance fairly
  // between larger sources, independently of caller/selection order.
  sized.sort((a, b) => a.bytes - b.bytes || compareId(a.source.id, b.source.id));
  let remaining = ANALYSIS_EVIDENCE_BYTES;
  const result = sized.map(({ source, bytes }, index) => {
    const allowance = Math.min(bytes, Math.floor(remaining / (sized.length - index)));
    remaining -= allowance;
    if (bytes <= allowance) return { ...source };
    let used = 0, end = 0;
    for (const character of source.body) {
      const size = encoder.encode(character).length;
      if (used + size > allowance) break;
      used += size; end += character.length;
    }
    // A single contiguous prefix, never stitched passages or replacement text.
    // sha256 continues to bind the complete stored source, including unread text.
    return { ...source, body: source.body.slice(0, end) };
  });
  return result.sort((a, b) => compareId(a.id, b.id));
}

function compareId(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
