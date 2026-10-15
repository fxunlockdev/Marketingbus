CREATE TABLE "StaticComposition" (
 "id" TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
 "itemId" TEXT NOT NULL, "revisionId" TEXT NOT NULL, "brandVersion" INTEGER NOT NULL,
 "version" INTEGER NOT NULL CHECK ("version" > 0), "document" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT','APPROVED','SUPERSEDED')),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "StaticComposition_businessId_organizationId_fkey" FOREIGN KEY ("businessId","organizationId") REFERENCES "Business"("id","organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StaticComposition_itemId_version_key" ON "StaticComposition"("itemId","version");
CREATE INDEX "StaticComposition_businessId_itemId_idx" ON "StaticComposition"("businessId","itemId");
