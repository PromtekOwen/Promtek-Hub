ALTER TABLE quotes ADD COLUMN team TEXT;
ALTER TABLE psc_items ADD COLUMN parent_key TEXT;
CREATE TABLE IF NOT EXISTS jira_quotes (issue_id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, project_key TEXT NOT NULL, summary TEXT, status TEXT, done INTEGER NOT NULL DEFAULT 0, team TEXT, assignee_id TEXT, assignee_name TEXT, reporter_name TEXT, parent_key TEXT, created_at TEXT, updated_at TEXT, synced_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_jira_quotes_open ON jira_quotes(done, project_key);
CREATE TABLE IF NOT EXISTS customer_lists (project_key TEXT NOT NULL, kind TEXT NOT NULL, issue_id TEXT, issue_key TEXT NOT NULL, status TEXT, status_error TEXT, checked_at TEXT NOT NULL, PRIMARY KEY (project_key, kind));
CREATE TABLE IF NOT EXISTS list_moves (issue_key TEXT PRIMARY KEY, project_key TEXT, kind TEXT, from_parent TEXT, to_parent TEXT, status TEXT NOT NULL, error TEXT, tries INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
