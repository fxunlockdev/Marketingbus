import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import sharp from "sharp";
import { storyboardDocument, totalDuration, type StoryboardDocument } from "./document";
import { MAX_VIDEO_BYTES, motionDailyLimit } from "./limits";
const exec = promisify(execFile);
const width = 720, height = 1280, fps = 24;
export type MotionResult = { bytes: Buffer; durationMs: number; width: number; height: number };
export type MotionRenderer = (document: StoryboardDocument, assets: Map<string, Uint8Array>) => Promise<MotionResult>;
function binaries() {
  const ffmpeg = process.env.FFMPEG_PATH, ffprobe = process.env.FFPROBE_PATH;
  if (!ffmpeg || !ffprobe || !isAbsolute(ffmpeg) || !isAbsolute(ffprobe)) throw Error("Set absolute operator-managed FFmpeg and FFprobe paths.");
  return { ffmpeg, ffprobe };
}
const childEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "production" };
let probe: { key: string; until: number; ok: boolean } | undefined;
export async function motionRendererAvailable() {
  try {
    motionDailyLimit(); const paths = binaries(), key = JSON.stringify(paths);
    if (probe?.key === key && probe.until > Date.now()) return probe.ok;
    const results = await Promise.all([exec(paths.ffmpeg, ["-hide_banner", "-encoders"], { timeout: 5000, maxBuffer: 1000000, env: childEnv, encoding: "utf8" }), exec(paths.ffprobe, ["-version"], { timeout: 5000, maxBuffer: 100000, env: childEnv, encoding: "utf8" })]);
    const ok = /\blibx264\b/.test(results[0].stdout) && /ffprobe version/.test(results[1].stdout);
    probe = { key, until: Date.now() + 60000, ok }; return ok;
  } catch { return false; }
}
const escape = (value: string) => value.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
function captionLines(caption: string) {
  const lines: string[] = []; let line = "";
  for (const word of caption.split(/\s+/)) {
    if (word.length > 27) throw Error("A caption word does not fit. Shorten it before rendering.");
    if ((line + " " + word).trim().length > 27) { lines.push(line); line = word; } else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  if (lines.length > 6) throw Error("Caption does not fit the safe area.");
  return lines;
}
export async function renderShotFrame(document: StoryboardDocument, index: number, assets: Map<string, Uint8Array>) {
  const shot = document.shots[index], parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${document.background}"/>`];
  async function image(id: string, x: number, y: number, w: number, h: number) {
    const data = assets.get(id); if (!data) throw Error("Approved scene asset missing.");
    const png = await sharp(data, { limitInputPixels: 16000000, failOn: "warning" }).resize(w, h, { fit: "contain", background: "#00000000" }).png().toBuffer();
    parts.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${png.toString("base64")}"/>`);
  }
  if (document.logo) await image(document.logo.id, 56, 70, 230, 130);
  if (shot.asset) await image(shot.asset.id, 56, 240, 608, 620);
  // Fixed dark caption panel gives predictable contrast regardless of brand colour.
  parts.push('<rect x="36" y="906" width="648" height="310" rx="20" fill="#18212b"/>');
  captionLines(shot.caption).forEach((line, n) => parts.push(`<text x="62" y="958" fill="#ffffff" font-family="sans-serif" font-weight="600" font-size="36" transform="translate(0 ${n * 44})">${escape(line)}</text>`));
  parts.push("</svg>");
  return sharp(Buffer.from(parts.join("")), { limitInputPixels: width * height }).png().toBuffer();
}
let active = 0;
// App-owned finite templates only. No customer HTML/JS/filter strings, shell or remote media.
export const renderMotion: MotionRenderer = async (raw, assets) => {
  if (active) throw Error("The local motion renderer is busy.");
  active++;
  let directory: string | undefined;
  try {
    const document = storyboardDocument.parse(raw), tools = binaries(), deadline = Date.now() + 90000;
    directory = await mkdtemp(join(tmpdir(), "marketingbus-motion-"));
    const run = async (binary: string, args: string[]) => {
      if (Date.now() >= deadline) throw Error("Motion render exceeded its time limit.");
      return exec(binary, args, { cwd: directory, env: childEnv, encoding: "utf8", timeout: Math.min(30000, deadline - Date.now()), killSignal: "SIGKILL", maxBuffer: 1000000, windowsHide: true });
    };
    const clips: string[] = [];
    for (const [index, shot] of document.shots.entries()) {
      const png = `scene-${index}.png`, clip = `clip-${index}.mp4`, seconds = shot.durationMs / 1000;
      await writeFile(join(directory, png), await renderShotFrame(document, index, assets), { flag: "wx", mode: 0o600 });
      const filter = shot.motion === "fade" ? `fade=t=in:st=0:d=0.25,fade=t=out:st=${seconds - 0.25}:d=0.25` : "null";
      await run(tools.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-max_alloc", "67108864", "-filter_threads", "1", "-threads", "1", "-protocol_whitelist", "file", "-loop", "1", "-framerate", String(fps), "-i", png, "-vf", filter, "-frames:v", String(shot.durationMs * fps / 1000), "-an", "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "24", "-maxrate", "3M", "-bufsize", "6M", "-pix_fmt", "yuv420p", "-map_metadata", "-1", "-fs", String(MAX_VIDEO_BYTES), "-movflags", "+faststart", "-f", "mp4", clip]);
      clips.push(clip);
    }
    await writeFile(join(directory, "clips.txt"), clips.map(name => `file '${name}'`).join("\n"), { flag: "wx", mode: 0o600 });
    await run(tools.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-f", "concat", "-safe", "1", "-i", "clips.txt", "-map", "0:v:0", "-c", "copy", "-an", "-map_metadata", "-1", "-fs", String(MAX_VIDEO_BYTES), "-movflags", "+faststart", "-f", "mp4", "output.mp4"]);
    const file = join(directory, "output.mp4"), size = (await stat(file)).size;
    if (size <= 0 || size >= MAX_VIDEO_BYTES) throw Error("Rendered video exceeds its file allowance.");
    const result = await run(tools.ffprobe, ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "stream=codec_name,codec_type,width,height,r_frame_rate:format=duration", "-of", "json", "output.mp4"]);
    const metadata = JSON.parse(result.stdout), stream = metadata.streams?.[0], durationMs = Math.round(Number(metadata.format?.duration) * 1000);
    if (metadata.streams?.length !== 1 || stream?.codec_type !== "video" || stream.codec_name !== "h264" || stream.width !== width || stream.height !== height || stream.r_frame_rate !== "24/1" || !Number.isFinite(durationMs) || Math.abs(durationMs - totalDuration(document)) > 100) throw Error("Rendered media failed stream/duration validation.");
    return { bytes: await readFile(file), durationMs, width, height };
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { active--; }
  }
};
