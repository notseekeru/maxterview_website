-- BYOK is removed from the app: no endpoint writes this table and no code reads it, so the rows are
-- unrecoverable ciphertext under a key nothing loads. Dropping it discards every saved key.
DROP TABLE IF EXISTS llm_credentials;
