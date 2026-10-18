ALTER TABLE "VideoClip" ADD COLUMN "mediaKind" TEXT NOT NULL DEFAULT 'VIDEO';
ALTER TABLE "VideoClip" ADD COLUMN "instrumentalConfirmedAt" TIMESTAMP(3);
ALTER TABLE "VideoClip" ADD CONSTRAINT "VideoClip_media_kind_check" CHECK (
  ("mediaKind" = 'VIDEO' AND "instrumentalConfirmedAt" IS NULL) OR
  ("mediaKind" = 'AUDIO' AND "instrumentalConfirmedAt" IS NOT NULL AND "generationId" IS NULL
    AND "sourceBytes" BETWEEN 1 AND 8388608 AND "bytes" BETWEEN 0 AND 8388608
    AND "durationMs" BETWEEN 0 AND 30000 AND "processorVersion" = 'instrumental-pcm-v1')
);
