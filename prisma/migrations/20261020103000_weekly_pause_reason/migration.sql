ALTER TABLE "WeeklyPolicy" ADD COLUMN "pauseReason" TEXT;
ALTER TABLE "WeeklyPolicy" ADD CONSTRAINT "WeeklyPolicy_pauseReason_check"
  CHECK ("pauseReason" IS NULL OR "pauseReason" IN ('CONTEXT_INVALID', 'BRAND_CHANGED', 'AUTHORIZER_CHANGED'));
