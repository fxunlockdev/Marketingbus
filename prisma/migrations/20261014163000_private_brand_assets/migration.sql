CREATE TABLE "BrandAsset" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL UNIQUE,
  "label" TEXT NOT NULL,
  "purpose" TEXT NOT NULL CHECK ("purpose" IN ('logo', 'product', 'reference')),
  "sha256" TEXT NOT NULL,
  "bytes" INTEGER NOT NULL CHECK ("bytes" > 0 AND "bytes" <= 5242880),
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "uploadedBy" TEXT NOT NULL,
  "rightsConfirmedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandAsset_businessId_organizationId_fkey" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "BrandAsset_businessId_organizationId_status_idx" ON "BrandAsset"("businessId", "organizationId", "status");
