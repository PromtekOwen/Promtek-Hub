CREATE TABLE IF NOT EXISTS toil_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, seconds INTEGER NOT NULL, effective_date TEXT NOT NULL, note TEXT, created_by TEXT NOT NULL, created_by_name TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_toil_adjustments_account ON toil_adjustments(account_id);
