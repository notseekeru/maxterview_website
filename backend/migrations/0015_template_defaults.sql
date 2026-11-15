-- One row per owner who has been given the built-in presets (app.main.DEFAULT_TEMPLATES). The marker
-- is what keeps a DELETED default deleted: nothing else records that an owner was ever seeded, and
-- Clerk owns identity, so there is no user row to hang the flag on.
CREATE TABLE IF NOT EXISTS template_seeds (
    owner_id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
