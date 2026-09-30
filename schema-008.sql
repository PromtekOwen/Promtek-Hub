CREATE TABLE IF NOT EXISTS obs_library (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, source TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_obs_library_kind ON obs_library(kind);
CREATE TABLE IF NOT EXISTS obs_surveys (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', report_key TEXT, project_key TEXT, client TEXT, survey_date TEXT, data TEXT NOT NULL, pdf_name TEXT, jira_attached INTEGER NOT NULL DEFAULT 0, drive_file_id TEXT, drive_link TEXT, delivery_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_obs_surveys_account ON obs_surveys(account_id, status);
CREATE INDEX IF NOT EXISTS idx_obs_surveys_report ON obs_surveys(report_key);
