import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { emailConfiguration, tokenSchema } from "./service";
import { sealSecret } from "../secrets";
const roles = z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER"]);
export const teamAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("invite"),
      email: z
        .email()
        .max(254)
        .transform((e) => e.toLowerCase()),
      role: z.enum(["ADMIN", "EDITOR", "VIEWER"]),
    })
    .strict(),
  z
    .object({ action: z.literal("revoke"), invitationId: z.string().min(1) })
    .strict(),
  z
    .object({
      action: z.literal("role"),
      userId: z.string().min(1),
      role: roles,
    })
    .strict(),
  z.object({ action: z.literal("remove"), userId: z.string().min(1) }).strict(),
]);
export async function readTeam(organizationId: string, actorId: string) {
  const membership = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId, userId: actorId } },
  });
  if (!membership) throw new AppError(404, "Workspace not found.");
  const canManage = ["OWNER", "ADMIN"].includes(membership.role);
  const members = await db.membership.findMany({
    where: { organizationId },
    select: {
      userId: true,
      role: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: { userId: "asc" },
  });
  return {
    role: membership.role,
    members,
    invitations: canManage
      ? await db.teamInvitation.findMany({
          where: { organizationId },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            expiresAt: true,
          },
        })
      : [],
    events: canManage
      ? await db.teamEvent.findMany({
          where: { organizationId },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      : [],
  };
}
export async function manageTeam(
  organizationId: string,
  actorId: string,
  raw: unknown
) {
  const input = teamAction.parse(raw);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${organizationId} FOR UPDATE`;
    const actor = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId: actorId } },
      include: { user: true, organization: true },
    });
    if (!actor || !["OWNER", "ADMIN"].includes(actor.role))
      throw new AppError(403, "Workspace administrator access required.");
    if (input.action === "invite") {
      if (!actor.user.emailVerifiedAt)
        throw new AppError(403, "Verify your email before inviting teammates.");
      if (actor.role !== "OWNER" && input.role === "ADMIN")
        throw new AppError(403, "Only an owner can invite an administrator.");
      const config = emailConfiguration(),
        now = new Date();
      if (
        await tx.membership.count({
          where: { organizationId, user: { email: input.email } },
        })
      )
        throw new AppError(409, "This person is already a member.");
      if (
        await tx.teamInvitation.count({
          where: {
            organizationId,
            email: input.email,
            status: "PENDING",
            expiresAt: { gt: now },
          },
        })
      )
        throw new AppError(
          409,
          "An invitation is already pending for this address."
        );
      if (
        (await tx.teamInvitation.count({
          where: {
            organizationId,
            createdAt: { gt: new Date(Date.now() - 3600000) },
          },
        })) >= 10
      )
        throw new AppError(
          429,
          "This workspace has reached its hourly invitation allowance."
        );
      if (
        (await tx.membership.count({ where: { organizationId } })) +
          (await tx.teamInvitation.count({
            where: {
              organizationId,
              status: "PENDING",
              expiresAt: { gt: now },
            },
          })) >=
        50
      )
        throw new AppError(
          409,
          "This workspace has reached its team allowance."
        );
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(71403220)`;
      const used = await tx.rateLimit.aggregate({
        where: { key: { startsWith: "email-budget:" }, expiresAt: { gt: now } },
        _sum: { count: true },
      });
      if ((used._sum.count || 0) >= config.ceiling)
        throw new AppError(429, "Email delivery allowance reached. Try later.");
      const hour = Math.floor(now.getTime() / 3600000);
      await tx.rateLimit.upsert({
        where: { key: `email-budget:${hour}` },
        create: {
          key: `email-budget:${hour}`,
          expiresAt: new Date((hour + 25) * 3600000),
        },
        update: { count: { increment: 1 } },
      });
      const rawToken = randomBytes(32).toString("base64url"),
        id = createHash("sha256").update(rawToken).digest("hex"),
        outboxId = randomUUID();
      const expiresAt = new Date(now.getTime() + 24 * 3600000);
      const link = `${config.origin}/team-invitation#${new URLSearchParams({
        token: rawToken,
      })}`;
      await tx.teamInvitation.create({
        data: {
          id,
          organizationId,
          email: input.email,
          role: input.role,
          createdBy: actorId,
          outboxId,
          expiresAt,
        },
      });
      const payload = {
        from: config.from,
        to: [input.email],
        subject: "Your Marketingbus workspace invitation",
        text: `${actor.user.name} invited you to ${
          actor.organization.name
        } as ${input.role.toLowerCase()}. Sign in with this email, verify it, then accept the invitation:\n\n${link}\n\nExpires in 24 hours. Ignore this email if unexpected.`,
      };
      await tx.emailOutbox.create({
        data: {
          id: outboxId,
          userId: actorId,
          kind: "TEAM_INVITATION",
          encryptedPayload: sealSecret(
            JSON.stringify(payload),
            `email:${outboxId}:${actorId}`
          ),
          expiresAt,
        },
      });
    } else if (input.action === "revoke") {
      const invitation = await tx.teamInvitation.findFirst({
        where: { id: input.invitationId, organizationId, status: "PENDING" },
      });
      if (!invitation) throw new AppError(404, "Pending invitation not found.");
      if (actor.role !== "OWNER" && invitation.role === "ADMIN")
        throw new AppError(
          403,
          "Only an owner can manage administrator invitations."
        );
      await tx.teamInvitation.update({
        where: { id: invitation.id },
        data: { status: "REVOKED" },
      });
      await tx.emailOutbox.updateMany({
        where: { id: invitation.outboxId },
        data: { status: "EXPIRED", encryptedPayload: "", leaseUntil: null },
      });
    } else {
      const target = await tx.membership.findUnique({
        where: {
          organizationId_userId: { organizationId, userId: input.userId },
        },
      });
      if (!target) throw new AppError(404, "Member not found.");
      if (
        actor.role !== "OWNER" &&
        (["OWNER", "ADMIN"].includes(target.role) ||
          (input.action === "role" && ["OWNER", "ADMIN"].includes(input.role)))
      )
        throw new AppError(
          403,
          "Only owners can manage owner and administrator roles."
        );
      if (
        target.role === "OWNER" &&
        (input.action === "remove" || input.role !== "OWNER") &&
        (await tx.membership.count({
          where: { organizationId, role: "OWNER" },
        })) <= 1
      )
        throw new AppError(
          409,
          "The last workspace owner cannot be removed or demoted."
        );
      if (input.action === "remove")
        await tx.membership.delete({
          where: {
            organizationId_userId: { organizationId, userId: input.userId },
          },
        });
      else
        await tx.membership.update({
          where: {
            organizationId_userId: { organizationId, userId: input.userId },
          },
          data: { role: input.role },
        });
    }
    await tx.teamEvent.create({
      data: {
        organizationId,
        actorId,
        action: `TEAM_${input.action.toUpperCase()}`,
        detail:
          input.action === "invite"
            ? `Invitation queued for ${input.email} as ${input.role}.`
            : input.action === "revoke"
            ? "Invitation revoked."
            : `Member ${input.userId}: ${
                input.action === "role" ? input.role : "removed"
              }.`,
      },
    });
    return { ok: true };
  });
}
export async function acceptTeamInvitation(actorId: string, raw: string) {
  const token = tokenSchema.parse(raw),
    id = createHash("sha256").update(token).digest("hex");
  return db.$transaction(async (tx) => {
    const initial = await tx.teamInvitation.findUnique({ where: { id } });
    if (!initial) throw new AppError(400, "Invitation is invalid or expired.");
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${initial.organizationId} FOR UPDATE`;
    const invitation = await tx.teamInvitation.findUniqueOrThrow({
      where: { id },
    });
    const user = await tx.user.findUniqueOrThrow({ where: { id: actorId } });
    if (invitation.status !== "PENDING" || invitation.expiresAt <= new Date())
      throw new AppError(400, "Invitation is invalid or expired.");
    if (!user.emailVerifiedAt || user.email.toLowerCase() !== invitation.email)
      throw new AppError(
        403,
        "Sign in and verify the email address this invitation was sent to."
      );
    const inviter = await tx.membership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId,
          userId: invitation.createdBy,
        },
      },
    });
    if (
      !inviter ||
      !["OWNER", "ADMIN"].includes(inviter.role) ||
      (invitation.role === "ADMIN" && inviter.role !== "OWNER")
    )
      throw new AppError(
        409,
        "The inviter no longer has permission. Request a new invitation."
      );
    if (
      (await tx.membership.count({ where: { userId: actorId } })) >= 20 ||
      (await tx.membership.count({
        where: { organizationId: invitation.organizationId },
      })) >= 50
    )
      throw new AppError(409, "Workspace membership allowance reached.");
    // An invitation cannot silently overwrite an existing member's role.
    await tx.membership.upsert({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId,
          userId: actorId,
        },
      },
      create: {
        organizationId: invitation.organizationId,
        userId: actorId,
        role: invitation.role,
      },
      update: {},
    });
    await tx.teamInvitation.update({
      where: { id },
      data: { status: "ACCEPTED" },
    });
    await tx.emailOutbox.updateMany({
      where: { id: invitation.outboxId },
      data: { status: "EXPIRED", encryptedPayload: "", leaseUntil: null },
    });
    await tx.teamEvent.create({
      data: {
        organizationId: invitation.organizationId,
        actorId,
        action: "TEAM_JOINED",
        detail: "Verified invited email accepted a one-use invitation.",
      },
    });
    return { ok: true };
  });
}
