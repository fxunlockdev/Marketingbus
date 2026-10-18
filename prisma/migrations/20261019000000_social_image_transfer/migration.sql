ALTER TABLE "SocialPublication"
  ADD COLUMN "mediaTransferVersion" TEXT,
  ADD COLUMN "mediaExternalId" TEXT,
  ADD COLUMN "mediaUploaded" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "SocialPublication_connectionId_mediaExternalId_key" ON "SocialPublication"("connectionId", "mediaExternalId");
ALTER TABLE "SocialPublication" ADD CONSTRAINT "social_image_transfer_binding" CHECK (
  (("mediaTransferVersion" IS NULL AND "mediaExternalId" IS NULL AND NOT "mediaUploaded") OR
   ("mediaTransferVersion" IS NOT NULL AND length("mediaTransferVersion") BETWEEN 1 AND 500
    AND jsonb_typeof("payload"->'mediaExportId') = 'string'
    AND jsonb_typeof("payload"->'image') = 'object'
    AND "payload"->>'channel' = 'LinkedIn'
    AND ("mediaExternalId" IS NULL OR "mediaExternalId" ~ '^urn:li:image:[A-Za-z0-9_-]{1,200}$')
    AND (NOT "mediaUploaded" OR "mediaExternalId" IS NOT NULL))) IS TRUE
);
