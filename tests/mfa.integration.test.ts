import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { hash } from "bcryptjs";
import { db } from "../src/lib/db";
import {
  manageMfa,
  mfaStatus,
  verifyLoginFactor,
} from "../src/lib/identity/mfa";
import { consumeIdentityToken } from "../src/lib/identity/service";
import { decodeBase32, totp } from "../src/lib/identity/totp";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (
  process.env.TEST_DATABASE_URL &&
  (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL ||
    !["localhost", "127.0.0.1"].includes(
      new URL(process.env.TEST_DATABASE_URL).hostname
    ))
)
  throw Error("Local test DB required");
suite("MFA enrollment, recovery and session boundaries", () => {
  const ids: string[] = [],
    password = "fixture-password-2026";
  beforeAll(() => {
    vi.stubEnv(
      "SECRET_ENCRYPTION_KEYS_JSON",
      JSON.stringify({ test: randomBytes(32).toString("base64") })
    );
    vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test");
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: ids } } });
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  async function user() {
    const row = await db.user.create({
      data: {
        name: "MFA FIXTURE",
        email: `mfa-${crypto.randomUUID()}@example.test`,
        passwordHash: await hash(password, 4),
        emailVerifiedAt: new Date(),
      },
    });
    ids.push(row.id);
    return row;
  }
  it("requires password and fresh enrollment, encrypts secrets, invalidates old sessions", async () => {
    const u = await user(),
      now = new Date();
    await expect(
      manageMfa(
        u.id,
        0,
        { action: "begin", password: "wrong-password-value" },
        now
      )
    ).rejects.toThrow("incorrect");
    const begin = await manageMfa(u.id, 0, { action: "begin", password }, now);
    expect(
      JSON.stringify(
        await db.mfaCredential.findUnique({ where: { userId: u.id } })
      )
    ).not.toContain(begin.secret);
    await db.session.create({
      data: {
        id: crypto.randomUUID(),
        userId: u.id,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const enabled = await manageMfa(
      u.id,
      0,
      {
        action: "confirm",
        password,
        code: totp(decodeBase32(begin.secret), now.getTime()),
      },
      now
    );
    expect(enabled.recoveryCodes).toHaveLength(8);
    expect(await db.session.count({ where: { userId: u.id } })).toBe(0);
    expect((await mfaStatus(u.id)).enabled).toBe(true);
    await expect(
      verifyLoginFactor(u.id, 0, enabled.recoveryCodes[0], now)
    ).rejects.toThrow("security changed");
    await expect(verifyLoginFactor(u.id, 1, "", now)).rejects.toThrow(
      "authenticator"
    );
    await expect(
      verifyLoginFactor(
        u.id,
        1,
        totp(decodeBase32(begin.secret), now.getTime()),
        now
      )
    ).rejects.toThrow("unused");
    const later = new Date(now.getTime() + 30000),
      code = totp(decodeBase32(begin.secret), later.getTime());
    const attempts = await Promise.allSettled([
      verifyLoginFactor(u.id, 1, code, later),
      verifyLoginFactor(u.id, 1, code, later),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    await verifyLoginFactor(u.id, 1, enabled.recoveryCodes[0], later);
    await expect(
      verifyLoginFactor(u.id, 1, enabled.recoveryCodes[0], later)
    ).rejects.toThrow("unused");
    expect((await mfaStatus(u.id)).recoveryCodesRemaining).toBe(7);
    await manageMfa(
      u.id,
      1,
      { action: "disable", password, code: enabled.recoveryCodes[1] },
      later
    );
    expect((await mfaStatus(u.id)).enabled).toBe(false);
    await expect(verifyLoginFactor(u.id, 1)).rejects.toThrow(
      "security changed"
    );
  });
  it("does not bypass MFA through password recovery", async () => {
    const u = await user(),
      now = new Date();
    const begin = await manageMfa(u.id, 0, { action: "begin", password }, now);
    await manageMfa(
      u.id,
      0,
      {
        action: "confirm",
        password,
        code: totp(decodeBase32(begin.secret), now.getTime()),
      },
      now
    );
    const token = randomBytes(32).toString("base64url");
    await db.identityToken.create({
      data: {
        id: createHash("sha256").update(token).digest("hex"),
        userId: u.id,
        kind: "RESET_PASSWORD",
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await consumeIdentityToken(
      token,
      "RESET_PASSWORD",
      "new-fixture-password-2026"
    );
    expect((await mfaStatus(u.id)).enabled).toBe(true);
    await expect(verifyLoginFactor(u.id, 2, "")).rejects.toThrow(
      "authenticator"
    );
  });
  it("expires pending setup and rejects unverified enrollment", async () => {
    const u = await user(),
      now = new Date(),
      begin = await manageMfa(u.id, 0, { action: "begin", password }, now);
    await expect(
      manageMfa(
        u.id,
        0,
        {
          action: "confirm",
          password,
          code: totp(decodeBase32(begin.secret), now.getTime()),
        },
        new Date(now.getTime() + 11 * 60000)
      )
    ).rejects.toThrow("expired");
    await db.user.update({
      where: { id: u.id },
      data: { emailVerifiedAt: null },
    });
    await expect(
      manageMfa(u.id, 0, { action: "begin", password })
    ).rejects.toThrow("Verify your email");
  });
});
