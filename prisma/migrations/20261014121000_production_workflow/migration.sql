-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "job_business_scope";

-- AlterTable
ALTER TABLE "CreativeRevision" ADD COLUMN     "feedback" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "provenance" JSONB;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "quoteId" TEXT,
ADD COLUMN     "reservationId" TEXT,
ADD COLUMN     "result" JSONB;

-- CreateTable
CREATE TABLE "GenerationQuote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "brandVersion" INTEGER NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "supplierCeilingMicros" INTEGER NOT NULL,
    "request" JSONB NOT NULL,
    "configurationHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OFFERED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationQuote_organizationId_createdAt_idx" ON "GenerationQuote"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationQuote_acceptedAt_status_idx" ON "GenerationQuote"("acceptedAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationQuote_id_organizationId_key" ON "GenerationQuote"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEntry_itemId_key" ON "CalendarEntry"("itemId");

-- CreateIndex
CREATE INDEX "CalendarEntry_organizationId_scheduledFor_idx" ON "CalendarEntry"("organizationId", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEntry_itemId_organizationId_key" ON "CalendarEntry"("itemId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeRevision_id_organizationId_key" ON "CreativeRevision"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_quoteId_key" ON "Job"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_reservationId_key" ON "Job"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_quoteId_organizationId_key" ON "Job"("quoteId", "organizationId");

-- AddForeignKey
ALTER TABLE "GenerationQuote" ADD CONSTRAINT "GenerationQuote_businessId_organizationId_fkey" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationQuote" ADD CONSTRAINT "GenerationQuote_itemId_organizationId_fkey" FOREIGN KEY ("itemId", "organizationId") REFERENCES "ProductionItem"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_itemId_organizationId_fkey" FOREIGN KEY ("itemId", "organizationId") REFERENCES "ProductionItem"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_revisionId_organizationId_fkey" FOREIGN KEY ("revisionId", "organizationId") REFERENCES "CreativeRevision"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_quoteId_organizationId_fkey" FOREIGN KEY ("quoteId", "organizationId") REFERENCES "GenerationQuote"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "GenerationQuote" ADD CONSTRAINT "GenerationQuote_positive_budgets" CHECK ("credits" > 0 AND "credits" <= 8000 AND "supplierCeilingMicros" > 0 AND "supplierCeilingMicros" <= 80000000);
ALTER TABLE "Job" ADD CONSTRAINT "Job_reservation_scope_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT;
