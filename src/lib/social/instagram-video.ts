import type { z } from "zod";
import type { publicationVideo } from "./contracts";
import { fingerprint } from "./instagram-jpeg";
export const instagramVideoVersion = "approved-reel-mp4-v1";
export type InstagramVideo = { version: typeof instagramVideoVersion; bytes: Uint8Array; sha256: string };
export function instagramVideo(bytes: Uint8Array, expected: z.infer<typeof publicationVideo>): InstagramVideo {
  if (bytes.length < 12 || bytes.length > 20 * 1024 * 1024 || bytes.length !== expected.bytes ||
      Buffer.from(bytes).toString("ascii", 4, 8) !== "ftyp" || fingerprint(bytes) !== expected.sha256) throw Error("Approved Reel bytes changed.");
  return { version: instagramVideoVersion, bytes, sha256: expected.sha256 };
}
// One RFC byte range only. No multipart amplification or arbitrary remote fetch.
export function reelRange(header: string | null, length: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw Error("Unsatisfiable range");
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if (first !== null && !Number.isSafeInteger(first) || last !== null && !Number.isSafeInteger(last)) throw Error("Unsatisfiable range");
  const start = first ?? Math.max(0, length - (last ?? 0)), end = first === null || last === null ? length - 1 : Math.min(last, length - 1);
  if (start < 0 || start >= length || end < start || first === null && !last) throw Error("Unsatisfiable range");
  return { start, end };
}
