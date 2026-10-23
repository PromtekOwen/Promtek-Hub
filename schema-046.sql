ALTER TABLE xp_ledger ADD COLUMN overtime_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE xp_ledger ADD COLUMN start_time TEXT;
