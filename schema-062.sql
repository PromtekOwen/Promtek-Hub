CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, tile TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, body TEXT, link TEXT, ref_key TEXT, dedupe TEXT UNIQUE, created_at TEXT NOT NULL, read_at TEXT, in_app INTEGER NOT NULL DEFAULT 1, digest INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(account_id, in_app, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_digest ON notifications(digest);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
CREATE TABLE IF NOT EXISTS notify_prefs (account_id TEXT NOT NULL, tile TEXT NOT NULL, prefs TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (account_id, tile));
ALTER TABLE alerts ADD COLUMN not_before TEXT;
