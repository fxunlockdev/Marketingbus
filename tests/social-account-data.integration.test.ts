import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { sealSecret } from "../src/lib/secrets";
import { type OAuthScope } from "../src/lib/social/oauth";
import { expireSocialAccountData, forgetSocialAccountData, readSocialAccountData, refreshSocialAccountData } from "../src/lib/social/account-data-service";
import { unavailableOrganic, type AccountSnapshot, type SocialDataAdapter } from "../src/lib/social/account-data-contracts";
const local = process.env.TEST_DATABASE_URL;
if (local && (process.env.DATABASE_URL !== local || !["localhost", "127.0.0.1"].includes(new URL(local).hostname))) throw Error("Local test DB required");
const suite = local ? describe : describe.skip;
suite("tenant-scoped social account data", () => {
  const orgs: string[] = [], users: string[] = [];
  beforeAll(() => { vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test"); vi.stubEnv("SECRET_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") })); });
  afterAll(async () => { await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } }); vi.unstubAllEnvs(); await db.$disconnect(); });
  async function fixture() {
    const org = await db.organization.create({ data: { name: "Data LOCAL TEST" } }); orgs.push(org.id);
    const user = await db.user.create({ data: { name: "Local test", email: `${randomUUID()}@example.test`, passwordHash: "not-a-login" } }); users.push(user.id);
    await db.membership.create({ data: { organizationId: org.id, userId: user.id, role: "OWNER" } });
    const session = await db.session.create({ data: { id: randomUUID(), userId: user.id, expiresAt: new Date(Date.now() + 3600000) } });
    const business = await db.business.create({ data: { organizationId: org.id, name: "Data fixture" } });
    const scope: OAuthScope = { businessId: business.id, organizationId: org.id, actorId: user.id, sessionId: session.id }, id = randomUUID(), token = `local-private-${randomUUID()}`;
    const connection = await db.socialConnection.create({ data: { id, organizationId: org.id, businessId: business.id, provider: "Facebook", externalAccountId: "789", label: "Local Page", encryptedToken: sealSecret(token, `social:${org.id}:${business.id}:${id}`), permissions: ["pages_read_engagement"], expiresAt: new Date(Date.now() + 3600000) } });
    const snapshot = (): AccountSnapshot => ({ provider: "Facebook", externalAccountId: "789", observedAt: new Date().toISOString(), definitionVersion: "fixture-v1", profile: { name: "Local Page", followers: 0, likes: null, mediaCount: null }, lifetimeOrganic: unavailableOrganic(), posts: [], hasMore: false });
    const read = vi.fn<SocialDataAdapter["read"]>(async () => snapshot()), adapter = { version: "fixture-v1", read }, adapters = () => ({ Facebook: adapter });
    return { scope, connection, token, snapshot, read, adapter, adapters };
  }
  it("persists only verified data without publishing, billing or scheduling jobs", async () => {
    const f = await fixture(); await refreshSocialAccountData(f.scope, f.connection.id, f.adapters);
    const value = await readSocialAccountData(f.scope, f.connection.id);
    expect(value.snapshot?.profile).toMatchObject({ followers: 0, likes: null });
    expect(JSON.stringify(value)).not.toMatch(/encryptedToken|local-private|dataLease/);
    expect(f.read.mock.calls[0][0].token).toBe(f.token);
    expect(await db.job.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    const row = await db.socialConnection.findUniqueOrThrow({ where: { id: f.connection.id } }); expect(row.dataLeaseId).toBeNull(); expect(row.dataErrorCode).toBeNull();
  });
  it("allows viewers to read but not refresh or erase", async () => {
    const f = await fixture(); await refreshSocialAccountData(f.scope, f.connection.id, f.adapters);
    await db.membership.updateMany({ where: { organizationId: f.scope.organizationId }, data: { role: "VIEWER" } });
    expect((await readSocialAccountData(f.scope, f.connection.id)).snapshot).not.toBeNull();
    await expect(refreshSocialAccountData(f.scope, f.connection.id, f.adapters)).rejects.toThrow(/owner or admin/);
    await expect(forgetSocialAccountData(f.scope, f.connection.id)).rejects.toThrow(/owner or admin/);
  });
  it("rejects cross-tenant and cross-business reads and writes", async () => {
    const f = await fixture(), other = await fixture();
    for (const action of [readSocialAccountData, forgetSocialAccountData]) await expect(action(other.scope, f.connection.id)).rejects.toThrow(/not found/);
    await expect(refreshSocialAccountData(other.scope, f.connection.id, f.adapters)).rejects.toThrow(/not found/);
    const second = await db.business.create({ data: { organizationId: f.scope.organizationId, name: "Other business" } });
    await expect(readSocialAccountData({ ...f.scope, businessId: second.id }, f.connection.id)).rejects.toThrow(/not found/); expect(f.read).not.toHaveBeenCalled();
  });
  it("serializes simultaneous refreshes and preserves cooldown after deletion", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([refreshSocialAccountData(f.scope, f.connection.id, f.adapters), refreshSocialAccountData(f.scope, f.connection.id, f.adapters)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(f.read).toHaveBeenCalledTimes(1);
    await forgetSocialAccountData(f.scope, f.connection.id); expect((await readSocialAccountData(f.scope, f.connection.id)).snapshot).toBeNull();
    await expect(refreshSocialAccountData(f.scope, f.connection.id, f.adapters)).rejects.toThrow(/15 minutes/);
  });
  it.each(["wrong-account", "wrong-provider", "secret", "future", "old", "oversize"])("rejects %s snapshots without saving or leaking details", async fault => {
    const f = await fixture(); f.read.mockImplementation(async () => {
      const value = f.snapshot();
      if (fault === "wrong-account") value.externalAccountId = "999";
      if (fault === "wrong-provider") value.provider = "Instagram";
      if (fault === "secret") value.profile.name = f.token;
      if (fault === "future") value.observedAt = "2099-01-01T00:00:00Z";
      if (fault === "old") value.observedAt = "2020-01-01T00:00:00Z";
      if (fault === "oversize") value.profile.name = "x".repeat(150000);
      return value;
    });
    await expect(refreshSocialAccountData(f.scope, f.connection.id, f.adapters)).rejects.toThrow(/could not be verified/);
    expect(await db.socialConnection.findUniqueOrThrow({ where: { id: f.connection.id } })).toMatchObject({ dataSnapshot: null, dataLeaseId: null, dataErrorCode: "READ_NOT_COMPLETED" });
    await expect(refreshSocialAccountData(f.scope, f.connection.id, f.adapters)).rejects.toThrow(/15 minutes/);
  });
  it.each(["disconnect", "rotate", "forget", "role", "session", "mfa", "configuration"])("discards a response when %s changes during the request", async change => {
    const f = await fixture(); f.read.mockImplementation(async () => {
      if (change === "disconnect") await db.socialConnection.update({ where: { id: f.connection.id }, data: { status: "DISCONNECTED" } });
      if (change === "rotate") await db.socialConnection.update({ where: { id: f.connection.id }, data: { encryptedToken: "rotated" } });
      if (change === "forget") await forgetSocialAccountData(f.scope, f.connection.id);
      if (change === "role") await db.membership.updateMany({ where: { organizationId: f.scope.organizationId }, data: { role: "VIEWER" } });
      if (change === "session") await db.session.delete({ where: { id: f.scope.sessionId } });
      if (change === "mfa") await db.organization.update({ where: { id: f.scope.organizationId }, data: { requireMfa: true } });
      if (change === "configuration") f.adapter.version = "changed";
      return f.snapshot();
    });
    // A registry returning the same mutated object must still invalidate an in-flight read.
    await expect(refreshSocialAccountData(f.scope, f.connection.id, f.adapters)).rejects.toThrow();
    expect((await db.socialConnection.findUniqueOrThrow({ where: { id: f.connection.id } })).dataSnapshot).toBeNull();
  });
  it("requires configured adapters and known valid expiry before a request", async () => {
    const f = await fixture(); await expect(refreshSocialAccountData(f.scope, f.connection.id, () => ({}))).rejects.toThrow(/not enabled/);
    await db.socialConnection.update({ where: { id: f.connection.id }, data: { expiresAt: null } });
    await expect(refreshSocialAccountData(f.scope, f.connection.id, f.adapters)).rejects.toThrow(/Reconnect/); expect(f.read).not.toHaveBeenCalled();
  });
  it("hides and expires old snapshots; expired authorization also hides fresh data", async () => {
    const f = await fixture(); await refreshSocialAccountData(f.scope, f.connection.id, f.adapters);
    await db.socialConnection.update({ where: { id: f.connection.id }, data: { dataFetchedAt: new Date(Date.now() - 31 * 86400000) } });
    expect((await readSocialAccountData(f.scope, f.connection.id)).snapshot).toBeNull(); await expireSocialAccountData();
    expect((await db.socialConnection.findUniqueOrThrow({ where: { id: f.connection.id } })).dataSnapshot).toBeNull();
    await db.socialConnection.update({ where: { id: f.connection.id }, data: { dataSnapshot: f.snapshot(), dataFetchedAt: new Date(), expiresAt: new Date(0) } });
    expect((await readSocialAccountData(f.scope, f.connection.id)).snapshot).toBeNull();
  });
  it("enforces paired snapshot and lease fields at the database boundary", async () => {
    const f = await fixture();
    await expect(db.socialConnection.update({ where: { id: f.connection.id }, data: { dataSnapshot: f.snapshot() } })).rejects.toThrow(/snapshot_check/);
    await expect(db.socialConnection.update({ where: { id: f.connection.id }, data: { dataFetchedAt: new Date(), dataSnapshot: Prisma.DbNull } })).rejects.toThrow(/snapshot_check/);
    await expect(db.socialConnection.update({ where: { id: f.connection.id }, data: { dataLeaseId: "unpaired" } })).rejects.toThrow(/lease_check/);
  });
});
