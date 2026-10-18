ALTER TABLE "SocialPublication" ADD COLUMN "metricsInvalidatedAt" TIMESTAMP(3);
-- Retain receipts/snapshots for audit, but never resume an invalidated learning source.
ALTER TABLE "SocialPublication" ADD CONSTRAINT "SocialPublication_invalidated_metrics_stopped"
CHECK ("metricsInvalidatedAt" IS NULL OR ("nextMetricsAt" IS NULL AND "metricsLeaseUntil" IS NULL));
