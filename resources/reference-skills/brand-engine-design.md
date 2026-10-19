# Brand Engine — Visual Generation Recipes

Produce finished, inspectable visual artifacts. Use GPT Image generation for photography,
illustration, environments, product worlds, and stylistic exploration; use deterministic
HTML/CSS/SVG or canvas composition for exact logos, typography, grids, and UI. The final
result is the combination. Never answer a visual request with only prose, prompts, or a brief.

Ground every visual in `brand/visual-identity.md`. If it is missing and the user supplied
enough references to infer a coherent direction, create a labeled draft identity and proceed.
Ask only when a missing choice would materially change the result.

## Choose the delivery structure first

Default to **separate assets**, not a collage:

- One requested creative → one standalone final image.
- Several requested creatives → generate them one by one with a dedicated prompt and QA pass
  for each; save and return each image separately.
- Variants of one concept → separate files with stable names such as `concept-a.png`,
  `concept-b.png`, and `concept-c.png`.
- Campaign systems → separate platform-ready files; optionally add a contact sheet only as a
  convenience after every individual file is complete.
- Brand boards, moodboards, contact sheets, and collages → create only when the user names
  that format or clearly asks to see the whole visual system together.

Never force unrelated assets into one generation. A collage is a presentation format, not
the default generation strategy. When image generation supports only one output per call,
issue one call per requested asset and preserve each result.

## Mandatory production loop

1. Inventory every input and label its role: exact logo/product asset, identity reference,
   style reference, content source, or edit target. Inspect local images before prompting.
2. Write a one-sentence visual thesis: audience impression, focal subject, distinct style,
   and the compositional idea. Reject generic "clean and modern" directions.
3. Build a shot/asset list. Generate each materially different photograph, illustration,
   texture, mockup, ad, or screen as a separate GPT Image call. Do not ask one generation to
   create an entire text-heavy brand system reliably. Assemble a board only when requested.
4. Prompt using scene → subject → materials/detail → composition → lighting → palette →
   invariants → avoid list. State the exact role of every reference image. Request no
   invented words, marks, labels, or watermarks in generated imagery unless that text is
   meant to be baked into a photograph.
5. Compose exact typography, approved logo files, UI, icons, labels, and alignment locally.
   Never accept a regenerated logo as the final brand mark.
6. Render the final master at the requested size. If no size is supplied, use the 2K rules
   below. Save the editable composition beside the exported PNG.
7. Inspect the PNG at full size and thumbnail size. Check cropping, hierarchy, spelling,
   logo fidelity, contrast, edge quality, repetition, reference adherence, and unintended
   artifacts. Iterate with one targeted change at a time until material defects are gone.
8. Deliver every actual PNG separately, report its pixel dimensions and saved path, and
   include a short design rationale. If a contact sheet or board was requested, deliver the
   individual source images too unless the user explicitly wants only the board. Prompts and
   briefs are supporting material, never the deliverable.

If image generation is unavailable, say that the visual artifact is blocked and name the
required capability. Do not pretend a verbal description completes the request.

## GPT Image quality and 2K policy

- Prefer the built-in GPT Image tool. Use the newest available GPT image model; when using
  the explicit API/CLI path, default to `gpt-image-2` with `quality=high`.
- "2K" means an exported master whose long edge is at least 2048 px. Defaults:
  square `2048×2048`, landscape `2048×1152`, portrait `1536×2048`, story `1152×2048`.
- For exact platform sizes below 2K, first create a 2K master in the same aspect ratio, then
  downsample with a high-quality filter. Preserve the 2K master.
- Never enlarge a visibly soft 1024 px generation and call it 2K quality. Either generate
  at 2K where supported or use the generated image as one element inside a native 2K layout.
- Use high quality for finals and dense/reference-sensitive imagery; lower quality is only
  for explicitly requested drafts.
- For products or identity-sensitive edits, preserve silhouette, proportions, label zones,
  materials, and distinctive features. Use deterministic overlays for exact packaging text.

## Design quality bar (applies to every visual)

Anti-template policy — never ship:
- centered-headline + gradient-blob hero clichés, uniform card grids, default font stacks,
  gray-on-white with one token accent color, same radius/shadow/spacing on everything

Every visual must show at least four of: hierarchy through scale contrast · intentional
spacing rhythm · depth/layering (overlap, surfaces, shadow) · typography with character and
a real pairing · semantic color use · a grid-breaking or editorial moment · texture/
atmosphere when the direction calls for it. Pick a SPECIFIC style direction from
visual-identity.md (editorial, neo-brutalist, dark/light luxury, Swiss, bento,
retro-futurist…) — never vague "clean minimal".

Copy inside visuals comes from the strategy layer: the headline is a hook or pain line from
`strategy/` (or quick-derived), never generic filler. Voice QA applies to all visible text.

## Output and export

Save to `brand/assets/<YYYY-MM-DD>-<slug>/` when an asset has multiple sources or variants;
otherwise use a dated filename directly under `brand/assets/`. Keep generated source images,
the editable composition, and final PNG clearly named. Do not overwrite prior visual assets.

Platform exports: `1:1` 1080×1080 · `4:5` 1080×1350 · `9:16` 1080×1920 · `link` 1200×628 ·
`banner` 1500×500. Default to a 2K master in the requested aspect ratio plus the relevant
platform export. Do not create a square board unless the request calls for one.

## `brandboard` — 2K visual brand world board

Create a polished 2048×2048 board modeled on an agency presentation, not a token sheet.
Use a disciplined editorial grid with 6–9 distinct panels chosen from: brand essence hero,
approved logo lockups, palette/material macro, small coherent icon family, product/packaging
mockups, apparel or environmental application, lifestyle campaign frame, app/site interface,
and social campaign tiles. Include only panels relevant to the brand.

Generate the photographic/product/lifestyle panels separately so each has strong art
direction and consistent lighting. Compose the board with the original logo, exact type,
panel numbers, and concise labels locally. Maintain one color-science and material language
across all panels while varying scale and composition. The finished board should communicate
a usable brand world at a glance, with no duplicated scenes, gibberish, or pseudo-logos.
This collage-style recipe applies only to an explicit `brandboard`, moodboard, contact-sheet,
or visual-system-overview request. It is not the default for static ads, product images,
lifestyle imagery, UI screens, or campaign assets.

## `static [size] [topic|angle]` — Static ad creative

The workhorse (maps to Pillar 4's "static comparison frames" format too). Grounded in a
persona × pain × awareness cell. Layouts to choose from (pick for the angle, vary across a
batch): big-type pain headline · us-vs-them comparison table · annotated product ("what's
inside") · review/quote card with real cited quote · before-after-bridge · editorial
magazine cut · meme-adjacent native frame (only if voice allows). Always: headline ≤9 words
from the hook bank · one focal point · brand block small and consistent · CTA matched to
awareness stage. Deliver 2–3 layout variants per request, each structurally different
(Andromeda logic applies to statics as well). Generate required hero imagery, then compose
the exact copy and logo. Deliver 2–3 structurally different PNG files separately unless the
user asks for one. Do not place the variants into a collage unless requested.

## `mockup [page|screen]` — Page/screen design

Create real copy from the landing/email recipes and a high-fidelity rendered 2K concept.
When implementation is requested, also provide responsive production HTML; otherwise do not
substitute an HTML file for the requested image deliverable.

## `carousel [n] [topic]` — Swipe carousel (IG/LinkedIn)

n slides (default 5–7), each exported as its own 1080×1350 PNG. Add a 2K contact sheet only
when requested or when it is clearly useful as a secondary preview.
Slide 1 = hook frame (scroll-stopper, minimal text) · middle = one idea per slide with
progressive disclosure · last = CTA + brand block. Narrative arc follows pain → mechanism →
proof → CTA. Keep the visual system coherent while changing composition across slides.

## `thumbnail [video-topic]` — Video/YouTube thumbnail

1280×720: face/subject zone note, ≤4-word overlay text, high contrast against platform UI,
2 variants (curiosity vs. outcome framing).
