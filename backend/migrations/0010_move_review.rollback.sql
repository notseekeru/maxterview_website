-- Discards every per-turn annotation and the derived accuracy; the run then reads as ungraded
-- (the 1-10 dims in feedback.scores survive, since the columns are independent).
ALTER TABLE feedback DROP COLUMN IF EXISTS accuracy;
ALTER TABLE messages DROP COLUMN IF EXISTS move_class;
