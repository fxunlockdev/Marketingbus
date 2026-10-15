import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { boundedUpload, MAX_IMAGE_BYTES, normalizeImage } from "../src/lib/assets/images";
describe("brand image validation", () => {
  it("re-encodes genuine images and strips metadata", async () => {
    const input = await sharp({ create: { width: 10, height: 12, channels: 4, background: "#c67139" } }).png().withMetadata({ orientation: 6 }).toBuffer();
    const result = await normalizeImage(input); const metadata = await sharp(result.data).metadata();
    expect(result.width).toBe(12); expect(result.height).toBe(10);
    expect(metadata.format).toBe("webp"); expect(metadata.exif).toBeUndefined();
    expect(result.sha256).toHaveLength(64);
  });
  it("rejects active content and invalid files even if named like images", async () => {
    await expect(normalizeImage(Buffer.from('<svg><script>alert(1)</script></svg>'))).rejects.toThrow("genuine");
    await expect(normalizeImage(Buffer.from([255, 216, 255, 0, 0]))).rejects.toThrow("safely decoded");
  });
  it("bounds bytes independently of Content-Length", async () => {
    const request = new Request("https://example.test", { method: "POST", headers: { "Content-Length": "1" }, body: new Uint8Array(MAX_IMAGE_BYTES + 1) });
    await expect(boundedUpload(request)).rejects.toThrow("5 MB");
  });
  it("rejects oversized decoded dimensions", async () => {
    const input = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
    await expect(normalizeImage(input)).rejects.toThrow("16 megapixels");
  });
});
