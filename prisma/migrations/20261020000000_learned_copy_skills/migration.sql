ALTER TABLE "LearningProposal" DROP CONSTRAINT "LearningProposal_status_check";
ALTER TABLE "LearningProposal" ADD CONSTRAINT "LearningProposal_status_check"
  CHECK ("status" IN ('PROPOSED','PROMOTED','REVERTED','REJECTED',
    'SKILL_PROPOSED','SKILL_ACTIVE','SKILL_RETIRED','SKILL_EXPIRED'));
ALTER TABLE "LearningProposal" ADD CONSTRAINT "LearningProposal_skill_evidence_check"
  CHECK ("status" NOT LIKE 'SKILL_%' OR
    ("evidence"->>'kind' IS NOT NULL AND "evidence"->>'kind' = 'FEEDBACK_SKILL_V1'));
