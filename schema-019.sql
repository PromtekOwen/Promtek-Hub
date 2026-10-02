CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_email TEXT, actor_name TEXT, area TEXT NOT NULL, action TEXT NOT NULL, subject_type TEXT, subject_id TEXT, subject_label TEXT, changes TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_area ON audit_log(area, at);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_log(subject_type, subject_id);
CREATE TABLE IF NOT EXISTS org_versions (n INTEGER PRIMARY KEY, reference TEXT NOT NULL, issued_at TEXT NOT NULL, issued_by TEXT, issued_by_name TEXT, summary TEXT, major INTEGER NOT NULL DEFAULT 0, minor INTEGER NOT NULL DEFAULT 0, snapshot TEXT, image TEXT, image_width INTEGER, image_height INTEGER, confluence_status TEXT NOT NULL DEFAULT 'none', confluence_error TEXT, published_at TEXT);
CREATE TABLE IF NOT EXISTS org_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_email TEXT, account_id TEXT, person_name TEXT, kind TEXT NOT NULL, field TEXT, label TEXT, before TEXT, after TEXT, version_n INTEGER, excluded INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_org_changes_pending ON org_changes(version_n);
