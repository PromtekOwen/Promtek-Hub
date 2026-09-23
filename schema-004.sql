ALTER TABLE completed_jobs ADD COLUMN stage_name TEXT;
ALTER TABLE completed_jobs ADD COLUMN stage_share REAL;
CREATE INDEX IF NOT EXISTS idx_jobs_stage ON completed_jobs(discipline, stage_name);
