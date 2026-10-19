-- Existing evidence re-evaluation expires stale observational proposals.
ALTER TABLE "LearningProposal" DROP CONSTRAINT "LearningProposal_status_check";
ALTER TABLE "LearningProposal" ADD CONSTRAINT "LearningProposal_status_check"
  CHECK ("status" IN ('PROPOSED','PROMOTED','REVERTED','REJECTED','EXPIRED',
    'SKILL_PROPOSED','SKILL_ACTIVE','SKILL_RETIRED','SKILL_EXPIRED'));
