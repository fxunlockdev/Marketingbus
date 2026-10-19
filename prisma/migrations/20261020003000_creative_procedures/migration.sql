ALTER TABLE "BrandAnalysis" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'BRAND';
ALTER TABLE "BrandAnalysis" ADD CONSTRAINT "BrandAnalysis_purpose_check" CHECK (purpose IN ('BRAND', 'SKILL_REFLECTION'));
ALTER TABLE "LearningProposal" DROP CONSTRAINT "LearningProposal_status_check";
ALTER TABLE "LearningProposal" ADD CONSTRAINT "LearningProposal_status_check" CHECK (status IN
 ('PROPOSED','PROMOTED','REVERTED','REJECTED','EXPIRED','SKILL_PROPOSED','SKILL_ACTIVE','SKILL_RETIRED','SKILL_EXPIRED',
  'PROCEDURE_PROPOSED','PROCEDURE_ACTIVE','PROCEDURE_RETIRED'));
ALTER TABLE "LearningProposal" ADD CONSTRAINT "LearningProposal_procedure_evidence_check" CHECK
 (status NOT LIKE 'PROCEDURE_%' OR (evidence->>'kind' IS NOT NULL AND evidence->>'kind'='CREATIVE_PROCEDURE_V1'));
