CREATE TABLE IF NOT EXISTS request_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, from_dev INTEGER NOT NULL DEFAULT 0, account_id TEXT, name TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_request_messages ON request_messages(request_id, id);
ALTER TABLE feature_requests ADD COLUMN requester_unread INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feature_requests ADD COLUMN dev_unread INTEGER NOT NULL DEFAULT 0;
INSERT INTO request_messages (request_id, from_dev, name, body, created_at) SELECT id, 1, updated_by, reply, updated_at FROM feature_requests WHERE reply IS NOT NULL AND reply != '' AND id NOT IN (SELECT request_id FROM request_messages);
