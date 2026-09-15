-- yoyo rollback for 0012_archive (read from 0012_archive.rollback.sql)
-- Nothing else references the flag, so dropping the column restores the previous behaviour exactly:
-- every run shows in the history again.
ALTER TABLE interviews DROP COLUMN IF EXISTS archived_at;
