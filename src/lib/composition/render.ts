import sharp from "sharp";
import { canvasDocument, placements, type Placement } from "./document";
import { escapeXml, outlinedText } from "../typography";
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
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="creative-title" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title id="creative-title">${escapeXml([copy.brand, copy.headline, copy.cta].filter(Boolean).join(". "))}</title><rect width="100%" height="100%" fill="${document.background}"/>`,
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
      try { parts.push(outlinedText(copy[l.field], { x, y, width: w, height: h, fontSize: Math.round(l.fontSize * width), weight: l.field === "headline" ? 700 : 400, color: l.color }).svg); }
      catch (error) { throw Error(`${l.field}: ${error instanceof Error ? error.message : "Typography could not be rendered."}`); }
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
