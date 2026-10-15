CREATE TABLE "CompositionExport" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "businessId" TEXT NOT NULL,
 "organizationId" TEXT NOT NULL,
 "compositionId" TEXT NOT NULL,
 "placement" TEXT NOT NULL CHECK ("placement" IN ('square','portrait','story','landscape')),
 "rendererVersion" TEXT NOT NULL,
 "manifest" JSONB NOT NULL,
 "objectKey" TEXT NOT NULL UNIQUE,
 "status" TEXT NOT NULL DEFAULT 'STORING',
 "sha256" TEXT NOT NULL DEFAULT '',
 "bytes" INTEGER NOT NULL CHECK ("bytes" >= 0 AND "bytes" <= 5242880),
 "leaseUntil" TIMESTAMP(3),
 "purgeAfter" TIMESTAMP(3) NOT NULL,
 "createdBy" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CompositionExport_businessId_organizationId_fkey" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CompositionExport_compositionId_placement_rendererVersion_key" ON "CompositionExport"("compositionId", "placement", "rendererVersion");
CREATE INDEX "CompositionExport_businessId_organizationId_createdAt_idx" ON "CompositionExport"("businessId", "organizationId", "createdAt");
CREATE INDEX "CompositionExport_status_purgeAfter_leaseUntil_idx" ON "CompositionExport"("status", "purgeAfter", "leaseUntil");
