-- Dropping the table discards every saved BYOK key: they are unrecoverable ciphertext anyway
-- (users re-paste after a rollback/re-apply).
DROP TABLE IF EXISTS llm_credentials;
