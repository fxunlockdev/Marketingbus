import { describe, expect, it } from "vitest";
import { boundedAnalysisEvidence, ANALYSIS_EVIDENCE_BYTES } from "../src/lib/knowledge/analysis-evidence";
import { validateSuggestions } from "../src/lib/knowledge/grounding";

const source = (id: string, body: string) => ({ id, body, title: id, sha256: "a".repeat(64) });
const bytes = (text: string) => new TextEncoder().encode(text).length;
describe("bounded brand evidence", () => {
  it("preserves small sources and canonicalizes order without mutating the originals", () => {
    const sources = [source("b", "A short document."), source("a", "Another document.")];
    expect(boundedAnalysisEvidence(sources)).toEqual([sources[1], sources[0]]);
    expect(sources.map(s => s.id)).toEqual(["b", "a"]);
  });
  it("uses the same bounded prefix for long pages regardless of selection order", () => {
    const sources = [source("b", "B".repeat(80000)), source("a", "A".repeat(80000)), source("c", "Short source.")];
    const result = boundedAnalysisEvidence(sources);
    expect(result).toEqual(boundedAnalysisEvidence([...sources].reverse()));
    expect(result.reduce((n, s) => n + bytes(s.body), 0)).toBe(ANALYSIS_EVIDENCE_BYTES);
    expect(result[0].body.length).toBe(11993);
    expect(result[1].body.length).toBe(11994);
    expect(result[2]).toEqual(sources[2]);
    for (const s of result) {
      const original = sources.find(o => o.id === s.id)!;
      expect(original.body.startsWith(s.body)).toBe(true);
      expect(s.sha256).toBe(original.sha256);
    }
  });
  it.each(["🙂", "商", "e\u0301", "𠮷"])("never splits UTF-8 code points for %s", character => {
    const sources = [source("a", character.repeat(Math.floor(79000 / bytes(character)))), source("b", "A".repeat(79999))];
    const result = boundedAnalysisEvidence(sources);
    expect(result.reduce((n, s) => n + bytes(s.body), 0)).toBeLessThanOrEqual(24000);
    for (const s of result) {
      expect(s.body).not.toContain("\uFFFD");
      expect(sources.find(o => o.id === s.id)!.body.startsWith(s.body)).toBe(true);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(s.body))).toBe(s.body);
    }
  });
  it("bounds each source, source count and duplicate identity", () => {
    for (const sources of [[], [source("a", "a".repeat(80001))], [source("a", "a"), source("a", "b")], ["a", "b", "c", "d"].map(id => source(id, id))]) {
      expect(() => boundedAnalysisEvidence(sources)).toThrow();
    }
  });
  it("rejects a citation present only in the unread part of a long source", () => {
    const quote = "This statement is outside the analyzed excerpt.";
    const sources = boundedAnalysisEvidence([source("a", "x".repeat(24000) + quote)]);
    const suggestion = { field: "offering", kind: "EXACT_EXCERPT", value: quote, reason: "An invented unseen citation.", citations: [{ sourceId: "a", sha256: "a".repeat(64), excerpt: quote }] };
    expect(() => validateSuggestions({ suggestions: [suggestion] }, sources)).toThrow("Citation");
  });
});
