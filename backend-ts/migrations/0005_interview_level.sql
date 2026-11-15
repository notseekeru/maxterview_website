
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS level TEXT NOT NULL DEFAULT 'any'
    CHECK (level IN ('any', 'intern', 'junior', 'mid', 'senior', 'staff', 'principal'));
