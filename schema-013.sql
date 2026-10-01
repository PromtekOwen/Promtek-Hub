ALTER TABLE employees ADD COLUMN elo_week REAL;
CREATE TABLE IF NOT EXISTS elo_matches (category_id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, epic_key TEXT, summary TEXT, discipline TEXT, done_date TEXT, status TEXT NOT NULL, reason TEXT, job_elo REAL, job_elo_after REAL, estimate_seconds INTEGER, actual_seconds INTEGER, ratio REAL, score REAL, weight REAL, people INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_elo_matches_done ON elo_matches(done_date);
CREATE TABLE IF NOT EXISTS elo_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, category_id TEXT, kind TEXT NOT NULL, seconds INTEGER, share REAL, expected REAL, score REAL, k REAL, weight REAL, delta REAL NOT NULL, elo_before REAL NOT NULL, elo_after REAL NOT NULL, reverses_id INTEGER, reversed_at TEXT, reversed_by TEXT, note TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_elo_events_account ON elo_events(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_elo_events_category ON elo_events(category_id);
UPDATE completed_jobs SET weighted_score = score_tech * 0.40 + score_scope * 0.30 + score_risk * 0.20 + score_dep * 0.10 WHERE score_tech IS NOT NULL AND score_scope IS NOT NULL AND score_risk IS NOT NULL AND score_dep IS NOT NULL;
