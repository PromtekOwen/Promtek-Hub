CREATE TABLE IF NOT EXISTS item_involvements (issue_key TEXT NOT NULL, kind TEXT NOT NULL, account_id TEXT NOT NULL, added_by TEXT, added_at TEXT NOT NULL, PRIMARY KEY (issue_key, account_id));
CREATE INDEX IF NOT EXISTS idx_item_involvements_account ON item_involvements(account_id);
ALTER TABLE vehicles ADD COLUMN country TEXT NOT NULL DEFAULT 'uk';
