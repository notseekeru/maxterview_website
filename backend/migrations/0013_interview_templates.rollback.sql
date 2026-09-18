-- yoyo rollback for 0013_interview_templates (read from 0013_interview_templates.rollback.sql)
-- Nothing references presets (applying one copies its values into a new interview), so dropping the
-- table restores the previous behaviour with no orphaned state.
DROP TABLE IF EXISTS interview_templates;
