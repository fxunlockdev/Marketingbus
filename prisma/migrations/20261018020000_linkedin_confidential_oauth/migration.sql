BEGIN;
ALTER TABLE "SocialOAuthFlow" ADD COLUMN "authentication" TEXT NOT NULL DEFAULT 'S256';
ALTER TABLE "SocialOAuthFlow" ADD CONSTRAINT "SocialOAuthFlow_authentication_check" CHECK (
  "authentication" = 'S256' OR ("authentication" = 'LINKEDIN_CONFIDENTIAL' AND "provider" = 'LinkedIn')
);
ALTER TABLE "SocialOAuthFlow" DROP CONSTRAINT "SocialOAuthFlow_secrets_check";
ALTER TABLE "SocialOAuthFlow" ADD CONSTRAINT "SocialOAuthFlow_secrets_check" CHECK (
  ("status" = 'PENDING' AND "encryptedCandidates" IS NULL AND (
    ("authentication" = 'S256' AND "encryptedVerifier" IS NOT NULL) OR
    ("authentication" = 'LINKEDIN_CONFIDENTIAL' AND "encryptedVerifier" IS NULL)
  )) OR
  ("status" = 'CHOOSING' AND "encryptedCandidates" IS NOT NULL AND "encryptedVerifier" IS NULL) OR
  ("status" NOT IN ('PENDING','CHOOSING') AND "encryptedVerifier" IS NULL AND "encryptedCandidates" IS NULL)
);
COMMIT;
