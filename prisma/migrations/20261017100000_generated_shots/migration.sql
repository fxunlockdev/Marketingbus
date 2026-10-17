ALTER TABLE "VideoClip" ADD COLUMN "generationId" TEXT;
CREATE TABLE "VideoGeneration" (
  "id" TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL, "storyboardId" TEXT NOT NULL, "itemId" TEXT NOT NULL,
  "copyRevisionId" TEXT, "brandVersion" INTEGER NOT NULL, "shotId" TEXT NOT NULL,
  "shotLabel" TEXT NOT NULL, "documentHash" TEXT NOT NULL, "prompt" TEXT NOT NULL,
  "route" JSONB NOT NULL, "configurationHash" TEXT NOT NULL, "durationMs" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OFFERED', "credits" INTEGER NOT NULL,
  "supplierCeilingMicros" INTEGER NOT NULL, "supplierCostMicros" INTEGER,
  "reservationId" TEXT, "providerJobId" TEXT, "providerJobKey" TEXT, "receipt" JSONB,
  "pollCount" INTEGER NOT NULL DEFAULT 0, "nextPollAt" TIMESTAMP(3), "leaseUntil" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL, "acceptedAt" TIMESTAMP(3), "submittedAt" TIMESTAMP(3),
  "errorCode" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoGeneration_businessId_organizationId_fkey" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VideoGeneration_id_businessId_organizationId_key" ON "VideoGeneration"("id", "businessId", "organizationId");
CREATE UNIQUE INDEX "VideoGeneration_reservationId_key" ON "VideoGeneration"("reservationId");
CREATE UNIQUE INDEX "VideoGeneration_providerJobKey_key" ON "VideoGeneration"("providerJobKey");
CREATE INDEX "VideoGeneration_businessId_organizationId_createdAt_idx" ON "VideoGeneration"("businessId", "organizationId", "createdAt");
CREATE INDEX "VideoGeneration_status_nextPollAt_leaseUntil_idx" ON "VideoGeneration"("status", "nextPollAt", "leaseUntil");
CREATE UNIQUE INDEX "VideoClip_generationId_key" ON "VideoClip"("generationId");
CREATE UNIQUE INDEX "VideoClip_generationId_businessId_organizationId_key" ON "VideoClip"("generationId", "businessId", "organizationId");
ALTER TABLE "VideoClip" ADD CONSTRAINT "VideoClip_generationId_businessId_organizationId_fkey" FOREIGN KEY ("generationId", "businessId", "organizationId") REFERENCES "VideoGeneration"("id", "businessId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
