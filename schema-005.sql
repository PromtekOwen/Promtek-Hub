CREATE TABLE IF NOT EXISTS pow_forms (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', issue_key TEXT, issue_id TEXT, project_key TEXT, customer TEXT, site TEXT, job_missing INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, pdf_name TEXT, jira_attached INTEGER NOT NULL DEFAULT 0, drive_file_id TEXT, delivery_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_pow_account ON pow_forms(account_id, status);
CREATE INDEX IF NOT EXISTS idx_pow_submitted ON pow_forms(submitted_at);
CREATE TABLE IF NOT EXISTS ra_library (id TEXT PRIMARY KEY, title TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0);
