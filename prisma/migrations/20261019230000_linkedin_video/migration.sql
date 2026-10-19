-- LinkedIn videos retain the same durable registration/upload/post fences.
-- Match the exact asset URN family to the immutable media kind, never either family.
ALTER TABLE "SocialPublication" DROP CONSTRAINT "social_image_transfer_binding";
ALTER TABLE "SocialPublication" ADD CONSTRAINT "social_image_transfer_binding" CHECK (
  (("mediaTransferVersion" IS NULL AND "mediaExternalId" IS NULL AND NOT "mediaUploaded") OR
   ("mediaTransferVersion" IS NOT NULL AND length("mediaTransferVersion") BETWEEN 1 AND 500
    AND jsonb_typeof("payload"->'mediaExportId') = 'string'
    AND ((jsonb_typeof("payload"->'image') = 'object' AND NOT ("payload" ? 'video') AND "payload"->>'format' = 'static') OR
         (jsonb_typeof("payload"->'video') = 'object' AND NOT ("payload" ? 'image') AND "payload"->>'format' = 'video'))
    AND (("payload"->>'channel' = 'LinkedIn' AND
          ("mediaExternalId" IS NULL OR
           ("payload" ? 'image' AND "mediaExternalId" ~ '^urn:li:image:[A-Za-z0-9_-]{1,200}$') OR
           ("payload" ? 'video' AND "mediaExternalId" ~ '^urn:li:video:[A-Za-z0-9_-]{1,200}$'))) OR
         ("payload"->>'channel' IN ('Facebook', 'Instagram') AND
          ("mediaExternalId" IS NULL OR "mediaExternalId" ~ '^[1-9][0-9]{0,39}$')))
    AND (NOT "mediaUploaded" OR "mediaExternalId" IS NOT NULL))) IS TRUE
);
