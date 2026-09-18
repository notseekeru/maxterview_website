-- yoyo rollback for 0014_resumes (read from 0014_resumes.rollback.sql)
-- Columns before the table: the FKs live on interviews/interview_templates, and dropping them with
-- their columns leaves nothing pointing at resumes. The interviews and their transcripts survive.
ALTER TABLE interviews DROP COLUMN IF EXISTS resume_id;
ALTER TABLE interview_templates DROP COLUMN IF EXISTS resume_id;
DROP TABLE IF EXISTS resumes;
