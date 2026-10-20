ALTER TABLE psc_items ADD COLUMN chargeable TEXT;
ALTER TABLE contract_issues ADD COLUMN chargeable TEXT;
CREATE TABLE IF NOT EXISTS contract_time_charges (worklog_id TEXT PRIMARY KEY, issue_id TEXT, chargeable INTEGER NOT NULL, decided_by TEXT, decided_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_contract_time_charges_issue ON contract_time_charges(issue_id);
INSERT OR IGNORE INTO sync_state (key, value) VALUES ('charge_rule_from', date('now'));
