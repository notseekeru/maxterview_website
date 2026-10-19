-- Stored rather than derived-on-read so a letter is a thing that was issued and keeps its numbers:
-- the rate card can move, and a run annotated back then still shows the offer it was quoted.
-- No owner_id: like feedback, this is scoped through its interview (ON DELETE CASCADE), and the
-- interview is the only thing that knows who owns it.
-- `band` is the level slug the offer was PRICED against (not always the run's level: `any` prices as
-- mid), so the letter can show where the base sits inside its band without re-deriving the band.
CREATE TABLE IF NOT EXISTS offers (
    interview_id  UUID PRIMARY KEY REFERENCES interviews (id) ON DELETE CASCADE,
    title         TEXT        NOT NULL,
    band          TEXT        NOT NULL
                  CHECK (band IN ('any', 'intern', 'junior', 'mid', 'senior', 'staff', 'principal')),
    base_salary   INTEGER     NOT NULL CHECK (base_salary > 0),
    signing_bonus INTEGER     NOT NULL DEFAULT 0 CHECK (signing_bonus >= 0),
    equity        INTEGER     NOT NULL DEFAULT 0 CHECK (equity >= 0),
    performance   SMALLINT    NOT NULL CHECK (performance BETWEEN 0 AND 100),
    benefits      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
