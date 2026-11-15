-- Saved create-interview presets: a named copy of the dials + role/level/topic, owner-scoped,
-- no FK (a preset outlives the runs it spawns). CHECKs mirror app.dials / app.models.
CREATE TABLE IF NOT EXISTS interview_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    role TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 200),
    level TEXT NOT NULL DEFAULT 'any'
        CHECK (level IN ('any', 'intern', 'junior', 'mid', 'senior', 'staff', 'principal')),
    topic TEXT NOT NULL DEFAULT '' CHECK (length(topic) <= 500),
    company_size TEXT NOT NULL DEFAULT 'any'
        CHECK (company_size IN ('any', '1-10', '11-50', '51-200', '201-1k', '1k-5k', '5k+')),
    cynicism TEXT NOT NULL DEFAULT 'neutral'
        CHECK (cynicism IN ('kind', 'neutral', 'skeptical')),
    brutally_honest BOOLEAN NOT NULL DEFAULT false,
    human_mode BOOLEAN NOT NULL DEFAULT true,
    hardcore BOOLEAN NOT NULL DEFAULT false,
    mix_chitchat SMALLINT NOT NULL DEFAULT 0 CHECK (mix_chitchat BETWEEN 0 AND 4),
    mix_behavioural SMALLINT NOT NULL DEFAULT 2 CHECK (mix_behavioural BETWEEN 0 AND 4),
    mix_technical SMALLINT NOT NULL DEFAULT 4 CHECK (mix_technical BETWEEN 0 AND 4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS interview_templates_owner_created_idx
    ON interview_templates (owner_id, created_at DESC);
