import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import {
  manageTeam,
  readTeam,
  acceptTeamInvitation,
  previewTeamInvitation,
  registerInvitedUser,
} from "../src/lib/identity/teams";
import { openSecret } from "../src/lib/secrets";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (
  process.env.TEST_DATABASE_URL &&
  (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL ||
    !["localhost", "127.0.0.1"].includes(
      new URL(process.env.TEST_DATABASE_URL).hostname
    ))
)
  throw Error("Local test DB required");
suite("workspace invitations and privilege boundaries", () => {
  const users: string[] = [],
    organizations: string[] = [];
  beforeAll(() => {
    vi.stubEnv(
      "SECRET_ENCRYPTION_KEYS_JSON",
      JSON.stringify({ test: randomBytes(32).toString("base64") })
    );
    vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test");
    vi.stubEnv("RESEND_API_KEY", "fixture-only");
    vi.stubEnv("RESEND_FROM_EMAIL", "team@example.com");
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
    vi.stubEnv("EMAIL_DELIVERY_ENABLED", "true");
    vi.stubEnv("EMAIL_DAILY_LIMIT", "1000");
  });
  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: organizations } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  async function user(verified = true) {
    const row = await db.user.create({
      data: {
        name: "Team fixture",
        email: `team-${crypto.randomUUID()}@example.com`,
        passwordHash: "not-used",
        emailVerifiedAt: verified ? new Date() : null,
      },
    });
    users.push(row.id);
    return row;
  }
  async function setup() {
    const owner = await user(),
      org = await db.organization.create({
        data: {
          name: "TEAM FIXTURE",
          memberships: { create: { userId: owner.id, role: "OWNER" } },
        },
      });
    organizations.push(org.id);
    return { owner, org };
  }
  async function invitation(
    ctx: Awaited<ReturnType<typeof setup>>,
    email: string
  ) {
    await manageTeam(ctx.org.id, ctx.owner.id, {
      action: "invite",
      email,
      role: "EDITOR",
    });
    const invite = await db.teamInvitation.findFirstOrThrow({
      where: { organizationId: ctx.org.id, email },
    });
    const mail = await db.emailOutbox.findUniqueOrThrow({
      where: { id: invite.outboxId },
    });
    const payload = JSON.parse(
      openSecret(mail.encryptedPayload, `email:${mail.id}:${ctx.owner.id}`)
    );
    const token = String(payload.text).match(/#token=([A-Za-z0-9_-]+)/)![1];
    return { invite, token };
  }
  it("requires admin access and verified inviter email", async () => {
    const ctx = await setup(),
      outsider = await user();
    await expect(readTeam(ctx.org.id, outsider.id)).rejects.toThrow(
      "not found"
    );
    await expect(
      manageTeam(ctx.org.id, outsider.id, {
        action: "invite",
        email: outsider.email,
        role: "EDITOR",
      })
    ).rejects.toThrow("administrator");
    await db.user.update({
      where: { id: ctx.owner.id },
      data: { emailVerifiedAt: null },
    });
    await expect(
      manageTeam(ctx.org.id, ctx.owner.id, {
        action: "invite",
        email: outsider.email,
        role: "EDITOR",
      })
    ).rejects.toThrow("Verify your email");
  });
  it("requires the invited verified email, consumes links once and never returns the raw token", async () => {
    const ctx = await setup(),
      recipient = await user(false),
      outsider = await user(),
      { invite, token } = await invitation(ctx, recipient.email);
    expect(invite.id).not.toBe(token);
    expect(
      JSON.stringify(await readTeam(ctx.org.id, ctx.owner.id))
    ).not.toContain(token);
    await expect(acceptTeamInvitation(outsider.id, token)).rejects.toThrow(
      "email address"
    );
    await expect(acceptTeamInvitation(recipient.id, token)).rejects.toThrow(
      "email address"
    );
    await db.user.update({
      where: { id: recipient.id },
      data: { emailVerifiedAt: new Date() },
    });
    const result = await Promise.allSettled([
      acceptTeamInvitation(recipient.id, token),
      acceptTeamInvitation(recipient.id, token),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db.membership.findUniqueOrThrow({
          where: {
            organizationId_userId: {
              organizationId: ctx.org.id,
              userId: recipient.id,
            },
          },
        })
      ).role
    ).toBe("EDITOR");
    expect(
      (
        await db.emailOutbox.findUniqueOrThrow({
          where: { id: invite.outboxId },
        })
      ).encryptedPayload
    ).toBe("");
  });
  it("revokes invitations and rejects expired or no-longer-authorized invitations", async () => {
    const ctx = await setup(),
      a = await user(),
      first = await invitation(ctx, a.email);
    await manageTeam(ctx.org.id, ctx.owner.id, {
      action: "revoke",
      invitationId: first.invite.id,
    });
    await expect(acceptTeamInvitation(a.id, first.token)).rejects.toThrow(
      "invalid or expired"
    );
    const b = await user(),
      second = await invitation(ctx, b.email);
    await db.teamInvitation.update({
      where: { id: second.invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(acceptTeamInvitation(b.id, second.token)).rejects.toThrow(
      "invalid or expired"
    );
    const c = await user(),
      third = await invitation(ctx, c.email);
    await db.membership.update({
      where: {
        organizationId_userId: {
          organizationId: ctx.org.id,
          userId: ctx.owner.id,
        },
      },
      data: { role: "VIEWER" },
    });
    await expect(acceptTeamInvitation(c.id, third.token)).rejects.toThrow(
      "no longer has permission"
    );
  });
  it("protects the last owner under concurrency and blocks admin escalation", async () => {
    const ctx = await setup(),
      second = await user(),
      admin = await user();
    await db.membership.createMany({
      data: [
        { organizationId: ctx.org.id, userId: second.id, role: "OWNER" },
        { organizationId: ctx.org.id, userId: admin.id, role: "ADMIN" },
      ],
    });
    await expect(
      manageTeam(ctx.org.id, admin.id, {
        action: "role",
        userId: admin.id,
        role: "OWNER",
      })
    ).rejects.toThrow("Only owners");
    const changes = await Promise.allSettled([
      manageTeam(ctx.org.id, ctx.owner.id, {
        action: "role",
        userId: ctx.owner.id,
        role: "EDITOR",
      }),
      manageTeam(ctx.org.id, second.id, {
        action: "role",
        userId: second.id,
        role: "EDITOR",
      }),
    ]);
    expect(changes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.membership.count({
        where: { organizationId: ctx.org.id, role: "OWNER" },
      })
    ).toBe(1);
  });
  it("previews only workspace and role without consuming or revealing recipient identity", async () => {
    const ctx = await setup(), email = `new-${crypto.randomUUID()}@example.com`, { invite, token } = await invitation(ctx, email);
    const preview = await previewTeamInvitation(token);
    expect(preview).toMatchObject({ workspace: "TEAM FIXTURE", role: "EDITOR" });
    expect(JSON.stringify(preview)).not.toContain(email); expect(JSON.stringify(preview)).not.toContain(token);
    expect((await db.teamInvitation.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe("PENDING");
  });
  it("creates only the invited membership, verifies the new address and clears bearer mail", async () => {
    const ctx = await setup(), email = `new-${crypto.randomUUID()}@example.com`, { invite, token } = await invitation(ctx, email);
    const created = await registerInvitedUser({ token, email: email.toUpperCase(), name: "Invited editor", password: "A-unique-test-password!" }); users.push(created.id);
    const account = await db.user.findUniqueOrThrow({ where: { id: created.id }, include: { memberships: true } });
    expect(account.emailVerifiedAt).not.toBeNull(); expect(account.memberships).toHaveLength(1);
    expect(account.memberships[0]).toMatchObject({ organizationId: ctx.org.id, role: "EDITOR" });
    expect(await db.membership.count({ where: { userId: account.id, role: "OWNER" } })).toBe(0);
    expect((await db.emailOutbox.findUniqueOrThrow({ where: { id: invite.outboxId } })).encryptedPayload).toBe("");
    expect(await db.teamEvent.count({ where: { organizationId: ctx.org.id, actorId: account.id, action: "TEAM_JOINED" } })).toBe(1);
    expect(Object.keys(created).sort()).toEqual(["authVersion", "id"]);
    await expect(registerInvitedUser({ token, email, name: "Replay", password: "A-unique-test-password!" })).rejects.toThrow("invalid or expired");
  });
  it("wrong email and malformed inputs cannot create a user or consume the invitation", async () => {
    const ctx = await setup(), email = `new-${crypto.randomUUID()}@example.com`, { invite, token } = await invitation(ctx, email), wrong = `wrong-${crypto.randomUUID()}@example.com`;
    await expect(registerInvitedUser({ token, email: wrong, name: "Wrong person", password: "A-unique-test-password!" })).rejects.toThrow("email address");
    expect(await db.user.findUnique({ where: { email: wrong } })).toBeNull();
    await expect(registerInvitedUser({ token, email, name: "Editor", password: "short" })).rejects.toThrow();
    await expect(registerInvitedUser({ token, email, name: "Editor", password: "A-unique-test-password!", role: "OWNER" })).rejects.toThrow();
    expect((await db.teamInvitation.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe("PENDING");
  });
  it("cannot overwrite an existing account or bypass its authentication", async () => {
    const ctx = await setup(), existing = await user(false), { invite, token } = await invitation(ctx, existing.email);
    await expect(registerInvitedUser({ token, email: existing.email, name: "Impersonator", password: "Replacement-password!" })).rejects.toThrow("signing in");
    const unchanged = await db.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(unchanged.passwordHash).toBe(existing.passwordHash); expect(unchanged.emailVerifiedAt).toBeNull();
    expect(await db.membership.count({ where: { userId: existing.id } })).toBe(0);
    expect((await db.teamInvitation.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe("PENDING");
  });
  it("rechecks revoked, expired and demoted invitations before signup", async () => {
    for (const invalidation of ["REVOKED", "EXPIRED", "DEMOTED"]) {
      const ctx = await setup(), email = `new-${crypto.randomUUID()}@example.com`, { invite, token } = await invitation(ctx, email);
      if (invalidation === "DEMOTED") await db.membership.update({ where: { organizationId_userId: { organizationId: ctx.org.id, userId: ctx.owner.id } }, data: { role: "VIEWER" } });
      else await db.teamInvitation.update({ where: { id: invite.id }, data: invalidation === "EXPIRED" ? { expiresAt: new Date(0) } : { status: "REVOKED" } });
      await expect(previewTeamInvitation(token)).rejects.toThrow();
      await expect(registerInvitedUser({ token, email, name: "Blocked user", password: "A-unique-test-password!" })).rejects.toThrow();
      expect(await db.user.findUnique({ where: { email } })).toBeNull();
    }
  });
  it("serializes concurrent registrations so a link creates one account and one membership", async () => {
    const ctx = await setup(), email = `new-${crypto.randomUUID()}@example.com`, { token } = await invitation(ctx, email);
    const input = { token, email, name: "Concurrent editor", password: "A-unique-test-password!" };
    const results = await Promise.allSettled([registerInvitedUser(input), registerInvitedUser(input)]);
    const created = await db.user.findUniqueOrThrow({ where: { email } }); users.push(created.id);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.membership.count({ where: { userId: created.id } })).toBe(1);
  });
});
