-- yoyo down migration (rollback half of 0015_template_defaults.sql). The seeded rows themselves go
-- with the marker's meaning: they are ordinary presets the owner is free to keep.
DROP TABLE IF EXISTS template_seeds;
