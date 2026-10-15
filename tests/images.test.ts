import { afterEach, describe, expect, it, vi } from "vitest";
import { imageCost, selectImageRoute } from "../src/lib/images/contracts";
import { generateGeminiImage } from "../src/lib/providers/gemini-image";
const rates = [{ model: "gemini-fixture", lane: "creative", inputUsdPerMillion: 2, outputUsdPerMillion: 8, maxOutputTokens: 4096, verifiedUntil: "2099-01-01T00:00:00Z" }, { model: "gemini-fixture-revision", lane: "revision", inputUsdPerMillion: 1, outputUsdPerMillion: 4, maxOutputTokens: 4096, verifiedUntil: "2099-01-01T00:00:00Z" }];
function route(revision = false) { vi.stubEnv("GEMINI_API_KEY", "fixture"); vi.stubEnv("IMAGE_RATE_CARD_JSON", JSON.stringify(rates)); return selectImageRoute(revision, "Brief", 0); }
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("image authorization and Gemini transport", () => {
  it("uses the cheaper approved revision lane only for scoped revisions", () => {
    expect(route().model.lane).toBe("creative"); expect(route(true).model.lane).toBe("revision");
    expect(route(true).supplierCeilingMicros).toBeLessThan(route().supplierCeilingMicros);
  });
  it("requires current verified rates and a server key", () => {
    route(); vi.stubEnv("GEMINI_API_KEY", ""); expect(() => selectImageRoute(false, "x", 0)).toThrow("not configured");
    vi.stubEnv("GEMINI_API_KEY", "fixture"); vi.stubEnv("IMAGE_RATE_CARD_JSON", JSON.stringify([{ ...rates[0], verifiedUntil: "2000-01-01T00:00:00Z" }]));
    expect(() => selectImageRoute(false, "x", 0)).toThrow("verified rates");
  });
  it("includes thinking usage and rejects unknown or excessive billing", () => {
    const r = route(); expect(imageCost(r, { promptTokenCount: 100, candidatesTokenCount: 200, thoughtsTokenCount: 50, totalTokenCount: 350 })).toBe(2200);
    expect(() => imageCost(r, { promptTokenCount: 100, candidatesTokenCount: 200, totalTokenCount: 999 })).toThrow();
    expect(() => imageCost(r, {})).toThrow();
    expect(() => imageCost(r, { promptTokenCount: 100, candidatesTokenCount: 5000, totalTokenCount: 5100 })).toThrow();
  });
  it("submits once to the fixed endpoint and ignores thought images", async () => {
    const r = route(), usage = { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 };
    const fetcher = vi.fn(async () => Response.json({ responseId: "fixture-response", usageMetadata: usage, candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, inlineData: { mimeType: "image/png", data: Buffer.from("thought").toString("base64") } }, { inlineData: { mimeType: "image/png", data: Buffer.from("final").toString("base64") } }] } }] }));
    vi.stubGlobal("fetch", fetcher);
    const result = await generateGeminiImage({ route: r, prompt: "brief", references: [Buffer.from("reference")] }, "fixture");
    expect(result.image?.toString()).toBe("final"); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture:generateContent");
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.generationConfig.candidateCount).toBe(1); expect(body.contents[0].parts[1].inlineData.mimeType).toBe("image/webp");
  });
  it("does not retry transport errors and does not accept truncated output", async () => {
    const r = route(), fetcher = vi.fn(async () => { throw Error("timeout"); }); vi.stubGlobal("fetch", fetcher);
    await expect(generateGeminiImage({ route: r, prompt: "brief", references: [] }, "fixture")).rejects.toThrow("timeout"); expect(fetcher).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", async () => Response.json({ responseId: "fixture", usageMetadata: {}, candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGk=" } }] } }] }));
    expect((await generateGeminiImage({ route: r, prompt: "brief", references: [] }, "fixture")).image).toBeNull();
  });
});
