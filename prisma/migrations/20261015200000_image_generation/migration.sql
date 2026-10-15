CREATE TABLE "ImageGeneration" (
 "id" TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
 "actorId" TEXT NOT NULL, "itemId" TEXT NOT NULL, "revisionId" TEXT NOT NULL,
 "brandVersion" INTEGER NOT NULL, "version" INTEGER NOT NULL,
 "parentId" TEXT, "feedback" TEXT NOT NULL DEFAULT '', "prompt" TEXT NOT NULL,
 "references" JSONB NOT NULL, "route" JSONB NOT NULL, "configurationHash" TEXT NOT NULL,
 "credits" INTEGER NOT NULL CHECK ("credits" > 0),
 "supplierCeilingMicros" INTEGER NOT NULL CHECK ("supplierCeilingMicros" > 0),
 "status" TEXT NOT NULL DEFAULT 'OFFERED', "expiresAt" TIMESTAMP(3) NOT NULL,
 "acceptedAt" TIMESTAMP(3), "submittedAt" TIMESTAMP(3), "leaseUntil" TIMESTAMP(3),
 "reservationId" TEXT UNIQUE, "providerResponseId" TEXT, "supplierCostMicros" INTEGER,
 "usage" JSONB, "errorCode" TEXT, "approvedBy" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ImageGeneration_businessId_organizationId_fkey" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "ImageGeneration_item_scope_fkey" FOREIGN KEY ("itemId", "organizationId") REFERENCES "ProductionItem"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
 UNIQUE ("id", "businessId", "organizationId"), UNIQUE ("itemId", "version")
);
CREATE INDEX "ImageGeneration_businessId_organizationId_createdAt_idx" ON "ImageGeneration"("businessId", "organizationId", "createdAt");
CREATE INDEX "ImageGeneration_status_leaseUntil_idx" ON "ImageGeneration"("status", "leaseUntil");
ALTER TABLE "BrandAsset" DROP CONSTRAINT "BrandAsset_purpose_check";
ALTER TABLE "BrandAsset" ADD CONSTRAINT "BrandAsset_purpose_check" CHECK ("purpose" IN ('logo','product','reference','generated'));
ALTER TABLE "BrandAsset" ADD COLUMN "generationId" TEXT UNIQUE;
CREATE UNIQUE INDEX "BrandAsset_generationId_businessId_organizationId_key" ON "BrandAsset"("generationId", "businessId", "organizationId");
ALTER TABLE "BrandAsset" ADD CONSTRAINT "BrandAsset_generation_scope_fkey" FOREIGN KEY ("generationId", "businessId", "organizationId") REFERENCES "ImageGeneration"("id", "businessId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrandAsset" ADD CONSTRAINT "BrandAsset_generated_origin_check" CHECK (("purpose"='generated')=("generationId" IS NOT NULL));
