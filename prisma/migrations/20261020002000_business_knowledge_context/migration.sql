-- Persist the exact task-specific knowledge projection authorized for generation.
-- Existing records remain legacy snapshots; no new infrastructure or inferred data.
ALTER TABLE "ImageGeneration" ADD COLUMN "knowledgeContext" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "VideoGeneration" ADD COLUMN "knowledgeContext" JSONB NOT NULL DEFAULT '{}';
