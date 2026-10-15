import sharp from "sharp";
import { canvasDocument, placements, type Placement } from "./document";
const escapeXml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[
        c
      ]!)
  );
function lines(text: string, capacity: number) {
  const result: string[] = [];
  let current = "";
  for (const word of text.trim().split(/\s+/)) {
    if (word.length > capacity)
      throw Error(
        "A word is too wide for this layer. Widen the layer or reduce its font size."
      );
    if ((current + " " + word).trim().length > capacity) {
      result.push(current);
      current = word;
    } else current = (current + " " + word).trim();
  }
  if (current) result.push(current);
  return result;
}
let activeRenders = 0;
export async function renderCanvas(raw: unknown, placement: Placement, copy: { brand: string; headline: string; cta: string }, images: Map<string, Uint8Array>) {
  if (activeRenders >= 2) throw Error("The renderer is busy. Try again shortly; no credits were used.");
  activeRenders++;
  try { return await renderCanvasInternal(raw, placement, copy, images); }
  finally { activeRenders--; }
}
async function renderCanvasInternal(
  raw: unknown,
  placement: Placement,
  copy: { brand: string; headline: string; cta: string },
  images: Map<string, Uint8Array>
) {
  const document = canvasDocument.parse(raw),
    [width, height] = placements[placement];
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${document.background}"/>`,
  ];
  for (const l of document.layers) {
    const x = Math.round(l.x * width),
      y = Math.round(l.y * height),
      w = Math.round(l.width * width),
      h = Math.round(l.height * height);
    if (l.kind === "image") {
      const bytes = images.get(l.assetId);
      if (!bytes) throw Error("Approved image missing");
      const png = await sharp(bytes, { limitInputPixels: 16000000 })
        .resize(w, h, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      parts.push(
        `<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${png.toString(
          "base64"
        )}"/>`
      );
    } else {
      const font = Math.round(l.fontSize * width),
        lineHeight = font * 1.3;
      const wrapped = lines(
        copy[l.field],
        Math.max(1, Math.floor(w / (font * 0.68)))
      );
      if (wrapped.length * lineHeight > h)
        throw Error(
          `${l.field} does not fit this placement. Increase its box height or reduce font size.`
        );
      parts.push(
        `<text fill="${
          l.color
        }" font-family="sans-serif" font-size="${font}" font-weight="${
          l.field === "headline" ? 700 : 400
        }">${wrapped
          .map(
            (text, i) =>
              `<tspan x="${x}" y="${y + font + i * lineHeight}">${escapeXml(
                text
              )}</tspan>`
          )
          .join("")}</text>`
      );
    }
  }
  parts.push("</svg>");
  const svg = Buffer.from(parts.join(""));
  return {
    svg,
    png: await sharp(svg, { limitInputPixels: 3000000 }).png().toBuffer(),
    width,
    height,
  };
}
