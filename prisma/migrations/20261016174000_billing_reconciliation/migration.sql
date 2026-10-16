CREATE TABLE "BillingReconciliation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "eventId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingReconciliation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "BillingEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "BillingReconciliation_eventId_createdAt_idx" ON "BillingReconciliation"("eventId", "createdAt");
