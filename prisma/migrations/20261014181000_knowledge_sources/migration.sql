CREATE TABLE "KnowledgeSource" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "businessId" TEXT NOT NULL,
 "organizationId" TEXT NOT NULL,
 "kind" TEXT NOT NULL,
 "title" TEXT NOT NULL,
 "sourceUrl" TEXT NOT NULL DEFAULT '',
 "body" TEXT NOT NULL DEFAULT '',
 "sha256" TEXT NOT NULL DEFAULT '',
 "status" TEXT NOT NULL DEFAULT 'PROPOSED',
 "createdBy" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "retrievedAt" TIMESTAMP(3),
 CONSTRAINT "KnowledgeSource_business_scope" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "KnowledgeSource_businessId_organizationId_createdAt_idx" ON "KnowledgeSource"("businessId", "organizationId", "createdAt");
