-- yoyo up migration: the ENTIRE file body is the "up" step.
-- (yoyo reads rollback from a separate 0005_interview_level.rollback.sql.)
-- Add interviews.level: target seniority for the mock interview (None/Any -> adapt).
-- Stored as a stable lowercase slug; frees interview create from role-string hacks.

ALTER TABLE interviews ADD COLUMN IF NOT EXISTS level TEXT NOT NULL DEFAULT 'any'
    CHECK (level IN ('any', 'intern', 'junior', 'mid', 'senior', 'staff', 'principal'));
