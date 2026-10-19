import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { downloadProviderMedia, mediaHost, mediaUrl, type MediaDownload } from "./media-download";
import { assertClipSignature } from "../video/clip-normalizer";

const origin = "https://api.higgsfield.ai";
const failure = () => Error("Higgsfield request could not be verified.");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const model = z.enum(["seedance-2.5-text", "kling-3.0-standard-text"]);
const inputSchema = z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/), model, durationMs: z.number().int().min(3000).max(8000).multipleOf(1000), prompt: z.string().min(1).max(12000) }).strict();
export type HiggsfieldInput = z.infer<typeof inputSchema>;
const verificationSettings = {
  verifiedUntil: z.iso.datetime(), outputHosts: z.array(z.string().refine(h => { try { mediaHost(h); return true; } catch { return false; } })).min(1).max(8),
};
export const higgsfieldSettings = z.union([
  z.object({ keyId: z.string().regex(/^[A-Za-z0-9_-]{8,256}$/), secret: z.string().regex(/^[\x21-\x7e]{16,512}$/).refine(v => !v.includes(":")), ...verificationSettings }).strict(),
  z.object({ apiKey: z.string().regex(/^[\x21-\x7e]{16,1024}$/), ...verificationSettings }).strict(),
]).refine(c => new Set(c.outputHosts).size === c.outputHosts.length);
export type HiggsfieldSettings = z.infer<typeof higgsfieldSettings>;
const estimateSchema = z.object({ requestHash: hex, credentialFingerprint: hex, estimatedUsdMicros: z.number().int().nonnegative().max(80000000), credits: z.string().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/), observedAt: z.number().int().positive(), signature: hex }).strict();
export type HiggsfieldEstimate = z.infer<typeof estimateSchema>;
const receiptSchema = z.object({ operationId: inputSchema.shape.operationId, model, requestHash: hex, credentialFingerprint: hex, providerJobId: uuid, statusUrl: z.string().max(500), estimatedUsdMicros: estimateSchema.shape.estimatedUsdMicros, acceptedAt: z.number().int().positive(), signature: hex }).strict();
export type HiggsfieldSubmission = z.infer<typeof receiptSchema>;
export function usdMicros(raw: unknown) {
  const decimal = z.string().regex(/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,6})?$/).parse(raw);
  const [whole, fraction = ""] = decimal.split(".");
  const result = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  if (result > 80000000n) throw failure();
  return Number(result);
}
export function higgsfieldRequest(raw: HiggsfieldInput) {
  const input = inputSchema.parse(raw);
  if (!input.prompt.trim() || input.model === "seedance-2.5-text" && input.durationMs < 4000) throw failure();
  const path = input.model === "seedance-2.5-text" ? "/bytedance/seedance-2.5/text-to-video" : "/kling-video/v3.0/std/text-to-video";
  const body = input.model === "seedance-2.5-text"
    ? { prompt: input.prompt, duration: input.durationMs / 1000, resolution: "720p", aspect_ratio: "9:16", output_format: "mp4", generate_audio: false }
    : { prompt: input.prompt, duration: input.durationMs / 1000, aspect_ratio: "9:16", sound: "off", cfg_scale: 0.5, multi_shots: false };
  return { input, path, body, requestHash: hash({ operationId: input.operationId, path, body }) };
}

// A real low-level network transport, not yet a registered ShotAdapter. The
// job integration must journal this receipt and verify final expense separately.
export function createHiggsfieldTransport(raw: HiggsfieldSettings, fetcher: typeof fetch = fetch, download: MediaDownload = downloadProviderMedia) {
  const config = higgsfieldSettings.parse(raw);
  const credentialFingerprint = hash("apiKey" in config ? { apiKey: config.apiKey } : { keyId: config.keyId, secret: config.secret });
  const credential = "apiKey" in config ? config.apiKey : `${config.keyId}:${config.secret}`;
  const signingKey = "apiKey" in config ? config.apiKey : config.secret;
  const signingIdentity = "apiKey" in config ? credentialFingerprint : config.keyId;
  function fresh() {
    const remaining = new Date(config.verifiedUntil).getTime() - Date.now();
    if (remaining <= 0 || remaining > 90 * 86400000) throw failure();
  }
  fresh();
  const sign = (kind: string, value: unknown) => createHmac("sha256", signingKey).update(JSON.stringify({ kind, value, keyId: signingIdentity, protocol: "higgsfield-network-v1" })).digest("hex");
  function verify(kind: string, value: Record<string, unknown> & { signature: string }) {
    const { signature, ...rest } = value;
    if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(sign(kind, rest), "hex")) || rest.credentialFingerprint !== credentialFingerprint) throw failure();
  }
  async function json(path: string, method: "GET" | "POST", body: unknown, parent: AbortSignal, idempotency?: string) {
    fresh(); const signal = AbortSignal.any([parent, AbortSignal.timeout(15000)]);
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      response = await fetcher(origin + path, { method, signal, redirect: "error", credentials: "omit", cache: "no-store", headers: { Authorization: `Key ${credential}`, Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...(idempotency ? { "Idempotency-Key": idempotency } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      signal.throwIfAborted();
      if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") || !response.body) throw failure();
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 65536)) throw failure();
      const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
          if (part.done) break;
          bytes += part.value.byteLength; if (bytes > 65536) throw failure(); parts.push(part.value);
        }
        if (declared !== null && Number(declared) !== bytes) throw failure();
        fresh(); return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
      } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); throw failure(); }
  }
  function statusUrl(id: string, raw: string) {
    const expected = `${origin}/requests/${uuid.parse(id)}/status`;
    if (raw !== expected) throw failure(); return raw;
  }
  return {
    credentialFingerprint,
    bindSubmission(raw: unknown, input: HiggsfieldInput) {
      try {
        fresh();
        const receipt = receiptSchema.parse(raw), request = higgsfieldRequest(input);
        verify("submission", receipt); statusUrl(receipt.providerJobId, receipt.statusUrl);
        if (receipt.operationId !== input.operationId || receipt.model !== input.model || receipt.requestHash !== request.requestHash || receipt.acceptedAt > Date.now()) throw failure();
        return receipt;
      } catch { throw failure(); }
    },
    async estimate(raw: HiggsfieldInput, signal: AbortSignal): Promise<HiggsfieldEstimate> {
      try {
        const request = higgsfieldRequest(raw);
        const value = z.object({ usd: z.string(), credits: estimateSchema.shape.credits }).parse(await json(`/estimate${request.path}`, "POST", request.body, signal));
        const estimate = { requestHash: request.requestHash, credentialFingerprint, estimatedUsdMicros: usdMicros(value.usd), credits: value.credits, observedAt: Date.now() };
        return { ...estimate, signature: sign("estimate", estimate) };
      } catch { throw failure(); }
    },
    async submit(raw: HiggsfieldInput, rawEstimate: HiggsfieldEstimate, ceilingMicros: number, signal: AbortSignal): Promise<HiggsfieldSubmission> {
      try {
        const request = higgsfieldRequest(raw), estimate = estimateSchema.parse(rawEstimate); verify("estimate", estimate);
        if (!Number.isSafeInteger(ceilingMicros) || ceilingMicros < 0 || ceilingMicros > 80000000 || estimate.requestHash !== request.requestHash || estimate.estimatedUsdMicros > ceilingMicros || estimate.observedAt > Date.now() || Date.now() - estimate.observedAt > 600000) throw failure();
        // Exactly one HTTP attempt. The persisted operation ID is stable; no random retry key.
        const accepted = z.object({ request_id: uuid, status_url: z.string().max(500), status: z.enum(["queued", "in_progress", "completed", "failed", "nsfw", "canceled"]) }).parse(await json(request.path, "POST", request.body, signal, raw.operationId));
        const receipt = { operationId: request.input.operationId, model: request.input.model, requestHash: request.requestHash, credentialFingerprint, providerJobId: accepted.request_id, statusUrl: statusUrl(accepted.request_id, accepted.status_url), estimatedUsdMicros: estimate.estimatedUsdMicros, acceptedAt: Date.now() };
        return { ...receipt, signature: sign("submission", receipt) };
      } catch { throw failure(); }
    },
    async poll(raw: HiggsfieldSubmission, signal: AbortSignal, options: { downloadCompleted?: boolean } = {}) {
      try {
        const receipt = receiptSchema.parse(raw); verify("submission", receipt); statusUrl(receipt.providerJobId, receipt.statusUrl);
        if (receipt.acceptedAt > Date.now()) throw failure();
        const value = z.object({ request_id: z.literal(receipt.providerJobId), status: z.enum(["queued", "in_progress", "completed", "failed", "nsfw", "canceled"]), video: z.object({ url: z.string().max(4096) }).optional() }).parse(await json(`/requests/${receipt.providerJobId}/status`, "GET", undefined, signal));
        const base = { providerJobId: receipt.providerJobId, requestHash: receipt.requestHash, expense: "unverified" as const };
        if (value.status === "queued" || value.status === "in_progress") return { ...base, state: "pending" as const };
        if (value.status !== "completed") return { ...base, state: value.status };
        if (!value.video) throw failure();
        mediaUrl(value.video.url, config.outputHosts);
        if (options.downloadCompleted === false) return { ...base, state: "completed" as const };
        const bytes = await download(value.video.url, config.outputHosts, signal);
        signal.throwIfAborted(); fresh(); assertClipSignature(Buffer.from(bytes));
        return { ...base, state: "completed" as const, bytes };
      } catch { throw failure(); }
    },
  };
}
