import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertClipSignature, boundedClipUpload, clipMetadata, normalizeClip } from "../src/lib/video/clip-normalizer";
import { renderMotion } from "../src/lib/video/render";
import { storyboardDocument } from "../src/lib/video/document";
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
  it.each(["size", "fps", "duration", "codec", "pixel", "rotation", "truncated", "subtitle", "nonfinite"])("rejects unsafe %s metadata", field => {
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
  it("refuses overlapping decoder work", async () => {
    const first = normalizeClip(source); await expect(normalizeClip(source)).rejects.toThrow("busy"); await first;
  }, 40000);
});
