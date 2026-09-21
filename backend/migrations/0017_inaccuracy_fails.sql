-- yoyo up migration: the ENTIRE file body is the "up" step.
-- (yoyo reads rollback from a separate 0017_inaccuracy_fails.rollback.sql.)
-- Hardcore's fail set widened: a vague answer fails the run too. This constraint is the schema half
-- of rating.FAIL_CLASSES and has to move with it, or the UPDATE that records an inaccuracy failure
-- 500s on a run the candidate was already told was over.
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_failed_class_check;
ALTER TABLE interviews ADD CONSTRAINT interviews_failed_class_check
    CHECK (failed_class IN ('inaccuracy', 'mistake', 'blunder'));
