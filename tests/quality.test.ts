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
  it.each([
    ["Book for USD 100", "We serve 100 customers. USD payments accepted."],
    ["Book for AED 100", "Session price: USD 100. AED payments accepted."],
    ["Only $100", "100 customers. Prices in $."],
    ["Only €100", "100 customers. Prices in €."],
    ["Only £100", "100 customers. Prices in £."],
    ["Only ₹100", "100 customers. Prices in ₹."],
    ["Only CAD 1,200.50", "USD 1,200.50; CAD accepted."],
    ["ＵＳＤ １００", "We serve 100 customers. USD payments accepted."],
    ["-$100", "Price: $100"],
    ["USD -100", "Price: USD 100"],
    ["Only 100 USD", "We serve 100 USD-funded clients."],
    ["January 12, 2028", "January 12, 2027. Our 2028 plans are separate."],
    ["12 January 2028", "12 January 2027. Our 2028 plans are separate."],
    ["Jan 12", "Jan manages our 12 projects."],
    ["12th Jan", "Jan manages our 12th project."],
    ["Saturday, January 12", "Saturday workshops. January 12 consultations."],
    ["Friday 12 January 2028", "Friday workshops. 12 January 2028 consultations."],
    ["USD 100", "USD\n100 clients"],
    ["January 12", "January\n12 projects"],
  ])("requires one contiguous confirmed price/date for %s", (caption, facts) => {
    expect(evaluateCreative({ ...creative, caption }, { facts }).eligible).toBe(false);
  });
  it.each(["USD 100", "$100", "€100", "£100", "₹100", "CAD 1,200.50", "100 AED", "January 12, 2028", "12 January 2028", "Jan 12", "12th Jan", "Saturday, January 12", "Wednesday 12 January 2028"])("allows an exact confirmed compound %s", caption => {
    expect(evaluateCreative({ ...creative, caption }, { facts: `Confirmed: ${caption}.` }).eligible).toBe(true);
  });
  it("retains conservative price matching without inventing currency conversions", () => {
    expect(evaluateCreative({ ...creative, caption: "USD 100" }, { facts: "Price: $100" }).eligible).toBe(false);
    expect(evaluateCreative({ ...creative, caption: "USD 100.00" }, { facts: "Price: USD 100" }).eligible).toBe(false);
  });
  it.each(["February 31", "31 April", "June 00", "January 32", "Feb 29, 2027", "29 February 1900", "February 29, 2100", "January 1, 0000", "Friday 12 January 2028", "Monday, February 29, 2028", "Ｊｕｎｅ ３１", "June 11st", "June 22th", "June 13rd"])("rejects an impossible named date even when confirmed: %s", caption => {
    const result = evaluateCreative({ ...creative, caption }, { facts: caption });
    expect(result).toMatchObject({ eligible: false, humanReviewRequired: true });
    expect(result.defects).toEqual(expect.arrayContaining([expect.objectContaining({ code: "INVALID_CALENDAR_DATE" })]));
  });
  it.each(["February 29", "29 Feb. 2028", "February 29, 2000", "29th February 2028", "Tuesday, February 29, 2028", "Wednesday 12 January 2028", "1 January 0001", "December 31, 9999", "Saturday, January 12", "June 1st", "June 2nd", "June 3rd", "June 11th", "June 12th", "June 13th", "June 21st", "June 22nd", "June 23rd", "June 30th"])("allows a possible confirmed date without assuming a missing year: %s", caption => {
    expect(evaluateCreative({ ...creative, caption }, { facts: caption })).toMatchObject({ eligible: true, humanReviewRequired: true });
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
