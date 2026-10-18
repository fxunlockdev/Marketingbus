ALTER TABLE "VideoGeneration" ADD COLUMN "creativeBrief" JSONB NOT NULL DEFAULT '{}', ADD COLUMN "revisionOfId" TEXT;
ALTER TABLE "VideoGeneration" ADD CONSTRAINT "VideoGeneration_revisionOfId_businessId_organizationId_fkey"
  FOREIGN KEY ("revisionOfId", "businessId", "organizationId") REFERENCES "VideoGeneration"("id", "businessId", "organizationId") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "VideoGeneration_revisionOfId_businessId_organizationId_idx" ON "VideoGeneration"("revisionOfId", "businessId", "organizationId");
ALTER TABLE "VideoGeneration" ADD CONSTRAINT "VideoGeneration_creative_brief_check" CHECK (
  ("creativeBrief" = '{}'::jsonb AND "revisionOfId" IS NULL) OR
  (jsonb_typeof("creativeBrief") = 'object' AND "creativeBrief"->>'version' = '1'
   AND jsonb_typeof("creativeBrief"->'direction') = 'string' AND length("creativeBrief"->>'direction') <= 1000
   AND jsonb_typeof("creativeBrief"->'revisions') = 'array'
   AND jsonb_array_length("creativeBrief"->'revisions') BETWEEN 0 AND 4
   AND (("revisionOfId" IS NULL AND jsonb_array_length("creativeBrief"->'revisions') = 0)
     OR ("revisionOfId" IS NOT NULL AND "revisionOfId" <> "id" AND jsonb_array_length("creativeBrief"->'revisions') > 0
       AND "creativeBrief"->'revisions'->-1->>'parentId' = "revisionOfId"))) IS TRUE
);
