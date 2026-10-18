import { createHash } from "node:crypto";
import sharp from "sharp";
import type { PublicationPayload } from "./contracts";

export const instagramJpegVersion = `ig-jpeg-v1:${sharp.versions.sharp}:${sharp.versions.vips}`;
export const fingerprint = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export type InstagramJpeg = { bytes: Uint8Array; sha256: string; version: string };
let conversions = 0;
// Our supported profile, not a claim that these are all Instagram's allowed formats.
export async function instagramJpeg(png: Uint8Array, image: NonNullable<PublicationPayload["image"]>): Promise<InstagramJpeg> {
  if (conversions >= 2) throw Error("Image conversion is busy.");
  if (image.width !== 1080 || ![1080, 1350].includes(image.height) || png.length !== image.bytes || png.length > 5 * 1024 * 1024 || fingerprint(png) !== image.sha256) throw Error("Invalid approved Instagram image.");
  conversions++;
  try {
    const input = sharp(png, { limitInputPixels: 2_000_000, failOn: "warning", animated: false }).timeout({ seconds: 5 });
    const metadata = await input.metadata();
    if (metadata.format !== "png" || metadata.width !== image.width || metadata.height !== image.height || (metadata.pages ?? 1) !== 1) throw Error("Approved image geometry changed.");
    const { data, info } = await input.flatten({ background: "#ffffff" }).toColourspace("srgb").jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
    if (info.width !== image.width || info.height !== image.height || !data.length || data.length > 4 * 1024 * 1024) throw Error("Instagram delivery exceeds its supported profile.");
    return { bytes: data, sha256: fingerprint(data), version: instagramJpegVersion };
  } finally { conversions--; }
}
