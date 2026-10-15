import { db } from "@/lib/db";
export const dynamic="force-dynamic";
export async function GET() {
  try {
    // Connectivity alone cannot detect an unapplied initial migration.
    await db.$queryRaw`SELECT "id", "emailVerifiedAt", "authVersion" FROM "User" LIMIT 0`;
    await db.$queryRaw`SELECT "authVersion" FROM "Session" LIMIT 0`;
    await db.$queryRaw`SELECT "key" FROM "RateLimit" LIMIT 0`;
    await db.$queryRaw`SELECT "organizationId" FROM "Wallet" LIMIT 0`;
    await db.$queryRaw`SELECT "configurationHash" FROM "GenerationQuote" LIMIT 0`;
    await db.$queryRaw`SELECT "revisionId" FROM "CalendarEntry" LIMIT 0`;
    await db.$queryRaw`SELECT "submittedAt" FROM "Job" LIMIT 0`;
    await db.$queryRaw`SELECT "lastSeenAt" FROM "WorkerHeartbeat" LIMIT 0`;
    await db.$queryRaw`SELECT "ceilingMicros" FROM "SupplierAuthorization" LIMIT 0`;
    await db.$queryRaw`SELECT "objectKey", "approvedForGeneration", "purgeLeaseUntil" FROM "BrandAsset" LIMIT 0`;
    await db.$queryRaw`SELECT "sha256" FROM "KnowledgeSource" LIMIT 0`;
    await db.$queryRaw`SELECT "expiresAt" FROM "IdentityToken" LIMIT 0`;
    await db.$queryRaw`SELECT "encryptedPayload" FROM "EmailOutbox" LIMIT 0`;
    await db.$queryRaw`SELECT "encryptedToken" FROM "SocialConnection" LIMIT 0`;
    await db.$queryRaw`SELECT "payloadHash", "metricsLeaseUntil" FROM "SocialPublication" LIMIT 0`;
    await db.$queryRaw`SELECT "definitionVersion" FROM "MetricSnapshot" LIMIT 0`;
    await db.$queryRaw`SELECT "evidence" FROM "LearningProposal" LIMIT 0`;
    await db.$queryRaw`SELECT "document" FROM "StaticComposition" LIMIT 0`;
    await db.$queryRaw`SELECT "outboxId" FROM "TeamInvitation" LIMIT 0`;
    await db.$queryRaw`SELECT "actorId" FROM "TeamEvent" LIMIT 0`;
    await db.$queryRaw`SELECT "enabledAt", "lastStep" FROM "MfaCredential" LIMIT 0`;
    return Response.json({status:"ok"},{headers:{"Cache-Control":"no-store"}});
  }
  catch { return Response.json({status:"unavailable"},{status:503,headers:{"Cache-Control":"no-store"}}); }
}
