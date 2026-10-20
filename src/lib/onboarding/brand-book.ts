import { brandInput, type BrandInput } from "../brand";
export function brandBookHtml(raw: BrandInput, draft = false) {
  const brand = brandInput.parse(Object.fromEntries(Object.keys(brandInput.shape).map(key => [key, raw[key as keyof BrandInput]])));
  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const section = (title: string, value: string) => `<section><h2>${escape(title)}</h2><p>${escape(value || "Not set yet.")}</p></section>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(brand.name)} — Brand book</title>
<style>body{font:17px/1.6 system-ui,sans-serif;color:#25221e;background:#fff;margin:48px auto;padding:0 28px;max-width:800px}h1{font-size:44px;line-height:1.1}h2{font-size:22px}p{white-space:pre-wrap;overflow-wrap:anywhere}section{border-top:1px solid #ddd;padding:16px 0;break-inside:avoid}.swatch{display:inline-block;width:56px;height:56px;border:1px solid #777;background:${brand.color};vertical-align:middle;margin-right:12px}small{color:#595650}@media print{body{margin:0;max-width:none}}</style>
<header><small>${draft ? "DRAFT · REVIEW BEFORE USE" : "YOUR BRAND BOOK"}</small><h1>${escape(brand.name)}</h1><p>${escape(brand.website)}</p></header>
${section("What we do", brand.offering)}${section("Who we’re here for", brand.audience)}${section("Our goal", brand.goal)}${section("Our voice", brand.tone)}
${brand.difference ? section("What makes us different", brand.difference) : ""}${brand.proof ? section("Approved supporting facts", brand.proof) : ""}
<section><h2>Visual starting point</h2><p><span class="swatch"></span>${escape(brand.color)} · ${escape(brand.designPreset)} layout</p><p>Typography: Figtree. Keep layouts clear and leave room around your logo.</p><small>This is a starter guide from your saved brand kit, not a new logo or a recreation of uploaded artwork.</small></section>
${section("What to avoid", brand.restrictions || "Do not invent prices, dates, testimonials or results.")}${section("Where we show up", brand.channels.join(", "))}
<footer><small>Created from your ${draft ? "draft" : "reviewed"} brand details. Open this file in a browser and choose Print → Save as PDF to share it.</small></footer></html>`;
}
