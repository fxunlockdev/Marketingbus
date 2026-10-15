-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_reservation_scope_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_id_organizationId_key" ON "Reservation"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "job_business_scope" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_reservationId_organizationId_fkey" FOREIGN KEY ("reservationId", "organizationId") REFERENCES "Reservation"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
