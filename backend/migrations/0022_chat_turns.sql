ALTER TABLE messages RENAME TO chat_turns;

ALTER INDEX ix_messages_interview RENAME TO ix_chat_turns_interview;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'chat_turns'::regclass AND conname LIKE 'messages\_%'
    LOOP
        EXECUTE format('ALTER TABLE chat_turns RENAME CONSTRAINT %I TO %I', c.conname, 'chat_turns' || substr(c.conname, 9));
    END LOOP;
END $$;
