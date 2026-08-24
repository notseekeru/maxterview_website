-- yoyo rollback for 0002_billing (read from 0002_billing.rollback.sql)
ALTER TABLE interviews DROP COLUMN IF EXISTS chat_turns;
DROP TABLE IF EXISTS subscriptions;
