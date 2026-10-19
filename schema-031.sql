ALTER TABLE mes_tickets ADD COLUMN release_notes TEXT;
ALTER TABLE mes_tickets ADD COLUMN fix_versions TEXT;
ALTER TABLE mes_tickets ADD COLUMN subtask_ids TEXT;
ALTER TABLE mes_plan ADD COLUMN assignee_id TEXT;
CREATE TABLE IF NOT EXISTS mes_note_items (issue_id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, version_id TEXT NOT NULL, summary TEXT, type TEXT, module TEXT, status TEXT, done INTEGER NOT NULL DEFAULT 0, include TEXT, priority INTEGER, assignee_id TEXT, assignee_name TEXT, blocks TEXT, attachments TEXT, jira_updated TEXT, read_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_mes_note_items_version ON mes_note_items(version_id);
CREATE TABLE IF NOT EXISTS mes_note_edits (issue_id TEXT PRIMARY KEY, blocks TEXT, title TEXT, module TEXT, based_on TEXT, note_synced INTEGER NOT NULL DEFAULT 1, note_error TEXT, written_by TEXT, written_at TEXT, updated_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mes_note_kinds (issue_id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, kind TEXT NOT NULL, jira_synced INTEGER NOT NULL DEFAULT 0, jira_error TEXT, set_by TEXT, set_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mes_release_notes (version_id TEXT PRIMARY KEY, version_name TEXT, release_date TEXT, version_number TEXT, intro TEXT, read_at TEXT, updated_by TEXT, updated_at TEXT);
