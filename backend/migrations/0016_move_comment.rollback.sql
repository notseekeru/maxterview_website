-- yoyo rollback for 0016_move_comment (read from 0016_move_comment.rollback.sql)
-- Drops the per-turn notes; the classes and the accuracy derived from them survive (independent
-- columns), so a rolled-back run reads as badge-only.
ALTER TABLE messages DROP COLUMN IF EXISTS comment;
