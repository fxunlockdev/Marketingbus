import { z } from "zod";

export const strategies = [
  { id: "education", name: "Teach something useful", description: "Answer real customer questions and explain your offering." },
  { id: "problem-solution", name: "Show how you help", description: "Connect a customer problem to a specific, supportable benefit." },
  { id: "behind-scenes", name: "Show the work", description: "Explain your process without inventing personal stories or results." },
  { id: "product", name: "Put the offering first", description: "Focus on confirmed features, details and use cases." },
] as const;
export const contentPreferences = z.object({
  businessType: z.enum(["services", "local", "products"]).default("services"),
  strategy: z.enum(["education", "problem-solution", "behind-scenes", "product"]).default("education"),
  language: z.enum(["English (US)", "English (UK)"]).default("English (US)"),
  visualStyle: z.enum(["natural", "studio", "cinematic"]).default("natural"),
}).strict();
export type ContentPreferences = z.infer<typeof contentPreferences>;
export function preferenceDirection(raw: unknown) {
  const p = contentPreferences.parse(raw ?? {});
  return { ...p, strategyDescription: strategies.find(s => s.id === p.strategy)!.description };
}
