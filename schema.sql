-- Promtek Hub database schema (Cloudflare D1 / SQLite)

-- One row per engineer, sourced from the Employee issues in Jira project DNM.
CREATE TABLE IF NOT EXISTS employees (
  account_id  TEXT PRIMARY KEY,          -- Jira/Atlassian account ID
  name        TEXT NOT NULL,
  email       TEXT UNIQUE,               -- Google sign-in email, linked on first login
  profile_key TEXT,                      -- e.g. DNM-123
  elo         REAL,
  baseline    REAL,
  jira_xp     INTEGER NOT NULL DEFAULT 0,  -- XP currently shown in Jira (for shadow-mode comparison)
  opening_xp  INTEGER NOT NULL DEFAULT 0,  -- XP carried over from Jira when the ledger started
  updated_at  TEXT
);

-- Cached details of the Jira issues people log time against.
CREATE TABLE IF NOT EXISTS jobs (
  issue_id    TEXT PRIMARY KEY,
  issue_key   TEXT,
  summary     TEXT,
  job_elo     REAL,
  xp_override REAL,
  fetched_at  INTEGER NOT NULL
);

-- The XP ledger: one row per Tempo worklog. Total XP = opening_xp + SUM(xp).
CREATE TABLE IF NOT EXISTS xp_ledger (
  worklog_id   TEXT PRIMARY KEY,         -- Tempo worklog ID
  account_id   TEXT NOT NULL,
  issue_id     TEXT NOT NULL,
  work_date    TEXT NOT NULL,            -- YYYY-MM-DD
  seconds      INTEGER NOT NULL,
  description  TEXT,
  job_elo      REAL,
  engineer_elo REAL,                     -- engineer's ELO when the time was first logged
  override     REAL,
  rate         REAL NOT NULL,            -- XP per minute
  xp           INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON xp_ledger(account_id, work_date);
CREATE INDEX IF NOT EXISTS idx_ledger_date ON xp_ledger(work_date);

-- Worklogs whose author has no Employee profile (shown on the Admin page).
CREATE TABLE IF NOT EXISTS unmatched_worklogs (
  worklog_id TEXT PRIMARY KEY,
  account_id TEXT,
  issue_id   TEXT,
  work_date  TEXT,
  seconds    INTEGER,
  seen_at    TEXT
);

-- Small key/value store for sync cursors and status.
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
