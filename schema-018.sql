ALTER TABLE mes_tickets ADD COLUMN assignee_id TEXT;
ALTER TABLE mes_tickets ADD COLUMN status_category TEXT;
CREATE TABLE IF NOT EXISTS mes_capacity (account_id TEXT PRIMARY KEY, hours_per_week REAL NOT NULL, days TEXT NOT NULL, away TEXT, included INTEGER NOT NULL DEFAULT 1, updated_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mes_schedule (issue_id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, version_id TEXT, account_id TEXT, start_date TEXT, due_date TEXT, hours REAL, set_assignee INTEGER NOT NULL DEFAULT 0, accepted_by TEXT, accepted_at TEXT NOT NULL, jira_synced INTEGER NOT NULL DEFAULT 0, jira_error TEXT);
CREATE TABLE IF NOT EXISTS mes_suggestion_decisions (issue_id TEXT NOT NULL, version_id TEXT NOT NULL, decision TEXT NOT NULL, decided_by TEXT, decided_at TEXT NOT NULL, PRIMARY KEY (issue_id, version_id));
DELETE FROM sync_state WHERE key = 'mes_cursor';
