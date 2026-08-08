-- 0001_init.sql — initial schema for maxterview.
-- Run via `make migrate` in order. Idempotent (IF NOT EXISTS) so re-running is safe.
-- All data is scoped to owner_id (Clerk `sub`) — D4.

-- Interviews: one practice session per row.
CREATE TABLE IF NOT EXISTS interviews (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    TEXT        NOT NULL,            -- Clerk `sub` (D4)
    role        TEXT        NOT NULL,            -- e.g. "backend engineer"
    topic       TEXT        NOT NULL DEFAULT '', -- optional focus area
    status      TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'completed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_interviews_owner_id ON interviews (owner_id);
CREATE INDEX IF NOT EXISTS ix_interviews_owner_created ON interviews (owner_id, created_at DESC);

-- Messages: each Q&A turn within an interview.
CREATE TABLE IF NOT EXISTS messages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    interview_id UUID        NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
    role         TEXT        NOT NULL
                 CHECK (role IN ('user', 'assistant', 'system')),
    content      TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_messages_interview ON messages (interview_id, created_at);

-- Feedback: the AI's scored review for a completed interview.
CREATE TABLE IF NOT EXISTS feedback (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    interview_id  UUID        NOT NULL UNIQUE REFERENCES interviews (id) ON DELETE CASCADE,
    scores        JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- per-dimension scores
    verdict       TEXT        NOT NULL,                      -- overall verdict
    tips          JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- actionable tips
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
