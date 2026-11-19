CREATE TABLE IF NOT EXISTS customers (project_key TEXT PRIMARY KEY, project_id TEXT, name TEXT, region TEXT, last_update TEXT, issue_count INTEGER, synced_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customer_items (issue_id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, project_key TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT, status TEXT, status_cat TEXT, contact TEXT, phone TEXT, email TEXT, address TEXT, created TEXT, updated TEXT, synced_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_customer_items_project ON customer_items(project_key);
