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
    parent_id: issue.fields?.parent?.id ? String(issue.fields.parent.id) : null,
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
  const fields = ['summary', 'parent', env.FIELD_ELO, env.FIELD_XP_OVERRIDE];
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
        `INSERT INTO jobs (issue_id, issue_key, summary, job_elo, xp_override, parent_id, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, summary = excluded.summary,
           job_elo = excluded.job_elo, xp_override = excluded.xp_override, parent_id = excluded.parent_id,
           fetched_at = excluded.fetched_at`
      ).bind(job.issue_id, job.issue_key, job.summary, job.job_elo, job.xp_override, job.parent_id, job.fetched_at);
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

  const { results: empRows } = await env.DB.prepare('SELECT account_id, elo, elo_week, condor_elo, condor_elo_week, baseline FROM employees').all();
  const employees = new Map(empRows.map((e) => [e.account_id, e]));
  const jobs = await loadJobs(env, wls.map((w) => w.issueId));
  // An approved dispute sets the category's ELO here, covering its stages too.
  const { results: overrideRows } = await env.DB.prepare('SELECT category_id, job_elo FROM job_overrides').all();
  const overrides = new Map(overrideRows.map((o) => [o.category_id, o.job_elo]));
  // Condor development tickets take their difficulty from the hub's estimate.
  const { results: mesRows } = await env.DB.prepare('SELECT issue_id, ticket_elo FROM mes_estimates WHERE ticket_elo IS NOT NULL').all();
  for (const m of mesRows) overrides.set(m.issue_id, m.ticket_elo);

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
    // The engineer's ELO is captured when the time is first logged, from the
    // value frozen on Monday, so later changes never rewrite XP already earned.
    // Condor development is judged against the developer's Condor rating, not their customer ELO.
    const isMes = /^MES-/i.test(job.issue_key || '');
    const engineerElo = prev?.engineer_elo
      ?? (isMes ? emp.condor_elo_week ?? emp.condor_elo : emp.elo_week ?? emp.elo) ?? DEFAULT_ELO;
    const override = job.xp_override ?? 1;
    const jobElo = overrides.get(String(wl.issueId)) ?? (job.parent_id ? overrides.get(job.parent_id) : undefined) ?? job.job_elo;
    const rate = xpRate({ jobElo, engineerElo, baseline: emp.baseline ?? DEFAULT_BASELINE, override });
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
      jobElo ?? null, engineerElo, override, rate, xp, wl.loggedAt || now, now, now));
    stmts.push(env.DB.prepare('DELETE FROM unmatched_worklogs WHERE worklog_id = ?').bind(wl.id));
  }

  await runBatches(env, stmts);
  if (unmatched.size) await raiseUnmatchedAlert(env, [...unmatched]);
  return { processed: wls.length, changed, unmatched: unmatched.size };
}

// ---------- Alerts ----------

export async function raiseAlert(env, { kind, dedupe, subject, body, recipient = null }) {
  await env.DB.prepare(
    `INSERT INTO alerts (kind, dedupe, subject, body, recipient, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe) DO NOTHING`
  ).bind(kind, dedupe, subject, body, recipient, new Date().toISOString()).run();
}

// Recalculates XP already earned on these issues, keeping each worklog's
// engineer ELO as it was when the time was logged.
export async function recalcIssues(env, issueIds) {
  const ids = [...new Set(issueIds.map(String))];
  let changed = 0;
  for (const part of chunk(ids, CHUNK)) {
    await env.DB.prepare(`UPDATE jobs SET fetched_at = 0 WHERE issue_id IN (${placeholders(part.length)})`).bind(...part).run();
    const { results } = await env.DB.prepare(
      `SELECT worklog_id, account_id, issue_id, work_date, seconds, description, logged_at FROM xp_ledger
        WHERE issue_id IN (${placeholders(part.length)})`
    ).bind(...part).all();
    const wls = results.map((r) => ({ id: r.worklog_id, accountId: r.account_id, issueId: r.issue_id, startDate: r.work_date,
      seconds: r.seconds, description: r.description || '', loggedAt: r.logged_at }));
    if (wls.length) changed += (await processWorklogs(env, wls)).changed;
  }
  return { changed };
}

async function raiseUnmatchedAlert(env, accountIds) {
  const day = londonDate();
  await raiseAlert(env, {
    kind: 'unmatched-worklog',
    dedupe: `unmatched:${day}:${accountIds.sort().join(',')}`,
    subject: 'Time logged by someone without an Employee profile',
    body: `Time was logged in Tempo by ${accountIds.length} Atlassian account(s) with no employee in the hub:\n\n`
      + accountIds.map((id) => `  ${id}`).join('\n')
      + '\n\nThey are earning no XP until they are added under Admin, Employees with that Jira account ID.',
  });
}

// Hands unsent alerts to the mail relay, if one is configured.
export async function sendAlerts(env) {
  if (!env.ALERT_WEBHOOK_URL) return { skipped: 'No mail relay configured' };
  const { results } = await env.DB.prepare(
    'SELECT id, subject, body, recipient FROM alerts WHERE sent_at IS NULL ORDER BY id LIMIT 15'
  ).all();
  if (!results.length) return { sent: 0 };
  const now = new Date().toISOString();
  let sent = 0;
  for (const alert of results) {
    const res = await fetch(env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.ALERT_WEBHOOK_SECRET || '', to: alert.recipient || env.ALERT_EMAIL || '', subject: alert.subject, body: alert.body }),
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
  if ((await getState(env, 'employees_source')) !== 'jira') {
    return { employees: 0, skippedNoUserId: [], departed: 0, skipped: 'Employees are kept in the hub' };
  }
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

  // Anyone whose Employee issue has gone is marked as no longer in Jira,
  // rather than quietly disappearing along with their history.
  const seen = issues.map((issue) => String(issue.fields?.[userIdField] || '').trim()).filter(Boolean);
  let departed = 0;
  if (seen.length) {
    const { results } = await env.DB.prepare(
      `SELECT account_id FROM employees WHERE active = 1 AND account_id NOT IN (${seen.map(() => '?').join(',')})`
    ).bind(...seen).all();
    departed = results.length;
    if (departed) {
      await runBatches(env, results.map((row) => env.DB.prepare(
        'UPDATE employees SET active = 0, updated_at = ? WHERE account_id = ?'
      ).bind(now, row.account_id)));
    }
  }

  await setState(env, 'last_profile_refresh', now);
  return { employees: stmts.length, skippedNoUserId: skipped, departed };
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

// The free Workers plan allows 50 outside calls per run. Each run does the
// Tempo sync, then the next job in turn; a job with nothing to do (no calls
// made) hands over to the one after, so quiet jobs never waste a run.
const SLOTS = ['orders', 'categories', 'elo', 'bitbucket', 'mes', 'mes-sync', 'hourly-scan', 'hourly-jobs', 'hourly-quotes', 'alerts'];

export async function runScheduled(env) {
  if (!(await getState(env, 'ledger_start'))) return;
  const errors = [];
  const attempt = async (label, fn) => {
    try { return await fn(); } catch (err) { errors.push(`${label}: ${err.message}`); console.error(label, err); return null; }
  };
  // These make no outside calls, and the freeze must come before Monday's first time is counted.
  const Elo = await import('./elo.js');
  await attempt('Weekly snapshot', () => snapshotWeek(env));
  await attempt('Weekly ELO freeze', () => Elo.freezeWeek(env));
  await attempt('Tempo sync', () => pollRecent(env, { force: true }));
  await attempt('Deletion check', () => reconcileNextDay(env));

  const hourKey = new Date().toISOString().slice(0, 13);
  const onceAnHour = async (slot, fn) => {
    if ((await getState(env, `slot_hour:${slot}`)) === hourKey) return { idle: true };
    await setState(env, `slot_hour:${slot}`, hourKey);
    await fn();
    return {};
  };
  const jobs = {
    orders: async () => attempt('Job backfill', async () => (await import('./jobs.js')).backfillStep(env)),
    categories: async () => attempt('Finished categories', async () => (await import('./jobs.js')).scanCategories(env)),
    elo: async () => {
      const r = await attempt('ELO ratings', async () => (await import('./elo.js')).rateStep(env, { limit: 2 }));
      return typeof r?.skipped === 'string' ? { idle: true } : r;
    },
    bitbucket: async () => attempt('Bitbucket', async () => {
      const r = await (await import('./devtime.js')).poll(env);
      if (r.error) throw new Error(r.error);
      return r;
    }),
    mes: async () => {
      const Mes = await import('./mes.js');
      await attempt('MES tickets', () => Mes.scan(env));
      await attempt('Condor ratings', () => Mes.rateStep(env));
    },
    'hourly-scan': () => onceAnHour('hourly-scan', async () => {
      await attempt('Profile refresh', () => refreshProfiles(env));
      await attempt('Day reminders', async () => (await import('./devtime.js')).reminders(env));
      await attempt('Completed jobs', async () => (await import('./jobs.js')).scanCompleted(env));
    }),
    'hourly-jobs': () => onceAnHour('hourly-jobs', () => attempt('Estimates and disputes', async () => (await import('./disputes.js')).hourly(env))),
    'hourly-quotes': () => onceAnHour('hourly-quotes', async () => {
      await attempt('Quotes', async () => (await import('./quotes.js')).hourly(env));
      await attempt('Company chart', async () => (await import('./orgdocs.js')).hourly(env));
      if (new Date().getUTCHours() === 7) await attempt('Vehicle expiries', async () => (await import('./vehicles.js')).checkExpiries(env));
    }),
    'mes-sync': async () => {
      const pending = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM mes_estimates WHERE jira_synced = 0) + (SELECT COUNT(*) FROM mes_plan WHERE jira_synced = 0)
              + (SELECT COUNT(*) FROM mes_schedule WHERE jira_synced = 0) AS n`
      ).first();
      if (!pending?.n) return { idle: true };
      await attempt('MES to Jira', async () => (await import('./mes.js')).hourly(env));
      await attempt('MES timeline', async () => (await import('./mes-plan.js')).syncSchedule(env, { max: 20 }));
    },
    alerts: async () => {
      const waiting = await env.DB.prepare('SELECT COUNT(*) AS n FROM alerts WHERE sent_at IS NULL').first();
      if (!waiting?.n) return { idle: true };
      await attempt('Alert email', () => sendAlerts(env));
    },
  };

  let pointer = Number(await getState(env, 'slot_pointer')) || 0;
  for (let tries = 0; tries < SLOTS.length; tries++) {
    const slot = SLOTS[pointer % SLOTS.length];
    pointer = (pointer + 1) % SLOTS.length;
    const r = await jobs[slot]();
    if (!r?.idle) break;
  }
  await setState(env, 'slot_pointer', pointer);

  await setState(env, 'last_scheduled_run', new Date().toISOString());
  await setState(env, 'last_error', errors.length ? `${new Date().toISOString()} ${errors.join(' | ')}` : '');
}
