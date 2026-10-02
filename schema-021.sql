DELETE FROM sync_state WHERE key = 'category_cursor';
DELETE FROM sync_state WHERE key = 'estimate_alerts_since';
ALTER TABLE completed_jobs ADD COLUMN stage_type TEXT;
CREATE TABLE IF NOT EXISTS quote_splits (category_id TEXT PRIMARY KEY, category_key TEXT NOT NULL, quote_id INTEGER, seconds INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', method TEXT, subtasks TEXT, handed_off_at TEXT NOT NULL, checked_at TEXT, error TEXT);
