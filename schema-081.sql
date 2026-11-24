ALTER TABLE doc_items ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS doc_edits (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, rev INTEGER NOT NULL, session TEXT, path TEXT, value TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_doc_edits_doc ON doc_edits(doc_id, rev);
CREATE TABLE IF NOT EXISTS doc_presence (doc_id INTEGER NOT NULL, account_id TEXT NOT NULL, name TEXT, session TEXT, field TEXT, seen_at TEXT, PRIMARY KEY (doc_id, account_id));
CREATE TABLE IF NOT EXISTS customer_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT, issue_key TEXT, project_key TEXT, customer TEXT, site TEXT, engineer_account TEXT, engineer_name TEXT, name TEXT, email TEXT, position TEXT, satisfied INTEGER, resolved TEXT, recommend INTEGER, data_confidence INTEGER, sales_visit INTEGER, testimonial INTEGER, suggestions TEXT, created_at TEXT NOT NULL, sales_done_at TEXT, sales_done_by TEXT, testimonial_done_at TEXT, testimonial_done_by TEXT, UNIQUE (source, source_id));
CREATE INDEX IF NOT EXISTS idx_customer_feedback_created ON customer_feedback(created_at);
