-- Service contracts: the contracts, their visits and tokens, the token clock,
-- and things that need someone to look at them.

CREATE TABLE IF NOT EXISTS contracts (
  issue_key      TEXT PRIMARY KEY,
  issue_id       TEXT NOT NULL,
  project_key    TEXT NOT NULL,
  customer       TEXT,
  summary        TEXT,
  status         TEXT,
  tier           TEXT,
  bank_holiday   INTEGER NOT NULL DEFAULT 0,
  start_date     TEXT,
  renewal_date   TEXT,
  end_date       TEXT,
  f_available    REAL,
  f_used         REAL,
  f_overdraft    REAL,
  synced_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_project ON contracts(project_key);

-- Visits, calibration visits, the obsolescence report and tokens under each contract.
CREATE TABLE IF NOT EXISTS contract_items (
  issue_id      TEXT PRIMARY KEY,
  issue_key     TEXT NOT NULL,
  contract_key  TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- visit, calibration, obsolescence, token
  summary       TEXT,
  status        TEXT,
  done          INTEGER NOT NULL DEFAULT 0,
  synced_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contract_items_contract ON contract_items(contract_key, kind);

-- Which customer the PSC items people log time to belong to.
CREATE TABLE IF NOT EXISTS contract_issues (
  issue_id     TEXT PRIMARY KEY,
  issue_key    TEXT,
  issuetype    TEXT,
  parent_id    TEXT,
  org          TEXT,
  summary      TEXT,
  checked_at   TEXT NOT NULL
);

-- An Organization name in PSC matched by hand to a customer's project.
CREATE TABLE IF NOT EXISTS contract_org_map (
  org          TEXT PRIMARY KEY,
  project_key  TEXT NOT NULL
);

-- Each token the clock has used, and how far its Jira changes have got.
CREATE TABLE IF NOT EXISTS contract_charges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_key  TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  reason        TEXT NOT NULL,            -- clock, end
  trigger_key   TEXT,
  trigger_summary TEXT,
  token_key     TEXT,
  overdraft     INTEGER NOT NULL DEFAULT 0,
  step          INTEGER NOT NULL DEFAULT 0, -- 0 to do, 1 named, 2 linked, 3 done
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL,
  done_at       TEXT,
  UNIQUE(contract_key, seq)
);

-- Things that need someone: dates that look wrong, a start date passed without
-- acceptance, a PSC with no Organization, a change Jira wouldn't take.
CREATE TABLE IF NOT EXISTS contract_flags (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe        TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  contract_key  TEXT,
  ref_key       TEXT,
  detail        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  resolved_by   TEXT,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_contract_flags_open ON contract_flags(resolved_at);

-- What the hub has done to each contract in Jira, newest first in the tile.
CREATE TABLE IF NOT EXISTS contract_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_key  TEXT NOT NULL,
  at            TEXT NOT NULL,
  text          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contract_events ON contract_events(contract_key, id);
