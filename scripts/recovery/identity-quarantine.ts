import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

// Rehearsal-only: called with the fresh local target created by the guarded runner.
// No production CLI, environment fallback, provider call or cutover behavior.
const tables = ["User", "Session", "IdentityToken", "TeamInvitation", "EmailOutbox", "MfaCredential", "SocialOAuthFlow"] as const;
type Counts = Record<typeof tables[number], number>;
export type IdentityQuarantinePreview = { database: string; fingerprint: string; counts: Counts };
export function assertQuarantineTarget(name: string) {
  if (!/^mb_restore_[a-f0-9]{24}_target$/.test(name)) throw Error("Identity quarantine requires the exact generated rehearsal target.");
}
async function assertDatabase(tx: Prisma.TransactionClient, database: string) {
  const actual = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (actual[0]?.name !== database) throw Error("Identity quarantine target mismatch.");
}
async function snapshot(tx: Prisma.TransactionClient, database: string): Promise<IdentityQuarantinePreview> {
  await assertDatabase(tx, database);
  const digest = createHash("sha256").update(database), counts = {} as Counts;
  let bytes = 0;
  for (const table of tables) {
    // Identifiers are a closed constant list, never supplied by the caller.
    const rows = await tx.$queryRawUnsafe<{ row: string }[]>(`SELECT to_jsonb(t)::text AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 10001`);
    if (rows.length > 10000) throw Error("Identity quarantine rehearsal row limit exceeded.");
    counts[table] = rows.length; digest.update(table);
    for (const { row } of rows) {
      const length = Buffer.byteLength(row); bytes += length;
      if (bytes > 8 * 1024 * 1024) throw Error("Identity quarantine rehearsal byte limit exceeded.");
      digest.update(`${length}:`).update(row);
    }
  }
  return { database, fingerprint: digest.digest("hex"), counts };
}
export async function previewIdentityQuarantine(db: PrismaClient, database: string) {
  assertQuarantineTarget(database);
  return db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    return snapshot(tx, database);
  }, { isolationLevel: "RepeatableRead", timeout: 10000 });
}
export async function quarantineRestoredIdentity(db: PrismaClient, database: string, expectedFingerprint: string, now = new Date()) {
  assertQuarantineTarget(database);
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint) || !Number.isFinite(now.getTime()) || now.getTime() < 0 || Math.floor(now.getTime() / 30000) + 1 > 2147483647) throw Error("Invalid identity quarantine confirmation.");
  return db.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '2000ms'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
    await assertDatabase(tx, database);
    // All writes to these tables serialize with this operation, not only callers
    // honoring an application advisory lock. The runner starts no app/worker.
    await tx.$executeRawUnsafe(`LOCK TABLE ${tables.map(t => `public."${t}"`).join(", ")} IN SHARE ROW EXCLUSIVE MODE`);
    const before = await snapshot(tx, database);
    if (before.fingerprint !== expectedFingerprint) throw Error("Identity quarantine preview changed. Inspect again.");
    await tx.user.updateMany({ data: { authVersion: { increment: 1 } } });
    await tx.session.deleteMany(); // Cascades temporary OAuth flows and their secrets.
    await tx.identityToken.updateMany({ where: { usedAt: null }, data: { usedAt: now } });
    await tx.teamInvitation.updateMany({ where: { status: "PENDING" }, data: { status: "REVOKED" } });
    await tx.emailOutbox.updateMany({ where: { status: { in: ["QUEUED", "SENDING"] } }, data: { status: "EXPIRED", expiresAt: now, encryptedPayload: "", leaseUntil: null } });
    await tx.mfaCredential.updateMany({ data: { pendingSecret: "", pendingExpiresAt: null, recoveryHashes: [] } });
    // Do not revive TOTP steps that could have been consumed after the backup,
    // including the verifier's accepted +1 clock-skew window.
    // Keep the enrolled factor and never move an already later fence backwards.
    const step = Math.floor(now.getTime() / 30000) + 1;
    await tx.mfaCredential.updateMany({ where: { enabledAt: { not: null }, lastStep: { lt: step } }, data: { lastStep: step } });
    const after = await snapshot(tx, database);
    return { before, after, productionRecoveryVerified: false as const };
  }, { timeout: 10000 });
}
