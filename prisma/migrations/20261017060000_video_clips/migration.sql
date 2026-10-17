CREATE TABLE "VideoClip" (
  "id" TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
  "brandVersion" INTEGER NOT NULL, "label" TEXT NOT NULL, "createdBy" TEXT NOT NULL,
  "rightsConfirmedAt" TIMESTAMP(3) NOT NULL, "status" TEXT NOT NULL DEFAULT 'UPLOADING',
  "sourceKey" TEXT NOT NULL, "sourceHash" TEXT NOT NULL, "sourceBytes" INTEGER NOT NULL,
  "objectKey" TEXT NOT NULL, "sha256" TEXT NOT NULL DEFAULT '', "bytes" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER NOT NULL DEFAULT 0, "processorVersion" TEXT NOT NULL,
  "approvedBy" TEXT, "leaseUntil" TIMESTAMP(3), "errorCode" TEXT,
  "purgeAfter" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoClip_businessId_organizationId_fkey" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "VideoClip_status_check" CHECK ("status" IN ('UPLOADING','QUEUED','RUNNING','STORING','READY','APPROVED','REJECTED','FAILED','ARCHIVED','DELETING','DELETED')),
  CONSTRAINT "VideoClip_size_check" CHECK ("sourceBytes" > 0 AND "sourceBytes" <= 20971520 AND "bytes" >= 0 AND "bytes" <= 20971520)
);
CREATE UNIQUE INDEX "VideoClip_sourceKey_key" ON "VideoClip"("sourceKey");
CREATE UNIQUE INDEX "VideoClip_objectKey_key" ON "VideoClip"("objectKey");
CREATE INDEX "VideoClip_businessId_organizationId_createdAt_idx" ON "VideoClip"("businessId","organizationId","createdAt");
CREATE INDEX "VideoClip_status_leaseUntil_idx" ON "VideoClip"("status","leaseUntil");
