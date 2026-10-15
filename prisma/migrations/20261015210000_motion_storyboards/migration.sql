ALTER TABLE "WorkerHeartbeat" ADD COLUMN "motionReady" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "VideoStoryboard" (
 "id" TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
 "itemId" TEXT NOT NULL, "copyRevisionId" TEXT, "brandVersion" INTEGER NOT NULL, "version" INTEGER NOT NULL,
 "document" JSONB NOT NULL, "shotApprovals" JSONB NOT NULL, "authorId" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'DRAFT', "approvedBy" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "VideoStoryboard_businessId_organizationId_fkey" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "VideoStoryboard_itemId_organizationId_fkey" FOREIGN KEY ("itemId", "organizationId") REFERENCES "ProductionItem"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
 UNIQUE ("itemId", "version"), UNIQUE ("id", "businessId", "organizationId")
);
CREATE INDEX "VideoStoryboard_businessId_organizationId_createdAt_idx" ON "VideoStoryboard"("businessId", "organizationId", "createdAt");
CREATE TABLE "MotionRender" (
 "id" TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "storyboardId" TEXT NOT NULL,
 "rendererVersion" TEXT NOT NULL, "documentHash" TEXT NOT NULL, "objectKey" TEXT NOT NULL UNIQUE,
 "status" TEXT NOT NULL DEFAULT 'QUEUED', "bytes" INTEGER NOT NULL CHECK ("bytes">=0 AND "bytes"<=20971520),
 "sha256" TEXT NOT NULL DEFAULT '', "durationMs" INTEGER NOT NULL CHECK ("durationMs">=1000 AND "durationMs"<=30000),
 "createdBy" TEXT NOT NULL, "approvedBy" TEXT, "errorCode" TEXT, "leaseUntil" TIMESTAMP(3), "purgeAfter" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MotionRender_businessId_organizationId_fkey" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "MotionRender_storyboardId_businessId_organizationId_fkey" FOREIGN KEY ("storyboardId", "businessId", "organizationId") REFERENCES "VideoStoryboard"("id", "businessId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
 UNIQUE ("storyboardId", "rendererVersion")
);
CREATE INDEX "MotionRender_businessId_organizationId_createdAt_idx" ON "MotionRender"("businessId", "organizationId", "createdAt");
CREATE INDEX "MotionRender_status_leaseUntil_idx" ON "MotionRender"("status", "leaseUntil");
CREATE TABLE "MotionAuthorization" ("key" TEXT PRIMARY KEY, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
