
ALTER TABLE interviews
    ADD COLUMN IF NOT EXISTS company_size TEXT NOT NULL DEFAULT 'any'
        CHECK (company_size IN ('any', '1-10', '11-50', '51-200', '201-1k', '1k-5k', '5k+')),
    ADD COLUMN IF NOT EXISTS cynicism TEXT NOT NULL DEFAULT 'neutral'
        CHECK (cynicism IN ('kind', 'neutral', 'skeptical')),
    ADD COLUMN IF NOT EXISTS brutally_honest BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS human_mode BOOLEAN NOT NULL DEFAULT true,
    -- Question budget per kind; the arc is opening -> chitchat -> behavioural -> technical ->
    -- wrap-up, so 0 means "skip that kind" and the interview still has an ending.
    ADD COLUMN IF NOT EXISTS mix_chitchat SMALLINT NOT NULL DEFAULT 0
        CHECK (mix_chitchat BETWEEN 0 AND 4),
    ADD COLUMN IF NOT EXISTS mix_behavioural SMALLINT NOT NULL DEFAULT 2
        CHECK (mix_behavioural BETWEEN 0 AND 4),
    ADD COLUMN IF NOT EXISTS mix_technical SMALLINT NOT NULL DEFAULT 4
        CHECK (mix_technical BETWEEN 0 AND 4);
