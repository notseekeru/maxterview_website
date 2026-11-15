ALTER TABLE interviews
    DROP COLUMN IF EXISTS depth,
    ADD COLUMN IF NOT EXISTS mix_chitchat SMALLINT NOT NULL DEFAULT 0
        CHECK (mix_chitchat BETWEEN 0 AND 4),
    ADD COLUMN IF NOT EXISTS mix_behavioural SMALLINT NOT NULL DEFAULT 2
        CHECK (mix_behavioural BETWEEN 0 AND 4),
    ADD COLUMN IF NOT EXISTS mix_technical SMALLINT NOT NULL DEFAULT 4
        CHECK (mix_technical BETWEEN 0 AND 4);

ALTER TABLE interview_templates
    DROP COLUMN IF EXISTS depth,
    ADD COLUMN IF NOT EXISTS mix_chitchat SMALLINT NOT NULL DEFAULT 0
        CHECK (mix_chitchat BETWEEN 0 AND 4),
    ADD COLUMN IF NOT EXISTS mix_behavioural SMALLINT NOT NULL DEFAULT 2
        CHECK (mix_behavioural BETWEEN 0 AND 4),
    ADD COLUMN IF NOT EXISTS mix_technical SMALLINT NOT NULL DEFAULT 4
        CHECK (mix_technical BETWEEN 0 AND 4);
