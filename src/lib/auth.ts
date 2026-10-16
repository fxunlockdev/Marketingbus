import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { AppError } from "./http";
const cookieName = "marketingbus_session";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function session() {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token) return null;
  const record = await db.session.findUnique({ where: { id: digest(token) }, include: { user: { include: { memberships: { include: { organization: true } } } } } });
  if (!record || record.expiresAt <= new Date() || record.authVersion !== record.user.authVersion) return null;
  return record.user;
}
export async function requireUser() {
  const user = await session(); if (!user) throw new AppError(401, "Please sign in."); return user;
}
// Never return the raw session cookie to a service or the browser.
export async function requireSessionId() {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token) throw new AppError(401, "Please sign in.");
  return digest(token);
}
export async function startSession(userId: string, expectedAuthVersion: number) {
  await endSession();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  const origin=new URL(process.env.APP_ORIGIN??"http://localhost");
  if(origin.protocol!=="https:"&&!["localhost","127.0.0.1"].includes(origin.hostname))throw new AppError(503,"HTTPS is required for hosted sessions.");
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.authVersion !== expectedAuthVersion) throw new AppError(401, "Account credentials changed. Sign in again.");
    await tx.session.create({ data: { id: digest(token), userId, expiresAt, authVersion: user.authVersion } });
  });
  (await cookies()).set(cookieName, token, { httpOnly: true, secure: origin.protocol==="https:", sameSite: "lax", path: "/", expires: expiresAt });
}
export async function endSession() {
  const jar = await cookies(); const token = jar.get(cookieName)?.value;
  if (token) await db.session.deleteMany({ where: { id: digest(token) } });
  jar.delete(cookieName);
}
export async function rateLimit(scope: string, identifier: string, limit: number) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `${scope}:${hour}:${digest(identifier)}`;
  const record = await db.rateLimit.upsert({ where: { key }, create: { key, expiresAt: new Date((hour + 1) * 3_600_000) }, update: { count: { increment: 1 } } });
  if (record.count > limit) throw new AppError(429, "Too many attempts. Please try again later.");
}
export async function requireBusiness(id: string, write = false) {
  const user = await requireUser();
  const organizations = user.memberships.filter(m => !write || ["OWNER", "ADMIN", "EDITOR"].includes(m.role)).map(m => m.organizationId);
  const business = await db.business.findFirst({ where: { id, organizationId: { in: organizations } } });
  if (!business) throw new AppError(404, "Business not found.");
  return { user, business };
}
