-- Internal billing foundations. No payment integration is enabled by this migration.
ALTER TABLE "Reservation" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'INITIAL',
ADD COLUMN "revisionCredits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Wallet" ADD COLUMN "debt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "revisionAvailable" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "revisionDebt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_revision_nonnegative"
  CHECK ("revisionAvailable" >= 0 AND "debt" >= 0 AND "revisionDebt" >= 0);
ALTER TABLE "Reservation" ADD CONSTRAINT "reservation_revision_allocation"
  CHECK ("revisionCredits" >= 0 AND "revisionCredits" <= "credits"
    AND "purpose" IN ('INITIAL', 'REVISION')
    AND ("purpose" = 'REVISION' OR "revisionCredits" = 0));

CREATE TABLE "BillingCheckout" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "offer" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CREATED',
  "providerSessionId" TEXT,
  "url" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingCheckout_organizationId_fkey" FOREIGN KEY ("organizationId")
    REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "BillingSubscription" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "offer" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
  "updatedThrough" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingSubscription_organizationId_fkey" FOREIGN KEY ("organizationId")
    REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "BillingPayment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "checkoutId" TEXT,
  "subscriptionId" TEXT,
  "periodStart" TIMESTAMP(3),
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "generalCredits" INTEGER NOT NULL,
  "revisionCredits" INTEGER NOT NULL,
  "refundedMinor" INTEGER NOT NULL DEFAULT 0,
  "reclaimedGeneral" INTEGER NOT NULL DEFAULT 0,
  "reclaimedRevision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingPayment_organizationId_fkey" FOREIGN KEY ("organizationId")
    REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "billing_payment_amounts" CHECK (
    "amountMinor" > 0 AND "generalCredits" >= 0 AND "revisionCredits" >= 0
    AND "refundedMinor" BETWEEN 0 AND "amountMinor"
    AND "reclaimedGeneral" BETWEEN 0 AND "generalCredits"
    AND "reclaimedRevision" BETWEEN 0 AND "revisionCredits")
);
CREATE TABLE "BillingEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "payload" JSONB NOT NULL,
  "digest" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "errorCode" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "BillingCheckout_providerSessionId_key" ON "BillingCheckout"("providerSessionId");
CREATE INDEX "BillingCheckout_organizationId_createdAt_idx" ON "BillingCheckout"("organizationId", "createdAt");
CREATE INDEX "BillingSubscription_organizationId_idx" ON "BillingSubscription"("organizationId");
CREATE INDEX "BillingPayment_organizationId_createdAt_idx" ON "BillingPayment"("organizationId", "createdAt");
CREATE UNIQUE INDEX "BillingPayment_subscriptionId_periodStart_key" ON "BillingPayment"("subscriptionId", "periodStart");
CREATE INDEX "BillingEvent_status_availableAt_idx" ON "BillingEvent"("status", "availableAt");
