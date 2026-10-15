import sharp from "sharp";
import { createHash } from "node:crypto";
import { AppError } from "../http";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const BUSINESS_ASSET_BYTES = 25 * 1024 * 1024;
export async function boundedUpload(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "Choose an image to upload.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > MAX_IMAGE_BYTES) { await reader.cancel(); throw new AppError(413, "Images must be 5 MB or smaller."); }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}
export async function normalizeImage(input: Buffer) {
  if (!input.length || input.length > MAX_IMAGE_BYTES) throw new AppError(413, "Images must be between 1 byte and 5 MB.");
  // Check signatures before invoking a decoder. SVG/HTML/PDF and disguised files are not accepted.
  const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = input[0] === 255 && input[1] === 216 && input[2] === 255;
  const webp = input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP";
  if (!png && !jpeg && !webp) throw new AppError(400, "Use a genuine PNG, JPEG or WebP image.");
  try {
    const decoder = sharp(input, { limitInputPixels: 16_000_000, failOn: "warning" });
    const meta = await decoder.metadata();
    if (!meta.width || !meta.height || (meta.pages || 1) > 1) throw Error("Animated or invalid image");
    // Re-encode, remove EXIF/location/embedded metadata, preserve transparency and correct orientation.
    const { data, info } = await decoder.rotate().webp({ lossless: true }).toBuffer({ resolveWithObject: true });
    if (data.length > MAX_IMAGE_BYTES) throw new AppError(413, "The normalized image exceeds 5 MB. Use a smaller image.");
    return { data, bytes: data.length, width: info.width, height: info.height, sha256: createHash("sha256").update(data).digest("hex") };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "This image could not be safely decoded. Use a still image of at most 16 megapixels.");
  }
}
