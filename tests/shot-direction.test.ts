import { describe, it, expect } from "vitest";
import { nextShotBrief, readShotBrief, validateShotBriefBinding } from "../src/lib/video/creative-brief";
describe("bounded generated-shot creative direction", () => {
  it("reads only the exact legacy default as an empty direction", () => {
    expect(readShotBrief({})).toEqual({ version: 1, direction: "", revisions: [] });
    for (const value of [null, [], "", { version: 1 }, { direction: "x", revisions: [] }, { version: 1, direction: "x", revisions: [], prompt: "injected" }]) expect(() => readShotBrief(value)).toThrow();
  });
  it("preserves chronological feedback and rejects replayed parents or excessive steps", () => {
    let brief = readShotBrief({ version: 1, direction: "Soft lighting", revisions: [] });
    for (let i = 0; i < 4; i++) brief = nextShotBrief(`parent-${i}`, brief, `Keep the lighting; change camera move ${i}.`);
    expect(brief.direction).toBe("Soft lighting"); expect(brief.revisions.map(r => r.parentId)).toEqual(["parent-0", "parent-1", "parent-2", "parent-3"]);
    expect(() => nextShotBrief("parent-4", brief, "A fifth change request.")).toThrow("Four feedback");
    const once = nextShotBrief("parent", {}, "Slower camera movement.");
    expect(() => nextShotBrief("parent", once, "A different change.")).toThrow("Repeated revision");
    expect(() => validateShotBriefBinding(once, null)).toThrow("history differs");
    expect(() => validateShotBriefBinding(once, "other-parent")).toThrow("history differs");
    expect(validateShotBriefBinding(once, "parent")).toEqual(once);
  });
});
