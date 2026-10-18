import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { AppError } from "../http";
import type { ClipNormalizer } from "./clip-normalizer";
export const AUDIO_PROCESSOR_VERSION = "instrumental-pcm-v1";
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export function requireAudioProcessing() {
  if (process.env.AUDIO_PROCESSING_ENABLED !== "true") throw new AppError(503, "Instrumental audio processing is not enabled by the operator.");
}
export function audioFormat(input: Buffer): "wav" | "mp3" {
  if (!input.length || input.length > MAX_AUDIO_BYTES) throw new AppError(413, "Audio must be no larger than 8 MB.");
  if (input.length >= 44 && input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (input.length >= 16 && (input.toString("ascii", 0, 3) === "ID3" || input[0] === 255 && (input[1] & 0xe0) === 0xe0)) return "mp3";
  throw new AppError(400, "Choose a genuine WAV or MP3 instrumental track.");
}
const metadataSchema = z.object({ streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string(), sample_rate: z.string(), channels: z.number().int(), duration: z.string().optional() })).length(1), format: z.object({ duration: z.string() }) });
export function audioMetadata(raw: unknown, normalized = false) {
  const p = metadataSchema.parse(raw), s = p.streams[0], durationMs = Math.round(Number(p.format.duration) * 1000), rate = Number(s.sample_rate);
  if (s.codec_type !== "audio" || !["mp3", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"].includes(s.codec_name) || !Number.isFinite(rate) || rate < 8000 || rate > 96000 || s.channels < 1 || s.channels > 2 || !Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > 30000 || normalized && (s.codec_name !== "pcm_s16le" || rate !== 48000 || s.channels !== 2)) throw Error("Unsupported audio streams, rate or duration.");
  return { durationMs };
}
export async function boundedAudioUpload(request: Request) {
  if (!["audio/wav", "audio/x-wav", "audio/mpeg"].includes(request.headers.get("content-type")?.split(";")[0] || "")) throw new AppError(400, "Upload WAV or MP3 audio.");
  const reader = request.body?.getReader(); if (!reader) throw new AppError(400, "Choose an audio track.");
  const chunks: Uint8Array[] = []; let length = 0; const start = Date.now();
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 30000);
  try {
    while (true) {
      const part = await reader.read(); if (Date.now() - start >= 30000) throw new AppError(408, "Audio upload timed out.");
      if (part.done) break;
      length += part.value.length; if (length > MAX_AUDIO_BYTES) throw new AppError(413, "Audio must be no larger than 8 MB."); chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks); audioFormat(bytes); return bytes;
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const exec = promisify(execFile);
let active = false;
// File-only demuxing, stripped metadata, bounded work and no secrets in child env.
// These restrictions are defense in depth, not an OS-level decoder sandbox.
export const normalizeAudio: ClipNormalizer = async input => {
  const format = audioFormat(input), ffmpeg = process.env.FFMPEG_PATH, ffprobe = process.env.FFPROBE_PATH;
  if (active || !ffmpeg || !ffprobe || !isAbsolute(ffmpeg) || !isAbsolute(ffprobe)) throw Error("Audio processor unavailable.");
  active = true; let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "marketingbus-audio-")); const deadline = Date.now() + 60000;
    const run = (binary: string, args: string[]) => {
      if (Date.now() >= deadline) throw Error("Audio processing deadline exceeded.");
      return exec(binary, args, { cwd: dir, env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "production" }, timeout: Math.min(30000, deadline - Date.now()), killSignal: "SIGKILL", maxBuffer: 256000, encoding: "utf8" });
    };
    const probe = async (name: string, type: string) => JSON.parse((await run(ffprobe, ["-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file", "-f", type, "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,duration:format=duration", "-of", "json", name])).stdout);
    await writeFile(join(dir, "source"), input, { flag: "wx", mode: 0o600 }); const before = audioMetadata(await probe("source", format));
    await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file", "-f", format, "-i", "source", "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", "30", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "-map_metadata", "-1", "-map_chapters", "-1", "-fs", String(MAX_AUDIO_BYTES), "-f", "wav", "normalized.wav"]);
    const size = (await stat(join(dir, "normalized.wav"))).size; if (!size || size >= MAX_AUDIO_BYTES) throw Error("Normalized audio exceeds its allowance.");
    const after = audioMetadata(await probe("normalized.wav", "wav"), true);
    if (Math.abs(before.durationMs - after.durationMs) > 100) throw Error("Audio decoding truncated the source.");
    return { bytes: await readFile(join(dir, "normalized.wav")), durationMs: after.durationMs };
  } finally { try { if (dir) await rm(dir, { recursive: true, force: true }); } finally { active = false; } }
};
