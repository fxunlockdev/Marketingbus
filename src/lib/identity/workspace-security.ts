import { compare } from "bcryptjs";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { consumeFactor } from "./mfa";

export const workspaceSecurityInput = z.object({
  requireMfa: z.boolean(),
  expectedRequireMfa: z.boolean(),
  password: z.string().min(12).max(64),
  code: z.string().min(6).max(64),
}).strict();

// Recheck at sensitive service boundaries, including OAuth callbacks without a page session.
export async function assertWorkspaceMfa(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
  const member = await tx.membership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: { organization: true, user: { select: { mfa: { select: { enabledAt: true } } } } },
  });
  if (!member) throw new AppError(404, "Workspace not found.");
  if (member.organization.requireMfa && !member.user.mfa?.enabledAt)
    throw new AppError(403, "This workspace requires MFA. Set up an authenticator in Account security, then sign in again.");
}

export async function setWorkspaceSecurity(organizationId: string, actorId: string, expectedVersion: number, raw: unknown, now = new Date()) {
  const input = workspaceSecurityInput.parse(raw);
  const user = await db.user.findUnique({ where: { id: actorId } });
  if (!user || !(await compare(input.password, user.passwordHash))) throw new AppError(401, "Password is incorrect.");
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(71403221)`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${organizationId} FOR UPDATE`;
    const actor = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId: actorId } },
      include: { organization: true, user: { include: { mfa: true } } },
    });
    if (!actor || actor.role !== "OWNER") throw new AppError(403, "Only a workspace owner can change its security policy.");
    if (actor.user.authVersion !== expectedVersion || actor.user.passwordHash !== user.passwordHash)
      throw new AppError(401, "Account security changed. Sign in again.");
    if (!actor.user.emailVerifiedAt || !actor.user.mfa?.enabledAt)
      throw new AppError(409, "Verify your email and enable your own MFA before changing workspace security.");
    if (actor.organization.requireMfa !== input.expectedRequireMfa)
      throw new AppError(409, "Workspace security changed. Refresh before trying again.");
    await consumeFactor(tx, actorId, input.code, now);
    if (actor.organization.requireMfa !== input.requireMfa) {
      await tx.organization.update({ where: { id: organizationId }, data: { requireMfa: input.requireMfa } });
      await tx.teamEvent.create({ data: {
        organizationId, actorId, action: input.requireMfa ? "MFA_REQUIRED" : "MFA_OPTIONAL",
        detail: input.requireMfa ? "Owner required MFA for workspace access." : "Owner made workspace MFA optional; existing authenticators remain enabled.",
      } });
    }
    return { ok: true, requireMfa: input.requireMfa };
  });
}
