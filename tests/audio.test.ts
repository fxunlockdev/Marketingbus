import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioFormat, audioMetadata, boundedAudioUpload, normalizeAudio, requireAudioProcessing, MAX_AUDIO_BYTES } from "../src/lib/video/audio-normalizer";
import { renderMotion } from "../src/lib/video/render";
import { storyboardDocument, soundtrackRangeFits } from "../src/lib/video/document";
import { shotHash } from "../src/lib/video/service";
import { motionConfigurationHash } from "../src/lib/video/limits";
const exec = promisify(execFile);
const music = { id: "track", sha256: "a".repeat(64), startMs: 1000, gainPercent: 25, fadeInMs: 250, fadeOutMs: 250 };
const document = { title: "Music test", background: "#112233", logo: null, shots: [{ id: "a", label: "Opening", caption: "Considered spaces", durationMs: 2000, motion: "hold" as const, asset: null }] };
const metadata = () => ({ streams: [{ codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "48000", channels: 2 }], format: { duration: "3.000" } });
describe("instrumental audio boundaries", () => {
  it.each([Buffer.from("#EXTM3U\nhttp://localhost"), Buffer.from("<html>not audio</html>"), Buffer.alloc(MAX_AUDIO_BYTES + 1), Buffer.alloc(0)])("rejects non-audio and oversized signatures", bytes => { expect(() => audioFormat(bytes)).toThrow(); });
  it.each(["codec", "rate", "channels", "extra", "duration", "nan", "kind"])("rejects unsafe %s metadata", field => {
    const m = metadata(); if (field === "codec") m.streams[0].codec_name = "flac"; if (field === "rate") m.streams[0].sample_rate = "192000";
    if (field === "channels") m.streams[0].channels = 6; if (field === "extra") m.streams.push(m.streams[0]); if (field === "duration") m.format.duration = "31";
    if (field === "nan") m.format.duration = "NaN"; if (field === "kind") m.streams[0].codec_type = "video"; expect(() => audioMetadata(m)).toThrow();
  });
  it("requires exact normalized PCM and does not silently enable the audio worker", () => {
    expect(audioMetadata(metadata(), true).durationMs).toBe(3000); const m = metadata(); m.streams[0].codec_name = "mp3"; expect(() => audioMetadata(m, true)).toThrow();
    vi.stubEnv("AUDIO_PROCESSING_ENABLED", "false"); const hash = motionConfigurationHash(); expect(requireAudioProcessing).toThrow("not enabled");
    vi.stubEnv("AUDIO_PROCESSING_ENABLED", "true"); expect(requireAudioProcessing).not.toThrow(); expect(motionConfigurationHash()).not.toBe(hash); vi.unstubAllEnvs();
  });
  it("bounds streamed bytes, ignores claimed length and cancels a rejected body", async () => {
    const cancel = vi.fn(), body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_AUDIO_BYTES + 1)); }, cancel });
    await expect(boundedAudioUpload(new Request("https://example.test", { method: "POST", headers: { "Content-Type": "audio/wav", "Content-Length": "1" }, body, duplex: "half" } as RequestInit))).rejects.toThrow("8 MB"); expect(cancel).toHaveBeenCalledOnce();
    await expect(boundedAudioUpload(new Request("https://example.test", { method: "POST", body: "x" }))).rejects.toThrow("WAV or MP3");
  });
  it("keeps old silent hashes stable and binds every music change to new shot reviews", () => {
    const d = storyboardDocument.parse(document); expect(d).not.toHaveProperty("soundtrack"); const hash = shotHash(d, d.shots[0]);
    const withMusic = storyboardDocument.parse({ ...d, soundtrack: music }); expect(shotHash(withMusic, withMusic.shots[0])).not.toBe(hash);
    expect(shotHash({ ...withMusic, soundtrack: { ...music, gainPercent: 30 } }, withMusic.shots[0])).not.toBe(shotHash(withMusic, withMusic.shots[0]));
    expect(soundtrackRangeFits(withMusic, 3000)).toBe(true); expect(soundtrackRangeFits(withMusic, 2999)).toBe(false);
  });
  it.each([{ gainPercent: 101 }, { startMs: 20001 }, { startMs: 29000 }, { fadeInMs: 2000, fadeOutMs: 1000 }, { url: "http://127.0.0.1" }, { filter: "amovie=remote" }])("rejects unsafe soundtrack settings %j", change => {
    expect(storyboardDocument.safeParse({ ...document, soundtrack: { ...music, ...change } }).success).toBe(false);
  });
});
const suite = process.env.TEST_FFMPEG_PATH && process.env.TEST_FFPROBE_PATH ? describe : describe.skip;
suite("real audio normalization and muxing", () => {
  let dir: string, source: Buffer;
  beforeAll(async () => {
    vi.stubEnv("FFMPEG_PATH", process.env.TEST_FFMPEG_PATH!); vi.stubEnv("FFPROBE_PATH", process.env.TEST_FFPROBE_PATH!); vi.stubEnv("AUDIO_PROCESSING_ENABLED", "true");
    dir = await mkdtemp(join(tmpdir(), "music-fixture-"));
    await exec(process.env.FFMPEG_PATH!, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=4", "-c:a", "pcm_s16le", "-metadata", "title=private fixture title", join(dir, "source.wav")], { timeout: 10000 }); source = await readFile(join(dir, "source.wav"));
  });
  afterAll(async () => { vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); });
  it("normalizes WAV and MP3 to metadata-stripped stereo PCM, not source passthrough", async () => {
    const wav = await normalizeAudio(source); expect(wav.durationMs).toBe(4000); expect(wav.bytes.includes(Buffer.from("private fixture title"))).toBe(false); expect(wav.bytes.equals(source)).toBe(false);
    await exec(process.env.FFMPEG_PATH!, ["-nostdin", "-v", "error", "-i", join(dir, "source.wav"), "-c:a", "libmp3lame", join(dir, "source.mp3")], { timeout: 10000 });
    const mp3 = await normalizeAudio(await readFile(join(dir, "source.mp3"))); expect(Math.abs(mp3.durationMs - 4000)).toBeLessThan(100); expect(audioFormat(mp3.bytes)).toBe("wav");
  });
  it("exports H264/AAC and verifies actual decoded gain and fades", async () => {
    const normalized = await normalizeAudio(source), d = storyboardDocument.parse({ ...document, soundtrack: music });
    const result = await renderMotion(d, new Map([[music.id, normalized.bytes]])); expect(result.durationMs).toBe(2000);
    const file = join(dir, "with-music.mp4"); await writeFile(file, result.bytes);
    const decoded = await exec(process.env.FFMPEG_PATH!, ["-nostdin", "-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { timeout: 10000, encoding: "buffer", maxBuffer: 1000000 });
    const rms = (start: number, end: number) => { let sum = 0, count = 0; for (let i = Math.floor(start * 48000); i < end * 48000; i++) { const v = decoded.stdout.readFloatLE(i * 4); sum += v * v; count++; } return Math.sqrt(sum / count); };
    const middle = rms(0.8, 1.2); expect(middle).toBeGreaterThan(0.01); expect(middle).toBeLessThan(0.03); expect(rms(0, 0.05)).toBeLessThan(middle / 3); expect(rms(1.95, 2)).toBeLessThan(middle / 3);
    expect(result.bytes.includes(Buffer.from("private fixture title"))).toBe(false);
  }, 60000);
  it("rejects corrupt audio, missing/short sources and a disabled audio renderer", async () => {
    await expect(normalizeAudio(source.subarray(0, 44))).rejects.toThrow();
    const d = storyboardDocument.parse({ ...document, soundtrack: music }); await expect(renderMotion(d, new Map())).rejects.toThrow("missing");
    const normalized = await normalizeAudio(source); const longer = { ...d, soundtrack: { ...music, startMs: 3000 } }; await expect(renderMotion(longer, new Map([[music.id, normalized.bytes]]))).rejects.toThrow("shorter");
    vi.stubEnv("AUDIO_PROCESSING_ENABLED", "false"); await expect(renderMotion(d, new Map([[music.id, normalized.bytes]]))).rejects.toThrow("not enabled");
  }, 60000);
});
