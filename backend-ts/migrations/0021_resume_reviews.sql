-- One review per resume, replaced on each rebuild. `source_hash` is the sha256 of `resumes.text` at
-- the time the reviewer read it, so an edit makes the row stale and the API stops serving it: advice
-- about a resume the candidate no longer has is worse than no advice.
CREATE TABLE IF NOT EXISTS resume_reviews (
    resume_id UUID PRIMARY KEY REFERENCES resumes(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
    review JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
