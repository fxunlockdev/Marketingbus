CREATE TABLE "SocialOAuthFlow" (
  "id" TEXT PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "configurationHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "encryptedVerifier" TEXT,
  "encryptedCandidates" TEXT,
  "errorCode" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialOAuthFlow_business_fkey" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialOAuthFlow_session_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialOAuthFlow_status_check" CHECK ("status" IN ('PENDING','EXCHANGING','CHOOSING','CONNECTED','CANCELLED','FAILED','EXPIRED')),
  CONSTRAINT "SocialOAuthFlow_secrets_check" CHECK (
    ("status" = 'PENDING' AND "encryptedVerifier" IS NOT NULL AND "encryptedCandidates" IS NULL) OR
    ("status" = 'CHOOSING' AND "encryptedCandidates" IS NOT NULL AND "encryptedVerifier" IS NULL) OR
    ("status" NOT IN ('PENDING','CHOOSING') AND "encryptedVerifier" IS NULL AND "encryptedCandidates" IS NULL)
  )
);
CREATE UNIQUE INDEX "SocialOAuthFlow_stateHash_key" ON "SocialOAuthFlow"("stateHash");
CREATE INDEX "SocialOAuthFlow_businessId_sessionId_createdAt_idx" ON "SocialOAuthFlow"("businessId", "sessionId", "createdAt");
CREATE INDEX "SocialOAuthFlow_expiresAt_idx" ON "SocialOAuthFlow"("expiresAt");
