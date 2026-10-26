CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, author_tag TEXT NOT NULL, created_day TEXT NOT NULL, categories TEXT NOT NULL, problem TEXT NOT NULL, solution TEXT, status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT, decided_by TEXT, decided_day TEXT, ups INTEGER NOT NULL DEFAULT 0, downs INTEGER NOT NULL DEFAULT 0, author_unread INTEGER NOT NULL DEFAULT 0, admin_unread INTEGER NOT NULL DEFAULT 0, admin_told INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE TABLE IF NOT EXISTS feedback_votes (feedback_id TEXT NOT NULL, voter_tag TEXT NOT NULL, vote INTEGER NOT NULL, PRIMARY KEY (feedback_id, voter_tag));
CREATE INDEX IF NOT EXISTS idx_feedback_votes_tag ON feedback_votes(voter_tag);
CREATE TABLE IF NOT EXISTS feedback_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, feedback_id TEXT NOT NULL, from_admin INTEGER NOT NULL DEFAULT 0, admin_name TEXT, body TEXT NOT NULL, day TEXT NOT NULL, admin_told INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_feedback_messages_post ON feedback_messages(feedback_id);
