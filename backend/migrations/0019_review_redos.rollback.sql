-- yoyo down migration for 0019_review_redos.sql.
ALTER TABLE feedback DROP COLUMN IF EXISTS redos;
