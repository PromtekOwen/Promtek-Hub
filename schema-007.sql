ALTER TABLE employees ADD COLUMN extension TEXT;
CREATE TABLE IF NOT EXISTS call_customers (phone TEXT PRIMARY KEY, project_key TEXT NOT NULL, label TEXT, kind TEXT NOT NULL DEFAULT 'customer', created_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS call_actions (call_id TEXT NOT NULL, account_id TEXT NOT NULL, action TEXT NOT NULL, issue_key TEXT, worklog_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY (call_id, account_id));
CREATE INDEX IF NOT EXISTS idx_call_actions_account ON call_actions(account_id, created_at);
