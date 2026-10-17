import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { assertClipSignature, boundedClipUpload, clipMetadata, normalizeClip } from "../src/lib/video/clip-normalizer";
import { renderMotion } from "../src/lib/video/render";
import { storyboardDocument } from "../src/lib/video/document";
import { VIDEO_FORMATS, videoLayout } from "../src/lib/video/layout";
const exec = promisify(execFile);
const metadata = () => ({ streams: [{ codec_type: "video", codec_name: "h264", width: 720, height: 1280, pix_fmt: "yuv420p", avg_frame_rate: "24/1", duration: "2.0" }], format: { duration: "2.0" } });
describe("clip boundaries", () => {
  it("requires genuine bounded MP4 signatures and rejects playlists/HTML", () => {
    for (const b of [Buffer.from("#EXTM3U"), Buffer.from("<html>not video</html>"), Buffer.alloc(21 * 1024 * 1024)]) expect(() => assertClipSignature(b)).toThrow();
  });
  it("allows one bounded H.264 stream with optional AAC source audio only", () => {
    expect(clipMetadata(metadata(), true).durationMs).toBe(2000);
    const m = metadata(); (m.streams as unknown[]).push({ codec_type: "audio", codec_name: "aac" });
    expect(clipMetadata(m).durationMs).toBe(2000); expect(() => clipMetadata(m, true)).toThrow();
  });
  it.each(["size", "fps", "duration", "codec", "pixel", "rotation", "truncated", "subtitle", "nonfinite", "anamorphic"])("rejects unsafe %s metadata", field => {
    const m = metadata(), v = m.streams[0];
    if (field === "size") v.width = 4096;
    if (field === "fps") v.avg_frame_rate = "120/1";
    if (field === "duration") m.format.duration = v.duration = "60";
    if (field === "codec") v.codec_name = "hevc";
    if (field === "pixel") v.pix_fmt = "yuv420p10le";
    if (field === "rotation") Object.assign(v, { side_data_list: [{ rotation: 90 }] });
    if (field === "truncated") v.duration = "1";
    if (field === "subtitle") (m.streams as unknown[]).push({ codec_type: "subtitle", codec_name: "mov_text" });
    if (field === "nonfinite") v.avg_frame_rate = "0/0";
    if (field === "anamorphic") Object.assign(v, { sample_aspect_ratio: "4:3" });
    expect(() => clipMetadata(m)).toThrow();
  });
  it("counts actual streamed bytes and cancels oversized upload, ignoring claimed length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(21 * 1024 * 1024)); }, cancel });
    const request = new Request("http://localhost/fixture", { method: "POST", headers: { "Content-Type": "video/mp4", "Content-Length": "1" }, body, duplex: "half" } as RequestInit);
    await expect(boundedClipUpload(request)).rejects.toThrow("20 MB"); expect(cancel).toHaveBeenCalledOnce();
    await expect(boundedClipUpload(new Request("http://localhost/fixture", { method: "POST", body: "data" }))).rejects.toThrow("MP4");
  });
});
const suite = process.env.TEST_FFMPEG_PATH && process.env.TEST_FFPROBE_PATH ? describe : describe.skip;
suite("real clip quarantine normalization and assembly", () => {
  let dir: string, source: Buffer;
  beforeAll(async () => {
    vi.stubEnv("FFMPEG_PATH", process.env.TEST_FFMPEG_PATH!); vi.stubEnv("FFPROBE_PATH", process.env.TEST_FFPROBE_PATH!);
    dir = await mkdtemp(join(tmpdir(), "clip-fixture-"));
    await exec(process.env.TEST_FFMPEG_PATH!, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-metadata", "title=private fixture metadata", "-movflags", "+faststart", join(dir, "fixture.mp4")], { timeout: 10000 });
    source = await readFile(join(dir, "fixture.mp4"));
  });
  afterAll(async () => { vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); });
  it("re-encodes genuine footage, removes audio/metadata and assembles it with motion cards", async () => {
    const normalized = await normalizeClip(source);
    expect(normalized.durationMs).toBe(2000); expect(normalized.bytes.includes(Buffer.from("private fixture metadata"))).toBe(false);
    const doc = storyboardDocument.parse({ title: "Mixed local test", background: "#e5d9c7", logo: null, shots: [
      { id: "clip", label: "Footage", caption: "Reviewed footage", durationMs: 2000, motion: "fade", asset: null, clip: { id: "fixture", sha256: "a".repeat(64) } },
      { id: "card", label: "Card", caption: "Explore more", durationMs: 1000, motion: "hold", asset: null },
    ] });
    const output = await renderMotion(doc, new Map([["fixture", normalized.bytes]]));
    expect(output).toMatchObject({ durationMs: 3000, width: 720, height: 1280 });
    expect(output.bytes.toString("ascii", 4, 8)).toBe("ftyp");
  }, 60000);
  it("rejects corrupted MP4 rather than rendering or exposing the original", async () => {
    await expect(normalizeClip(source.subarray(0, 128))).rejects.toThrow();
  });
  it.each(VIDEO_FORMATS)("composites real footage into the %s media window without covering it", async format => {
    const normalized = await normalizeClip(source);
    const d = storyboardDocument.parse({ title: "Format footage", background: "#ffffff", format, logo: null, shots: [{ id: "clip", label: "Footage", caption: "Reviewed footage", durationMs: 1000, motion: "hold", asset: null, clip: { id: "fixture", sha256: "a".repeat(64) } }] });
    const result = await renderMotion(d, new Map([["fixture", normalized.bytes]])), l = videoLayout(d);
    expect(result).toMatchObject({ width: l.width, height: l.height, durationMs: 1000 });
    const file = join(dir, `format-${format}.mp4`); await writeFile(file, result.bytes);
    const frame = await exec(process.env.TEST_FFMPEG_PATH!, ["-nostdin", "-v", "error", "-ss", "0.5", "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"], { timeout: 10000, encoding: "buffer", maxBuffer: 3000000 });
    const { data } = await sharp(frame.stdout).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [...data.subarray((y * l.width + x) * 3, (y * l.width + x) * 3 + 3)];
    expect(at(l.media.x + l.media.width / 2, l.media.y + l.media.height / 2).some(v => v < 150)).toBe(true);
    expect(at(10, 10).every(v => v > 230)).toBe(true);
    expect(at(l.panel.x + 10, l.panel.y + l.panel.height / 2).every(v => v < 70)).toBe(true);
  }, 40000);
  it("refuses overlapping decoder work", async () => {
    const first = normalizeClip(source); await expect(normalizeClip(source)).rejects.toThrow("busy"); await first;
  }, 40000);
  it("preserves landscape aspect and uses the selected time and crop in actual encoded pixels", async () => {
    const pattern = "color=c=red:s=640x360:r=24:d=2,drawbox=x=320:y=0:w=320:h=360:color=blue:t=fill,drawbox=x=0:y=0:w=320:h=360:color=green:t=fill:enable='gte(t,1)',drawbox=x=320:y=0:w=320:h=360:color=yellow:t=fill:enable='gte(t,1)'";
    await exec(process.env.TEST_FFMPEG_PATH!, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", pattern, "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", join(dir, "colour-source.mp4")], { timeout: 10000 });
    const normalized = await normalizeClip(await readFile(join(dir, "colour-source.mp4")));
    const normalizedFile = join(dir, "landscape.mp4"); await writeFile(normalizedFile, normalized.bytes);
    const p = JSON.parse((await exec(process.env.TEST_FFPROBE_PATH!, ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", normalizedFile], { timeout: 5000 })).stdout);
    expect(p.streams).toEqual([{ width: 640, height: 360 }]);
    async function sample(startMs: number, fit: "cover" | "contain", x: number) {
      const d = storyboardDocument.parse({ title: "Pixel evidence", background: "#ffffff", logo: null, shots: [{ id: "clip", label: "Footage", caption: "Pixel test", durationMs: 1000, motion: "hold", asset: null, clip: { id: "fixture", sha256: "a".repeat(64) }, clipEdit: { startMs, fit, x, y: 50 } }] });
      const result = await renderMotion(d, new Map([["fixture", normalized.bytes]]));
      const file = join(dir, `result-${startMs}-${fit}-${x}.mp4`); await writeFile(file, result.bytes);
      const frame = await exec(process.env.TEST_FFMPEG_PATH!, ["-nostdin", "-v", "error", "-ss", "0.5", "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"], { timeout: 10000, encoding: "buffer", maxBuffer: 2000000 });
      const { data } = await sharp(frame.stdout).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const at = (px: number, py: number) => [...data.subarray((py * 720 + px) * 3, (py * 720 + px) * 3 + 3)];
      return { center: at(360, 550), top: at(360, 245), bytes: result.bytes };
    }
    const left = await sample(0, "cover", 0), right = await sample(0, "cover", 100), later = await sample(1000, "cover", 0), fit = await sample(0, "contain", 50);
    expect(left.center[0]).toBeGreaterThan(180); expect(left.center[2]).toBeLessThan(80);
    expect(right.center[2]).toBeGreaterThan(180); expect(right.center[0]).toBeLessThan(80);
    expect(later.center[1]).toBeGreaterThan(80); expect(later.center[0]).toBeLessThan(80); expect(later.center[2]).toBeLessThan(80);
    expect(fit.top.every(v => v > 220)).toBe(true); expect(left.top.some(v => v < 80)).toBe(true);
  }, 60000);
});
