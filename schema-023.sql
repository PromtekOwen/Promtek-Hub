ALTER TABLE mes_plan ADD COLUMN decided_for TEXT;
UPDATE mes_plan SET decided_for = version_id WHERE version_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS mes_releases (version_id TEXT PRIMARY KEY, version_name TEXT, board_id TEXT, filter_id TEXT, sprints TEXT, updated_by TEXT, updated_at TEXT NOT NULL, error TEXT);
