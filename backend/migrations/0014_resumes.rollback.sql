ALTER TABLE interviews DROP COLUMN IF EXISTS resume_id;
ALTER TABLE interview_templates DROP COLUMN IF EXISTS resume_id;
DROP TABLE IF EXISTS resumes;
