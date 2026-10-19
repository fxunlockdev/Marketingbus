-- Native views are not interchangeable with impressions or video views.
ALTER TABLE "MetricSnapshot" ADD COLUMN "views" INTEGER;
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_views_nonnegative" CHECK ("views" IS NULL OR "views" >= 0);
