CREATE TABLE IF NOT EXISTS jira_users (account_id TEXT PRIMARY KEY, email TEXT, cloud_id TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at INTEGER NOT NULL, connected_at TEXT, last_used_at TEXT, problem TEXT);
CREATE TABLE IF NOT EXISTS jira_oauth_states (state TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL);
