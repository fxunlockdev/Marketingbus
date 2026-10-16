import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create, type Font, type Glyph } from "fontkit";

export const TYPOGRAPHY_VERSION = "figtree-outlines-v1";
type Weight = 400 | 600 | 700;
type Face = { font: Font; subset: string; weight: Weight; sha256: string };
type PositionedGlyph = { glyph: Glyph; x: number; y: number };
type Line = { text: string; glyphs: PositionedGlyph[]; minX: number; maxX: number; minY: number; maxY: number; width: number };
let loaded: Face[] | undefined;
export const escapeXml = (text: string) => text.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));

function faces() {
  if (loaded) return loaded;
  try {
    const result: Face[] = [];
    // Code-owned, pinned static fonts only. No remote or uploaded font is parsed.
    for (const weight of [400, 600, 700] as const) for (const subset of ["latin", "latin-ext"]) {
      const bytes = readFileSync(join(process.cwd(), "node_modules", "@fontsource", "figtree", "files", `figtree-${subset}-${weight}-normal.woff2`));
      const font = create(bytes);
      if (!("layout" in font) || font.unitsPerEm !== 1000 || !["Figtree Light", "Figtree Light SemiBold"].includes(font.familyName) || font["OS/2"].usWeightClass !== weight) throw Error("Unexpected bundled font");
      result.push({ font, subset, weight, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    loaded = result; return result;
  } catch { throw Error("Bundled typography is unavailable. Please contact the studio administrator."); }
}
export function typographyManifest() {
  return { version: TYPOGRAPHY_VERSION, family: "Figtree", packageVersion: "5.3.0", faces: faces().map(({ subset, weight, sha256 }) => ({ subset, weight, sha256 })) };
}

function shape(text: string, weight: Weight): Line {
  const fonts = faces().filter(face => face.weight === weight);
  const groups: { font: Font; text: string }[] = [];
  // Keep combining sequences together; NFC gives a precomposed glyph where one exists.
  for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) {
    const face = fonts.find(face => [...segment].every(char => face.font.hasGlyphForCodePoint(char.codePointAt(0)!)));
    if (!face) throw Error(`This font cannot render ${[...segment].map(c => `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`).join(" ")}. Use supported Latin text; multilingual fonts and emoji are not available yet.`);
    const last = groups.at(-1);
    if (last?.font === face.font) last.text += segment; else groups.push({ font: face.font, text: segment });
  }
  const glyphs: PositionedGlyph[] = [];
  let penX = 0, penY = 0, minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const group of groups) {
    const run = group.font.layout(group.text);
    if (run.direction !== "ltr" || run.glyphs.some(glyph => !glyph.id)) throw Error("This text requires an unsupported writing system.");
    run.glyphs.forEach((glyph, index) => {
      const position = run.positions[index], x = penX + position.xOffset, y = penY + position.yOffset;
      glyphs.push({ glyph, x, y });
      const box = glyph.bbox;
      if ([box.minX, box.maxX, box.minY, box.maxY].every(Number.isFinite)) {
        minX = Math.min(minX, x + box.minX); maxX = Math.max(maxX, x + box.maxX);
        minY = Math.min(minY, y + box.minY); maxY = Math.max(maxY, y + box.maxY);
      }
      penX += position.xAdvance; penY += position.yAdvance;
    });
  }
  maxX = Math.max(maxX, penX);
  if (![minX, maxX, minY, maxY, penX, penY].every(Number.isFinite) || Math.abs(penY) > 0.001) throw Error("Typography measurement failed.");
  return { text, glyphs, minX, maxX, minY, maxY, width: maxX - minX };
}

export function layoutText(raw: string, options: { fontSize: number; weight: Weight; width: number; height: number; lineHeight?: number; maxLines?: number }) {
  if (typeof raw !== "string" || raw.length > 1000) throw Error("Text exceeds the typography allowance (1,000 characters per layer).");
  if (!Number.isFinite(options.fontSize) || options.fontSize < 8 || options.fontSize > 200 || !Number.isFinite(options.width) || options.width <= 0 || !Number.isFinite(options.height) || options.height <= 0 || ![400, 600, 700].includes(options.weight)) throw Error("Invalid text geometry.");
  const text = raw.normalize("NFC").replace(/\r\n?/g, "\n");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) throw Error("Remove unsupported control characters from this text.");
  const scale = options.fontSize / 1000, cache = new Map<string, Line>();
  const measure = (value: string) => { let result = cache.get(value); if (!result) { result = shape(value, options.weight); cache.set(value, result); } return result; };
  const lines: Line[] = [];
  if (text.trim()) for (const paragraph of text.split("\n")) {
    let current = "";
    const words = paragraph.trim().split(/[ \t]+/).filter(Boolean);
    for (const word of words) {
      if (measure(word).width * scale > options.width + 0.001) throw Error("A word is too wide for this layer. Widen the layer or reduce its font size.");
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate).width * scale > options.width + 0.001) { lines.push(measure(current)); current = word; } else current = candidate;
    }
    lines.push(measure(current));
  }
  const font = faces().find(face => face.weight === options.weight)!.font;
  const ascent = Math.max(font.ascent, ...lines.map(line => line.maxY)) * scale;
  const descent = Math.max(-font.descent, ...lines.map(line => -line.minY)) * scale;
  const lineHeight = options.lineHeight ?? Math.max(options.fontSize * 1.3, ascent + descent);
  if (!Number.isFinite(lineHeight) || lineHeight < ascent + descent || lines.length > (options.maxLines ?? 32) || lines.length * lineHeight > options.height + 0.001)
    throw Error("Text does not fit this layer. Increase its box height or reduce font size; no text was clipped.");
  const baseline = ascent + (lineHeight - ascent - descent) / 2;
  return { lines, scale, baseline, lineHeight, height: lines.length * lineHeight, width: Math.max(0, ...lines.map(line => line.width * scale)) };
}

export function outlinedText(text: string, options: Parameters<typeof layoutText>[1] & { x: number; y: number; color: string }) {
  if (![options.x, options.y].every(Number.isFinite) || !/^#[a-fA-F0-9]{6}$/.test(options.color)) throw Error("Invalid text appearance.");
  const layout = layoutText(text, options), parts: string[] = [];
  const number = (value: number) => Number(value.toFixed(5));
  layout.lines.forEach((line, index) => {
    const baseline = options.y + layout.baseline + index * layout.lineHeight;
    for (const { glyph, x, y } of line.glyphs) {
      const path = glyph.path.toSVG();
      if (path) parts.push(`<path d="${path}" transform="translate(${number(options.x + (x - line.minX) * layout.scale)} ${number(baseline - y * layout.scale)}) scale(${number(layout.scale)} ${number(-layout.scale)})"/>`);
    }
  });
  const svg = `<g fill="${options.color}" aria-label="${escapeXml(text)}"><title>${escapeXml(text)}</title>${parts.join("")}</g>`;
  if (Buffer.byteLength(svg) > 2000000) throw Error("Text outlines exceed the export allowance.");
  return { svg, width: layout.width, height: layout.height, lines: layout.lines.map(line => line.text) };
}
