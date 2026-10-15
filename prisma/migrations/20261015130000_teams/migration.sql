CREATE TABLE "TeamInvitation" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "email" TEXT NOT NULL,
 "role" TEXT NOT NULL CHECK ("role" IN ('ADMIN','EDITOR','VIEWER')), "createdBy" TEXT NOT NULL,
 "outboxId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
 "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "TeamInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TeamInvitation_organizationId_createdAt_idx" ON "TeamInvitation"("organizationId","createdAt");
CREATE TABLE "TeamEvent" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "actorId" TEXT NOT NULL,
 "action" TEXT NOT NULL, "detail" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "TeamEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TeamEvent_organizationId_createdAt_idx" ON "TeamEvent"("organizationId","createdAt");
