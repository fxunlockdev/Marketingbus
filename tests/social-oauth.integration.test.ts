import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { beginSocialOAuth, cancelSocialOAuth, chooseSocialAccount, completeSocialOAuth, configuredSocialOAuthAdapters, expireSocialOAuth, readSocialConnections, type OAuthScope, type SocialOAuthAdapter } from "../src/lib/social/oauth";
import { openSecret } from "../src/lib/secrets";
import { createLinkedInOAuthAdapter } from "../src/lib/social/linkedin-oauth";
import { linkedInFixture } from "./helpers/linkedin";
const local = process.env.TEST_DATABASE_URL;
if (local && (process.env.DATABASE_URL !== local || !["localhost", "127.0.0.1"].includes(new URL(local).hostname))) throw Error("Local test DB required");
const suite = local ? describe : describe.skip;
suite("session-bound social authorization", () => {
  const orgs: string[] = [], users: string[] = [];
  beforeAll(() => {
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
    vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test");
    vi.stubEnv("SECRET_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  });
  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function fixture() {
    const organization = await db.organization.create({ data: { name: "OAuth LOCAL TEST" } }); orgs.push(organization.id);
    const user = await db.user.create({ data: { name: "OAuth test", email: `${randomUUID()}@example.test`, passwordHash: "not-a-login" } }); users.push(user.id);
    await db.membership.create({ data: { organizationId: organization.id, userId: user.id, role: "OWNER" } });
    const session = await db.session.create({ data: { id: randomUUID(), userId: user.id, expiresAt: new Date(Date.now() + 3600000) } });
    const business = await db.business.create({ data: { organizationId: organization.id, name: "OAuth fixture" } });
    const scope: OAuthScope = { businessId: business.id, organizationId: organization.id, actorId: user.id, sessionId: session.id };
    const exchange = vi.fn<SocialOAuthAdapter["exchange"]>().mockResolvedValue([
      { externalAccountId: "page-1", label: "First page", token: "private-access-token-one", permissions: ["publish"], expiresAt: new Date(Date.now() + 3600000).toISOString() },
      { externalAccountId: "page-2", label: "Second page", token: "private-access-token-two", permissions: ["publish"], expiresAt: null },
    ]);
    const adapter: SocialOAuthAdapter = { config: { version: "test-v1", clientId: "test-client", authorizationEndpoint: "https://authorization.example.test/authorize", scopes: ["publish"] }, exchange };
    const adapters = { Facebook: adapter, Instagram: adapter };
    async function begin() {
      const url = new URL((await beginSocialOAuth(scope, "Facebook", adapters)).authorizationUrl);
      const state = url.searchParams.get("state")!;
      const flow = await db.socialOAuthFlow.findUniqueOrThrow({ where: { stateHash: createHash("sha256").update(state).digest("hex") } });
      return { url, state, flow, params: new URLSearchParams({ state, code: "private-authorization-code" }) };
    }
    return { scope, adapter, adapters, exchange, begin };
  }
  it("leaves unconfigured providers disabled", () => expect(configuredSocialOAuthAdapters()).toEqual({}));
  it("completes the LinkedIn web flow through explicit selection and encrypted tenant-bound storage", async () => {
    const f = await fixture(), transport = linkedInFixture();
    const adapters = { LinkedIn: createLinkedInOAuthAdapter(transport.config, transport.fetcher) };
    const url = new URL((await beginSocialOAuth(f.scope, "LinkedIn", adapters)).authorizationUrl);
    expect(url.origin).toBe("https://www.linkedin.com");
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.href).not.toContain(transport.config.clientSecret);
    const state = url.searchParams.get("state")!;
    const flow = await db.socialOAuthFlow.findUniqueOrThrow({ where: { stateHash: createHash("sha256").update(state).digest("hex") } });
    expect(flow.encryptedVerifier).toBeNull();
    expect(flow.authentication).toBe("LINKEDIN_CONFIDENTIAL");
    await expect(db.socialOAuthFlow.update({ where: { id: flow.id }, data: { provider: "Facebook" } })).rejects.toThrow(/authentication_check/);
    await expect(db.socialOAuthFlow.update({ where: { id: flow.id }, data: { encryptedVerifier: "unexpected-verifier" } })).rejects.toThrow(/secrets_check/);
    const parameters = new URLSearchParams({ state, code: "local-code" });
    await expect(completeSocialOAuth("other-session", "LinkedIn", parameters, adapters)).rejects.toThrow(/does not match/);
    await expect(completeSocialOAuth(f.scope.sessionId, "Facebook", parameters, adapters)).rejects.toThrow(/does not match/);
    expect(transport.fetcher).not.toHaveBeenCalled();
    await completeSocialOAuth(f.scope.sessionId, "LinkedIn", parameters, adapters);
    await expect(completeSocialOAuth(f.scope.sessionId, "LinkedIn", parameters, adapters)).rejects.toThrow(/already used/);
    expect(transport.fetcher).toHaveBeenCalledTimes(4);
    const view = await readSocialConnections(f.scope, adapters);
    expect(view.flows[0].status).toBe("CHOOSING");
    expect(JSON.stringify(view)).not.toMatch(/local-access-token|local-client-secret|urn:li:organization/);
    expect(await db.socialConnection.count({ where: { businessId: f.scope.businessId } })).toBe(0);
    const other = await fixture();
    await expect(chooseSocialAccount(other.scope, flow.id, view.flows[0].choices[0].choiceId, adapters)).rejects.toThrow(/not found/);
    const connected = await chooseSocialAccount(f.scope, flow.id, view.flows[0].choices[0].choiceId, adapters);
    const stored = await db.socialConnection.findUniqueOrThrow({ where: { id: connected.id } });
    expect(stored).toMatchObject({ provider: "LinkedIn", externalAccountId: "urn:li:organization:123", status: "CONNECTED" });
    expect(stored.encryptedToken).not.toContain("local-access-token");
    expect(openSecret(stored.encryptedToken, `social:${f.scope.organizationId}:${f.scope.businessId}:${stored.id}`)).toBe("local-access-token");
    expect(await db.socialOAuthFlow.findUnique({ where: { id: flow.id } })).toMatchObject({ status: "CONNECTED", encryptedCandidates: null });
  });
  it("does not permit a confidential-flow downgrade on other providers or endpoints", async () => {
    const f = await fixture();
    const pending = await f.begin();
    await expect(db.socialOAuthFlow.update({ where: { id: pending.flow.id }, data: { encryptedVerifier: null } })).rejects.toThrow(/secrets_check/);
    const adapter: SocialOAuthAdapter = { ...f.adapter, config: { ...f.adapter.config, authentication: "LINKEDIN_CONFIDENTIAL" } };
    await expect(beginSocialOAuth(f.scope, "Facebook", { Facebook: adapter })).rejects.toThrow(/configuration is invalid/);
    await expect(beginSocialOAuth(f.scope, "LinkedIn", { LinkedIn: adapter })).rejects.toThrow(/configuration is invalid/);
    expect(f.exchange).not.toHaveBeenCalled();
  });
  it("invalidates pending LinkedIn exchanges when credentials rotate", async () => {
    const f = await fixture(), transport = linkedInFixture();
    const adapters = { LinkedIn: createLinkedInOAuthAdapter(transport.config, transport.fetcher) };
    const url = new URL((await beginSocialOAuth(f.scope, "LinkedIn", adapters)).authorizationUrl);
    adapters.LinkedIn = createLinkedInOAuthAdapter({ ...transport.config, clientSecret: "rotated-secret" }, transport.fetcher);
    await expect(completeSocialOAuth(f.scope.sessionId, "LinkedIn", new URLSearchParams({ state: url.searchParams.get("state")!, code: "code" }), adapters)).rejects.toThrow(/settings changed/);
    expect(transport.fetcher).not.toHaveBeenCalled();
  });
  it("blocks a previously started callback if workspace MFA becomes required", async () => {
    const f = await fixture(), b = await f.begin();
    await db.organization.update({ where: { id: f.scope.organizationId }, data: { requireMfa: true } });
    await expect(completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters)).rejects.toThrow(/requires MFA/);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(await db.socialConnection.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it("binds S256 and hashed state, encrypts temporary tokens, and requires one explicit account selection", async () => {
    const f = await fixture(), b = await f.begin();
    expect(b.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(JSON.stringify(b.flow)).not.toContain(b.state);
    await completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters);
    const verifier = f.exchange.mock.calls[0][0].verifier;
    expect(b.url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(f.exchange.mock.calls[0][0].redirectUri).toBe("http://127.0.0.1:3000/api/social/facebook/callback");
    expect(await db.socialConnection.count({ where: { businessId: f.scope.businessId } })).toBe(0);
    const row = await db.socialOAuthFlow.findUniqueOrThrow({ where: { id: b.flow.id } });
    expect(row).toMatchObject({ status: "CHOOSING", encryptedVerifier: null });
    expect(JSON.stringify(row)).not.toContain("private-access-token");
    const view = await readSocialConnections(f.scope, f.adapters);
    for (const secret of ["private-access-token", "private-authorization-code", "encrypted", "stateHash", "sessionId", "page-1"]) expect(JSON.stringify(view)).not.toContain(secret);
    const selection = view.flows[0].choices[1];
    const connected = await chooseSocialAccount(f.scope, b.flow.id, selection.choiceId, f.adapters);
    const connection = await db.socialConnection.findUniqueOrThrow({ where: { id: connected.id } });
    expect(connection.externalAccountId).toBe("page-2");
    expect(openSecret(connection.encryptedToken, `social:${f.scope.organizationId}:${f.scope.businessId}:${connection.id}`)).toBe("private-access-token-two");
    expect(await db.socialOAuthFlow.findUnique({ where: { id: b.flow.id } })).toMatchObject({ status: "CONNECTED", encryptedVerifier: null, encryptedCandidates: null });
    await expect(chooseSocialAccount(f.scope, b.flow.id, selection.choiceId, f.adapters)).rejects.toThrow(/already used/);
    expect(await db.auditEvent.count({ where: { businessId: f.scope.businessId, action: "SOCIAL_CONNECTED" } })).toBe(1);
  });
  it("rejects other sessions, providers, duplicate parameters and replayed callbacks without another exchange", async () => {
    const f = await fixture(), b = await f.begin();
    await expect(completeSocialOAuth("another-session", "Facebook", b.params, f.adapters)).rejects.toThrow(/does not match/);
    await expect(completeSocialOAuth(f.scope.sessionId, "Instagram", b.params, f.adapters)).rejects.toThrow(/does not match/);
    const duplicate = new URLSearchParams(b.params); duplicate.append("state", b.state);
    await expect(completeSocialOAuth(f.scope.sessionId, "Facebook", duplicate, f.adapters)).rejects.toThrow(/Invalid/);
    const outcomes = await Promise.allSettled([1, 2].map(() => completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters)));
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it("requires current owner/admin authority and a valid session at begin and selection", async () => {
    const f = await fixture(), b = await f.begin();
    await completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters);
    const choice = (await readSocialConnections(f.scope, f.adapters)).flows[0].choices[0];
    await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "EDITOR" } });
    await expect(f.begin()).rejects.toThrow(/owner or admin/);
    await expect(chooseSocialAccount(f.scope, b.flow.id, choice.choiceId, f.adapters)).rejects.toThrow(/owner or admin/);
    expect((await readSocialConnections(f.scope, f.adapters)).flows).toEqual([]);
    await db.user.update({ where: { id: f.scope.actorId }, data: { authVersion: { increment: 1 } } });
    await expect(readSocialConnections(f.scope, f.adapters)).rejects.toThrow(/Sign in again/);
  });
  it("rejects cross-business scope and foreign account choices", async () => {
    const f = await fixture(), other = await fixture(), b = await f.begin();
    await completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters);
    const choice = (await readSocialConnections(f.scope, f.adapters)).flows[0].choices[0];
    await expect(chooseSocialAccount(other.scope, b.flow.id, choice.choiceId, f.adapters)).rejects.toThrow(/not found/);
    await expect(chooseSocialAccount(f.scope, b.flow.id, randomUUID(), f.adapters)).rejects.toThrow(/Choose an account/);
    await expect(readSocialConnections({ ...f.scope, businessId: other.scope.businessId }, f.adapters)).rejects.toThrow(/not found/);
  });
  it("does not retain grants when membership is revoked during exchange", async () => {
    const f = await fixture(), b = await f.begin();
    f.exchange.mockImplementationOnce(async () => {
      await db.membership.delete({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } } });
      return [{ externalAccountId: "page", label: "Page", token: "secret", permissions: ["publish"], expiresAt: null }];
    });
    await completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters);
    expect(await db.socialOAuthFlow.findUnique({ where: { id: b.flow.id } })).toMatchObject({ status: "FAILED", encryptedCandidates: null });
  });
  it.each(["missing-scope", "expired", "duplicate", "oversized", "throw"])("fails closed on %s provider results without storing raw errors", async kind => {
    const f = await fixture(), b = await f.begin();
    const account = { externalAccountId: "page", label: "Page", token: "secret", permissions: ["publish"], expiresAt: null as string | null };
    if (kind === "missing-scope") account.permissions = ["read"];
    if (kind === "expired") account.expiresAt = new Date(0).toISOString();
    if (kind === "oversized") account.token = "x".repeat(100001);
    if (kind === "throw") f.exchange.mockRejectedValueOnce(Error("private-provider-secret-error"));
    else f.exchange.mockResolvedValueOnce(kind === "duplicate" ? [account, account] : [account]);
    await completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters);
    const row = await db.socialOAuthFlow.findUniqueOrThrow({ where: { id: b.flow.id } });
    expect(row).toMatchObject({ status: "FAILED", encryptedCandidates: null, encryptedVerifier: null, errorCode: "EXCHANGE_NOT_COMPLETED" });
    expect(JSON.stringify(row)).not.toContain("private-provider");
    await expect(completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters)).rejects.toThrow(/already used/);
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it("denial consumes the flow and erases its verifier without exchanging", async () => {
    const f = await fixture(), b = await f.begin();
    await completeSocialOAuth(f.scope.sessionId, "Facebook", new URLSearchParams({ state: b.state, error: "access_denied", error_description: "private" }), f.adapters);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(await db.socialOAuthFlow.findUnique({ where: { id: b.flow.id } })).toMatchObject({ status: "FAILED", encryptedVerifier: null, errorCode: "AUTHORIZATION_DENIED" });
  });
  it("cancellation during exchange discards late credentials", async () => {
    const f = await fixture(), b = await f.begin();
    f.exchange.mockImplementationOnce(async () => {
      await cancelSocialOAuth(f.scope, b.flow.id);
      return [{ externalAccountId: "page", label: "Page", token: "secret", permissions: ["publish"], expiresAt: null }];
    });
    await completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters);
    expect(await db.socialOAuthFlow.findUnique({ where: { id: b.flow.id } })).toMatchObject({ status: "CANCELLED", encryptedCandidates: null });
  });
  it("changing configuration or removing adapters prevents account activation", async () => {
    const f = await fixture(), b = await f.begin();
    await completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters);
    const choice = (await readSocialConnections(f.scope, f.adapters)).flows[0].choices[0];
    await expect(chooseSocialAccount(f.scope, b.flow.id, choice.choiceId, {})).rejects.toThrow(/not enabled/);
    f.adapter.config.version = "changed";
    await expect(chooseSocialAccount(f.scope, b.flow.id, choice.choiceId, f.adapters)).rejects.toThrow(/settings changed/);
  });
  it("expired requests cannot exchange or select and bounded retention removes secret rows", async () => {
    const f = await fixture(), b = await f.begin();
    await db.socialOAuthFlow.update({ where: { id: b.flow.id }, data: { expiresAt: new Date(0) } });
    await expect(completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters)).rejects.toThrow(/expired/);
    await expireSocialOAuth();
    expect(await db.socialOAuthFlow.findUnique({ where: { id: b.flow.id } })).toBeNull();
    expect(f.exchange).not.toHaveBeenCalled();
  });
  it("new requests cancel older pending grants, and logout deletes temporary material", async () => {
    const f = await fixture(), first = await f.begin();
    await f.begin();
    expect(await db.socialOAuthFlow.findUnique({ where: { id: first.flow.id } })).toMatchObject({ status: "CANCELLED", encryptedVerifier: null });
    await db.session.delete({ where: { id: f.scope.sessionId } });
    expect(await db.socialOAuthFlow.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it("concurrent selection creates only one account and consumes all temporary candidates", async () => {
    const f = await fixture(), b = await f.begin();
    await completeSocialOAuth(f.scope.sessionId, "Facebook", b.params, f.adapters);
    const choices = (await readSocialConnections(f.scope, f.adapters)).flows[0].choices;
    const results = await Promise.allSettled(choices.map(choice => chooseSocialAccount(f.scope, b.flow.id, choice.choiceId, f.adapters)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.socialConnection.count({ where: { businessId: f.scope.businessId } })).toBe(1);
  });
});
