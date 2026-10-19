import { z } from "zod";
import { MAX_IMAGE_BYTES } from "../assets/images";
import { imageProvider } from "../images/contracts";
import { generateGeminiImage, type ImageGenerator } from "./gemini-image";

// Official Images API, single 2K artwork. GPT-6 directs the approved
// creative brief in the text pipeline; it is not an image-output model ID.
// https://developers.openai.com/api/docs/guides/image-generation
export const generateOpenAIImage: ImageGenerator = async (request, key) => {
  if (imageProvider(request.route.model.model) !== "openai" || !request.route.model.quality || request.references.length > 3 || request.references.some(b => !b.length || b.length > MAX_IMAGE_BYTES)) throw Error("Invalid OpenAI image request");
  const parameters = { model: request.route.model.model, prompt: request.prompt, n: 1, size: "2048x2048", quality: request.route.model.quality, output_format: "webp", ...(request.safetyIdentifier ? { safety_identifier: z.string().regex(/^[a-f0-9]{64}$/).parse(request.safetyIdentifier) } : {}) };
  let body: string | FormData = JSON.stringify(parameters);
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  if (request.references.length) {
    const form = new FormData();
    for (const [name, value] of Object.entries(parameters)) form.set(name, String(value));
    for (const [index, bytes] of request.references.entries()) form.append("image[]", new Blob([new Uint8Array(bytes)], { type: "image/webp" }), `reference-${index}.webp`);
    body = form;
  } else headers["Content-Type"] = "application/json";
  const response = await fetch(`https://api.openai.com/v1/images/${request.references.length ? "edits" : "generations"}`, {
    method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(150000),
  });
  if (!response.ok || !response.body) throw Error("Image provider outcome needs reconciliation");
  const id = z.string().min(1).max(200).parse(response.headers.get("x-request-id"));
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    length += chunk.value.length;
    if (length > 8 * 1024 * 1024) { await reader.cancel(); throw Error("Image provider response exceeded limit"); }
    chunks.push(chunk.value);
  }
  const result = z.object({ usage: z.unknown(), data: z.array(z.object({ b64_json: z.string().optional() })).max(1) }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const encoded = result.data[0]?.b64_json; let image: Buffer | null = null;
  if (encoded && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length <= MAX_IMAGE_BYTES && bytes.toString("base64") === encoded) image = bytes;
  }
  return { id, image, usage: result.usage };
};

export const generateImage: ImageGenerator = (request, key) => imageProvider(request.route.model.model) === "openai" ? generateOpenAIImage(request, key) : generateGeminiImage(request, key);
