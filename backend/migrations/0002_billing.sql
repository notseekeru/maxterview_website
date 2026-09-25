-- yoyo up migration: the ENTIRE file body is the "up" step.
-- (yoyo reads rollback from a separate 0002_billing.rollback.sql.)
-- M10 (MONETIZATION.md): entitlement/tier + per-interview chat-turn counter.

-- subscriptions — source of tier entitlement (mirrors Clerk/Stripe billing state).
CREATE TABLE IF NOT EXISTS subscriptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id            TEXT        NOT NULL UNIQUE,          -- Clerk sub
    stripe_id           TEXT        NOT NULL DEFAULT '',
    plan                TEXT        NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'premium')),
    status              TEXT        NOT NULL DEFAULT 'active', -- active | past_due | canceled
    current_period_end  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_subscriptions_owner_id ON subscriptions (owner_id);

-- interviews.chat_turns — count of user turns (free tier per-interview cap; no token metering).
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS chat_turns INTEGER NOT NULL DEFAULT 0;
