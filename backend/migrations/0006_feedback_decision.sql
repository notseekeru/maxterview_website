-- yoyo up migration: the ENTIRE file body is the "up" step.
-- (yoyo reads rollback from a separate 0006_feedback_decision.rollback.sql.)
-- Post-interview hire/reject SPECTRUM + how well-evidenced it is: a completed run is not
-- pass/fail. `decision` is NULL for feedback written before these columns existed AND when
-- the model emitted nothing usable - an undecided run stays undecided rather than defaulting
-- to a verdict. CHECK mirrors app.models.DECISIONS.

ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS decision TEXT
        CHECK (decision IS NULL OR decision IN ('reject', 'lean_reject', 'lean_hire', 'hire')),
    ADD COLUMN IF NOT EXISTS certainty SMALLINT
        CHECK (certainty IS NULL OR certainty BETWEEN 0 AND 100);
