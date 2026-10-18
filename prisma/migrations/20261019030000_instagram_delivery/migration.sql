ALTER TABLE "SocialPublication"
  ADD COLUMN "mediaDeliveryTokenHash" TEXT,
  ADD COLUMN "mediaDeliveryExpiresAt" TIMESTAMP(3),
  ADD COLUMN "mediaDeliverySha256" TEXT,
  ADD COLUMN "mediaDeliveryBytes" INTEGER,
  ADD COLUMN "mediaDeliveryVersion" TEXT,
  ADD COLUMN "mediaDeliveryAuthorizationVersion" INTEGER,
  ADD COLUMN "mediaDeliveryReads" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SocialPublication" DROP CONSTRAINT "social_image_transfer_binding";
ALTER TABLE "SocialPublication" ADD CONSTRAINT "social_image_transfer_binding" CHECK (
  (("mediaTransferVersion" IS NULL AND "mediaExternalId" IS NULL AND NOT "mediaUploaded") OR
   ("mediaTransferVersion" IS NOT NULL AND length("mediaTransferVersion") BETWEEN 1 AND 500
    AND jsonb_typeof("payload"->'mediaExportId') = 'string'
    AND jsonb_typeof("payload"->'image') = 'object'
    AND (("payload"->>'channel' = 'LinkedIn' AND
          ("mediaExternalId" IS NULL OR "mediaExternalId" ~ '^urn:li:image:[A-Za-z0-9_-]{1,200}$')) OR
         ("payload"->>'channel' IN ('Facebook', 'Instagram') AND
          ("mediaExternalId" IS NULL OR "mediaExternalId" ~ '^[1-9][0-9]{0,39}$')))
    AND (NOT "mediaUploaded" OR "mediaExternalId" IS NOT NULL))) IS TRUE
);
ALTER TABLE "SocialPublication" ADD CONSTRAINT "social_instagram_delivery_binding" CHECK (
  (("mediaDeliveryTokenHash" IS NULL AND "mediaDeliveryExpiresAt" IS NULL
    AND "mediaDeliverySha256" IS NULL AND "mediaDeliveryBytes" IS NULL
    AND "mediaDeliveryVersion" IS NULL AND "mediaDeliveryAuthorizationVersion" IS NULL
    AND "mediaDeliveryReads" = 0) OR
   ("mediaDeliveryTokenHash" ~ '^[a-f0-9]{64}$' AND "mediaDeliveryExpiresAt" IS NOT NULL
    AND "mediaDeliverySha256" ~ '^[a-f0-9]{64}$' AND "mediaDeliveryBytes" BETWEEN 1 AND 4194304
    AND length("mediaDeliveryVersion") BETWEEN 1 AND 100
    AND "mediaDeliveryAuthorizationVersion" > 0 AND "mediaDeliveryReads" BETWEEN 0 AND 12
    AND "mediaTransferVersion" IS NOT NULL AND "payload"->>'channel' = 'Instagram')) IS TRUE
);
