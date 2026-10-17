import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { renderMotion, renderShotFrame, motionRendererAvailable } from "../src/lib/video/render";
import { storyboardDocument } from "../src/lib/video/document";
import { VIDEO_FORMATS, VIDEO_LAYOUTS } from "../src/lib/video/layout";
const enabled = !!process.env.TEST_FFMPEG_PATH && !!process.env.TEST_FFPROBE_PATH;
const suite = enabled ? describe : describe.skip;
suite("actual local FFmpeg rendering", () => {
  beforeAll(() => {
    vi.stubEnv("FFMPEG_PATH", process.env.TEST_FFMPEG_PATH!); vi.stubEnv("FFPROBE_PATH", process.env.TEST_FFPROBE_PATH!);
    vi.stubEnv("MOTION_RENDERING_ENABLED", "true"); vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "6");
  });
  afterAll(() => vi.unstubAllEnvs());
  const document = storyboardDocument.parse({ title: "Local motion fixture", background: "#e5d9c7", logo: null, shots: [
    { id: "opening", label: "Opening", caption: "Local render test", durationMs: 1500, motion: "fade", asset: null },
    { id: "close", label: "Close", caption: "No model-generated footage", durationMs: 1500, motion: "hold", asset: null },
  ] });
  it("encodes, concatenates and probes a real bounded MP4", async () => {
    expect(await motionRendererAvailable()).toBe(true);
    const result = await renderMotion(document, new Map());
    expect(result).toMatchObject({ width: 720, height: 1280, durationMs: 3000 });
    expect(result.bytes.toString("ascii", 4, 8)).toBe("ftyp"); expect(result.bytes.length).toBeLessThan(2000000);
    if (process.env.MOTION_SAMPLE_OUTPUT) await writeFile(process.env.MOTION_SAMPLE_OUTPUT, result.bytes);
  }, 40000);
  it.each(VIDEO_FORMATS)("renders exact logo/artwork and validates a real %s MP4", async format => {
    const original = await sharp({ create: { width: 80, height: 80, channels: 4, background: "#dd3322" } }).png().toBuffer();
    const assets = new Map([["original", original]]), ref = { id: "original", sha256: "a".repeat(64) };
    const d = storyboardDocument.parse({ ...document, format, logo: ref, shots: [{ ...document.shots[0], motion: "hold", caption: "Considered spaces", durationMs: 1000, asset: ref }] });
    const frame = await renderShotFrame(d, 0, assets), l = VIDEO_LAYOUTS[format];
    expect(await sharp(frame).metadata()).toMatchObject({ width: l.width, height: l.height });
    const { data } = await sharp(frame).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const box of [l.logo, l.media]) {
      const at = (Math.floor(box.y + box.height / 2) * l.width + Math.floor(box.x + box.width / 2)) * 3;
      expect([...data.subarray(at, at + 3)]).toEqual([221, 51, 34]);
    }
    const output = await renderMotion(d, assets);
    expect(output).toMatchObject({ width: l.width, height: l.height, durationMs: 1000 });
    expect(output.bytes.toString("ascii", 4, 8)).toBe("ftyp");
  }, 40000);
  it("renders exact approved image bytes without network access and rejects missing assets", async () => {
    const d = { ...document, shots: [{ ...document.shots[0], asset: { id: "original", sha256: "a".repeat(64) } }] };
    await expect(renderShotFrame(d, 0, new Map())).rejects.toThrow("missing");
    const bytes = await sharp({ create: { width: 50, height: 50, channels: 4, background: "#d04a3a" } }).png().toBuffer();
    const frame = await renderShotFrame(d, 0, new Map([["original", bytes]]));
    expect(await sharp(frame).metadata()).toMatchObject({ width: 720, height: 1280, format: "png" });
  });
  it("rejects unsupported captions and measured overflow before encoding", async () => {
    for (const caption of ["An emoji 🚀", "W".repeat(100)]) {
      await expect(renderShotFrame({ ...document, shots: [{ ...document.shots[0], caption }] }, 0, new Map())).rejects.toThrow();
    }
  });
  it("refuses overlapping local renders instead of overloading the process", async () => {
    const first = renderMotion(document, new Map());
    await expect(renderMotion(document, new Map())).rejects.toThrow("busy"); await first;
  }, 40000);
});
