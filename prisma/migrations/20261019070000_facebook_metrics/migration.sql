-- Native unique viewers and reactions are not interchangeable with reach or engagements.
ALTER TABLE "MetricSnapshot" ADD COLUMN "uniqueViewers" INTEGER, ADD COLUMN "reactions" INTEGER;
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_uniqueViewers_nonnegative" CHECK ("uniqueViewers" IS NULL OR "uniqueViewers" >= 0);
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_reactions_nonnegative" CHECK ("reactions" IS NULL OR "reactions" >= 0);
