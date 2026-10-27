CREATE TABLE IF NOT EXISTS psc_handoffs (issue_key TEXT PRIMARY KEY, source_key TEXT, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', target_key TEXT, quote_id INTEGER, summary TEXT, customer TEXT, project_key TEXT, created_by TEXT, created_name TEXT, created_at TEXT NOT NULL, done_at TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, payload TEXT);
ALTER TABLE quotes ADD COLUMN prospect TEXT;
ALTER TABLE quotes ADD COLUMN psc_key TEXT;
