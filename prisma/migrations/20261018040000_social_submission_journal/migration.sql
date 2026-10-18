ALTER TABLE "SocialPublication"
  ADD COLUMN "submissionAdapterVersion" TEXT,
  ADD COLUMN "candidatePostId" TEXT,
  ADD CONSTRAINT "SocialPublication_submission_adapter_check" CHECK (
    "submissionAdapterVersion" IS NULL OR length("submissionAdapterVersion") BETWEEN 1 AND 100
  ),
  ADD CONSTRAINT "SocialPublication_candidate_check" CHECK (
    "candidatePostId" IS NULL OR ("submissionAdapterVersion" IS NOT NULL AND length("candidatePostId") BETWEEN 1 AND 500)
  );
CREATE UNIQUE INDEX "SocialPublication_connectionId_candidatePostId_key" ON "SocialPublication"("connectionId", "candidatePostId");
