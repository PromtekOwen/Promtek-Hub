// Keeps the XP ledger in step with Tempo and the employee list in step with Jira.
import { fetchWorklogs } from './tempo.js';
import { searchJql, getIssue, findFieldId } from './jira.js';
import { xpRate, levelFromXp, DEFAULT_ELO, DEFAULT_BASELINE } from './progression.js';

const CHUNK = 50;                 // D1 allows up to 100 bound parameters per query
const JOB_CACHE_MS = 60 * 60 * 1000;
const POLL_OVERLAP_MS = 3 * 60 * 1000;
const RECONCILE_DAYS = 14;

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const placeholders = (n) => Array(n).fill('?').join(',');
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isNaN(parseFloat(v)) ? null : parseFloat(v));
const isoSeconds = (d) => d.toISOString().slice(0, 19) + 'Z';

export function londonDate(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(ms));
}

export async function getState(env, key) {
  const row = await env.DB.prepare('SELECT value FROM sync_state WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setState(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, String(value)).run();
}

async function runBatches(env, statements) {
  for (const part of chunk(statements, CHUNK)) await env.DB.batch(part);
}

// ---------- Jobs (the Jira issues time is logged against) ----------

function jobFromIssue(env, issue) {
  return {
    issue_id: String(issue.id),
    issue_key: issue.key,
    summary: issue.fields?.summary || '',
    job_elo: num(issue.fields?.[env.FIELD_ELO]),
    xp_override: num(issue.fields?.[env.FIELD_XP_OVERRIDE]),
    fetched_at: Date.now(),
  };
}

async function loadJobs(env, issueIds) {
  const ids = [...new Set(issueIds.filter(Boolean))];
  const jobs = new Map();
  const freshAfter = Date.now() - JOB_CACHE_MS;

  for (const part of chunk(ids, CHUNK)) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM jobs WHERE issue_id IN (${placeholders(part.length)})`
    ).bind(...part).all();
    for (const row of results) if (row.fetched_at >= freshAfter) jobs.set(row.issue_id, row);
  }

  const missing = ids.filter((id) => !jobs.has(id));
  const fields = ['summary', env.FIELD_ELO, env.FIELD_XP_OVERRIDE];
  for (const part of chunk(missing, CHUNK)) {
    let issues;
    try {
      issues = await searchJql(env, `id in (${part.join(',')})`, fields);
    } catch (err) {
      // One deleted or hidden issue makes the whole JQL fail; fall back to one at a time.
      issues = [];
      for (const id of part) {
        const issue = await getIssue(env, id, fields);
        if (issue) issues.push(issue);
      }
    }
    const stmts = issues.map((issue) => {
      const job = jobFromIssue(env, issue);
      jobs.set(job.issue_id, job);
      return env.DB.prepare(
        `INSERT INTO jobs (issue_id, issue_key, summary, job_elo, xp_override, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, summary = excluded.summary,
           job_elo = excluded.job_elo, xp_override = excluded.xp_override, fetched_at = excluded.fetched_at`
      ).bind(job.issue_id, job.issue_key, job.summary, job.job_elo, job.xp_override, job.fetched_at);
    });
    await runBatches(env, stmts);
  }
  return jobs;
}

// ---------- XP ledger ----------

export async function processWorklogs(env, worklogs) {
  const ledgerStart = await getState(env, 'ledger_start');
  if (!ledgerStart) return { processed: 0, changed: 0 };

  // Only worklogs dated on/after go-live: earlier time is already in opening_xp.
  const wls = worklogs.filter((w) => w.accountId && w.issueId && w.startDate && w.startDate >= ledgerStart);
  if (!wls.length) return { processed: 0, changed: 0 };

  const { results: empRows } = await env.DB.prepare('SELECT account_id, elo, baseline FROM employees').all();
  const employees = new Map(empRows.map((e) => [e.account_id, e]));
  const jobs = await loadJobs(env, wls.map((w) => w.issueId));

  const existing = new Map();
  for (const part of chunk(wls.map((w) => w.id), CHUNK)) {
    const { results } = await env.DB.prepare(
      `SELECT worklog_id, engineer_elo, seconds, xp, work_date, issue_id FROM xp_ledger WHERE worklog_id IN (${placeholders(part.length)})`
    ).bind(...part).all();
    for (const row of results) existing.set(row.worklog_id, row);
  }

  const now = new Date().toISOString();
  const stmts = [];
  const unmatched = new Set();
  let changed = 0;

  for (const wl of wls) {
    const emp = employees.get(wl.accountId);
    if (!emp) {
      unmatched.add(wl.accountId);
      stmts.push(env.DB.prepare(
        `INSERT INTO unmatched_worklogs (worklog_id, account_id, issue_id, work_date, seconds, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(worklog_id) DO UPDATE SET seconds = excluded.seconds, work_date = excluded.work_date, seen_at = excluded.seen_at`
      ).bind(wl.id, wl.accountId, wl.issueId, wl.startDate, wl.seconds, now));
      continue;
    }

    const job = jobs.get(wl.issueId) || {};
    const prev = existing.get(wl.id);
    // The engineer's ELO is captured when the time is first logged, so later
    // ELO changes never rewrite XP that has already been earned.
    const engineerElo = prev?.engineer_elo ?? emp.elo ?? DEFAULT_ELO;
    const override = job.xp_override ?? 1;
    const rate = xpRate({ jobElo: job.job_elo, engineerElo, baseline: emp.baseline ?? DEFAULT_BASELINE, override });
    const xp = Math.round(rate * (wl.seconds / 60));

    if (prev && prev.xp === xp && prev.seconds === wl.seconds && prev.work_date === wl.startDate && prev.issue_id === wl.issueId) {
      continue;
    }
    changed++;
    stmts.push(env.DB.prepare(
      `INSERT INTO xp_ledger (worklog_id, account_id, issue_id, work_date, seconds, description, job_elo, engineer_elo, override, rate, xp, logged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(worklog_id) DO UPDATE SET account_id = excluded.account_id, issue_id = excluded.issue_id,
         work_date = excluded.work_date, seconds = excluded.seconds, description = excluded.description,
         job_elo = excluded.job_elo, override = excluded.override, rate = excluded.rate, xp = excluded.xp,
         logged_at = excluded.logged_at, updated_at = excluded.updated_at`
    ).bind(wl.id, wl.accountId, wl.issueId, wl.startDate, wl.seconds, wl.description.slice(0, 500),
      job.job_elo ?? null, engineerElo, override, rate, xp, wl.loggedAt || now, now, now));
    stmts.push(env.DB.prepare('DELETE FROM unmatched_worklogs WHERE worklog_id = ?').bind(wl.id));
  }

  await runBatches(env, stmts);
  if (unmatched.size) await raiseUnmatchedAlert(env, [...unmatched]);
  return { processed: wls.length, changed, unmatched: unmatched.size };
}

// ---------- Alerts ----------

export async function raiseAlert(env, { kind, dedupe, subject, body }) {
  await env.DB.prepare(
    `INSERT INTO alerts (kind, dedupe, subject, body, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dedupe) DO NOTHING`
  ).bind(kind, dedupe, subject, body, new Date().toISOString()).run();
}

async function raiseUnmatchedAlert(env, accountIds) {
  const day = londonDate();
  await raiseAlert(env, {
    kind: 'unmatched-worklog',
    dedupe: `unmatched:${day}:${accountIds.sort().join(',')}`,
    subject: 'Time logged by someone without an Employee profile',
    body: `Time was logged in Tempo by ${accountIds.length} Atlassian account(s) with no Employee issue in ${env.PROFILE_PROJECT}:\n\n`
      + accountIds.map((id) => `  ${id}`).join('\n')
      + `\n\nThey are earning no XP until a profile exists with their account ID in the ${env.USERID_FIELD_NAME} field.`,
  });
}

// Hands unsent alerts to the mail relay, if one is configured.
export async function sendAlerts(env) {
  if (!env.ALERT_WEBHOOK_URL) return { skipped: 'No mail relay configured' };
  const { results } = await env.DB.prepare(
    'SELECT id, subject, body FROM alerts WHERE sent_at IS NULL ORDER BY id LIMIT 20'
  ).all();
  if (!results.length) return { sent: 0 };
  const now = new Date().toISOString();
  let sent = 0;
  for (const alert of results) {
    const res = await fetch(env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.ALERT_WEBHOOK_SECRET || '', to: env.ALERT_EMAIL || '', subject: alert.subject, body: alert.body }),
    });
    if (!res.ok) break;
    await env.DB.prepare('UPDATE alerts SET sent_at = ? WHERE id = ?').bind(now, alert.id).run();
    sent++;
  }
  return { sent };
}

// Pull worklogs created or edited since the last poll.
export async function pollRecent(env, { force = false } = {}) {
  if (!(await getState(env, 'ledger_start'))) return { skipped: 'Ledger not started yet' };
  const now = Date.now();
  const last = Number((await getState(env, 'last_poll')) || 0);
  if (!force && now - last < 30_000) return { skipped: 'Synced moments ago', changed: 0 };
  await setState(env, 'last_poll', now);

  const cursor = Number((await getState(env, 'tempo_cursor')) || now);
  const worklogs = await fetchWorklogs(env, { updatedFrom: isoSeconds(new Date(cursor - POLL_OVERLAP_MS)) });
  const result = await processWorklogs(env, worklogs);
  await setState(env, 'tempo_cursor', now);
  return { fetched: worklogs.length, ...result };
}

// Re-check one of the last 14 days per run, removing XP for deleted worklogs.
export async function reconcileNextDay(env) {
  const ledgerStart = await getState(env, 'ledger_start');
  if (!ledgerStart) return { skipped: 'Ledger not started yet' };
  const offset = Number((await getState(env, 'reconcile_offset')) || 0);
  await setState(env, 'reconcile_offset', (offset + 1) % RECONCILE_DAYS);

  const day = londonDate(Date.now() - offset * 86_400_000);
  if (day < ledgerStart) return { skipped: `${day} is before the ledger start` };

  const worklogs = await fetchWorklogs(env, { from: day, to: day });
  await processWorklogs(env, worklogs);

  const live = new Set(worklogs.map((w) => w.id));
  const { results } = await env.DB.prepare('SELECT worklog_id FROM xp_ledger WHERE work_date = ?').bind(day).all();
  const gone = results.map((r) => r.worklog_id).filter((id) => !live.has(id));
  await runBatches(env, gone.flatMap((id) => [
    env.DB.prepare('DELETE FROM xp_ledger WHERE worklog_id = ?').bind(id),
    env.DB.prepare('DELETE FROM unmatched_worklogs WHERE worklog_id = ?').bind(id),
  ]));
  return { day, fetched: worklogs.length, deleted: gone.length };
}

// ---------- Employees (from the DNM Employee issues) ----------

export async function refreshProfiles(env, { importXp = false } = {}) {
  let userIdField = await getState(env, 'userid_field');
  if (!userIdField) {
    userIdField = await findFieldId(env, env.USERID_FIELD_NAME);
    if (!userIdField) throw new Error(`Couldn't find a Jira field called "${env.USERID_FIELD_NAME}".`);
    await setState(env, 'userid_field', userIdField);
  }

  const issues = await searchJql(
    env,
    `project = "${env.PROFILE_PROJECT}" AND issuetype = "${env.PROFILE_ISSUETYPE}"`,
    ['summary', userIdField, env.FIELD_ELO, env.FIELD_BASELINE, env.FIELD_TOTAL_XP]
  );

  const now = new Date().toISOString();
  const stmts = [];
  const skipped = [];
  for (const issue of issues) {
    const f = issue.fields || {};
    const accountId = String(f[userIdField] || '').trim();
    if (!accountId) { skipped.push(issue.key); continue; }
    const jiraXp = Math.round(num(f[env.FIELD_TOTAL_XP]) || 0);
    stmts.push(env.DB.prepare(
      `INSERT INTO employees (account_id, name, profile_key, elo, baseline, jira_xp, opening_xp, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET name = excluded.name, profile_key = excluded.profile_key,
         elo = excluded.elo, baseline = excluded.baseline, jira_xp = excluded.jira_xp,
         updated_at = excluded.updated_at${importXp ? ', opening_xp = excluded.opening_xp' : ''}`
    ).bind(accountId, f.summary || issue.key, issue.key, num(f[env.FIELD_ELO]), num(f[env.FIELD_BASELINE]),
      jiraXp, importXp ? jiraXp : 0, now));
  }
  await runBatches(env, stmts);
  await setState(env, 'last_profile_refresh', now);
  return { employees: stmts.length, skippedNoUserId: skipped };
}

// One-off go-live step: carry over current XP from Jira and start the ledger today.
export async function startLedger(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM xp_ledger'),
    env.DB.prepare('DELETE FROM unmatched_worklogs'),
    env.DB.prepare("DELETE FROM sync_state WHERE key IN ('tempo_cursor', 'reconcile_offset', 'last_poll', 'ledger_start')"),
  ]);
  const result = await refreshProfiles(env, { importXp: true });
  const ledgerStart = londonDate();
  await setState(env, 'ledger_start', ledgerStart);
  await setState(env, 'tempo_cursor', Date.now());
  return { ...result, ledgerStart };
}

// ---------- Weekly snapshots ----------

export function mondayOf(dateIso) {
  const dow = new Date(`${dateIso}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return londonDate(Date.parse(`${dateIso}T12:00:00Z`) - ((dow + 6) % 7) * 86_400_000);
}

// Records each engineer's totals for a finished week, so progress over time
// survives even when ELO and XP keep moving.
export async function snapshotWeek(env, weekStart) {
  const monday = weekStart || mondayOf(londonDate(Date.now() - 7 * 86_400_000));
  const sunday = londonDate(Date.parse(`${monday}T12:00:00Z`) + 6 * 86_400_000);
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM weekly_snapshots WHERE week_start = ?').bind(monday).first();
  if (existing.n > 0) return { skipped: `${monday} already recorded` };

  const { results } = await env.DB.prepare(
    `SELECT e.account_id, e.opening_xp, e.elo,
            COALESCE((SELECT SUM(xp) FROM xp_ledger l WHERE l.account_id = e.account_id AND l.work_date <= ?), 0) AS xp_to_date,
            COALESCE((SELECT SUM(seconds) FROM xp_ledger l WHERE l.account_id = e.account_id AND l.work_date BETWEEN ? AND ?), 0) AS seconds,
            COALESCE((SELECT COUNT(*) FROM xp_ledger l WHERE l.account_id = e.account_id AND l.work_date BETWEEN ? AND ?), 0) AS worklogs,
            COALESCE((SELECT COUNT(DISTINCT work_date) FROM xp_ledger l WHERE l.account_id = e.account_id AND l.work_date BETWEEN ? AND ?), 0) AS days_logged,
            (SELECT AVG(julianday(substr(l.logged_at, 1, 10)) - julianday(l.work_date)) FROM xp_ledger l
              WHERE l.account_id = e.account_id AND l.work_date BETWEEN ? AND ? AND l.logged_at IS NOT NULL) AS avg_lag
       FROM employees e`
  ).bind(sunday, monday, sunday, monday, sunday, monday, sunday, monday, sunday).all();

  const now = new Date().toISOString();
  const stmts = results.map((r) => {
    const xp = r.opening_xp + r.xp_to_date;
    return env.DB.prepare(
      `INSERT INTO weekly_snapshots (account_id, week_start, xp, level, elo, seconds, worklogs, days_logged, avg_lag_days, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(r.account_id, monday, xp, levelFromXp(xp), r.elo, r.seconds, r.worklogs, r.days_logged, r.avg_lag, now);
  });
  await runBatches(env, stmts);
  return { week: monday, engineers: stmts.length };
}

// ---------- Scheduled run (every 2 minutes) ----------

export async function runScheduled(env) {
  if (!(await getState(env, 'ledger_start'))) return;
  const errors = [];
  const attempt = async (label, fn) => {
    try { await fn(); } catch (err) { errors.push(`${label}: ${err.message}`); console.error(label, err); }
  };
  await attempt('Tempo sync', () => pollRecent(env, { force: true }));
  await attempt('Deletion check', () => reconcileNextDay(env));
  if (new Date().getUTCMinutes() < 2) {
    await attempt('Profile refresh', () => refreshProfiles(env));
    await attempt('Weekly snapshot', () => snapshotWeek(env));
    await attempt('Alert email', () => sendAlerts(env));
  }

  await setState(env, 'last_scheduled_run', new Date().toISOString());
  await setState(env, 'last_error', errors.length ? `${new Date().toISOString()} ${errors.join(' | ')}` : '');
}
