import { describe, it, expect } from "vitest";
import {
  base32,
  decodeBase32,
  totp,
  verifyTotp,
} from "../src/lib/identity/totp";
describe("RFC 6238 authenticator algorithm", () => {
  const key = Buffer.from("12345678901234567890");
  it("matches the published SHA-1 eight-digit vectors, including dates past 2038", () => {
    for (const [time, code] of [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ] as const)
      expect(totp(key, time * 1000, 8)).toBe(code);
  });
  it("round-trips base32 and enforces replay and bounded skew", () => {
    const secret = base32(key);
    expect(decodeBase32(secret)).toEqual(key);
    const now = new Date(1234567890000),
      step = Math.floor(now.getTime() / 30000),
      code = totp(key, now.getTime());
    expect(verifyTotp(secret, code, -1, now)).toBe(step);
    expect(verifyTotp(secret, code, step, now)).toBeNull();
    expect(
      verifyTotp(secret, code, -1, new Date(now.getTime() + 120000))
    ).toBeNull();
    expect(verifyTotp(secret, "123", -1, now)).toBeNull();
  });
});
