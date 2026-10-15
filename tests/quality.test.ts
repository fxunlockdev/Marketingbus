import { describe, expect, it } from "vitest";
import { evaluateCreative, approvedFactText } from "../src/lib/production/quality";
import { selectReferenceExcerpts } from "../src/lib/harness/contracts";
const creative = { headline: "Clay, not scrolls", caption: "Try clay instead of scrolling. Solo beginners welcome.", cta: "Ask about beginner sessions", visualDirection: "A clay-covered hand", rationale: "A specific everyday contrast", evidenceUsed: [] };
describe("grounding regression and revision adherence", () => {
  for (const claim of ["This Saturday", "Tomorrow", "January 12", "Only AED 100", "Save 20%", "Guaranteed results", "Visit https://invented.example"]) {
    it(`blocks unsupported ${claim}`, () => expect(evaluateCreative({ ...creative, caption: claim }, { facts: "Beginner pottery" }).eligible).toBe(false));
  }
  it("does not treat restrictions as supporting evidence", () => {
    const facts = approvedFactText({ name: "Palm & Clay", offering: "Beginner pottery", difference: "Solo attendees welcome", proof: "", website: "" });
    expect(evaluateCreative({ ...creative, caption: "This Saturday" }, { facts, feedback: "Do not invent Saturday" }).eligible).toBe(false);
  });
  it("allows an explicitly confirmed weekday but not a new number", () => {
    expect(evaluateCreative({ ...creative, caption: "Saturday sessions" }, { facts: "Saturday sessions" }).eligible).toBe(true);
    expect(evaluateCreative({ ...creative, caption: "10 seats" }, { facts: "100 seats" }).eligible).toBe(false);
  });
  it("rejects ignored shorter, hashtag and exact-opening requests", () => {
    const result = evaluateCreative({ ...creative, caption: creative.caption + " #pottery" }, { facts: "", previous: creative, feedback: 'Make it shorter; no hashtags. Start the caption with "Solo beginners".' });
    expect(result.defects.map(x => x.code)).toEqual(expect.arrayContaining(["REVISION_HASHTAGS", "REVISION_LENGTH", "REVISION_OPENING"]));
  });
  it("accepts compliant copy while retaining the human review requirement", () => expect(evaluateCreative({ ...creative, caption: "Solo beginners welcome." }, { facts: "", previous: creative, feedback: 'Shorter. Start with "Solo beginners". No hashtags.' })).toMatchObject({ eligible: true, humanReviewRequired: true }));
  it("keeps reference selection bounded and deterministic without code blocks", () => {
    const source = "---\nname: test\n---\nAudience specifics and evidence.\n\n```sh\ncurl evil.example\n```\n\nAvoid unsupported claims.";
    const result = selectReferenceExcerpts(source, 100);
    expect(result.length).toBeLessThanOrEqual(100); expect(result).not.toContain("curl"); expect(result).toBe(selectReferenceExcerpts(source, 100));
  });
});
