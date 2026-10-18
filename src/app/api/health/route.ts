import { db } from "@/lib/db";
import { typographyManifest } from "@/lib/typography";
export const dynamic="force-dynamic";
export async function GET() {
  try {
    typographyManifest();
    // Connectivity alone cannot detect an unapplied initial migration.
    await db.$queryRaw`SELECT "id", "emailVerifiedAt", "authVersion" FROM "User" LIMIT 0`;
    await db.$queryRaw`SELECT "authVersion" FROM "Session" LIMIT 0`;
    await db.$queryRaw`SELECT "requireMfa" FROM "Organization" LIMIT 0`;
    await db.$queryRaw`SELECT "key" FROM "RateLimit" LIMIT 0`;
    await db.$queryRaw`SELECT "organizationId", "revisionAvailable", "debt", "revisionDebt" FROM "Wallet" LIMIT 0`;
    await db.$queryRaw`SELECT "purpose", "revisionCredits" FROM "Reservation" LIMIT 0`;
    await db.$queryRaw`SELECT "providerSessionId" FROM "BillingCheckout" LIMIT 0`;
    await db.$queryRaw`SELECT "updatedThrough" FROM "BillingSubscription" LIMIT 0`;
    await db.$queryRaw`SELECT "reclaimedGeneral", "reclaimedRevision" FROM "BillingPayment" LIMIT 0`;
    await db.$queryRaw`SELECT "digest", "availableAt" FROM "BillingEvent" LIMIT 0`;
    await db.$queryRaw`SELECT "paymentId", "providerRefundId", "status" FROM "BillingRefundOperation" LIMIT 0`;
    await db.$queryRaw`SELECT "eventId", "operatorId" FROM "BillingReconciliation" LIMIT 0`;
    await db.$queryRaw`SELECT "configurationHash" FROM "GenerationQuote" LIMIT 0`;
    await db.$queryRaw`SELECT "revisionId", "version" FROM "CalendarEntry" LIMIT 0`;
    await db.$queryRaw`SELECT "submittedAt" FROM "Job" LIMIT 0`;
    await db.$queryRaw`SELECT "lastSeenAt", "motionReady" FROM "WorkerHeartbeat" LIMIT 0`;
    await db.$queryRaw`SELECT "document", "shotApprovals" FROM "VideoStoryboard" LIMIT 0`;
    await db.$queryRaw`SELECT "documentHash", "sha256", "purgeAfter" FROM "MotionRender" LIMIT 0`;
    await db.$queryRaw`SELECT "sourceHash", "processorVersion", "mediaKind", "instrumentalConfirmedAt", "leaseUntil", "purgeAfter" FROM "VideoClip" LIMIT 0`;
    await db.$queryRaw`SELECT "reservationId", "providerJobKey", "nextPollAt", "settledAt", "supplierEstimateMicros", "expenseBasis", "supplierReconciledAt", "creativeBrief", "revisionOfId" FROM "VideoGeneration" LIMIT 0`;
    await db.$queryRaw`SELECT "key" FROM "MotionAuthorization" LIMIT 0`;
    await db.$queryRaw`SELECT "ceilingMicros" FROM "SupplierAuthorization" LIMIT 0`;
    await db.$queryRaw`SELECT "objectKey", "approvedForGeneration", "purgeLeaseUntil", "generationId" FROM "BrandAsset" LIMIT 0`;
    await db.$queryRaw`SELECT "references", "reservationId", "supplierCostMicros" FROM "ImageGeneration" LIMIT 0`;
    await db.$queryRaw`SELECT "sha256" FROM "KnowledgeSource" LIMIT 0`;
    await db.$queryRaw`SELECT "sources", "reservationId", "appliedFields" FROM "BrandAnalysis" LIMIT 0`;
    await db.$queryRaw`SELECT "expiresAt" FROM "IdentityToken" LIMIT 0`;
    await db.$queryRaw`SELECT "encryptedPayload" FROM "EmailOutbox" LIMIT 0`;
    await db.$queryRaw`SELECT "encryptedToken", "authorizationVersion", "dataSnapshot", "dataLeaseId" FROM "SocialConnection" LIMIT 0`;
    await db.$queryRaw`SELECT "stateHash", "encryptedCandidates", "configurationHash", "authentication" FROM "SocialOAuthFlow" LIMIT 0`;
    await db.$queryRaw`SELECT "payloadHash", "metricsLeaseUntil", "metricsInvalidatedAt", "metricsRequestedAt", "reconciliationAttempts", "nextReconciliationAt", "submissionAdapterVersion", "candidatePostId", "mediaTransferVersion", "mediaExternalId", "mediaUploaded" FROM "SocialPublication" LIMIT 0`;
    await db.$queryRaw`SELECT "definitionVersion" FROM "MetricSnapshot" LIMIT 0`;
    await db.$queryRaw`SELECT "evidence" FROM "LearningProposal" LIMIT 0`;
    await db.$queryRaw`SELECT "document", "approvedRendererVersion" FROM "StaticComposition" LIMIT 0`;
    await db.$queryRaw`SELECT "manifest", "leaseUntil", "purgeAfter" FROM "CompositionExport" LIMIT 0`;
    await db.$queryRaw`SELECT "outboxId" FROM "TeamInvitation" LIMIT 0`;
    await db.$queryRaw`SELECT "actorId" FROM "TeamEvent" LIMIT 0`;
    await db.$queryRaw`SELECT "enabledAt", "lastStep" FROM "MfaCredential" LIMIT 0`;
    await db.$queryRaw`SELECT "independentApproval" FROM "Business" LIMIT 0`;
    await db.$queryRaw`SELECT "authorId", "approvedBy" FROM "CreativeRevision" LIMIT 0`;
    await db.$queryRaw`SELECT "blocking" FROM "ReviewComment" LIMIT 0`;
    await db.$queryRaw`SELECT "creditsPerWeek" FROM "WeeklyPolicy" LIMIT 0`;
    await db.$queryRaw`SELECT "creditsAuthorized" FROM "WeeklyCycle" LIMIT 0`;
    await db.$queryRaw`SELECT "quoteId" FROM "WeeklyTask" LIMIT 0`;
    return Response.json({status:"ok"},{headers:{"Cache-Control":"no-store"}});
  }
  catch { return Response.json({status:"unavailable"},{status:503,headers:{"Cache-Control":"no-store"}}); }
}
