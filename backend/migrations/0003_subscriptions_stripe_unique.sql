-- yoyo up migration: the ENTIRE file body is the "up" step.
-- (yoyo reads rollback from a separate 0003_subscriptions_stripe_unique.rollback.sql.)
-- Enforce 1 customer -> 1 owner. payments.py resolves the owner via
-- `SELECT owner_id FROM subscriptions WHERE stripe_id = $1 LIMIT 1`, which assumes
-- stripe_id is unique. Partial (WHERE stripe_id <> '') so default-empty rows never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_stripe_id
    ON subscriptions (stripe_id) WHERE stripe_id <> '';
