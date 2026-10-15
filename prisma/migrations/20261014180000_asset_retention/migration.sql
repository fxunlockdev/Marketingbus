ALTER TABLE "BrandAsset"
  ADD COLUMN "approvedForGeneration" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedFromStatus" TEXT,
  ADD COLUMN "purgeAfter" TIMESTAMP(3),
  ADD COLUMN "purgeLeaseUntil" TIMESTAMP(3);
CREATE INDEX "BrandAsset_status_purgeAfter_purgeLeaseUntil_idx" ON "BrandAsset"("status", "purgeAfter", "purgeLeaseUntil");
