import { afterEach, describe, expect, it, vi } from "vitest";
import { storyboardDocument, subtitleVtt, totalDuration } from "../src/lib/video/document";
import { motionDailyLimit } from "../src/lib/video/limits";
import { shotHash } from "../src/lib/video/service";
const document = { title: "Reel", background: "#c67139", logo: null, shots: [{ id: "a", label: "Opening", caption: "Considered design", durationMs: 2000, motion: "fade" as const, asset: null }] };
afterEach(() => vi.unstubAllEnvs());
describe("finite storyboard contracts", () => {
  it("validates duration, shot count, uniqueness and reading pace", () => {
    expect(totalDuration(storyboardDocument.parse(document))).toBe(2000);
    expect(storyboardDocument.safeParse({ ...document, shots: [document.shots[0], document.shots[0]] }).success).toBe(false);
    expect(storyboardDocument.safeParse({ ...document, shots: Array.from({ length: 6 }, (_, n) => ({ ...document.shots[0], id: String(n), durationMs: 8000 })) }).success).toBe(false);
    expect(storyboardDocument.safeParse({ ...document, shots: [{ ...document.shots[0], caption: "a".repeat(100), durationMs: 1000 }] }).success).toBe(false);
    expect(storyboardDocument.safeParse({ ...document, shots: [{ ...document.shots[0], durationMs: 1350 }] }).success).toBe(false);
  });
  it("rejects arbitrary motion programs, remote media and unexpected fields", () => {
    expect(storyboardDocument.safeParse({ ...document, html: "<script>bad</script>" }).success).toBe(false);
    expect(storyboardDocument.safeParse({ ...document, shots: [{ ...document.shots[0], motion: "movie=https://untrusted.invalid/a.mp4" }] }).success).toBe(false);
    expect(storyboardDocument.safeParse({ ...document, shots: [{ ...document.shots[0], asset: { url: "http://localhost/secret" } }] }).success).toBe(false);
  });
  it("escapes VTT markup and uses cumulative exact shot times", () => {
    const d = storyboardDocument.parse({ ...document, shots: [{ ...document.shots[0], caption: "<script> & text" }, { ...document.shots[0], id: "b", durationMs: 1250 }] });
    const vtt = subtitleVtt(d); expect(vtt).toContain("00:00:02.000 --> 00:00:03.250"); expect(vtt).toContain("&lt;script&gt; &amp; text"); expect(vtt).not.toContain("<script>");
  });
  it("binds shot approval to shared styling and exact scene content", () => {
    const d = storyboardDocument.parse(document), hash = shotHash(d, d.shots[0]);
    expect(shotHash({ ...d, title: "Different internal title" }, d.shots[0])).toBe(hash);
    expect(shotHash({ ...d, background: "#000000" }, d.shots[0])).not.toBe(hash);
    expect(shotHash(d, { ...d.shots[0], caption: "New caption" })).not.toBe(hash);
  });
  it("requires a bounded operator rendering allowance", () => {
    vi.stubEnv("MOTION_RENDERING_ENABLED", "false"); expect(() => motionDailyLimit()).toThrow("paused");
    vi.stubEnv("MOTION_RENDERING_ENABLED", "true"); vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "101"); expect(() => motionDailyLimit()).toThrow();
    vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "6"); expect(motionDailyLimit()).toBe(6);
  });
});
