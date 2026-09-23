CREATE TABLE IF NOT EXISTS completed_jobs (issue_id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, kind TEXT NOT NULL, epic_id TEXT, epic_key TEXT, parent_id TEXT, project_key TEXT, project_name TEXT, team TEXT, discipline TEXT, summary TEXT, status TEXT, done_date TEXT, story_points REAL, score_scope REAL, score_tech REAL, score_dep REAL, score_risk REAL, weighted_score REAL, job_elo REAL, estimate_seconds INTEGER, actual_seconds INTEGER, child_count INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0, confidence TEXT NOT NULL DEFAULT 'poor', updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_jobs_discipline ON completed_jobs(discipline, story_points);
CREATE INDEX IF NOT EXISTS idx_jobs_done ON completed_jobs(done_date);
CREATE INDEX IF NOT EXISTS idx_jobs_epic ON completed_jobs(epic_id);
CREATE INDEX IF NOT EXISTS idx_jobs_kind ON completed_jobs(kind);
