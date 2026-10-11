CREATE TABLE IF NOT EXISTS feature_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, tile TEXT, title TEXT NOT NULL, details TEXT NOT NULL, account_id TEXT, email TEXT, name TEXT, status TEXT NOT NULL DEFAULT 'new', reply TEXT, updated_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_requests_status ON feature_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_email ON feature_requests(email, created_at);
