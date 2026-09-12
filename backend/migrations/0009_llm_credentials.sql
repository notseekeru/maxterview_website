-- yoyo up migration: the ENTIRE file body is the "up" step.
-- (yoyo reads rollback from a separate 0009_llm_credentials.rollback.sql.)
-- BYOK: one OpenAI-compatible provider per owner, written only from /settings/llm (app/byok.py).
--   api_key   Fernet ciphertext under BYOK_ENCRYPTION_KEY - the DB never holds a plaintext key
--   key_hint  last 4 characters of the key, purely so the UI can say WHICH key is saved
-- No row for an owner == "use the system LLM_* config", so absence is the feature's default.
CREATE TABLE IF NOT EXISTS llm_credentials (
    owner_id   TEXT PRIMARY KEY,
    base_url   TEXT        NOT NULL,
    model      TEXT        NOT NULL,
    api_key    TEXT        NOT NULL,
    key_hint   TEXT        NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
