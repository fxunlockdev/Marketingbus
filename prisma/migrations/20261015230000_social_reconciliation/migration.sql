ALTER TABLE "SocialPublication"
ADD COLUMN "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextReconciliationAt" TIMESTAMP(3);

CREATE INDEX "SocialPublication_status_nextReconciliationAt_idx"
ON "SocialPublication"("status", "nextReconciliationAt");
