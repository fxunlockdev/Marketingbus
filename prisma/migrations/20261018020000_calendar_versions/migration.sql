ALTER TABLE "CalendarEntry" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "CalendarEntry_organizationId_scheduledFor_id_idx" ON "CalendarEntry"("organizationId", "scheduledFor", "id");
