import { z } from "zod";
import { contentPreferences, preferenceDirection } from "./onboarding/preferences";
export const brandInput = z.object({
  name: z.string().trim().min(2, "Enter a business name.").max(100),
  website: z.union([z.literal(""), z.url().max(500)]).default(""),
  industry: z.string().trim().max(100).default(""),
  offering: z.string().trim().min(5, "Describe what your business offers.").max(2500),
  audience: z.string().trim().min(3, "Tell us who you serve.").max(1500),
  goal: z.string().trim().min(3, "Choose a business goal.").max(1000),
  difference: z.string().trim().max(1500).default(""),
  proof: z.string().trim().max(2000).default(""),
  tone: z.string().trim().min(2).max(300).default("Clear and conversational"),
  restrictions: z.string().trim().max(2000).default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color.").default("#c67139"),
  designPreset: z.enum(["editorial", "bold", "minimal"]).default("editorial"),
  channels: z.array(z.enum(["Instagram", "Facebook", "LinkedIn", "X", "YouTube"])).min(1).max(5).default(["Instagram", "LinkedIn"]),
  contentPreferences: contentPreferences.optional(),
}).strict();
export type BrandInput = z.infer<typeof brandInput>;
export const draftBrandInput = brandInput.extend({
  offering: z.string().trim().max(2500), audience: z.string().trim().max(1500), goal: z.string().trim().max(1000),
});
export type Suggestion = { id: string; title: string; reason: string; action: string; source: "Profile check" };
export function brandSuggestions(brand: Pick<BrandInput,"difference"|"proof"|"restrictions"|"tone">): Suggestion[] {
  const result: Suggestion[] = [];
  if (!brand.difference) result.push({ id:"difference", title:"Give your content a point of view", reason:"Your profile does not yet explain why a customer should choose you.", action:"Add one meaningful differentiator and an example.", source:"Profile check" });
  if (!brand.proof) result.push({ id:"proof", title:"Add proof we can actually use", reason:"There are no approved customer quotes, results or supporting facts in this profile.", action:"Add a sourced fact or an approved testimonial. We will not invent one.", source:"Profile check" });
  if (!brand.restrictions) result.push({ id:"restrictions", title:"Tell us what is off-limits", reason:"No claim restrictions or topics to avoid are recorded.", action:"Set any pricing, language, product or compliance restrictions.", source:"Profile check" });
  return result;
}
export function proposePlan(brand: BrandInput) {
  return brand.channels.slice(0,4).map((channel,index) => ({
    title: ["Introduce your point of view", "Show the offering", "Answer a customer question", "Explain your difference"][index],
    channel, format: channel === "YouTube" ? "motion" : "static",
    brief: { objective: brand.goal, audience: brand.audience, offering: brand.offering, proposition: brand.difference || "Requires a confirmed differentiator", proof: brand.proof || "No factual proof supplied; make no quantitative claims", ...(brand.contentPreferences ? { contentPreferences: preferenceDirection(brand.contentPreferences) } : {}), source:"Profile-based planning template", requiresCreativeDirection:true }
  }));
}
