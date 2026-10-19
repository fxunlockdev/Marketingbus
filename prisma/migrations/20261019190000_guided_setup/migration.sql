ALTER TABLE "Business"
  ADD COLUMN "contentPreferences" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "setupKey" TEXT,
  ADD COLUMN "setupStep" INTEGER,
  ADD COLUMN "setupRevision" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "Business_setupKey_key" ON "Business"("setupKey");
ALTER TABLE "Business" ADD CONSTRAINT "Business_setup_state_check" CHECK (
  ("setupStep" IS NULL AND "setupKey" IS NULL AND "setupRevision" = 0)
  OR ("setupStep" IS NOT NULL AND "setupStep" BETWEEN 1 AND 6 AND "setupKey" IS NOT NULL AND "setupRevision" > 0)
);
