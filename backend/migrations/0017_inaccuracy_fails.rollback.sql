-- yoyo rollback for 0017_inaccuracy_fails (read from 0017_inaccuracy_fails.rollback.sql)
-- Reverting the rule has to revert the records it produced: the narrowed CHECK cannot hold an
-- inaccuracy failure, so those rows are cleared (the run keeps its transcript and its class on the
-- message, which is what the review reads back).
UPDATE interviews SET failed_turn = NULL, failed_class = NULL WHERE failed_class = 'inaccuracy';
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_failed_class_check;
ALTER TABLE interviews ADD CONSTRAINT interviews_failed_class_check
    CHECK (failed_class IN ('mistake', 'blunder'));
