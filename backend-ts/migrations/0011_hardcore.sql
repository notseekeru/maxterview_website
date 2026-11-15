-- Hardcore mode (notes.md): one wrong answer and the run is over, judged as it is given rather
-- than at review time. The failure is STORED on the interview at the moment it happens, not derived
-- from the move classes afterwards: the two can disagree (a different classification pass), and the
-- candidate must not be told they failed for something the transcript no longer shows.
ALTER TABLE interviews
    ADD COLUMN IF NOT EXISTS hardcore BOOLEAN NOT NULL DEFAULT false,
    -- 1-based candidate turn that ended the run, and what it was called. Both NULL on a clean run,
    -- and on a non-hardcore run, which cannot fail this way.
    ADD COLUMN IF NOT EXISTS failed_turn SMALLINT,
    ADD COLUMN IF NOT EXISTS failed_class TEXT
        CHECK (failed_class IN ('mistake', 'blunder'));
