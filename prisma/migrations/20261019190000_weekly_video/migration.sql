ALTER TABLE "WeeklyPolicy" ADD COLUMN "videosAfterApproval" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "videoItems" INTEGER,
  ADD CONSTRAINT "weekly_video_policy" CHECK (("videoItems" IS NULL OR ("videoItems" >= 0 AND "videoItems" <= "maxItems")) AND
    (NOT "videosAfterApproval" OR (mode = 'DRAFTS' AND COALESCE("videoItems" > 0, false))));
ALTER TABLE "WeeklyCycle" ADD COLUMN "videoStatus" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "videoLeaseUntil" TIMESTAMP(3), ADD COLUMN "nextVideoAt" TIMESTAMP(3),
  ADD CONSTRAINT "weekly_video_cycle_status" CHECK ("videoStatus" IN ('NONE','OPEN','COMPLETE','CANCELLED','BLOCKED'));
CREATE INDEX "WeeklyCycle_videoStatus_nextVideoAt_idx" ON "WeeklyCycle"("videoStatus", "nextVideoAt");
ALTER TABLE "WeeklyTask" ADD COLUMN "videoStatus" TEXT NOT NULL DEFAULT 'SKIPPED',
  ADD COLUMN "storyboardId" TEXT, ADD COLUMN "renderId" TEXT,
  ADD CONSTRAINT "weekly_video_task_status" CHECK ("videoStatus" IN ('SKIPPED','WAITING','STORYBOARD','PRODUCING','REVIEW','RENDERED','CANCELLED','STOPPED')),
  ADD CONSTRAINT "weekly_video_board_required" CHECK ("videoStatus" NOT IN ('STORYBOARD','PRODUCING','REVIEW','RENDERED') OR "storyboardId" IS NOT NULL),
  ADD CONSTRAINT "weekly_video_render_required" CHECK ("videoStatus" <> 'RENDERED' OR "renderId" IS NOT NULL);
CREATE TABLE "WeeklyVideoShot" (
  "id" TEXT NOT NULL PRIMARY KEY, "taskId" TEXT NOT NULL, "shotId" TEXT NOT NULL, "generationId" TEXT NOT NULL,
  CONSTRAINT "WeeklyVideoShot_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WeeklyTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WeeklyVideoShot_generationId_key" ON "WeeklyVideoShot"("generationId");
CREATE UNIQUE INDEX "WeeklyVideoShot_taskId_shotId_key" ON "WeeklyVideoShot"("taskId", "shotId");
