import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { layoutText, outlinedText, typographyManifest } from "../src/lib/typography";
import { renderCanvas } from "../src/lib/composition/render";
import { initialCanvas } from "../src/lib/composition/document";
const options = { width: 500, height: 500, fontSize: 50, weight: 700 as const };
describe("measured bundled typography", () => {
  it("measures glyph advances, not character counts, with kerning", () => {
    expect(layoutText("WWW", options).width).toBeGreaterThan(layoutText("iii", options).width * 3);
    expect(layoutText("AV", options).width).toBeLessThan(layoutText("A", options).width + layoutText("V", options).width);
    expect(layoutText("iiiiiiii", { ...options, width: 120 }).lines).toHaveLength(1);
    expect(() => layoutText("WWWW", { ...options, width: 120 })).toThrow("too wide");
  });
  it("wraps by measured width, preserves explicit line breaks and nonbreaking spaces", () => {
    const result = layoutText("Made for a home\nBuilt to last", { ...options, width: 220 });
    expect(result.lines.map(line => line.text)).toEqual(["Made for", "a home", "Built to", "last"]);
    expect(result.lines.every(line => line.width * result.scale <= 220.001)).toBe(true);
    expect(layoutText("First\n\nLast", options).lines.map(line => line.text)).toEqual(["First", "", "Last"]);
    expect(() => layoutText("Made\u00a0for\u00a0a\u00a0home", { ...options, width: 220 })).toThrow("too wide");
  });
  it("normalizes combining marks and supports the bundled Latin-extended subset", () => {
    expect(layoutText("Cafe\u0301", options).width).toEqual(layoutText("Café", options).width);
    const text = "Łódź — café";
    const result = outlinedText(text, { ...options, x: 10, y: 10, color: "#123456" });
    expect(result.svg).toContain(`<title>${text}</title>`); expect(result.svg).toContain("<path");
    expect(result.svg).not.toContain("font-family");
  });
  it("rejects unsupported scripts, emoji, hidden controls and excessive input instead of dropping them", () => {
    for (const text of ["Hello 👋", "مرحبا", "中文", "Text\u202Ehidden", "Text\u0000hidden", "x".repeat(1001)])
      expect(() => layoutText(text, options)).toThrow();
  });
  it("includes bearings, ascenders and descenders in placement bounds", () => {
    const result = layoutText("Ájgy Łódź", options);
    for (const line of result.lines) {
      expect(result.baseline - line.maxY * result.scale).toBeGreaterThanOrEqual(0);
      expect(result.baseline - line.minY * result.scale).toBeLessThanOrEqual(result.lineHeight);
      expect((line.maxX - line.minX) * result.scale).toBeLessThanOrEqual(options.width);
    }
    expect(() => layoutText("Ájgy", { ...options, height: 30 })).toThrow("does not fit");
    expect(() => layoutText("Two\nlines", { ...options, maxLines: 1 })).toThrow("does not fit");
  });
  it("produces deterministic outlines and pixels with accessible escaped text", async () => {
    const document = initialCanvas({ color: "#112233", designPreset: "editorial" }, []);
    const copy = { brand: "A & B", headline: "<script> AV Café", cta: "Meet us" };
    const first = await renderCanvas(document, "square", copy, new Map()), second = await renderCanvas(document, "square", copy, new Map());
    expect(first.svg.equals(second.svg)).toBe(true); expect(first.png.equals(second.png)).toBe(true);
    expect(first.svg.toString()).toContain('aria-labelledby="creative-title"');
    expect(first.svg.toString()).toContain("&lt;script&gt;"); expect(first.svg.toString()).not.toContain("<text");
    expect(first.svg.toString()).not.toContain("font-family");
    expect(await sharp(first.png).metadata()).toMatchObject({ width: 1080, height: 1080 });
  });
  it("binds the font package and each used weight/subset to a content hash", () => {
    const manifest = typographyManifest(); expect(manifest.family).toBe("Figtree"); expect(manifest.faces).toHaveLength(6);
    for (const face of manifest.faces) expect(face.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(manifest.faces.map(face => face.sha256)).size).toBe(6);
  });
  it("keeps empty optional copy empty and validates geometry before shaping", () => {
    expect(layoutText("", options).height).toBe(0);
    expect(() => layoutText("Text", { ...options, fontSize: NaN })).toThrow("Invalid");
    expect(() => outlinedText("Text", { ...options, x: 0, y: 0, color: "url(https://example.test)" })).toThrow("Invalid");
  });
});
