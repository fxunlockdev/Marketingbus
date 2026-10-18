ALTER TABLE "SocialConnection" ADD COLUMN "authorizationVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SocialConnection" ADD CONSTRAINT "SocialConnection_authorizationVersion_check" CHECK ("authorizationVersion" > 0);
