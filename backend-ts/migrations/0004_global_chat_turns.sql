
ALTER TABLE interviews DROP COLUMN IF EXISTS chat_turns;

CREATE TABLE IF NOT EXISTS turn_usage (
    owner_id TEXT  NOT NULL,
    day      DATE  NOT NULL,           -- UTC day (reset at 00:00 UTC)
    turns    INT   NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, day)
);
