import { afterEach, describe, expect, it, vi } from "vitest";
import { actualCostMicros, selectRoute, assertExecutionEnabled } from "../src/lib/production/router";
import { validateCreative, creativeJsonSchema } from "../src/lib/production/content";
import { reason } from "../src/lib/providers/reasoning";
const models = [
  { provider: "openai" as const, model: "TEST-CREATIVE-NOT-A-REAL-MODEL", lane: "creative" as const, inputUsdPerMillion: 2, outputUsdPerMillion: 8, verifiedUntil: "2099-01-01T00:00:00Z" },
  { provider: "openai" as const, model: "TEST-ROUTINE-NOT-A-REAL-MODEL", lane: "routine" as const, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4, verifiedUntil: "2099-01-01T00:00:00Z" },
];
afterEach(() => vi.unstubAllEnvs());
describe("bounded model routing", () => {
  it("routes to Claude only with an explicit allowlist and verified lane", () => {
    vi.stubEnv("REASONING_PROVIDERS_JSON", '["openai","anthropic"]'); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-only");
    const claude = { ...models[0], provider: "anthropic" as const };
    expect(selectRoute("initial", 1000, [claude]).model.provider).toBe("anthropic");
    vi.stubEnv("REASONING_PROVIDERS_JSON", '["unknown"]'); expect(() => selectRoute("initial", 1000, [claude])).toThrow("allowlist");
  });
  it("keeps text on OpenAI even if a cheaper Claude key and model exist", () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-only"); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-only");
    const claude = { ...models[0], provider: "anthropic" as const, inputUsdPerMillion: 0.001, outputUsdPerMillion: 0.001 };
    expect(selectRoute("initial", 1000, [...models, claude]).model.provider).toBe("openai");
    expect(() => selectRoute("initial", 1000, [claude])).toThrow("eligible model");
  });
  it("uses the creative lane for new concepts, the routine lane only for scoped copy", () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-only");
    expect(selectRoute("initial", 1000, models).model.lane).toBe("creative");
    expect(selectRoute("concept", 1000, models).model.lane).toBe("creative");
    expect(selectRoute("copy", 1000, models).model.lane).toBe("routine");
  });
  it("fails closed for unverified rates or missing credentials", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => selectRoute("initial", 1000, models)).toThrow("eligible model");
    vi.stubEnv("OPENAI_API_KEY", "fixture-only");
    expect(() => selectRoute("initial", 1000, models, new Date("2100-01-01").getTime())).toThrow("eligible model");
  });
  it("does not route complex work into a cheaper unqualified lane", () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-only");
    expect(() => selectRoute("concept", 1000, [models[1]])).toThrow("eligible model");
  });
  it("reserves uncached cost and rejects spend beyond the ceiling", () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-only");
    const route = selectRoute("initial", 1000, models);
    expect(route.maxInputTokens).toBe(5096);
    expect(route.credits * 10000).toBeGreaterThanOrEqual(route.supplierCeilingMicros);
    expect(actualCostMicros(route, { input_tokens: 100, output_tokens: 50 })).toBe(600);
    expect(() => actualCostMicros(route, { input_tokens: 9000, output_tokens: 50 })).toThrow("authorization");
  });
  it("requires both the paid gate and a bounded daily allowance", () => {
    vi.stubEnv("PAID_EXECUTION_ENABLED", "false");
    expect(() => assertExecutionEnabled()).toThrow("paused");
    vi.stubEnv("PAID_EXECUTION_ENABLED", "true"); vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "0");
    expect(() => assertExecutionEnabled()).toThrow("daily");
  });
});
describe("creative output contract", () => {
  const creative = { headline: "A considered space", caption: "A home shaped around your everyday life.", cta: "Meet our studio", visualDirection: "Simple, editorial typography.", rationale: "Make the service relevant to homeowners.", evidenceUsed: [] };
  it("rejects invented evidence and platform-overlong copy", () => {
    expect(() => validateCreative({ ...creative, evidenceUsed: ["We doubled sales"] }, "Instagram", "")).toThrow("Unsupported");
    expect(() => validateCreative({ ...creative, caption: "a".repeat(281) }, "X", "")).toThrow("placement");
    expect(validateCreative(creative, "LinkedIn", "")).toEqual(creative);
  });
  it("requests strict JSON from OpenAI without storing responses", async () => {
    await reason("openai", { system: "Return the assigned JSON", input: "Fixture", model: "fixture", maxOutputTokens: 1000, jsonSchema: creativeJsonSchema }, "test-only", async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.text.format).toMatchObject({ type: "json_schema", strict: true }); expect(payload.store).toBe(false);
      expect(payload.service_tier).toBe("default");
      return Response.json({ id: "fixture", status: "completed", usage: { input_tokens: 10, output_tokens: 10 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(creative) }] }] });
    });
  });
});
