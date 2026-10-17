import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { AppError } from "../http";
import { MAX_VIDEO_BYTES } from "./limits";
export const CLIP_PROCESSOR_VERSION = "silent-clip-v1";
export type NormalizedClip = { bytes: Buffer; durationMs: number };
export type ClipNormalizer = (input: Buffer) => Promise<NormalizedClip>;
const exec = promisify(execFile);
const childEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "production" };
const probeSchema = z.object({ streams: z.array(z.object({
  codec_type: z.string(), codec_name: z.string(), width: z.number().optional(), height: z.number().optional(),
  pix_fmt: z.string().optional(), avg_frame_rate: z.string().optional(), duration: z.string().optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
})).min(1).max(2), format: z.object({ duration: z.string() }) });
export function clipMetadata(raw: unknown, normalized = false) {
  const p = probeSchema.parse(raw), videos = p.streams.filter(s => s.codec_type === "video"), v = videos[0];
  const durationMs = Math.round(Number(p.format.duration) * 1000);
  const [n, d] = (v?.avg_frame_rate || "").split("/").map(Number), fps = n / d;
  if (videos.length !== 1 || v.codec_name !== "h264" || !v.width || !v.height || v.width < 64 || v.height < 64 || v.width > 1920 || v.height > 1920 || v.width * v.height > 2073600 ||
    !["yuv420p", "yuvj420p"].includes(v.pix_fmt || "") || !Number.isFinite(fps) || fps < 1 || fps > 60 ||
    !Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 8100 || !Number.isFinite(Number(v.duration)) || Math.abs(Number(v.duration) * 1000 - durationMs) > 100 ||
    v.side_data_list?.some(s => s.rotation !== undefined && s.rotation !== 0) ||
    p.streams.some(s => s !== v && (s.codec_type !== "audio" || s.codec_name !== "aac")) ||
    normalized && (p.streams.length !== 1 || v.width !== 720 || v.height !== 1280 || fps !== 24 || v.pix_fmt !== "yuv420p")) throw Error("Unsupported clip streams, dimensions or duration.");
  return { durationMs, fps };
}
export function assertClipSignature(input: Buffer) {
  if (!input.length || input.length > MAX_VIDEO_BYTES) throw new AppError(413, "Clips must be no larger than 20 MB.");
  if (input.length < 16 || input.toString("ascii", 4, 8) !== "ftyp" || input.readUInt32BE(0) < 16 || input.readUInt32BE(0) > input.length) throw new AppError(400, "Choose a genuine MP4 video.");
}
export async function boundedClipUpload(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "video/mp4") throw new AppError(400, "Upload an MP4 video.");
  const reader = request.body?.getReader(); if (!reader) throw new AppError(400, "Choose a clip.");
  const chunks: Uint8Array[] = []; let length = 0;
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 30000);
  const start = Date.now();
  try {
    while (true) {
      const part = await reader.read();
      if (Date.now() - start >= 30000) throw new AppError(408, "Clip upload timed out.");
      if (part.done) break;
      length += part.value.length; if (length > MAX_VIDEO_BYTES) throw new AppError(413, "Clips must be no larger than 20 MB.");
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks); assertClipSignature(bytes); return bytes;
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
let active = false;
// No URLs, playlists, caller-selected paths, filter strings or environment secrets.
// Restricted demuxer/protocols and deadlines are defense layers, not a decoder sandbox.
export const normalizeClip: ClipNormalizer = async input => {
  assertClipSignature(input);
  if (active) throw Error("Clip processor busy.");
  const ffmpeg = process.env.FFMPEG_PATH, ffprobe = process.env.FFPROBE_PATH;
  if (!ffmpeg || !ffprobe || !isAbsolute(ffmpeg) || !isAbsolute(ffprobe)) throw Error("Clip processor unavailable.");
  active = true; let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "marketingbus-clip-")); const deadline = Date.now() + 60000;
    const run = async (binary: string, args: string[]) => {
      if (Date.now() >= deadline) throw Error("Clip processing deadline exceeded.");
      return exec(binary, args, { cwd: dir, env: childEnv, timeout: Math.min(30000, deadline - Date.now()), killSignal: "SIGKILL", maxBuffer: 256000, encoding: "utf8" });
    };
    const mediaInput = ["-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0"];
    const probe = async (name: string) => JSON.parse((await run(ffprobe, ["-v", "error", "-max_alloc", "67108864", ...mediaInput, "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,duration:stream_side_data=rotation:format=duration", "-of", "json", name])).stdout);
    await writeFile(join(dir, "input.mp4"), input, { flag: "wx", mode: 0o600 });
    const before = clipMetadata(await probe("input.mp4"));
    await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1", ...mediaInput,
      "-i", "input.mp4", "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24",
      "-t", "8", "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-maxrate", "3M", "-bufsize", "6M", "-map_metadata", "-1", "-map_chapters", "-1", "-fs", String(MAX_VIDEO_BYTES), "-movflags", "+faststart", "-f", "mp4", "output.mp4"]);
    const size = (await stat(join(dir, "output.mp4"))).size;
    if (!size || size >= MAX_VIDEO_BYTES) throw Error("Normalized clip exceeds its allowance.");
    const after = clipMetadata(await probe("output.mp4"), true);
    if (Math.abs(after.durationMs - before.durationMs) > 100) throw Error("Clip decoding truncated the source.");
    return { bytes: await readFile(join(dir, "output.mp4")), durationMs: after.durationMs };
  } finally { try { if (dir) await rm(dir, { recursive: true, force: true }); } finally { active = false; } }
};
