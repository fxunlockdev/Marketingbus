ALTER TABLE "ProductionItem" ADD COLUMN "revisionRequests" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "creative_revision_requests_nonnegative" CHECK ("revisionRequests" >= 0);
-- Carry existing authorized history forward. Requoting, deleting outputs and manual
-- editing cannot reset the per-creative allowance. Historical totals can exceed three.
UPDATE "ProductionItem" p SET "revisionRequests" =
  (SELECT COUNT(*) FROM "GenerationQuote" q WHERE q."itemId" = p.id AND q."organizationId" = p."organizationId" AND q."acceptedAt" IS NOT NULL AND q."baseVersion" > 0)
  + (SELECT GREATEST(COUNT(*) - 1, 0) FROM "ImageGeneration" g WHERE g."itemId" = p.id AND g."organizationId" = p."organizationId" AND g."acceptedAt" IS NOT NULL)
  + (SELECT COALESCE(SUM(s.revisions), 0) FROM
      (SELECT GREATEST(COUNT(*) - 1, COUNT(*) FILTER (WHERE "revisionOfId" IS NOT NULL)) AS revisions
       FROM "VideoGeneration" v WHERE v."itemId" = p.id AND v."organizationId" = p."organizationId" AND v."acceptedAt" IS NOT NULL GROUP BY v."shotId") s);
