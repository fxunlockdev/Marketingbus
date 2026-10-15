import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { encryptionReady, sealSecret } from "../secrets";
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const passwordSchema = z.string().min(12, "Use at least 12 characters.").max(64).refine(v => Buffer.byteLength(v, "utf8") <= 72, "Password must fit within 72 UTF-8 bytes.");
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export function emailConfiguration() {
  if (process.env.EMAIL_DELIVERY_ENABLED !== "true" || !process.env.RESEND_API_KEY || !encryptionReady()) throw new AppError(503, "Email delivery is not configured yet. Contact the workspace operator.");
  const from = z.email().safeParse(process.env.RESEND_FROM_EMAIL);
  const ceiling = Number(process.env.EMAIL_DAILY_LIMIT || 100);
  let origin: URL; try { origin = new URL(process.env.APP_ORIGIN || ""); } catch { throw new AppError(503, "Email origin is not configured."); }
  if (!from.success || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || (origin.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(origin.hostname))) || !Number.isInteger(ceiling) || ceiling < 1 || ceiling > 1000) throw new AppError(503, "Email delivery configuration needs attention.");
  return { from: from.data, origin: origin.origin, ceiling, key: process.env.RESEND_API_KEY };
}
export async function queueIdentityEmail(email: string, kind: "VERIFY_EMAIL" | "RESET_PASSWORD", now = new Date()) {
  const config = emailConfiguration();
  // Never return whether an account exists or the token to an HTTP caller.
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(71403220)`;
    const user = await tx.user.findUnique({ where: { email } });
    if (!user || (kind === "VERIFY_EMAIL" && user.emailVerifiedAt)) return;
    if (await tx.identityToken.count({ where: { userId: user.id, kind, createdAt: { gte: new Date(now.getTime() - 3600000) } } }) >= 3) return;
    // Durable hourly ledger survives account deletion, preventing quota reset via signup churn.
    const hour = Math.floor(now.getTime() / 3600000), prefix = "email-budget:";
    const used = await tx.rateLimit.aggregate({ where: { key: { startsWith: prefix }, expiresAt: { gt: now } }, _sum: { count: true } });
    if ((used._sum.count || 0) >= config.ceiling) return;
    await tx.rateLimit.upsert({ where: { key: `${prefix}${hour}` }, create: { key: `${prefix}${hour}`, expiresAt: new Date((hour + 25) * 3600000) }, update: { count: { increment: 1 } } });
    const raw = randomBytes(32).toString("base64url"), id = randomUUID();
    const expiresAt = new Date(now.getTime() + (kind === "RESET_PASSWORD" ? 30 : 60) * 60000);
    // Fragment never reaches access logs. Browser requires explicit confirmation before consumption.
    const link = `${config.origin}/account-link#${new URLSearchParams({ kind, token: raw })}`;
    const payload = { from: config.from, to: [email], subject: kind === "RESET_PASSWORD" ? "Reset your Marketingbus password" : "Verify your Marketingbus email", text: `${kind === "RESET_PASSWORD" ? "Choose a new password" : "Confirm your email address"}:\n\n${link}\n\nThis one-use link expires in ${kind === "RESET_PASSWORD" ? 30 : 60} minutes. If you did not request it, ignore this message.` };
    await tx.identityToken.create({ data: { id: digest(raw), userId: user.id, kind, expiresAt, createdAt: now } });
    await tx.emailOutbox.create({ data: { id, userId: user.id, kind, encryptedPayload: sealSecret(JSON.stringify(payload), `email:${id}:${user.id}`), expiresAt, createdAt: now, availableAt: now } });
  });
  return { ok: true, message: "If this account is eligible, an email has been queued. Check your inbox and spam folder." };
}
export async function consumeIdentityToken(raw: string, kind: "VERIFY_EMAIL" | "RESET_PASSWORD", password?: string, now = new Date()) {
  tokenSchema.parse(raw);
  const encoded = kind === "RESET_PASSWORD" ? await hash(passwordSchema.parse(password), 12) : undefined;
  await db.$transaction(async tx => {
    const token = await tx.identityToken.findUnique({ where: { id: digest(raw) } });
    if (!token || token.kind !== kind) throw new AppError(400, "This link is invalid or expired. Request a new one.");
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${token.userId} FOR UPDATE`;
    const consumed = await tx.identityToken.updateMany({ where: { id: token.id, kind, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (consumed.count !== 1) throw new AppError(400, "This link is invalid or expired. Request a new one.");
    if (kind === "VERIFY_EMAIL") await tx.user.update({ where: { id: token.userId }, data: { emailVerifiedAt: now } });
    else {
      await tx.user.update({ where: { id: token.userId }, data: { passwordHash: encoded, authVersion: { increment: 1 } } });
      await tx.mfaCredential.updateMany({ where: { userId: token.userId }, data: { pendingSecret: "", pendingExpiresAt: null } });
      await tx.session.deleteMany({ where: { userId: token.userId } });
    }
    await tx.identityToken.updateMany({ where: { userId: token.userId, kind, usedAt: null }, data: { usedAt: now } });
    await tx.emailOutbox.updateMany({ where: { userId: token.userId, kind, status: { in: ["QUEUED", "SENDING"] } }, data: { status: "EXPIRED", encryptedPayload: "", leaseUntil: null } });
  });
  return { ok: true };
}
/** Run even when sending is disabled: expired bearer material must not sit in the outbox indefinitely. */
export async function expireIdentityArtifacts(now = new Date()) {
  await db.mfaCredential.updateMany({ where: { pendingExpiresAt: { lte: now } }, data: { pendingSecret: "", pendingExpiresAt: null } });
  await db.teamInvitation.updateMany({ where: { status: "PENDING", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
  await db.teamInvitation.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 30 * 86400000) } } });
  await db.emailOutbox.updateMany({ where: { status: { in: ["QUEUED", "SENDING"] }, expiresAt: { lte: now } }, data: { status: "EXPIRED", encryptedPayload: "", leaseUntil: null } });
  await db.identityToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 7 * 86400000) } } });
  await db.emailOutbox.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * 86400000) }, status: { in: ["ACCEPTED", "FAILED", "EXPIRED"] } } });
}
