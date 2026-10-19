import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../http";

// Rates are operator-verified dollars per million tokens, not model-supplied prices.
// No assumed cache discounts; these are conservative, uncached ceilings.
const modelSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1).max(150),
  lane: z.enum(["routine", "creative"]),
  inputUsdPerMillion: z.number().positive().max(1000),
  outputUsdPerMillion: z.number().positive().max(2000),
  verifiedUntil: z.iso.datetime(),
}).strict();
export const routeSchema = z.object({
  model: modelSchema,
  reason: z.string(),
  maxOutputTokens: z.number().int().positive().max(8000),
  maxInputTokens: z.number().int().positive(),
  supplierCeilingMicros: z.number().int().positive().max(80_000_000),
  credits: z.number().int().positive().max(8000),
}).strict();
export type Route = z.infer<typeof routeSchema>;
export type Mode = "initial" | "copy" | "concept";
export function configuredModels() {
  try {
    return z.array(modelSchema).max(12).parse(JSON.parse(process.env.REASONING_RATE_CARD_JSON || "[]")).filter(m => m.provider === "openai");
  } catch { throw new AppError(503, "The model rate card needs operator verification."); }
}
export function configurationHash() {
  return createHash("sha256").update(JSON.stringify({ policy: "openai-text-v1", models: configuredModels() })).digest("hex");
}
export function keyFor(provider: "openai" | "anthropic") {
  return provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
}
export function assertExecutionEnabled() {
  if (process.env.PAID_EXECUTION_ENABLED !== "true") throw new AppError(503, "Paid production is paused. No credits were spent.");
  const ceiling = Number(process.env.DAILY_SUPPLIER_BUDGET_MICROS);
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0 || ceiling > 1_000_000_000) throw new AppError(503, "Set a verified daily supplier-spend ceiling before production.");
  totalSupplierBudget();
  return ceiling;
}
export function totalSupplierBudget() {
  const total = Number(process.env.TOTAL_SUPPLIER_BUDGET_MICROS);
  if (!Number.isSafeInteger(total) || total <= 0 || total > 1_000_000_000) throw new AppError(503, "Set an explicitly approved total supplier-spend ceiling before production.");
  return total;
}
export function selectRoute(mode: Mode, contextBytes: number, models = configuredModels(), now = Date.now()): Route {
  const eligible = models.filter(m => m.provider === "openai" && new Date(m.verifiedUntil).getTime() > now && !!keyFor(m.provider));
  // A cheap model is eligible only for a scoped copy revision. New concepts require the creative lane.
  const lane = mode === "copy" && eligible.some(m => m.lane === "routine") ? "routine" : "creative";
  const maxOutputTokens = mode === "copy" ? 2000 : 4000;
  // A byte/token bound plus generous envelope overhead, rather than a chars/4 estimate.
  const maxInputTokens = contextBytes + 4096;
  const candidates = eligible.filter(m => m.lane === lane).map(model => {
    const supplierCeilingMicros = Math.ceil((maxInputTokens * model.inputUsdPerMillion + maxOutputTokens * model.outputUsdPerMillion) * 1.2);
    return { model, supplierCeilingMicros };
  }).sort((a, b) => a.supplierCeilingMicros - b.supplierCeilingMicros);
  const selected = candidates[0];
  if (!selected) throw new AppError(503, "No eligible model has a current verified rate card and server key.");
  return routeSchema.parse({ ...selected, maxInputTokens, maxOutputTokens,
    credits: Math.max(1, Math.ceil(selected.supplierCeilingMicros / 10_000)),
    reason: lane === "routine" ? "Focused copy change; preserve the existing creative direction." : "Creative reasoning for a new concept or a substantial change." });
}
export function actualCostMicros(route: Route, usage: unknown) {
  const u = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(), cache_read_input_tokens: z.number().int().nonnegative().optional(),
  }).parse(usage);
  // We do not request Anthropic cache creation. Unexpected billed cache writes require reconciliation.
  if (u.cache_creation_input_tokens) throw Error("Unexpected cache-write billing");
  const input = u.input_tokens + (route.model.provider === "anthropic" ? u.cache_read_input_tokens || 0 : 0);
  const micros = Math.ceil(input * route.model.inputUsdPerMillion + u.output_tokens * route.model.outputUsdPerMillion);
  if (input > route.maxInputTokens || u.output_tokens > route.maxOutputTokens || micros > route.supplierCeilingMicros) throw Error("Provider usage exceeded authorization");
  return micros;
}
