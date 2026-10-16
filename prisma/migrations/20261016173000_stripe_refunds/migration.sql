CREATE TABLE "BillingRefundOperation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "paymentId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0 AND "amountMinor" <= 1000000),
  "status" TEXT NOT NULL DEFAULT 'SUBMITTING',
  "providerRefundId" TEXT,
  "operatorId" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingRefundOperation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "BillingPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BillingRefundOperation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BillingRefundOperation_providerRefundId_key" ON "BillingRefundOperation"("providerRefundId");
CREATE INDEX "BillingRefundOperation_paymentId_status_idx" ON "BillingRefundOperation"("paymentId", "status");
CREATE INDEX "BillingRefundOperation_organizationId_createdAt_idx" ON "BillingRefundOperation"("organizationId", "createdAt");
