CREATE TABLE "BrandAnalysis" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "brandVersion" INTEGER NOT NULL,
  "sources" JSONB NOT NULL,
  "route" JSONB NOT NULL,
  "configurationHash" TEXT NOT NULL,
  "credits" INTEGER NOT NULL CHECK ("credits" > 0),
  "supplierCeilingMicros" INTEGER NOT NULL CHECK ("supplierCeilingMicros" > 0),
  "status" TEXT NOT NULL DEFAULT 'OFFERED',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "reservationId" TEXT,
  "providerResponseId" TEXT,
  "supplierCostMicros" INTEGER,
  "usage" JSONB,
  "suggestions" JSONB,
  "rejectedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "appliedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandAnalysis_businessId_organizationId_fkey" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BrandAnalysis_reservationId_key" ON "BrandAnalysis"("reservationId");
CREATE INDEX "BrandAnalysis_businessId_organizationId_createdAt_idx" ON "BrandAnalysis"("businessId", "organizationId", "createdAt");
CREATE INDEX "BrandAnalysis_status_leaseUntil_idx" ON "BrandAnalysis"("status", "leaseUntil");
