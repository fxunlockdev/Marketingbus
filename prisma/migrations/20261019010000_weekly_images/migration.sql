ALTER TABLE "WeeklyPolicy" ADD COLUMN "imagesAfterApproval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WeeklyPolicy" ADD CONSTRAINT "WeeklyPolicy_images_mode_check" CHECK (NOT "imagesAfterApproval" OR "mode" = 'DRAFTS');
ALTER TABLE "WeeklyCycle" ADD COLUMN "mediaStatus" TEXT NOT NULL DEFAULT 'NONE', ADD COLUMN "mediaLeaseUntil" TIMESTAMP(3), ADD COLUMN "nextMediaAt" TIMESTAMP(3);
ALTER TABLE "WeeklyCycle" ADD CONSTRAINT "WeeklyCycle_media_status_check" CHECK ("mediaStatus" IN ('NONE', 'OPEN', 'COMPLETE', 'CANCELLED', 'BLOCKED'));
ALTER TABLE "WeeklyTask" ADD COLUMN "imageStatus" TEXT NOT NULL DEFAULT 'SKIPPED', ADD COLUMN "imageGenerationId" TEXT;
ALTER TABLE "WeeklyTask" ADD CONSTRAINT "WeeklyTask_image_status_check" CHECK ("imageStatus" IN ('SKIPPED', 'WAITING', 'QUOTED', 'AUTHORIZED', 'CANCELLED', 'STOPPED'));
ALTER TABLE "WeeklyTask" ADD CONSTRAINT "WeeklyTask_image_binding_check" CHECK ("imageStatus" NOT IN ('QUOTED', 'AUTHORIZED') OR "imageGenerationId" IS NOT NULL);
CREATE UNIQUE INDEX "WeeklyTask_imageGenerationId_key" ON "WeeklyTask"("imageGenerationId");
CREATE INDEX "WeeklyCycle_mediaStatus_nextMediaAt_idx" ON "WeeklyCycle"("mediaStatus", "nextMediaAt");
