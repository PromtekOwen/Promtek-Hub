CREATE INDEX IF NOT EXISTS idx_ledger_issue ON xp_ledger(issue_id, work_date);
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_id);
CREATE INDEX IF NOT EXISTS idx_completed_parent ON completed_jobs(parent_id, kind);
CREATE INDEX IF NOT EXISTS idx_snapshots_week ON weekly_snapshots(week_start);
CREATE INDEX IF NOT EXISTS idx_psc_items_parent ON psc_items(parent_key, done);
CREATE INDEX IF NOT EXISTS idx_jira_quotes_parent ON jira_quotes(parent_key, done);
CREATE INDEX IF NOT EXISTS idx_unmatched_issue ON unmatched_worklogs(issue_id, work_date);
CREATE INDEX IF NOT EXISTS idx_psc_writes_open ON psc_writes(done_at);
