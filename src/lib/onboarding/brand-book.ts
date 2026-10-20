import { brandInput, type BrandInput } from "../brand";
export function brandBookHtml(raw: BrandInput, draft = false) {
  const brand = brandInput.parse(Object.fromEntries(Object.keys(brandInput.shape).map(key => [key, raw[key as keyof BrandInput]])));
  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const section = (title: string, value: string) => `<section><h2>${escape(title)}</h2><p>${escape(value || "Not set yet.")}</p></section>`;
  const list = (items: string[]) => `<ul>${items.map(item => `<li>${escape(item)}</li>`).join("")}</ul>`;
  const voiceRules: string[] = [];
  if (/\b(clear|concise|direct|simple|precise)\b/i.test(brand.tone)) voiceRules.push("Use short sentences and concrete descriptions. Explain unfamiliar terms.");
  if (/\b(calm|considered|understated|sophisticated|elegant|polished)\b/i.test(brand.tone)) voiceRules.push("Let specific details carry the message. Avoid exaggerated adjectives, pressure and repeated exclamation marks.");
  if (/\b(warm|welcoming|friendly|approachable|empathetic)\b/i.test(brand.tone)) voiceRules.push("Write to one person. Answer their likely question before asking them to take action.");
  if (/\b(professional|authoritative|technical|educational)\b/i.test(brand.tone)) voiceRules.push("Explain the reason behind a recommendation and support factual claims with an approved source.");
  if (!voiceRules.length) voiceRules.push("Read each draft aloud and check that it matches the voice described above.");
  voiceRules.push("Prefer one clear idea and one next step per post. Do not turn a proposed writing style into a claim about the business.");
  const channelNotes: Record<string, string> = {
    Instagram: "Lead with one strong, relevant image or scene. Keep any text overlay short and put supporting detail in the caption.",
    Facebook: "Give enough context to understand the offer, then invite a relevant question or enquiry.",
    LinkedIn: "Open with a useful business insight. Explain the thinking or process behind the work before adding a call to action.",
    X: "Make one specific point. Keep essential qualifications in the post rather than hiding them in a follow-up.",
    YouTube: "Show the subject early, structure the explanation clearly and include captions for spoken content.",
  };
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(brand.name)} — Brand book</title>
<style>body{font:16px/1.65 system-ui,sans-serif;color:#25221e;background:#fff;margin:48px auto;padding:0 28px;max-width:860px}header{border-bottom:3px solid #25221e;padding-bottom:28px;margin-bottom:24px}h1{font-size:48px;line-height:1.1;letter-spacing:-.04em}h2{font-size:23px;line-height:1.25}h3{font-size:18px}p,li{white-space:pre-wrap;overflow-wrap:anywhere}section{border-top:1px solid #ddd;padding:20px 0;break-inside:avoid}li+li{margin-top:8px}.swatch{display:inline-block;width:56px;height:56px;border:1px solid #777;background:${brand.color};vertical-align:middle;margin-right:12px}.chapter{font-size:12px;text-transform:uppercase;letter-spacing:.12em;margin-top:48px;color:#595650}small{color:#595650}footer{border-top:2px solid #25221e;margin-top:32px;padding:20px 0}@media print{@page{margin:18mm}body{font-size:11pt;margin:0;padding:0;max-width:none}h1{font-size:32pt}.chapter{break-before:page;margin-top:0}header{break-after:avoid}h2,h3{break-after:avoid}}</style>
<header><small>${draft ? "DRAFT · REVIEW BEFORE USE" : "YOUR BRAND BOOK"}</small><h1>${escape(brand.name)}</h1><p>${escape(brand.website)}</p><p>A practical guide to what we say, how we sound and how we show up.</p></header>
${section("What we do", brand.offering)}${section("Who we’re here for", brand.audience)}${section("Our goal", brand.goal)}${section("Our voice", brand.tone)}
${brand.difference ? section("What makes us different", brand.difference) : ""}${brand.proof ? section("Approved supporting facts", brand.proof) : ""}
<p class="chapter">Putting the brand into practice</p>
<section><h2>Writing in our voice</h2>${list(voiceRules)}</section>
<section><h2>Build each message in this order</h2>${list([
  `Start with something relevant to ${brand.audience}.`,
  "Explain one part of the offering, using the business description on the previous page as your source.",
  brand.difference ? "Make the difference tangible: show it in the work or explain the process behind it." : "Show the work or explain the process. Do not claim a unique advantage until one is confirmed.",
  brand.proof ? "Use only the supporting facts listed in this guide, and keep any qualifications attached." : "Use a demonstration or process explanation. Add verified supporting facts before making claims about results.",
  `End with one next step that supports this goal: ${brand.goal}.`,
])}</section>
<section><h2>Content to build around</h2>${list([
  "The offering: explain one product, service or experience at a time.",
  "The process: show how the work is made or delivered, using real examples.",
  "Customer questions: answer a question your team actually receives; do not invent testimonials.",
  brand.proof ? "Evidence: tell the story behind an approved fact, without exaggerating what it proves." : "Evidence to collect: approved photographs, documented work and customer quotes with permission.",
])}</section>
${brand.channels.map(channel => section(channel, channelNotes[channel])).join("")}
<p class="chapter">Visual direction and final checks</p>
<section><h2>Visual starting point</h2><p><span class="swatch" aria-hidden="true"></span>Proposed accent: ${escape(brand.color)} · ${escape(brand.designPreset)} layout</p><p>This is the colour selected in your brand kit, not a verified colour extracted from your website. Confirm it against your existing guidelines before use.</p>${list([
  "Use original, approved logos and imagery. Do not stretch, redraw or recolour the logo without permission.",
  "Use the accent sparingly, with a neutral background and readable text contrast.",
  "Keep one clear focal point, a consistent type hierarchy and generous spacing.",
  "Use your approved brand typeface. If one is not set, choose a readable working font; this document does not establish a new official typeface.",
  "Preview each creative at its actual channel size. Keep text readable and important content away from crop edges.",
])}</section>
${section("What to avoid", brand.restrictions || "Do not invent prices, dates, testimonials or results.")}
<section><h2>Before anything is published</h2>${list([
  "Check names, details, links and any time-sensitive information.",
  "Check every factual claim against an approved source.",
  "Confirm permission for photographs, logos, quotations and other supplied material.",
  "Check the intended audience, channel, crop, captions and next step.",
  "Have the business owner approve the final creative and its scheduled destination.",
])}</section>
<footer><small>Created from your ${draft ? "draft" : "reviewed"} brand details. The practical guidance is a proposed working approach, not additional facts about your business. Open this file in a browser and choose Print → Save as PDF to share it.</small></footer></html>`;
}
