-- yoyo rollback for 0006_feedback_decision.
ALTER TABLE feedback DROP COLUMN IF EXISTS decision, DROP COLUMN IF EXISTS certainty;
