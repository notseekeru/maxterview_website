-- Review rebuilds spent on ONE run. Counted on the feedback row rather than the interview because a
-- redo only exists once a review does; app/billing.py owns the per-tier allowance.
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS redos INTEGER NOT NULL DEFAULT 0;
