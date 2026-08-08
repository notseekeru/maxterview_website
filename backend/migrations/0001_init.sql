-- migrate:up
CREATE TABLE IF NOT EXISTS interviews (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    TEXT        NOT NULL,
    role        TEXT        NOT NULL,
    topic       TEXT        NOT NULL DEFAULT '',
    status      TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'completed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_interviews_owner_id ON interviews (owner_id);
CREATE INDEX IF NOT EXISTS ix_interviews_owner_created ON interviews (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    interview_id UUID        NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
    role         TEXT        NOT NULL
                 CHECK (role IN ('user', 'assistant', 'system')),
    content      TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_messages_interview ON messages (interview_id, created_at);

CREATE TABLE IF NOT EXISTS feedback (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    interview_id  UUID        NOT NULL UNIQUE REFERENCES interviews (id) ON DELETE CASCADE,
    scores        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    verdict       TEXT        NOT NULL,
    tips          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- migrate:down
DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS interviews;
