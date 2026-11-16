ALTER TABLE psc_items ADD COLUMN reporter_id TEXT;
CREATE TABLE IF NOT EXISTS psc_org_members (org_id TEXT NOT NULL, account_id TEXT NOT NULL, email TEXT, name TEXT, read_at TEXT NOT NULL, PRIMARY KEY (org_id, account_id));
CREATE INDEX IF NOT EXISTS psc_org_members_account ON psc_org_members (account_id);
CREATE TABLE IF NOT EXISTS psc_contact_links (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, email TEXT, name TEXT, org_id TEXT NOT NULL, org_name TEXT, issue_key TEXT, new_domain INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL, done_by TEXT, done_at TEXT, UNIQUE (account_id, org_id));
