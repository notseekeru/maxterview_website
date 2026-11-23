-- Recreated empty: rolling back to a build that reads llm_credentials boots against a table with no
-- rows, and every owner falls back to the system LLM_* config exactly as if they had never saved.
CREATE TABLE IF NOT EXISTS llm_credentials (
    owner_id   TEXT PRIMARY KEY,
    base_url   TEXT        NOT NULL,
    model      TEXT        NOT NULL,
    api_key    TEXT        NOT NULL,
    key_hint   TEXT        NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
