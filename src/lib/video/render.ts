import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import sharp from "sharp";
import { storyboardDocument, totalDuration, DEFAULT_CLIP_EDIT, type StoryboardDocument } from "./document";
import { MAX_VIDEO_BYTES, motionDailyLimit } from "./limits";
import { outlinedText, typographyManifest } from "../typography";
import { videoLayout } from "./layout";
import { audioMetadata, requireAudioProcessing } from "./audio-normalizer";
const exec = promisify(execFile);
const fps = 24;
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
    typographyManifest();
    motionDailyLimit(); const paths = binaries(), audio = process.env.AUDIO_PROCESSING_ENABLED === "true", key = JSON.stringify({ ...paths, audio });
    if (probe?.key === key && probe.until > Date.now()) return probe.ok;
    const results = await Promise.all([exec(paths.ffmpeg, ["-hide_banner", "-encoders"], { timeout: 5000, maxBuffer: 1000000, env: childEnv, encoding: "utf8" }), exec(paths.ffprobe, ["-version"], { timeout: 5000, maxBuffer: 100000, env: childEnv, encoding: "utf8" })]);
    const ok = /\blibx264\b/.test(results[0].stdout) && (!audio || /\baac\b/.test(results[0].stdout) && /\bpcm_s16le\b/.test(results[0].stdout)) && /ffprobe version/.test(results[1].stdout);
    probe = { key, until: Date.now() + 60000, ok }; return ok;
  } catch { return false; }
}
export async function renderShotFrame(document: StoryboardDocument, index: number, assets: Map<string, Uint8Array>) {
  const { width, height, logo, media, panel, text } = videoLayout(document);
  const shot = document.shots[index], parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`, shot.clip ? `<path fill="${document.background}" fill-rule="evenodd" d="M0 0H${width}V${height}H0Z M${media.x} ${media.y}H${media.x + media.width}V${media.y + media.height}H${media.x}Z"/>` : `<rect width="100%" height="100%" fill="${document.background}"/>`];
  async function image(id: string, x: number, y: number, w: number, h: number) {
    const data = assets.get(id); if (!data) throw Error("Approved scene asset missing.");
    const png = await sharp(data, { limitInputPixels: 16000000, failOn: "warning" }).resize(w, h, { fit: "contain", background: "#00000000" }).png().toBuffer();
    parts.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${png.toString("base64")}"/>`);
  }
  if (document.logo) await image(document.logo.id, logo.x, logo.y, logo.width, logo.height);
  if (shot.asset) await image(shot.asset.id, media.x, media.y, media.width, media.height);
  // Fixed dark caption panel gives predictable contrast regardless of brand colour.
  parts.push(`<rect x="${panel.x}" y="${panel.y}" width="${panel.width}" height="${panel.height}" rx="20" fill="#18212b"/>`);
  parts.push(outlinedText(shot.caption, { ...text, weight: 600, color: "#ffffff" }).svg);
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
    const { width, height, media } = videoLayout(document);
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
      let inputs = ["-protocol_whitelist", "file", "-loop", "1", "-framerate", String(fps), "-i", png], filters = ["-vf", filter];
      if (shot.clip) {
        const data = assets.get(shot.clip.id); if (!data) throw Error("Approved scene clip missing.");
        const edit = shot.clipEdit ?? DEFAULT_CLIP_EDIT;
        const source = `source-${index}.mp4`; await writeFile(join(directory, source), data, { flag: "wx", mode: 0o600 });
        inputs = [...inputs, "-threads", "1", "-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", source];
        const framing = edit.fit === "cover"
          ? `scale=${media.width}:${media.height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${media.width}:${media.height}:(iw-${media.width})*${edit.x}/100:(ih-${media.height})*${edit.y}/100`
          : `scale=${media.width}:${media.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${media.width}:${media.height}:(ow-iw)/2:(oh-ih)/2:color=${document.background}`;
        filters = ["-filter_complex", `[1:v:0]trim=start=${edit.startMs / 1000}:duration=${seconds},setpts=PTS-STARTPTS,${framing},pad=${width}:${height}:${media.x}:${media.y}:color=${document.background},setsar=1,fps=24[footage];[footage][0:v:0]overlay=shortest=1,${filter}[scene]`, "-map", "[scene]"];
      }
      await run(tools.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-max_alloc", "67108864", "-filter_threads", "1", "-filter_complex_threads", "1", "-threads", "1", ...inputs, ...filters, "-frames:v", String(shot.durationMs * fps / 1000), "-an", "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "24", "-maxrate", "3M", "-bufsize", "6M", "-pix_fmt", "yuv420p", "-map_metadata", "-1", "-fs", String(MAX_VIDEO_BYTES), "-movflags", "+faststart", "-f", "mp4", clip]);
      clips.push(clip);
    }
    await writeFile(join(directory, "clips.txt"), clips.map(name => `file '${name}'`).join("\n"), { flag: "wx", mode: 0o600 });
    await run(tools.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-f", "concat", "-safe", "1", "-i", "clips.txt", "-map", "0:v:0", "-c", "copy", "-an", "-map_metadata", "-1", "-fs", String(MAX_VIDEO_BYTES), "-movflags", "+faststart", "-f", "mp4", "output.mp4"]);
    let output = "output.mp4";
    if (document.soundtrack) {
      requireAudioProcessing();
      const music = document.soundtrack, source = assets.get(music.id); if (!source) throw Error("Approved instrumental audio missing.");
      await writeFile(join(directory, "music.wav"), source, { flag: "wx", mode: 0o600 });
      const info = await run(tools.ffprobe, ["-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file", "-f", "wav", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,duration:format=duration", "-of", "json", "music.wav"]);
      const duration = totalDuration(document), seconds = duration / 1000;
      if (music.startMs + duration > audioMetadata(JSON.parse(info.stdout), true).durationMs) throw Error("Music is shorter than the approved range.");
      const filter = [`atrim=start=${music.startMs / 1000}:duration=${seconds}`, "asetpts=PTS-STARTPTS", `volume=${music.gainPercent / 100}`,
        ...(music.fadeInMs ? [`afade=t=in:st=0:d=${music.fadeInMs / 1000}`] : []), ...(music.fadeOutMs ? [`afade=t=out:st=${seconds - music.fadeOutMs / 1000}:d=${music.fadeOutMs / 1000}`] : [])].join(",");
      output = "with-music.mp4";
      await run(tools.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-max_alloc", "67108864", "-filter_threads", "1", "-threads", "1", "-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", "output.mp4", "-protocol_whitelist", "file", "-f", "wav", "-i", "music.wav", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af", filter, "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-t", String(seconds), "-map_metadata", "-1", "-map_chapters", "-1", "-fs", String(MAX_VIDEO_BYTES), "-movflags", "+faststart", "-f", "mp4", output]);
    }
    const file = join(directory, output), size = (await stat(file)).size;
    if (size <= 0 || size >= MAX_VIDEO_BYTES) throw Error("Rendered video exceeds its file allowance.");
    const result = await run(tools.ffprobe, ["-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file", "-show_entries", "stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels,duration:format=duration", "-of", "json", output]);
    const metadata = JSON.parse(result.stdout), stream = metadata.streams?.[0], durationMs = Math.round(Number(metadata.format?.duration) * 1000);
    if (metadata.streams?.length !== (document.soundtrack ? 2 : 1) || stream?.codec_type !== "video" || stream.codec_name !== "h264" || stream.width !== width || stream.height !== height || stream.r_frame_rate !== "24/1" || !Number.isFinite(durationMs) || Math.abs(durationMs - totalDuration(document)) > 100) throw Error("Rendered media failed stream/duration validation.");
    if (document.soundtrack) {
      const audio = metadata.streams[1];
      if (audio.codec_type !== "audio" || audio.codec_name !== "aac" || audio.sample_rate !== "48000" || audio.channels !== 2 || !Number.isFinite(Number(audio.duration)) || Math.abs(Number(audio.duration) * 1000 - totalDuration(document)) > 100) throw Error("Rendered soundtrack failed validation.");
    }
    return { bytes: await readFile(file), durationMs, width, height };
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { active--; }
  }
};
