-- yoyo up migration: the ENTIRE file body is the "up" step.
-- (yoyo reads rollback from a separate 0004_global_chat_turns.rollback.sql.)
-- Change model: per-interview chat-turn counter -> GLOBAL per-owner DAILY (UTC) allowance.
-- - drop interviews.chat_turns (per-interview counter no longer the gate)
-- - add turn_usage: one row per (owner, UTC day) counting user turns across ALL interviews.

ALTER TABLE interviews DROP COLUMN IF EXISTS chat_turns;

CREATE TABLE IF NOT EXISTS turn_usage (
    owner_id TEXT  NOT NULL,
    day      DATE  NOT NULL,           -- UTC day (reset at 00:00 UTC)
    turns    INT   NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, day)
);
