BEGIN;
ALTER TABLE "SocialOAuthFlow" DROP CONSTRAINT "SocialOAuthFlow_authentication_check";
ALTER TABLE "SocialOAuthFlow" ADD CONSTRAINT "SocialOAuthFlow_authentication_check" CHECK (
  "authentication" = 'S256' OR
  ("authentication" = 'LINKEDIN_CONFIDENTIAL' AND "provider" = 'LinkedIn') OR
  ("authentication" = 'META_CONFIDENTIAL' AND "provider" IN ('Facebook','Instagram'))
);
ALTER TABLE "SocialOAuthFlow" DROP CONSTRAINT "SocialOAuthFlow_secrets_check";
ALTER TABLE "SocialOAuthFlow" ADD CONSTRAINT "SocialOAuthFlow_secrets_check" CHECK (
  ("status" = 'PENDING' AND "encryptedCandidates" IS NULL AND (
    ("authentication" = 'S256' AND "encryptedVerifier" IS NOT NULL) OR
    ("authentication" IN ('LINKEDIN_CONFIDENTIAL','META_CONFIDENTIAL') AND "encryptedVerifier" IS NULL)
  )) OR
  ("status" = 'CHOOSING' AND "encryptedCandidates" IS NOT NULL AND "encryptedVerifier" IS NULL) OR
  ("status" NOT IN ('PENDING','CHOOSING') AND "encryptedVerifier" IS NULL AND "encryptedCandidates" IS NULL)
);
ALTER TABLE "SocialConnection"
  ADD COLUMN "dataSnapshot" JSONB,
  ADD COLUMN "dataFetchedAt" TIMESTAMP(3),
  ADD COLUMN "dataAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "dataLeaseId" TEXT,
  ADD COLUMN "dataLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "dataErrorCode" TEXT,
  ADD CONSTRAINT "SocialConnection_data_snapshot_check" CHECK (
    ("dataSnapshot" IS NULL AND "dataFetchedAt" IS NULL) OR
    ("dataSnapshot" IS NOT NULL AND jsonb_typeof("dataSnapshot") = 'object' AND "dataFetchedAt" IS NOT NULL AND octet_length("dataSnapshot"::text) <= 150000)
  ),
  ADD CONSTRAINT "SocialConnection_data_lease_check" CHECK (("dataLeaseId" IS NULL) = ("dataLeaseUntil" IS NULL)),
  ADD CONSTRAINT "SocialConnection_data_error_check" CHECK ("dataErrorCode" IS NULL OR "dataErrorCode" = 'READ_NOT_COMPLETED');
CREATE INDEX "SocialConnection_dataFetchedAt_idx" ON "SocialConnection"("dataFetchedAt");
COMMIT;
