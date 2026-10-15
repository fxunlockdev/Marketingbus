CREATE TABLE "SocialConnection" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "businessId" TEXT NOT NULL,
 "provider" TEXT NOT NULL CHECK ("provider" IN ('Instagram','Facebook','LinkedIn')),
 "externalAccountId" TEXT NOT NULL, "label" TEXT NOT NULL, "encryptedToken" TEXT NOT NULL,
 "permissions" TEXT[] NOT NULL, "status" TEXT NOT NULL DEFAULT 'CONNECTED' CHECK ("status" IN ('CONNECTED','DISCONNECTED','RECONNECT_REQUIRED')),
 "expiresAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "SocialConnection_businessId_organizationId_fkey" FOREIGN KEY ("businessId","organizationId") REFERENCES "Business"("id","organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SocialConnection_id_businessId_organizationId_key" ON "SocialConnection"("id","businessId","organizationId");
CREATE UNIQUE INDEX "SocialConnection_businessId_provider_externalAccountId_key" ON "SocialConnection"("businessId","provider","externalAccountId");
CREATE TABLE "SocialPublication" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "businessId" TEXT NOT NULL,
 "connectionId" TEXT NOT NULL, "revisionId" TEXT NOT NULL, "brandVersion" INTEGER NOT NULL,
 "payload" JSONB NOT NULL, "payloadHash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK ("status" IN ('SCHEDULED','SUBMITTING','NEEDS_RECONCILIATION','PUBLISHED','CANCELLED','FAILED')),
 "scheduledFor" TIMESTAMP(3) NOT NULL, "timezone" TEXT NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
 "leaseUntil" TIMESTAMP(3), "externalPostId" TEXT, "permalink" TEXT, "publishedAt" TIMESTAMP(3),
 "nextMetricsAt" TIMESTAMP(3), "metricsLeaseUntil" TIMESTAMP(3), "metricsFailures" INTEGER NOT NULL DEFAULT 0,
 "errorCode" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("status" <> 'PUBLISHED' OR ("externalPostId" IS NOT NULL AND "publishedAt" IS NOT NULL)),
 CONSTRAINT "SocialPublication_businessId_organizationId_fkey" FOREIGN KEY ("businessId","organizationId") REFERENCES "Business"("id","organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "SocialPublication_connectionId_businessId_organizationId_fkey" FOREIGN KEY ("connectionId","businessId","organizationId") REFERENCES "SocialConnection"("id","businessId","organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "SocialPublication_revisionId_organizationId_fkey" FOREIGN KEY ("revisionId","organizationId") REFERENCES "CreativeRevision"("id","organizationId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SocialPublication_revisionId_connectionId_key" ON "SocialPublication"("revisionId","connectionId");
CREATE UNIQUE INDEX "SocialPublication_connectionId_externalPostId_key" ON "SocialPublication"("connectionId","externalPostId");
CREATE UNIQUE INDEX "SocialPublication_id_businessId_organizationId_key" ON "SocialPublication"("id","businessId","organizationId");
CREATE INDEX "SocialPublication_status_scheduledFor_idx" ON "SocialPublication"("status","scheduledFor");
CREATE INDEX "SocialPublication_status_nextMetricsAt_idx" ON "SocialPublication"("status","nextMetricsAt");
CREATE TABLE "MetricSnapshot" (
 "id" TEXT PRIMARY KEY, "publicationId" TEXT NOT NULL, "businessId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
 "observedAt" TIMESTAMP(3) NOT NULL, "definitionVersion" TEXT NOT NULL,
 "impressions" INTEGER CHECK ("impressions" >= 0), "reach" INTEGER CHECK ("reach" >= 0), "engagements" INTEGER CHECK ("engagements" >= 0), "clicks" INTEGER CHECK ("clicks" >= 0), "videoViews" INTEGER CHECK ("videoViews" >= 0),
 CONSTRAINT "MetricSnapshot_publicationId_businessId_organizationId_fkey" FOREIGN KEY ("publicationId","businessId","organizationId") REFERENCES "SocialPublication"("id","businessId","organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MetricSnapshot_publicationId_observedAt_definitionVersion_key" ON "MetricSnapshot"("publicationId","observedAt","definitionVersion");
CREATE INDEX "MetricSnapshot_businessId_observedAt_idx" ON "MetricSnapshot"("businessId","observedAt");
CREATE TABLE "LearningProposal" (
 "id" TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "brandVersion" INTEGER NOT NULL,
 "hypothesis" TEXT NOT NULL, "evidence" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'PROPOSED' CHECK ("status" IN ('PROPOSED','PROMOTED','REVERTED','REJECTED')),
 "memoryId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "LearningProposal_businessId_organizationId_fkey" FOREIGN KEY ("businessId","organizationId") REFERENCES "Business"("id","organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LearningProposal_businessId_createdAt_idx" ON "LearningProposal"("businessId","createdAt");
