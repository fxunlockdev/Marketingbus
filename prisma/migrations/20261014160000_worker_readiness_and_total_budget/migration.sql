CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "runtimeVersion" TEXT NOT NULL,
    "configurationHash" TEXT NOT NULL,
    "executionEnabled" BOOLEAN NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkerHeartbeat_lastSeenAt_idx" ON "WorkerHeartbeat"("lastSeenAt");
CREATE TABLE "SupplierAuthorization" (
    "key" TEXT NOT NULL,
    "ceilingMicros" INTEGER NOT NULL CHECK ("ceilingMicros" > 0),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierAuthorization_pkey" PRIMARY KEY ("key")
);
-- Preserve historic authorization, including ambiguous submissions, across the upgrade.
INSERT INTO "SupplierAuthorization" ("key", "ceilingMicros", "createdAt")
SELECT "id", "supplierCeilingMicros", COALESCE("acceptedAt", "createdAt") FROM "GenerationQuote"
WHERE "status" IN ('ACCEPTED', 'COMPLETED', 'RECONCILE');
