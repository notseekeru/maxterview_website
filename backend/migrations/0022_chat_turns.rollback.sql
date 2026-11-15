ALTER INDEX ix_chat_turns_interview RENAME TO ix_messages_interview;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'chat_turns'::regclass AND conname LIKE 'chat_turns\_%'
    LOOP
        EXECUTE format('ALTER TABLE chat_turns RENAME CONSTRAINT %I TO %I', c.conname, 'messages' || substr(c.conname, 11));
    END LOOP;
END $$;

ALTER TABLE chat_turns RENAME TO messages;
