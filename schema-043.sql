CREATE TABLE IF NOT EXISTS log_favourites (account_id TEXT NOT NULL, issue_key TEXT NOT NULL, issue_id TEXT, title TEXT, sublabel TEXT, added_at TEXT, PRIMARY KEY (account_id, issue_key));
CREATE TABLE IF NOT EXISTS home_dismissals (account_id TEXT NOT NULL, item TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (account_id, item));
CREATE INDEX IF NOT EXISTS idx_wip_orders_created ON wip_orders(created);
