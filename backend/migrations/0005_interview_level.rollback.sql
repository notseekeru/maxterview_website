-- yoyo rollback for 0005_interview_level.
ALTER TABLE interviews DROP COLUMN IF EXISTS level;
