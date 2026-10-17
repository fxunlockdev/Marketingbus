import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { hash } from "bcryptjs";
import { db } from "../src/lib/db";
import { manageMfa, mfaStatus } from "../src/lib/identity/mfa";
import { decodeBase32, totp } from "../src/lib/identity/totp";
import { assertWorkspaceMfa, setWorkspaceSecurity } from "../src/lib/identity/workspace-security";
import { readTeam, manageTeam } from "../src/lib/identity/teams";
import { requireWorkspace, requireBusiness, session } from "../src/lib/auth";

const cookie = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => cookie.token ? { value: cookie.token } : undefined }) }));
const local = process.env.TEST_DATABASE_URL;
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Local fixture DB required");
const suite = local ? describe : describe.skip;
suite("workspace MFA policy and tenant access", () => {
  const users: string[] = [], orgs: string[] = [], password = "fixture-security-password";
  beforeAll(() => {
    vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "fixture");
    vi.stubEnv("SECRET_ENCRYPTION_KEYS_JSON", JSON.stringify({ fixture: randomBytes(32).toString("base64") }));
  });
  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function user() {
    const row = await db.user.create({ data: { name: "SECURITY FIXTURE", email: `${randomUUID()}@example.test`, passwordHash: await hash(password, 4), emailVerifiedAt: new Date() } });
    users.push(row.id); return row;
  }
  async function fixture(enrolled = true) {
    const owner = await user(), member = await user();
    const org = await db.organization.create({ data: { name: "MFA fixture", wallet: { create: {} }, memberships: { create: [{ userId: owner.id, role: "OWNER" }, { userId: member.id, role: "ADMIN" }] } } });
    orgs.push(org.id);
    const business = await db.business.create({ data: { name: "MFA-only brand", organizationId: org.id } });
    let codes: string[] = [];
    if (enrolled) {
      const now = new Date(), setup = await manageMfa(owner.id, 0, { action: "begin", password }, now);
      codes = (await manageMfa(owner.id, 0, { action: "confirm", password, code: totp(decodeBase32(setup.secret), now.getTime()) }, now)).recoveryCodes;
    }
    const change = (required: boolean, expected: boolean, index = 0) => setWorkspaceSecurity(org.id, owner.id, enrolled ? 1 : 0, { requireMfa: required, expectedRequireMfa: expected, password, code: codes[index] || "123456" });
    return { owner, member, org, business, codes, change };
  }
  async function signIn(userId: string, version = 0) {
    cookie.token = randomBytes(32).toString("base64url");
    await db.session.create({ data: { id: createHash("sha256").update(cookie.token).digest("hex"), userId, authVersion: version, expiresAt: new Date(Date.now() + 60000) } });
  }
  it("defaults to optional; requires an enrolled owner and does not create credits", async () => {
    const f = await fixture(false);
    expect((await readTeam(f.org.id, f.owner.id)).requireMfa).toBe(false);
    await expect(f.change(true, false)).rejects.toThrow("enable your own MFA");
    expect(await db.wallet.findUnique({ where: { organizationId: f.org.id } })).toMatchObject({ available: 0, held: 0 });
    expect(await db.teamEvent.count({ where: { organizationId: f.org.id } })).toBe(0);
  });
  it("requires current owner authority, password, auth version and an unused factor", async () => {
    const f = await fixture(), outsider = await user();
    const raw = { requireMfa: true, expectedRequireMfa: false, password, code: f.codes[0] };
    for (const id of [f.member.id, outsider.id]) await expect(setWorkspaceSecurity(f.org.id, id, 0, raw)).rejects.toThrow("Only a workspace owner");
    await expect(setWorkspaceSecurity(f.org.id, f.owner.id, 0, raw)).rejects.toThrow("security changed");
    await expect(setWorkspaceSecurity(f.org.id, f.owner.id, 1, { ...raw, password: "wrong-password-value" })).rejects.toThrow("incorrect");
    await expect(setWorkspaceSecurity(f.org.id, f.owner.id, 1, { ...raw, code: "000000-invalid" })).rejects.toThrow("unused");
    await f.change(true, false);
    await expect(f.change(false, true)).rejects.toThrow("unused");
    expect((await mfaStatus(f.owner.id)).recoveryCodesRemaining).toBe(7);
  });
  it("blocks existing un-enrolled sessions for only the protected workspace", async () => {
    const f = await fixture(), other = await db.organization.create({ data: { name: "Optional fixture", memberships: { create: { userId: f.member.id, role: "ADMIN" } } } }); orgs.push(other.id);
    await signIn(f.member.id);
    expect((await session())?.memberships).toHaveLength(2);
    await f.change(true, false);
    expect((await session())?.memberships.map(m => m.organizationId)).toEqual([other.id]);
    expect((await session())?.blockedMemberships.map(m => m.organizationId)).toEqual([f.org.id]);
    await expect(requireWorkspace(f.org.id)).rejects.toThrow("requires MFA");
    await expect(requireBusiness(f.business.id)).rejects.toThrow("not found");
    expect((await requireWorkspace(other.id)).id).toBe(f.member.id);
    await expect(readTeam(f.org.id, f.member.id)).rejects.toThrow("requires MFA");
    await expect(manageTeam(f.org.id, f.member.id, { action: "remove", userId: f.owner.id })).rejects.toThrow("requires MFA");
  });
  it("keeps enrollment possible and invalidates pre-enrollment sessions", async () => {
    const f = await fixture(); await f.change(true, false); await signIn(f.member.id);
    expect((await session())?.id).toBe(f.member.id);
    const now = new Date(), setup = await manageMfa(f.member.id, 0, { action: "begin", password }, now);
    await expect(assertWorkspaceMfa(db, f.org.id, f.member.id)).rejects.toThrow("requires MFA");
    await manageMfa(f.member.id, 0, { action: "confirm", password, code: totp(decodeBase32(setup.secret), now.getTime()) }, now);
    expect(await session()).toBeNull();
    await signIn(f.member.id, 1);
    expect((await requireBusiness(f.business.id)).user.id).toBe(f.member.id);
    expect((await readTeam(f.org.id, f.member.id)).requireMfa).toBe(true);
  });
  it("prevents factor disabling under policy without consuming a recovery code", async () => {
    const f = await fixture(); await f.change(true, false);
    await expect(manageMfa(f.owner.id, 1, { action: "disable", password, code: f.codes[1] })).rejects.toThrow("workspace requires MFA");
    expect((await mfaStatus(f.owner.id)).recoveryCodesRemaining).toBe(7);
    await f.change(false, true, 1);
    expect((await mfaStatus(f.owner.id)).enabled).toBe(true);
    await manageMfa(f.owner.id, 1, { action: "disable", password, code: f.codes[2] });
    expect((await mfaStatus(f.owner.id)).enabled).toBe(false);
  });
  it("serializes competing owner updates and rejects stale policy without spending its code", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.change(true, false, 0), f.change(true, false, 1)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await mfaStatus(f.owner.id)).recoveryCodesRemaining).toBe(7);
    expect(await db.teamEvent.count({ where: { organizationId: f.org.id, action: "MFA_REQUIRED" } })).toBe(1);
  });
  it("cannot race disabling the owner's factor against enabling the requirement", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.change(true, false, 0), manageMfa(f.owner.id, 1, { action: "disable", password, code: f.codes[1] })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const org = await db.organization.findUniqueOrThrow({ where: { id: f.org.id } });
    const mfa = await mfaStatus(f.owner.id);
    expect(org.requireMfa && !mfa.enabled).toBe(false);
  });
  it("uses only safe audit details and never sends email or mutates the wallet", async () => {
    const f = await fixture(), before = await db.wallet.findUnique({ where: { organizationId: f.org.id } });
    await f.change(true, false); await f.change(false, true, 1);
    const view = JSON.stringify(await readTeam(f.org.id, f.owner.id));
    for (const secret of [password, f.codes[0], f.codes[1], "encryptedSecret", "recoveryHashes", "passwordHash"]) expect(view).not.toContain(secret);
    expect(await db.wallet.findUnique({ where: { organizationId: f.org.id } })).toEqual(before);
    expect(await db.emailOutbox.count({ where: { userId: { in: [f.owner.id, f.member.id] } } })).toBe(0);
  });
});
