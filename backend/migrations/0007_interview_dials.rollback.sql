-- yoyo rollback for 0007_interview_dials.
ALTER TABLE interviews
    DROP COLUMN IF EXISTS company_size,
    DROP COLUMN IF EXISTS cynicism,
    DROP COLUMN IF EXISTS brutally_honest,
    DROP COLUMN IF EXISTS human_mode,
    DROP COLUMN IF EXISTS mix_chitchat,
    DROP COLUMN IF EXISTS mix_behavioural,
    DROP COLUMN IF EXISTS mix_technical;
