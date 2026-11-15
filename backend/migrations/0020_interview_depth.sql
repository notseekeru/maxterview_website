ALTER TABLE interviews
    ADD COLUMN IF NOT EXISTS depth TEXT NOT NULL DEFAULT 'standard'
        CHECK (depth IN ('screen', 'standard', 'full')),
    DROP COLUMN IF EXISTS mix_chitchat,
    DROP COLUMN IF EXISTS mix_behavioural,
    DROP COLUMN IF EXISTS mix_technical;

ALTER TABLE interview_templates
    ADD COLUMN IF NOT EXISTS depth TEXT NOT NULL DEFAULT 'standard'
        CHECK (depth IN ('screen', 'standard', 'full')),
    DROP COLUMN IF EXISTS mix_chitchat,
    DROP COLUMN IF EXISTS mix_behavioural,
    DROP COLUMN IF EXISTS mix_technical;
