-- yoyo rollback for 0004_global_chat_turns (read from 0004_global_chat_turns.rollback.sql)
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS chat_turns INTEGER NOT NULL DEFAULT 0;
DROP TABLE IF EXISTS turn_usage;
