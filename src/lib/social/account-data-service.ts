import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { openSecret } from "../secrets";
import { authorizeSocialScope, type OAuthScope } from "./oauth";
import { socialProvider } from "./contracts";
import { accountSnapshot, type SocialDataAdapters } from "./account-data-contracts";
import { configuredSocialDataAdapters } from "./account-data-adapters";

export const SOCIAL_DATA_COOLDOWN_MS = 15 * 60000;
export const SOCIAL_DATA_RETENTION_MS = 30 * 86400000;
export const eraseSocialData = { dataSnapshot: Prisma.DbNull, dataFetchedAt: null, dataLeaseId: null, dataLeaseUntil: null, dataErrorCode: null };
export async function readSocialAccountData(scope: OAuthScope, connectionId: string) {
  return db.$transaction(async tx => {
    await authorizeSocialScope(tx, scope, false);
    const connection = await tx.socialConnection.findFirst({ where: { id: connectionId, businessId: scope.businessId, organizationId: scope.organizationId } });
    if (!connection) throw new AppError(404, "Social account not found.");
    let snapshot = null;
    if (connection.status === "CONNECTED" && connection.expiresAt && connection.expiresAt > new Date() && connection.dataFetchedAt && connection.dataFetchedAt.getTime() > Date.now() - SOCIAL_DATA_RETENTION_MS) {
      const parsed = accountSnapshot.safeParse(connection.dataSnapshot);
      if (parsed.success && parsed.data.provider === connection.provider && parsed.data.externalAccountId === connection.externalAccountId) snapshot = parsed.data;
    }
    return { connectionId, snapshot, lastAttemptAt: connection.dataAttemptedAt, errorCode: connection.dataErrorCode };
  });
}
export async function forgetSocialAccountData(scope: OAuthScope, connectionId: string) {
  return db.$transaction(async tx => {
    await authorizeSocialScope(tx, scope);
    const result = await tx.socialConnection.updateMany({ where: { id: connectionId, businessId: scope.businessId, organizationId: scope.organizationId }, data: eraseSocialData });
    if (!result.count) throw new AppError(404, "Social account not found.");
    await tx.auditEvent.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, actorId: scope.actorId, action: "SOCIAL_DATA_FORGOTTEN", detail: "Saved account snapshot removed; remote posts and account authorization unchanged." } });
    return { ok: true };
  });
}
export async function refreshSocialAccountData(scope: OAuthScope, connectionId: string, adapters: () => SocialDataAdapters = configuredSocialDataAdapters) {
  const claim = await db.$transaction(async tx => {
    await authorizeSocialScope(tx, scope);
    const connection = await tx.socialConnection.findFirst({ where: { id: connectionId, businessId: scope.businessId, organizationId: scope.organizationId } });
    if (!connection) throw new AppError(404, "Social account not found.");
    if (connection.status !== "CONNECTED" || !connection.expiresAt || connection.expiresAt <= new Date()) throw new AppError(409, "Reconnect this account before reading its data.");
    const provider = socialProvider.parse(connection.provider), adapter = adapters()[provider];
    if (!adapter) throw new AppError(503, "Account data access is not enabled for this destination yet.");
    if ((connection.dataLeaseUntil && connection.dataLeaseUntil > new Date()) || (connection.dataAttemptedAt && connection.dataAttemptedAt.getTime() > Date.now() - SOCIAL_DATA_COOLDOWN_MS)) throw new AppError(429, "Account data can be refreshed once every 15 minutes. Saved data remains available.");
    const token = openSecret(connection.encryptedToken, `social:${scope.organizationId}:${scope.businessId}:${connection.id}`);
    const leaseId = randomUUID(), started = new Date();
    await tx.socialConnection.update({ where: { id: connectionId }, data: { dataAttemptedAt: started, dataLeaseId: leaseId, dataLeaseUntil: new Date(Date.now() + 120000), dataErrorCode: null } });
    return { connection, provider, adapter, adapterVersion: adapter.version, token, leaseId, started };
  });
  try {
    const signal = AbortSignal.timeout(30000);
    const raw = await claim.adapter.read({ id: connectionId, externalAccountId: claim.connection.externalAccountId, provider: claim.provider, token: claim.token }, signal);
    signal.throwIfAborted();
    const encoded = JSON.stringify(raw);
    if (Buffer.byteLength(encoded) > 140000 || encoded.includes(claim.token) || encoded.includes(claim.connection.encryptedToken)) throw Error("Invalid provider data.");
    const snapshot = accountSnapshot.parse(raw), observedAt = new Date(snapshot.observedAt);
    if (snapshot.provider !== claim.provider || snapshot.externalAccountId !== claim.connection.externalAccountId || observedAt < claim.started || observedAt.getTime() > Date.now() + 60000 || snapshot.posts.some(post => new Date(post.publishedAt) > observedAt)) throw Error("Invalid account data context.");
    await db.$transaction(async tx => {
      await authorizeSocialScope(tx, scope);
      const current = await tx.socialConnection.findUnique({ where: { id: connectionId } });
      if (!current || current.status !== "CONNECTED" || current.dataLeaseId !== claim.leaseId || !current.dataLeaseUntil || current.dataLeaseUntil <= new Date() || current.encryptedToken !== claim.connection.encryptedToken || current.externalAccountId !== claim.connection.externalAccountId || current.provider !== claim.provider || !current.expiresAt || current.expiresAt <= new Date() || adapters()[claim.provider]?.version !== claim.adapterVersion) throw new AppError(409, "Account access changed during refresh. Data was not saved.");
      await tx.socialConnection.update({ where: { id: connectionId }, data: { dataSnapshot: snapshot, dataFetchedAt: observedAt, dataLeaseId: null, dataLeaseUntil: null, dataErrorCode: null } });
      await tx.auditEvent.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, actorId: scope.actorId, action: "SOCIAL_DATA_REFRESHED", detail: `${claim.provider}: verified account snapshot imported. No publication or learning promotion performed.` } });
    });
    return { ok: true };
  } catch (error) {
    await db.socialConnection.updateMany({ where: { id: connectionId, businessId: scope.businessId, organizationId: scope.organizationId, dataLeaseId: claim.leaseId }, data: { ...eraseSocialData, dataErrorCode: "READ_NOT_COMPLETED" } });
    if (error instanceof AppError) throw error;
    throw new AppError(502, "Account data could not be verified. No new data was saved. Check access before retrying after 15 minutes.");
  }
}
export async function expireSocialAccountData() {
  const before = new Date(Date.now() - SOCIAL_DATA_RETENTION_MS);
  const rows = await db.socialConnection.findMany({ where: { dataFetchedAt: { lte: before } }, orderBy: { dataFetchedAt: "asc" }, take: 100, select: { id: true } });
  return db.socialConnection.updateMany({ where: { id: { in: rows.map(row => row.id) }, dataFetchedAt: { lte: before } }, data: { dataSnapshot: Prisma.DbNull, dataFetchedAt: null } });
}
