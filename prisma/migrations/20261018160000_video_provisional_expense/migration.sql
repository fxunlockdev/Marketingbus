ALTER TABLE "VideoGeneration"
  ADD COLUMN "supplierEstimateMicros" INTEGER,
  ADD COLUMN "expenseBasis" TEXT,
  ADD COLUMN "supplierReconciledAt" TIMESTAMP(3);

ALTER TABLE "VideoGeneration" ADD CONSTRAINT "VideoGeneration_provisional_expense_check" CHECK (
  ("expenseBasis" IS NULL AND "supplierEstimateMicros" IS NULL)
  OR ("expenseBasis" IS NOT NULL AND "expenseBasis" = 'ACCOUNT_QUOTE_V1'
    AND "supplierEstimateMicros" IS NOT NULL
    AND "supplierEstimateMicros" >= 0 AND "supplierEstimateMicros" <= "supplierCeilingMicros")
);
ALTER TABLE "VideoGeneration" ADD CONSTRAINT "VideoGeneration_reconciliation_check" CHECK (
  "supplierReconciledAt" IS NULL OR "supplierCostMicros" IS NOT NULL
);
