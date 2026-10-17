import { createHash, randomBytes } from "node:crypto";
import { compare } from "bcryptjs";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { encryptionReady, openSecret, sealSecret } from "../secrets";
import { base32, verifyTotp } from "./totp";
const recoveryHash = (userId: string, code: string) =>
  createHash("sha256")
    .update(`mfa-recovery:${userId}:${code.toLowerCase().replaceAll("-", "")}`)
    .digest("hex");
export const mfaAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("begin"),
      password: z.string().min(12).max(64),
    })
    .strict(),
  z
    .object({
      action: z.enum(["confirm", "disable"]),
      password: z.string().min(12).max(64),
      code: z.string().min(6).max(64),
    })
    .strict(),
]);
export async function mfaStatus(userId: string) {
  const record = await db.mfaCredential.findUnique({ where: { userId } });
  return {
    enabled: !!record?.enabledAt,
    available: encryptionReady(),
    recoveryCodesRemaining: record?.recoveryHashes.length ?? 0,
    requiredByWorkspace: await db.membership.count({ where: { userId, organization: { requireMfa: true } } }) > 0,
  };
}
export async function consumeFactor(
  tx: Prisma.TransactionClient,
  userId: string,
  code: string,
  now: Date
) {
  const record = await tx.mfaCredential.findUnique({ where: { userId } });
  if (!record?.enabledAt) return;
  const step = verifyTotp(
    openSecret(record.encryptedSecret, `mfa:${userId}`),
    code,
    record.lastStep,
    now
  );
  if (step !== null) {
    await tx.mfaCredential.update({
      where: { userId },
      data: { lastStep: step },
    });
    return;
  }
  const hash = recoveryHash(userId, code);
  if (
    /^[a-fA-F0-9-]{32,39}$/.test(code) &&
    record.recoveryHashes.includes(hash)
  ) {
    await tx.mfaCredential.update({
      where: { userId },
      data: { recoveryHashes: record.recoveryHashes.filter((h) => h !== hash) },
    });
    return;
  }
  throw new AppError(
    401,
    "Enter a valid unused authenticator or recovery code. If you just used a code, wait for the next one."
  );
}
// Called only after password validation; no session is issued until this transaction succeeds.
export async function verifyLoginFactor(
  userId: string,
  expectedVersion: number,
  code = "",
  now = new Date()
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.authVersion !== expectedVersion)
      throw new AppError(401, "Account security changed. Sign in again.");
    await consumeFactor(tx, userId, code, now);
    return user.authVersion;
  });
}
export async function manageMfa(
  userId: string,
  expectedVersion: number,
  raw: unknown,
  now = new Date()
) {
  const input = mfaAction.parse(raw),
    user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await compare(input.password, user.passwordHash)))
    throw new AppError(401, "Password is incorrect.");
  return db.$transaction(async (tx) => {
    // Policy changes and disabling a factor must not race.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(71403221)`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    const current = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (
      current.authVersion !== expectedVersion ||
      current.passwordHash !== user.passwordHash
    )
      throw new AppError(401, "Account security changed. Sign in again.");
    const record = await tx.mfaCredential.findUnique({ where: { userId } });
    if (input.action === "begin") {
      if (!current.emailVerifiedAt)
        throw new AppError(
          409,
          "Verify your email before enrolling an authenticator."
        );
      if (record?.enabledAt) throw new AppError(409, "MFA is already enabled.");
      if (!encryptionReady())
        throw new AppError(503, "MFA requires the server encryption keyring.");
      const secret = base32(randomBytes(20));
      const data = {
        pendingSecret: sealSecret(secret, `mfa-pending:${userId}`),
        pendingExpiresAt: new Date(now.getTime() + 10 * 60000),
      };
      await tx.mfaCredential.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
      return {
        ok: true,
        secret,
        recoveryCodes: [] as string[],
        signInAgain: false,
      };
    }
    if (input.action === "confirm") {
      if (
        record?.enabledAt ||
        !record?.pendingSecret ||
        !record.pendingExpiresAt ||
        record.pendingExpiresAt <= now
      )
        throw new AppError(
          409,
          "Authenticator enrollment expired. Start again."
        );
      const secret = openSecret(record.pendingSecret, `mfa-pending:${userId}`),
        step = verifyTotp(secret, input.code, -1, now);
      if (step === null)
        throw new AppError(401, "Authenticator code is incorrect.");
      const codes = Array.from({ length: 8 }, () =>
        randomBytes(16)
          .toString("hex")
          .match(/.{1,4}/g)!
          .join("-")
      );
      await tx.mfaCredential.update({
        where: { userId },
        data: {
          encryptedSecret: sealSecret(secret, `mfa:${userId}`),
          pendingSecret: "",
          pendingExpiresAt: null,
          enabledAt: now,
          lastStep: step,
          recoveryHashes: codes.map((c) => recoveryHash(userId, c)),
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: { authVersion: { increment: 1 } },
      });
      await tx.session.deleteMany({ where: { userId } });
      return { ok: true, secret: "", recoveryCodes: codes, signInAgain: true };
    }
    if (!record?.enabledAt) throw new AppError(409, "MFA is not enabled.");
    if (await tx.membership.count({ where: { userId, organization: { requireMfa: true } } }))
      throw new AppError(409, "A workspace requires MFA. Its owner must remove that requirement or your membership before you can disable MFA.");
    await consumeFactor(tx, userId, input.code, now);
    await tx.mfaCredential.delete({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: { authVersion: { increment: 1 } },
    });
    await tx.session.deleteMany({ where: { userId } });
    return {
      ok: true,
      secret: "",
      recoveryCodes: [] as string[],
      signInAgain: true,
    };
  });
}
