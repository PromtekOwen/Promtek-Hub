CREATE INDEX IF NOT EXISTS idx_psc_items_assignee ON psc_items(assignee_id, done);
CREATE INDEX IF NOT EXISTS idx_mes_note_items_assignee ON mes_note_items(assignee_id);
CREATE INDEX IF NOT EXISTS idx_completed_stage_type ON completed_jobs(kind, stage_type);
