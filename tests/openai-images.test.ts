import { afterEach, describe, expect, it, vi } from "vitest";
import { imageConfigurationHash, imageCost, imageKey, selectImageRoute } from "../src/lib/images/contracts";
import { generateImage } from "../src/lib/providers/openai-image";
const rate = { model: "gpt-image-2.5-sunburst", lane: "creative", quality: "high", inputUsdPerMillion: 8, textInputUsdPerMillion: 5, outputUsdPerMillion: 30, maxOutputTokens: 32768, verifiedUntil: "2099-01-01T00:00:00Z" };
const usage = { input_tokens: 150, input_tokens_details: { text_tokens: 100, image_tokens: 50 }, output_tokens: 200, total_tokens: 350 };
function setup() { vi.stubEnv("OPENAI_API_KEY", "synthetic-key"); vi.stubEnv("GEMINI_API_KEY", ""); vi.stubEnv("IMAGE_PROVIDER", "openai"); vi.stubEnv("IMAGE_RATE_CARD_JSON", JSON.stringify([rate])); return selectImageRoute(false, "Approved brand brief", 1); }
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("OpenAI image routing and accounting", () => {
 it("uses exact OpenAI image model, separately measures input modalities, and never needs Gemini", () => {
  const route = setup(); expect(imageKey(route.model.model)).toBe("synthetic-key"); expect(imageCost(route, usage)).toBe(6900);
  expect(() => imageCost(route, { ...usage, input_tokens: 149 })).toThrow();
  expect(() => imageCost(route, { ...usage, total_tokens: 349 })).toThrow();
  expect(() => imageCost(route, { ...usage, output_tokens: 40000, total_tokens: 40150 })).toThrow();
 });
 it("requires explicit model, quality, verified rates and a key; GPT-6 is not an image model ID", () => {
  setup(); vi.stubEnv("IMAGE_RATE_CARD_JSON", JSON.stringify([{ ...rate, quality: undefined }])); expect(() => selectImageRoute(false, "brief", 0)).toThrow();
  vi.stubEnv("IMAGE_RATE_CARD_JSON", JSON.stringify([{ ...rate, model: "gpt-6-astra" }])); expect(() => selectImageRoute(false, "brief", 0)).toThrow();
  setup(); vi.stubEnv("OPENAI_API_KEY", ""); expect(() => selectImageRoute(false, "brief", 0)).toThrow("not configured");
 });
 it("does not silently switch provider and invalidates configuration on a provider change", () => {
  setup(); const hash = imageConfigurationHash(); vi.stubEnv("IMAGE_PROVIDER", "gemini"); expect(imageConfigurationHash()).not.toBe(hash);
  expect(() => selectImageRoute(false, "brief", 0)).toThrow();
  vi.stubEnv("IMAGE_PROVIDER", ""); vi.stubEnv("IMAGE_RATE_CARD_JSON", JSON.stringify([rate, { model: "gemini-fixture", lane: "creative", inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxOutputTokens: 4096, verifiedUntil: rate.verifiedUntil }]));
  expect(() => selectImageRoute(false, "brief", 0)).toThrow("Select one");
 });
 it.each([false, true])("submits exactly once, with references=%s, to a fixed endpoint", async editing => {
  const route = setup();
  const fetcher = vi.fn(async () => Response.json({ usage, data: [{ b64_json: Buffer.from("artwork").toString("base64") }] }, { headers: { "x-request-id": "req-synthetic" } })); vi.stubGlobal("fetch", fetcher);
  const result = await generateImage({ route, prompt: "approved brief", references: editing ? [Buffer.from("original"), Buffer.from("previous")] : [] }, "synthetic-key");
  expect(result.image?.toString()).toBe("artwork"); expect(result.id).toBe("req-synthetic"); expect(result.usage).toEqual(usage); expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`https://api.openai.com/v1/images/${editing ? "edits" : "generations"}`); expect(init.redirect).toBe("error");
  if (editing) { const form = init.body as FormData; expect(form.get("model")).toBe(rate.model); expect(form.get("n")).toBe("1"); expect(form.get("size")).toBe("2048x2048"); expect(form.getAll("image[]")).toHaveLength(2); expect(await (form.getAll("image[]")[1] as Blob).text()).toBe("previous"); }
  else expect(JSON.parse(init.body as string)).toMatchObject({ model: rate.model, quality: "high", n: 1, size: "2048x2048", output_format: "webp" });
 });
 it("never retries ambiguous calls and requires an actual supplier request ID", async () => {
  const route = setup(), fetcher = vi.fn(async () => { throw Error("timeout"); }); vi.stubGlobal("fetch", fetcher);
  await expect(generateImage({ route, prompt: "brief", references: [] }, "key")).rejects.toThrow("timeout"); expect(fetcher).toHaveBeenCalledTimes(1);
  vi.stubGlobal("fetch", async () => Response.json({ usage, data: [] }));
  await expect(generateImage({ route, prompt: "brief", references: [] }, "key")).rejects.toThrow();
 });
 it("rejects multiple outputs, noncanonical base64 and overlarge response bodies", async () => {
  const route = setup(), headers = { "x-request-id": "req-fixture" };
  vi.stubGlobal("fetch", async () => Response.json({ usage, data: [{ b64_json: "aGk" }] }, { headers }));
  expect((await generateImage({ route, prompt: "brief", references: [] }, "key")).image).toBeNull();
  vi.stubGlobal("fetch", async () => Response.json({ usage, data: [{}, {}] }, { headers }));
  await expect(generateImage({ route, prompt: "brief", references: [] }, "key")).rejects.toThrow();
  vi.stubGlobal("fetch", async () => new Response("x".repeat(8 * 1024 * 1024 + 1), { headers }));
  await expect(generateImage({ route, prompt: "brief", references: [] }, "key")).rejects.toThrow("limit");
 });
});
