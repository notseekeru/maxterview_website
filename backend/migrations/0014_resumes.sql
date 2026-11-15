-- Imported resumes, owner-scoped. TEXT ONLY: the uploaded PDF is never stored and never served
-- back, so there is no blob path, no MIME sniffing, and no same-origin PDF viewer to exploit. `text`
-- is sanitized and capped by app/resumes.py before it arrives; the CHECK is the backstop for a bug
-- there, and mirrors that module's MAX_CHARS.
CREATE TABLE IF NOT EXISTS resumes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 60000),
    -- Provenance of the import (0 on a hand-pasted resume). Informational only: it never gates anything.
    page_count SMALLINT NOT NULL DEFAULT 0 CHECK (page_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS resumes_owner_created_idx
    ON resumes (owner_id, created_at DESC);

-- Attach points. ON DELETE SET NULL, never CASCADE: deleting a resume must not delete the interviews
-- or presets that referenced it. The run keeps its transcript; it just stops being tailored to a
-- resume that no longer exists.
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS resume_id UUID REFERENCES resumes(id) ON DELETE SET NULL;
ALTER TABLE interview_templates ADD COLUMN IF NOT EXISTS resume_id UUID REFERENCES resumes(id) ON DELETE SET NULL;

-- SET NULL has to find the referencing rows on every resume delete; without this index that is a
-- seq scan of interviews. Templates are ≤ 20 rows per owner, so they do not need one.
CREATE INDEX IF NOT EXISTS interviews_resume_idx ON interviews (resume_id) WHERE resume_id IS NOT NULL;
