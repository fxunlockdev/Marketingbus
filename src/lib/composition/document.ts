import { z } from "zod";
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const box = {
  x: z.number().min(0).max(0.95),
  y: z.number().min(0).max(0.95),
  width: z.number().min(0.05).max(1),
  height: z.number().min(0.05).max(1),
};
const layer = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("text"),
        field: z.enum(["brand", "headline", "cta"]),
        ...box,
        fontSize: z.number().min(0.015).max(0.12),
        color,
      })
      .strict(),
    z
      .object({
        kind: z.literal("image"),
        assetId: z.string().min(1).max(100),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        ...box,
      })
      .strict(),
  ])
  .refine(
    (l) => l.x + l.width <= 1.000001 && l.y + l.height <= 1.000001,
    "Keep every layer inside the canvas."
  );
export const canvasDocument = z
  .object({ background: color, layers: z.array(layer).min(1).max(8) })
  .strict();
export type CanvasDocument = z.infer<typeof canvasDocument>;
export const placements = {
  square: [1080, 1080],
  portrait: [1080, 1350],
  story: [1080, 1920],
  landscape: [1200, 628],
} as const;
export type Placement = keyof typeof placements;
export function initialCanvas(
  brand: { color: string; designPreset: string },
  assets: { id: string; purpose: string; sha256: string }[]
): CanvasDocument {
  const logo = assets.find((a) => a.purpose === "logo"),
    product = assets.find((a) => a.purpose === "product"),
    reference = assets.find((a) => a.purpose === "reference"),
    image = product ?? reference;
  const dark = brand.designPreset === "bold";
  const textColor = dark ? "#ffffff" : "#18212b";
  return canvasDocument.parse({
    background: dark ? "#18212b" : "#fffaf3",
    layers: [
      ...(image
        ? [
            {
              kind: "image",
              assetId: image.id,
              sha256: image.sha256,
              x: 0.53,
              y: 0.22,
              width: 0.42,
              height: 0.65,
            },
          ]
        : []),
      ...(logo
        ? [
            {
              kind: "image",
              assetId: logo.id,
              sha256: logo.sha256,
              x: 0.06,
              y: 0.05,
              width: 0.25,
              height: 0.13,
            },
          ]
        : [
            {
              kind: "text",
              field: "brand",
              x: 0.06,
              y: 0.06,
              width: 0.88,
              height: 0.12,
              fontSize: 0.03,
              color: textColor,
            },
          ]),
      {
        kind: "text",
        field: "headline",
        x: 0.06,
        y: 0.25,
        width: image ? 0.44 : 0.88,
        height: 0.5,
        fontSize: image ? 0.05 : 0.07,
        color: textColor,
      },
      {
        kind: "text",
        field: "cta",
        x: 0.06,
        y: 0.82,
        width: 0.88,
        height: 0.12,
        fontSize: 0.025,
        color: textColor,
      },
    ],
  });
}
