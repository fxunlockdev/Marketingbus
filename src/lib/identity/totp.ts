import { createHmac, timingSafeEqual } from "node:crypto";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes: Uint8Array) {
  let buffer = 0,
    bits = 0,
    encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits) encoded += alphabet[(buffer << (5 - bits)) & 31];
  return encoded;
}
export function decodeBase32(value: string) {
  if (!/^[A-Z2-7]{32}$/.test(value))
    throw Error("Invalid authenticator secret");
  let buffer = 0,
    bits = 0;
  const bytes: number[] = [];
  for (const char of value) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
    }
    buffer &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}
// RFC 4226 dynamic truncation, RFC 6238 30-second counter. SHA-1 is the TOTP PRF, not password hashing.
export function totp(secret: Buffer, timeMs: number, digits = 6) {
  if (![6, 8].includes(digits) || !Number.isFinite(timeMs) || timeMs < 0)
    throw Error("Invalid TOTP parameters");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30000)));
  const mac = createHmac("sha1", secret).update(counter).digest(),
    offset = mac[mac.length - 1] & 15;
  return String(
    (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  ).padStart(digits, "0");
}
export function verifyTotp(
  secret: string,
  code: string,
  lastStep: number,
  now: Date
) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now.getTime() / 30000),
    key = decodeBase32(secret);
  for (const step of [current, current - 1, current + 1]) {
    if (step < 0 || step <= lastStep) continue;
    if (
      timingSafeEqual(Buffer.from(code), Buffer.from(totp(key, step * 30000)))
    )
      return step;
  }
  return null;
}
