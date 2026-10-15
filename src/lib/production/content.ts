import { z } from "zod";
export const creativeSchema = z.object({
  headline: z.string().trim().min(1).max(160),
  caption: z.string().trim().min(1).max(3000),
  cta: z.string().trim().max(100),
  visualDirection: z.string().trim().min(1).max(2000),
  rationale: z.string().trim().min(1).max(1500),
  evidenceUsed: z.array(z.string().max(1000)).max(20),
}).strict();
export type Creative = z.infer<typeof creativeSchema>;
// Provider schema intentionally uses the widely supported strict JSON subset.
export const creativeJsonSchema = {
  type: "object", additionalProperties: false,
  properties: Object.fromEntries(Object.keys(creativeSchema.shape).map(key => [key, key === "evidenceUsed"
    ? { type: "array", items: { type: "string" } } : { type: "string" }])),
  required: Object.keys(creativeSchema.shape),
};
export function validateCreative(raw: unknown, channel: string, approvedProof: string) {
  const result = creativeSchema.parse(raw);
  const limits: Record<string, number> = { X: 280, Instagram: 2200, LinkedIn: 3000, Facebook: 3000 };
  if (result.caption.length > (limits[channel] || 3000)) throw Error("Caption exceeds the placement limit");
  if (result.evidenceUsed.some(claim => !approvedProof.includes(claim))) throw Error("Unsupported evidence reference");
  return result;
}
