-- yoyo up migration: the ENTIRE file body is the "up" step.
-- (yoyo reads rollback from a separate 0010_move_review.rollback.sql.)
-- Chess-style review, two halves:
--   messages.move_class  the model's verdict on ONE candidate turn (the move annotation)
--   feedback.accuracy    the derived 0-100 aggregate those annotations average to
-- feedback.accuracy is stored rather than recomputed from the classes in SQL so the class -> points
-- -> grade scale lives in exactly one place (app/rating.py), not half in Python and half in a CASE.
-- Both columns are nullable: an ungraded (or failed-classification) run must stay distinguishable
-- from one that scored 0.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS move_class TEXT
    CHECK (move_class IN ('brilliant', 'great', 'good', 'book', 'inaccuracy', 'mistake', 'blunder'));

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS accuracy INTEGER CHECK (accuracy BETWEEN 0 AND 100);
