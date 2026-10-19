import { z } from "zod";
import type { ImageRoute } from "../images/contracts";
import { MAX_IMAGE_BYTES } from "../assets/images";
export type ImageRequest = { route: ImageRoute; prompt: string; references: Buffer[]; safetyIdentifier?: string };
export type ImageResult = { id: string; usage: unknown; image: Buffer | null };
export type ImageGenerator = (request: ImageRequest, key: string) => Promise<ImageResult>;
// Official generateContent REST contract. One request, no SDK or transport retries.
// https://ai.google.dev/gemini-api/docs/generate-content/image-generation
// https://ai.google.dev/api/generate-content#UsageMetadata
export const generateGeminiImage: ImageGenerator = async (request, key) => {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${request.route.model.model}:generateContent`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: request.prompt }, ...request.references.map(data => ({ inlineData: { mimeType: "image/webp", data: data.toString("base64") } }))] }],
      generationConfig: { candidateCount: 1, maxOutputTokens: request.route.model.maxOutputTokens, responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } } }),
  });
  if (!response.ok || !response.body) throw Error("Image provider outcome needs reconciliation");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    length += chunk.value.length;
    if (length > 8 * 1024 * 1024) { await reader.cancel(); throw Error("Image provider response exceeded limit"); }
    chunks.push(chunk.value);
  }
  const part = z.object({ thought: z.boolean().optional(), inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional() });
  const result = z.object({ responseId: z.string().min(1).max(200), usageMetadata: z.unknown(), candidates: z.array(z.object({ finishReason: z.string().optional(), content: z.object({ parts: z.array(part).max(32) }).optional() })).max(1).optional() }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const candidate = result.candidates?.[0], images = candidate?.content?.parts.filter(p => !p.thought && p.inlineData) ?? [];
  let image: Buffer | null = null;
  if (candidate?.finishReason === "STOP" && images.length === 1) {
    const data = images[0].inlineData!;
    if (["image/png", "image/jpeg", "image/webp"].includes(data.mimeType) && /^[A-Za-z0-9+/]+={0,2}$/.test(data.data)) {
      const decoded = Buffer.from(data.data, "base64");
      if (decoded.length <= MAX_IMAGE_BYTES && decoded.toString("base64") === data.data) image = decoded;
    }
  }
  return { id: result.responseId, usage: result.usageMetadata, image };
};
