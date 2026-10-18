import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma, SocialOAuthFlow } from "@prisma/client";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { encryptionReady, openSecret, sealSecret } from "../secrets";
import { lockBusiness, type Scope } from "../production/service";
import { socialProvider } from "./contracts";
import { saveVerifiedConnectionInTransaction } from "./service";
import { assertWorkspaceMfa } from "../identity/workspace-security";
import { createLinkedInOAuthAdapter, LINKEDIN_AUTHORIZATION_ENDPOINT } from "./linkedin-oauth";

type Provider = z.infer<typeof socialProvider>;
export type OAuthScope = Scope & { sessionId: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const active = ["PENDING", "EXCHANGING", "CHOOSING"];
const erased = { encryptedVerifier: null, encryptedCandidates: null };
const context = (flow: Pick<SocialOAuthFlow, "id" | "organizationId" | "businessId" | "sessionId">) =>
  `social-oauth:${flow.organizationId}:${flow.businessId}:${flow.sessionId}:${flow.id}`;
const accountSchema = z.object({
  externalAccountId: z.string().min(1).max(200), label: z.string().trim().min(1).max(120),
  token: z.string().min(1).max(20000), permissions: z.array(z.string().min(1).max(100)).min(1).max(30),
  expiresAt: z.iso.datetime().nullable(),
}).strict();
const candidatesSchema = z.array(accountSchema.extend({ choiceId: z.uuid() }).strict()).min(1).max(20);
const configSchema = z.object({
  // Configurations are code-owned, never submitted by a customer. No implicit grant or silent PKCE downgrade.
  version: z.string().min(1).max(80), clientId: z.string().min(1).max(200),
  authorizationEndpoint: z.url(), scopes: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/)).min(1).max(30),
  authentication: z.enum(["S256", "LINKEDIN_CONFIDENTIAL"]).optional(),
}).strict();
export interface SocialOAuthAdapter {
  config: z.infer<typeof configSchema>;
  // Must verify token audience/scopes and management rights for every returned account, with bounded I/O.
  // Transport receives secrets only here, never in a URL or a log. Returned tokens stay encrypted server-side.
  exchange(input: { code: string; verifier: string; redirectUri: string; signal: AbortSignal }): Promise<unknown>;
}
export type SocialOAuthAdapters = Partial<Record<Provider, SocialOAuthAdapter>>;
export function configuredSocialOAuthAdapters(): SocialOAuthAdapters {
  // No fixture or generic arbitrary-URL adapter can be enabled through environment variables.
  if (process.env.LINKEDIN_CONNECTIONS_ENABLED === "true") {
    try {
      return { LinkedIn: createLinkedInOAuthAdapter({ clientId: process.env.LINKEDIN_CLIENT_ID || "", clientSecret: process.env.LINKEDIN_CLIENT_SECRET || "", apiVersion: process.env.LINKEDIN_API_VERSION || "", verifiedUntil: process.env.LINKEDIN_API_VERIFIED_UNTIL || "" }) };
    } catch { /* Missing/expired operator verification must leave the destination disabled. */ }
  }
  return {};
}
function configuration(provider: Provider, adapters: SocialOAuthAdapters) {
  const adapter = adapters[provider];
  if (!adapter || !encryptionReady()) throw new AppError(503, "This destination is not enabled yet. No account was connected.");
  const config = configSchema.parse(adapter.config), endpoint = new URL(config.authorizationEndpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search)
    throw new AppError(503, "Destination authorization configuration is invalid.");
  if (config.authentication === "LINKEDIN_CONFIDENTIAL" && (provider !== "LinkedIn" || endpoint.href !== LINKEDIN_AUTHORIZATION_ENDPOINT))
    throw new AppError(503, "Destination authorization configuration is invalid.");
  const origin = new URL(process.env.APP_ORIGIN || "http://invalid");
  if ((origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/")
    throw new AppError(503, "Application origin is not configured safely.");
  const redirectUri = `${origin.origin}/api/social/${provider.toLowerCase()}/callback`;
  return { adapter, config, redirectUri, hash: digest(JSON.stringify({ provider, config, redirectUri, authentication: config.authentication ?? "S256" })) };
}
async function authorize(tx: Prisma.TransactionClient, scope: OAuthScope, write = true) {
  // Same order as account/invitation operations; hold these locks through the final write.
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${scope.actorId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${scope.organizationId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${scope.sessionId} FOR UPDATE`;
  const session = await tx.session.findUnique({ where: { id: scope.sessionId }, include: { user: true } });
  if (!session || session.userId !== scope.actorId || session.expiresAt <= new Date() || session.authVersion !== session.user.authVersion)
    throw new AppError(401, "Sign in again before connecting an account.");
  const member = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member || (write && !["OWNER", "ADMIN"].includes(member.role))) throw new AppError(403, "A workspace owner or admin must manage connections.");
  await assertWorkspaceMfa(tx, scope.organizationId, scope.actorId);
  await lockBusiness(tx, scope);
  return member;
}
function assertFlow(flow: SocialOAuthFlow | null, scope: OAuthScope) {
  if (!flow || flow.businessId !== scope.businessId || flow.organizationId !== scope.organizationId || flow.actorId !== scope.actorId || flow.sessionId !== scope.sessionId)
    throw new AppError(404, "Connection request not found.");
  return flow;
}
export async function beginSocialOAuth(scope: OAuthScope, rawProvider: unknown, adapters: SocialOAuthAdapters) {
  const provider = socialProvider.parse(rawProvider);
  return db.$transaction(async tx => {
    await authorize(tx, scope);
    const { config, redirectUri, hash } = configuration(provider, adapters);
    const state = randomBytes(32).toString("base64url"), verifier = config.authentication === "LINKEDIN_CONFIDENTIAL" ? null : randomBytes(32).toString("base64url");
    const id = randomUUID();
    // Replacing this session's older requests is explicit and keeps the pending-secret footprint bounded.
    await tx.socialOAuthFlow.updateMany({ where: { businessId: scope.businessId, sessionId: scope.sessionId, provider, status: { in: active } }, data: { status: "CANCELLED", ...erased } });
    await tx.socialOAuthFlow.create({ data: { ...scope, id, provider, authentication: config.authentication ?? "S256", stateHash: digest(state), configurationHash: hash,
      encryptedVerifier: verifier ? sealSecret(verifier, `${context({ ...scope, id })}:verifier`) : null, expiresAt: new Date(Date.now() + 600000) } });
    const url = new URL(config.authorizationEndpoint);
    url.search = new URLSearchParams({ client_id: config.clientId, response_type: "code", redirect_uri: redirectUri,
      scope: config.scopes.join(" "), state }).toString();
    if (verifier) {
      url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      url.searchParams.set("code_challenge_method", "S256");
    }
    return { authorizationUrl: url.href };
  });
}
export async function completeSocialOAuth(sessionId: string, rawProvider: unknown, parameters: URLSearchParams, adapters: SocialOAuthAdapters) {
  const provider = socialProvider.parse(rawProvider);
  for (const key of ["state", "code", "error"]) if (parameters.getAll(key).length > 1) throw new AppError(400, "Invalid authorization response.");
  const state = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(parameters.get("state"));
  const initial = await db.socialOAuthFlow.findUnique({ where: { stateHash: digest(state) } });
  if (!initial || initial.sessionId !== sessionId || initial.provider !== provider) throw new AppError(400, "Connection request does not match this session or destination.");
  const scope = { businessId: initial.businessId, organizationId: initial.organizationId, actorId: initial.actorId, sessionId };
  const claimed = await db.$transaction(async tx => {
    await authorize(tx, scope);
    const flow = assertFlow(await tx.socialOAuthFlow.findUnique({ where: { id: initial.id } }), scope);
    if (flow.status !== "PENDING" || flow.expiresAt <= new Date()) throw new AppError(409, "This connection request was already used or expired. Start again.");
    if (parameters.has("error")) {
      await tx.socialOAuthFlow.update({ where: { id: flow.id }, data: { status: "FAILED", errorCode: "AUTHORIZATION_DENIED", ...erased } });
      return null;
    }
    const current = configuration(provider, adapters);
    if (current.hash !== flow.configurationHash) throw new AppError(409, "Destination settings changed. Start again.");
    const code = z.string().min(1).max(4096).parse(parameters.get("code"));
    const verifier = current.config.authentication === "LINKEDIN_CONFIDENTIAL" ? "" : openSecret(flow.encryptedVerifier!, `${context(flow)}:verifier`);
    // Claim BEFORE network I/O. Never retry an exchange after an uncertain outcome or worker interruption.
    await tx.socialOAuthFlow.update({ where: { id: flow.id }, data: { status: "EXCHANGING", ...erased } });
    return { flow, current, code, verifier };
  });
  if (!claimed) return { businessId: initial.businessId, flowId: initial.id };
  try {
    const signal = AbortSignal.timeout(30000);
    const result = await claimed.current.adapter.exchange({ code: claimed.code, verifier: claimed.verifier, redirectUri: claimed.current.redirectUri, signal });
    signal.throwIfAborted();
    // Adapter bounds its response body; this independently bounds the accepted structured payload.
    if (Buffer.byteLength(JSON.stringify(result) || "") > 100000) throw Error("Invalid authorization result");
    const accounts = z.array(accountSchema).min(1).max(20).parse(result);
    if (new Set(accounts.map(a => a.externalAccountId)).size !== accounts.length) throw Error("Duplicate accounts");
    for (const account of accounts) {
      if (claimed.current.config.scopes.some(scope => !account.permissions.includes(scope)) || (account.expiresAt && new Date(account.expiresAt).getTime() <= Date.now())) throw Error("Insufficient or expired authorization");
    }
    const candidates = accounts.map(account => ({ ...account, choiceId: randomUUID() }));
    await db.$transaction(async tx => {
      await authorize(tx, scope);
      const flow = assertFlow(await tx.socialOAuthFlow.findUnique({ where: { id: initial.id } }), scope);
      if (flow.status !== "EXCHANGING" || flow.expiresAt <= new Date() || configuration(provider, adapters).hash !== flow.configurationHash) throw Error("Connection context changed");
      await tx.socialOAuthFlow.update({ where: { id: flow.id }, data: { status: "CHOOSING", encryptedCandidates: sealSecret(JSON.stringify(candidates), `${context(flow)}:candidates`) } });
    });
  } catch {
    // Never save provider error text, URLs, codes, tokens or account data in audit/log messages.
    await db.socialOAuthFlow.updateMany({ where: { id: initial.id, status: "EXCHANGING" }, data: { status: "FAILED", errorCode: "EXCHANGE_NOT_COMPLETED", ...erased } });
  }
  return { businessId: initial.businessId, flowId: initial.id };
}
export const connectionAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin"), provider: socialProvider }).strict(),
  z.object({ action: z.literal("choose"), flowId: z.uuid(), choiceId: z.uuid() }).strict(),
  z.object({ action: z.literal("cancel"), flowId: z.uuid() }).strict(),
]);
export async function chooseSocialAccount(scope: OAuthScope, flowId: string, choiceId: string, adapters: SocialOAuthAdapters) {
  return db.$transaction(async tx => {
    await authorize(tx, scope);
    const flow = assertFlow(await tx.socialOAuthFlow.findUnique({ where: { id: flowId } }), scope);
    if (flow.status !== "CHOOSING" || flow.expiresAt <= new Date()) throw new AppError(409, "This account selection was already used or expired. Start again.");
    const provider = socialProvider.parse(flow.provider), current = configuration(provider, adapters);
    if (flow.configurationHash !== current.hash) throw new AppError(409, "Destination settings changed. Start again.");
    const candidates = candidatesSchema.parse(JSON.parse(openSecret(flow.encryptedCandidates!, `${context(flow)}:candidates`)));
    const account = candidates.find(candidate => candidate.choiceId === choiceId);
    if (!account) throw new AppError(400, "Choose an account from this connection request.");
    if ((account.expiresAt && new Date(account.expiresAt) <= new Date()) || current.config.scopes.some(permission => !account.permissions.includes(permission))) throw new AppError(409, "Account authorization expired or lacks required permissions. Start again.");
    const { choiceId: _choiceId, ...grant } = account;
    const { sessionId: _sessionId, ...auditScope } = scope;
    const connection = await saveVerifiedConnectionInTransaction(tx, auditScope, { ...grant, provider, expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null });
    await tx.socialOAuthFlow.update({ where: { id: flow.id }, data: { status: "CONNECTED", ...erased } });
    return connection;
  });
}
export async function cancelSocialOAuth(scope: OAuthScope, flowId: string) {
  return db.$transaction(async tx => {
    await authorize(tx, scope);
    const flow = assertFlow(await tx.socialOAuthFlow.findUnique({ where: { id: flowId } }), scope);
    if (active.includes(flow.status)) await tx.socialOAuthFlow.update({ where: { id: flow.id }, data: { status: "CANCELLED", ...erased } });
    return { ok: true };
  });
}
export async function readSocialConnections(scope: OAuthScope, adapters: SocialOAuthAdapters) {
  return db.$transaction(async tx => {
    const member = await authorize(tx, scope, false), canManage = ["OWNER", "ADMIN"].includes(member.role);
    const connections = await tx.socialConnection.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId }, orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, provider: true, label: true, status: true, expiresAt: true } });
    const flows = canManage ? await tx.socialOAuthFlow.findMany({ where: { businessId: scope.businessId, sessionId: scope.sessionId, actorId: scope.actorId, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: 10 }) : [];
    const enabledProviders = socialProvider.options.filter(provider => { try { configuration(provider, adapters); return true; } catch { return false; } });
    return { canManage, connections, enabledProviders, flows: flows.map(flow => {
      let choices: { choiceId: string; label: string }[] = [];
      if (flow.status === "CHOOSING") {
        try { choices = candidatesSchema.parse(JSON.parse(openSecret(flow.encryptedCandidates!, `${context(flow)}:candidates`))).map(({ choiceId, label }) => ({ choiceId, label })); } catch { /* Fail closed; cancel/start again remains available. */ }
      }
      return { id: flow.id, provider: flow.provider, status: flow.status, expiresAt: flow.expiresAt, choices };
    }) };
  });
}
export async function expireSocialOAuth() {
  // Bounded cleanup, independent of paid execution. Session deletion also cascades temporary secrets.
  const rows = await db.socialOAuthFlow.findMany({ where: { expiresAt: { lte: new Date() } }, orderBy: { expiresAt: "asc" }, take: 100, select: { id: true } });
  return db.socialOAuthFlow.deleteMany({ where: { id: { in: rows.map(row => row.id) }, expiresAt: { lte: new Date() } } });
}
