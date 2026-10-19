-- Drops the mode and every failure record with it: a re-apply starts from "nobody failed".
ALTER TABLE interviews DROP COLUMN IF EXISTS failed_class;
ALTER TABLE interviews DROP COLUMN IF EXISTS failed_turn;
ALTER TABLE interviews DROP COLUMN IF EXISTS hardcore;
