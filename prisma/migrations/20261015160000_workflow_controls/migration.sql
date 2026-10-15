ALTER TABLE "Business" ADD COLUMN "independentApproval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CreativeRevision" ADD COLUMN "approvedAt" TIMESTAMP(3), ADD COLUMN "approvedBy" TEXT, ADD COLUMN "authorId" TEXT;
ALTER TABLE "StaticComposition" ADD COLUMN "approvedBy" TEXT, ADD COLUMN "authorId" TEXT;
CREATE TABLE "ReviewComment" (
 "id" TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "revisionId" TEXT NOT NULL,
 "actorId" TEXT NOT NULL, "body" TEXT NOT NULL, "blocking" BOOLEAN NOT NULL DEFAULT false,
 "resolvedBy" TEXT, "resolvedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE CASCADE,
 FOREIGN KEY ("revisionId", "organizationId") REFERENCES "CreativeRevision"("id", "organizationId") ON DELETE CASCADE
);
CREATE INDEX "ReviewComment_revisionId_resolvedAt_idx" ON "ReviewComment"("revisionId", "resolvedAt");
CREATE TABLE "WeeklyPolicy" (
 "businessId" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,
 "mode" TEXT NOT NULL DEFAULT 'PLAN' CHECK ("mode" IN ('PLAN','DRAFTS')),
 "maxItems" INTEGER NOT NULL DEFAULT 4 CHECK ("maxItems" BETWEEN 1 AND 12),
 "creditsPerWeek" INTEGER NOT NULL DEFAULT 0 CHECK ("creditsPerWeek" BETWEEN 0 AND 8000),
 "weekday" INTEGER NOT NULL DEFAULT 1 CHECK ("weekday" BETWEEN 0 AND 6), "hourUTC" INTEGER NOT NULL DEFAULT 9 CHECK ("hourUTC" BETWEEN 0 AND 23),
 "nextRunAt" TIMESTAMP(3) NOT NULL, "version" INTEGER NOT NULL DEFAULT 1, "brandVersion" INTEGER NOT NULL, "actorId" TEXT NOT NULL,
 FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "WeeklyPolicy_businessId_organizationId_key" ON "WeeklyPolicy"("businessId", "organizationId");
CREATE INDEX "WeeklyPolicy_enabled_nextRunAt_idx" ON "WeeklyPolicy"("enabled", "nextRunAt");
CREATE TABLE "WeeklyCycle" (
 "id" TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "periodKey" TEXT NOT NULL,
 "policyVersion" INTEGER NOT NULL, "brandVersion" INTEGER NOT NULL, "planId" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'OPEN', "creditsAuthorized" INTEGER NOT NULL DEFAULT 0 CHECK ("creditsAuthorized">=0),
 "errorCode" TEXT, "leaseUntil" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "WeeklyCycle_businessId_periodKey_key" ON "WeeklyCycle"("businessId", "periodKey");
CREATE INDEX "WeeklyCycle_status_leaseUntil_idx" ON "WeeklyCycle"("status", "leaseUntil");
CREATE TABLE "WeeklyTask" (
 "id" TEXT PRIMARY KEY, "cycleId" TEXT NOT NULL, "itemId" TEXT NOT NULL, "quoteId" TEXT, "status" TEXT NOT NULL DEFAULT 'PENDING', "errorCode" TEXT,
 FOREIGN KEY ("cycleId") REFERENCES "WeeklyCycle"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "WeeklyTask_cycleId_itemId_key" ON "WeeklyTask"("cycleId", "itemId");
