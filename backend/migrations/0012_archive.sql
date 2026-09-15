-- yoyo up migration: the ENTIRE file body is the "up" step.
-- (yoyo reads rollback from a separate 0012_archive.rollback.sql.)
-- Archive (notes.md): "hide this run from my history" without deleting it. Deliberately NOT a status:
-- status is the interview's lifecycle (pending -> in_progress -> completed), and an archived run keeps
-- the one it had. A timestamp rather than a boolean because "when did I put this away" is free here
-- and answers "why is my history short" later.
ALTER TABLE interviews
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
