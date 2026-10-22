CREATE TABLE IF NOT EXISTS wip_past_items (issue_id TEXT PRIMARY KEY, issue_key TEXT, order_id TEXT, parent_id TEXT, level INTEGER NOT NULL, issuetype TEXT, subtask INTEGER NOT NULL DEFAULT 0, created TEXT, status_id TEXT, status_name TEXT, status_cat TEXT, share REAL, summary TEXT, kids_read INTEGER NOT NULL DEFAULT 0, events TEXT);
CREATE INDEX IF NOT EXISTS idx_wip_past_order ON wip_past_items(order_id);
CREATE INDEX IF NOT EXISTS idx_wip_past_key ON wip_past_items(issue_key);
ALTER TABLE wip_snapshots ADD COLUMN sheet_status TEXT;
ALTER TABLE wip_snapshots ADD COLUMN sheet_progress REAL;
ALTER TABLE wip_snapshots ADD COLUMN sheet_non_admin REAL;
ALTER TABLE wip_snapshots ADD COLUMN sheet_invoiced REAL;
ALTER TABLE wip_snapshots ADD COLUMN sheet_paid REAL;
