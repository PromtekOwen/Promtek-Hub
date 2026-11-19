ALTER TABLE coshh_items ADD COLUMN pending TEXT;
ALTER TABLE coshh_items ADD COLUMN release_n INTEGER;
ALTER TABLE coshh_items ADD COLUMN in_date TEXT;
ALTER TABLE coshh_items ADD COLUMN out_date TEXT;
CREATE TABLE IF NOT EXISTS coshh_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, coshh_no INTEGER, product TEXT, kind TEXT NOT NULL, by_name TEXT, at TEXT NOT NULL, release_n INTEGER);
CREATE INDEX IF NOT EXISTS idx_coshh_changes_release ON coshh_changes(release_n);
CREATE TABLE IF NOT EXISTS coshh_releases (n INTEGER PRIMARY KEY, ref TEXT NOT NULL, released_on TEXT NOT NULL, by_name TEXT, by_email TEXT, notes TEXT, status TEXT NOT NULL, error TEXT, at TEXT NOT NULL, touched_at TEXT, done_at TEXT);
