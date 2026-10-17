ALTER TABLE "VideoClip" DROP CONSTRAINT "VideoClip_status_check";
ALTER TABLE "VideoClip" ADD CONSTRAINT "VideoClip_status_check" CHECK (
  "status" IN ('UPLOADING','QUEUED','RUNNING','STORING','READY','APPROVED','REJECTED','FAILED','ARCHIVED','DELETING','DELETED')
  OR ("status" = 'AWAITING_GENERATION' AND "generationId" IS NOT NULL)
);
ALTER TABLE "VideoClip" DROP CONSTRAINT "VideoClip_size_check";
ALTER TABLE "VideoClip" ADD CONSTRAINT "VideoClip_size_check" CHECK (
  "sourceBytes" >= 0 AND "sourceBytes" <= 20971520 AND "bytes" >= 0 AND "bytes" <= 20971520
  AND ("sourceBytes" > 0 OR ("generationId" IS NOT NULL AND "status" IN ('AWAITING_GENERATION','FAILED','ARCHIVED','DELETING','DELETED')))
);
ALTER TABLE "VideoGeneration" ADD CONSTRAINT "VideoGeneration_status_check" CHECK (
  "status" IN ('OFFERED','QUEUED','RUNNING','SUBMITTING','POLLING','INGESTING','READY','FAILED','CANCELLED','NEEDS_RECONCILIATION')
);
ALTER TABLE "VideoGeneration" ADD CONSTRAINT "VideoGeneration_bounds_check" CHECK (
  "durationMs" >= 1000 AND "durationMs" <= 8000 AND "durationMs" % 250 = 0
  AND "credits" > 0 AND "credits" <= 8000 AND "supplierCeilingMicros" > 0 AND "supplierCeilingMicros" <= 80000000
  AND ("supplierCostMicros" IS NULL OR ("supplierCostMicros" >= 0 AND "supplierCostMicros" <= 1000000000))
  AND "pollCount" >= 0
);
