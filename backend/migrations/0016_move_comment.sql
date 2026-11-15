-- The annotator's note on ONE candidate turn: the thing in the answer that decided its class, and
-- what to do with it. Lives on the message for the same reason move_class does - it grades a single
-- turn, and the transcript is the only surface that reads it back. Nullable: ungraded runs, and runs
-- annotated before this column existed (the annotate/edit path refills those).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS comment TEXT;
