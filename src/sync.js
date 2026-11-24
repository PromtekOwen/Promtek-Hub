// Keeps the XP ledger in step with Tempo and the employee list in step with Jira.
import { fetchWorklogs, fetchUserWorklogs } from './tempo.js';
import { metered, addReads, readsToday, monthSoFar, overBudget, tidyReads, utcDay, utcMonth, daysInMonth, queryName, MONTHLY_READ_LIMIT, MONTHLY_WRITE_LIMIT, BACKGROUND_SHARE, PACE_ALERT } from './d1-meter.js';
import { searchJql, getIssue, findFieldId } from './jira.js';
import { rateFor, historyFor } from './xprates.js';
import { noteStatements } from './staff.js';
import { xpRate, levelFromXp, DEFAULT_ELO, DEFAULT_BASELINE } from './progression.js';
import { xpWith, applyOvertime, mondayOfDay } from './overtime.js';

const CHUNK = 50;                 // D1 allows up to 100 bound parameters per query
const JOB_CACHE_MS = 60 * 60 * 1000;
const POLL_OVERLAP_MS = 3 * 60 * 1000;
const RECONCILE_DAYS = 62;

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

// Moved on whenever XP in the ledger changes, so totals worked out from the
// ledger can be kept until then instead of being added up again on every visit.
export async function ledgerChanged(env) {
  await setState(env, 'ledger_changed_at', String(Date.now()));
}
export const ledgerStamp = async (env) => (await getState(env, 'ledger_changed_at')) || '0';

// A result worked out from many rows, kept in one row until its stamp moves on.
export async function remembered(env, key, stamp, work) {
  const saved = await getState(env, `memo:${key}`);
  if (saved) {
    try { const m = JSON.parse(saved); if (m.stamp === stamp) return m.value; } catch { /* worked out again */ }
  }
  const value = await work();
  try { await setState(env, `memo:${key}`, JSON.stringify({ stamp, value })); } catch { /* too big to keep: fine */ }
  return value;
}

async function runBatches(env, statements) {
  for (const part of chunk(statements, CHUNK)) await env.DB.batch(part);
}

// ---------- Jobs (the Jira issues time is logged against) ----------

// The Jira fields for a job's ELO and its XP Rate, as set for the Worker, or the ones Promtek uses.
const eloField = (env) => env.FIELD_ELO || 'customfield_15378';
const xpRateField = (env) => env.FIELD_XP_OVERRIDE || 'customfield_16566';

function jobFromIssue(env, issue) {
  return {
    issue_id: String(issue.id),
    issue_key: issue.key,
    summary: issue.fields?.summary || '',
    job_elo: num(issue.fields?.[eloField(env)]),
    xp_override: num(issue.fields?.[xpRateField(env)]),
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
  const fields = ['summary', 'parent', eloField(env), xpRateField(env)];
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

// A backfill of past time leaves Promtek Staff Involved and the unmatched-time alert alone.
// Whether the ledger keeps Tempo's own last-changed time (schema-064).
let stampKept = null;
async function keepsStamp(env) {
  if (stampKept === null) stampKept = await env.DB.prepare('SELECT tempo_updated_at FROM xp_ledger LIMIT 1').all().then(() => true, () => false);
  return stampKept;
}

// Worklogs removed from the hub. Tempo's search can go on returning one for a few
// minutes after it's gone, so these are never read back in.
export async function noteDeleted(env, rows) {
  if (!rows.length) return;
  const now = new Date().toISOString();
  await runBatches(env, rows.map((r) => env.DB.prepare('INSERT OR IGNORE INTO deleted_worklogs (worklog_id, account_id, deleted_at) VALUES (?, ?, ?)')
    .bind(String(r.worklog_id), r.account_id || null, now))).catch((err) => console.warn('Deleted worklogs not noted:', err.message));
}

export async function processWorklogs(env, worklogs, { backfill = false } = {}) {
  const ledgerStart = await getState(env, 'ledger_start');
  if (!ledgerStart) return { processed: 0, changed: 0 };

  // Only worklogs dated on/after go-live: earlier time is already in opening_xp.
  // Time logged ahead (a holiday booked into Tempo, say) counts from its day, not before.
  const today = londonDate();
  let wls = worklogs.filter((w) => w.accountId && w.issueId && w.startDate && w.startDate >= ledgerStart && w.startDate <= today);
  if (!wls.length) return { processed: 0, changed: 0 };
  // Anything removed from the hub stays removed, whatever Tempo's search still says.
  const deleted = new Set();
  for (const part of chunk(wls.map((w) => w.id), CHUNK)) {
    const { results } = await env.DB.prepare(`SELECT worklog_id FROM deleted_worklogs WHERE worklog_id IN (${placeholders(part.length)})`).bind(...part).all()
      .catch(() => ({ results: [] }));
    results.forEach((r) => deleted.add(String(r.worklog_id)));
  }
  if (deleted.size) wls = wls.filter((w) => !deleted.has(w.id));
  if (!wls.length) return { processed: 0, changed: 0 };
  const stamp = await keepsStamp(env);

  const { results: empRows } = await env.DB.prepare('SELECT account_id, elo, elo_week, condor_elo, condor_elo_week, baseline FROM employees').all();
  const employees = new Map(empRows.map((e) => [e.account_id, e]));
  const jobs = await loadJobs(env, wls.map((w) => w.issueId));
  // XP Rates changed in the hub start on their day, so time keeps the rate it was logged at.
  const rateHistory = await historyFor(env, wls.map((w) => w.issueId));
  // An approved dispute sets the category's ELO here, covering its stages too.
  const { results: overrideRows } = await env.DB.prepare('SELECT category_id, job_elo FROM job_overrides').all();
  const overrides = new Map(overrideRows.map((o) => [o.category_id, o.job_elo]));
  // Condor development tickets take their difficulty from the hub's estimate.
  const { results: mesRows } = await env.DB.prepare('SELECT issue_id, ticket_elo FROM mes_estimates WHERE ticket_elo IS NOT NULL').all();
  for (const m of mesRows) overrides.set(m.issue_id, m.ticket_elo);

  // Time logged against a job's documents earns more XP.
  const { multipliersFor } = await import('./docs.js');
  const docRates = await multipliersFor(env, wls.map((w) => w.id));

  const existing = new Map();
  for (const part of chunk(wls.map((w) => w.id), CHUNK)) {
    const { results } = await env.DB.prepare(
      `SELECT worklog_id, account_id, engineer_elo, seconds, xp, work_date, issue_id, overtime_seconds, start_time${stamp ? ', tempo_updated_at' : ''} FROM xp_ledger WHERE worklog_id IN (${placeholders(part.length)})`
    ).bind(...part).all();
    for (const row of results) existing.set(row.worklog_id, row);
  }

  const now = new Date().toISOString();
  const stmts = [];
  const unmatched = new Set();
  const involved = [];
  const weeks = [];
  let changed = 0;

  for (const wl of wls) {
    const emp = employees.get(wl.accountId);
    const prevRow = existing.get(wl.id);
    // Time newly logged on an item puts its author in Promtek Staff Involved.
    if (!backfill && (!prevRow || prevRow.issue_id !== wl.issueId)) involved.push({ issueId: wl.issueId, accountId: wl.accountId, issueKey: jobs.get(wl.issueId)?.issue_key });
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
    // An older copy of a worklog already changed (Tempo's search catching up) never undoes the change.
    if (prev?.tempo_updated_at && wl.updatedAt && wl.updatedAt < prev.tempo_updated_at) continue;
    // The engineer's ELO is captured when the time is first logged, from the
    // value frozen on Monday, so later changes never rewrite XP already earned.
    // Condor development is judged against the developer's Condor rating, not their customer ELO.
    const isMes = /^MES-/i.test(job.issue_key || '');
    const engineerElo = prev?.engineer_elo
      ?? (isMes ? emp.condor_elo_week ?? emp.condor_elo : emp.elo_week ?? emp.elo) ?? DEFAULT_ELO;
    const override = (rateFor(rateHistory.get(String(wl.issueId)), wl.startDate, job.xp_override ?? 1) ?? 1) * (docRates.get(String(wl.id)) || 1);
    const jobElo = overrides.get(String(wl.issueId)) ?? (job.parent_id ? overrides.get(job.parent_id) : undefined) ?? job.job_elo;
    const rate = xpRate({ jobElo, engineerElo, baseline: emp.baseline ?? DEFAULT_BASELINE, override });
    // Overtime keeps its share until the week is worked out again below.
    const sameWeek = prev && prev.account_id === wl.accountId && mondayOfDay(prev.work_date) === mondayOfDay(wl.startDate);
    const overtime = sameWeek ? Math.min(prev.overtime_seconds || 0, wl.seconds) : 0;
    const xp = xpWith(rate, wl.seconds, overtime);
    const startTime = wl.startTime || prev?.start_time || null;

    if (prev && prev.xp === xp && prev.seconds === wl.seconds && prev.work_date === wl.startDate && prev.issue_id === wl.issueId
      && (prev.start_time || null) === startTime) {
      if (stamp && wl.updatedAt && wl.updatedAt !== prev.tempo_updated_at) stmts.push(env.DB.prepare('UPDATE xp_ledger SET tempo_updated_at = ? WHERE worklog_id = ?').bind(wl.updatedAt, wl.id));
      continue;
    }
    changed++;
    weeks.push({ accountId: wl.accountId, monday: mondayOfDay(wl.startDate) });
    if (prev && !sameWeek) weeks.push({ accountId: prev.account_id || wl.accountId, monday: mondayOfDay(prev.work_date) });
    stmts.push(env.DB.prepare(
      `INSERT INTO xp_ledger (worklog_id, account_id, issue_id, work_date, seconds, description, job_elo, engineer_elo, override, rate, xp, overtime_seconds, start_time, logged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(worklog_id) DO UPDATE SET account_id = excluded.account_id, issue_id = excluded.issue_id,
         work_date = excluded.work_date, seconds = excluded.seconds, description = excluded.description,
         job_elo = excluded.job_elo, override = excluded.override, rate = excluded.rate, xp = excluded.xp,
         overtime_seconds = excluded.overtime_seconds, start_time = excluded.start_time,
         logged_at = excluded.logged_at, updated_at = excluded.updated_at`
    ).bind(wl.id, wl.accountId, wl.issueId, wl.startDate, wl.seconds, wl.description.slice(0, 500),
      jobElo ?? null, engineerElo, override, rate, xp, overtime, startTime, wl.loggedAt || now, now, now));
    if (stamp) stmts.push(env.DB.prepare('UPDATE xp_ledger SET tempo_updated_at = ? WHERE worklog_id = ?').bind(wl.updatedAt || now, wl.id));
    stmts.push(env.DB.prepare('DELETE FROM unmatched_worklogs WHERE worklog_id = ?').bind(wl.id));
  }

  await runBatches(env, stmts);
  // Kept apart from the ledger's own writes, so a problem here never holds up XP.
  if (weeks.length) {
    try { await applyOvertime(env, weeks); } catch (err) { console.warn('Overtime not worked out:', err.message); }
  }
  if (changed) await ledgerChanged(env);
  if (!backfill && weeks.length) await markDirty(env, wls.map((w) => w.startDate)).catch(() => {});
  // Kept apart from the ledger's own writes, so a problem here never holds up XP.
  if (involved.length) {
    try { await runBatches(env, noteStatements(env, involved)); } catch (err) { console.warn('Staff involved not noted:', err.message); }
  }
  if (unmatched.size && !backfill) await raiseUnmatchedAlert(env, [...unmatched]);
  return { processed: wls.length, changed, unmatched: unmatched.size };
}

// ---------- Alerts ----------

// An alert for a person goes as they've chosen in their notification settings (in the hub,
// by email, both or neither); one for the hub's own address goes out as it always has.
export async function raiseAlert(env, { kind, dedupe, subject, body, recipient = null, link = null, ref = {} }) {
  if (recipient) {
    try { if (await (await import('./notify.js')).routeAlert(env, { kind, dedupe, subject, body, recipient, link, ref })) return; }
    catch (err) { console.warn('Notification settings not applied:', err.message); }
  }
  await env.DB.prepare(
    `INSERT INTO alerts (kind, dedupe, subject, body, recipient, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe) DO NOTHING`
  ).bind(kind, dedupe, subject, body, recipient, new Date().toISOString()).run();
}

// XP Rates over time. Each item's XP Rate history is read from Jira (its changelog), so time
// earns the rate the item had on the day it was logged. Once a day the items with time in the
// last 90 days are checked; Admin can also have every item ever logged to checked, a batch per run.
const RATE_CHECK_DAYS = 90;
const RATE_STEP_ITEMS = 100;

// Checks these items: reads their XP Rate history and current rate from Jira, and works out
// again any time that earned at a rate other than the one the item had on its day.
async function rateStep(env, ids) {
  if (!ids.length) return { checked: 0, items: 0, fixed: 0, keys: [] };
  const earned = new Map();
  for (const part of chunk(ids, CHUNK)) {
    // Time on a job's documents earns its own rate on top, so it's left out of this check.
    const q = (docs) => env.DB.prepare(
      `SELECT issue_id, work_date, COALESCE(override, 1) AS override FROM xp_ledger WHERE issue_id IN (${placeholders(part.length)})
        ${docs ? 'AND worklog_id NOT IN (SELECT worklog_id FROM doc_worklogs)' : ''} GROUP BY issue_id, work_date, COALESCE(override, 1)`
    ).bind(...part).all();
    const { results } = await q(true).catch(() => q(false));
    for (const r of results) (earned.get(String(r.issue_id)) || earned.set(String(r.issue_id), []).get(String(r.issue_id))).push(r);
  }
  const { syncRateHistory } = await import('./xprates.js');
  await syncRateHistory(env, ids).catch((err) => console.warn('XP Rate history not read:', err.message));
  const history = await historyFor(env, ids);
  const fields = ['summary', 'parent', eloField(env), xpRateField(env)];
  const stale = [];
  const keys = [];
  for (const part of chunk(ids, CHUNK)) {
    let issues;
    try { issues = await searchJql(env, `id in (${part.join(',')})`, fields); } catch { continue; }
    const stmts = [];
    for (const issue of issues) {
      const job = jobFromIssue(env, issue);
      const had = earned.get(job.issue_id) || [];
      if (had.some((r) => Number(r.override) !== (rateFor(history.get(job.issue_id), r.work_date, job.xp_override ?? 1) ?? 1))) {
        stale.push(job.issue_id); keys.push(job.issue_key);
      }
      stmts.push(env.DB.prepare(
        `INSERT INTO jobs (issue_id, issue_key, summary, job_elo, xp_override, parent_id, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, summary = excluded.summary,
           job_elo = excluded.job_elo, xp_override = excluded.xp_override, parent_id = excluded.parent_id,
           fetched_at = excluded.fetched_at`
      ).bind(job.issue_id, job.issue_key, job.summary, job.job_elo, job.xp_override, job.parent_id, job.fetched_at));
    }
    await runBatches(env, stmts);
  }
  // The jobs were just read, so the time on them is worked out again without asking Jira twice.
  let changed = 0;
  for (const part of chunk(stale, CHUNK)) {
    const { results: rows } = await env.DB.prepare(
      `SELECT worklog_id, account_id, issue_id, work_date, seconds, description, logged_at, start_time FROM xp_ledger
        WHERE issue_id IN (${placeholders(part.length)})`
    ).bind(...part).all();
    const wls = rows.map((r) => ({ id: r.worklog_id, accountId: r.account_id, issueId: r.issue_id, startDate: r.work_date,
      seconds: r.seconds, description: r.description || '', loggedAt: r.logged_at, startTime: r.start_time }));
    if (wls.length) changed += (await processWorklogs(env, wls, { backfill: true })).changed;
  }
  return { checked: ids.length, items: stale.length, fixed: changed, keys };
}

export async function checkXpRates(env, { force = false } = {}) {
  const today = londonDate();
  if (!force && (await getState(env, 'xp_rate_check')) === today) return { idle: true };
  await setState(env, 'xp_rate_check', today);
  const from = londonDate(Date.now() - RATE_CHECK_DAYS * 86_400_000);
  const { results } = await env.DB.prepare('SELECT DISTINCT issue_id FROM xp_ledger WHERE work_date >= ?').bind(from).all();
  const ids = results.map((r) => String(r.issue_id));
  const out = { checked: 0, items: 0, fixed: 0, keys: [] };
  // Kept to a few hundred items a run, well inside the outside calls a run may make.
  for (const part of chunk(ids, RATE_STEP_ITEMS).slice(0, 3)) {
    const r = await rateStep(env, part);
    out.checked += r.checked; out.items += r.items; out.fixed += r.fixed; out.keys.push(...r.keys);
  }
  return { ...out, field: xpRateField(env) };
}

// Once, after lunch stopped counting towards the week's hours: every week since overtime
// started is worked out again, so lunch never pushed anyone into 1.5x XP.
async function overtimeWithoutLunch(env) {
  if (await getState(env, 'overtime_lunch_fix')) return { idle: true };
  const from = (await getState(env, 'overtime_from')) || londonDate();
  const { results } = await env.DB.prepare('SELECT DISTINCT account_id, work_date FROM xp_ledger WHERE work_date >= ?').bind(from).all();
  const weeks = [...new Map(results.map((r) => { const monday = mondayOfDay(r.work_date); return [`${r.account_id}|${monday}`, { accountId: r.account_id, monday }]; })).values()];
  const r = await applyOvertime(env, weeks);
  await setState(env, 'overtime_lunch_fix', new Date().toISOString());
  if (r.changed) await ledgerChanged(env);
  return { weeks: weeks.length, changed: r.changed };
}

// Every item ever logged to, checked a batch per run until done.
export async function startRateBackdate(env) {
  const saved = await rateBackdateStatus(env);
  if (saved.running) return saved;
  const { results } = await env.DB.prepare('SELECT DISTINCT issue_id FROM xp_ledger').all();
  const job = { ids: results.map((r) => String(r.issue_id)), total: results.length, done: 0, items: 0, fixed: 0, keys: [], started: new Date().toISOString() };
  await setState(env, 'xp_rate_backdate', JSON.stringify(job));
  return rateBackdateStep(env);
}

export async function rateBackdateStatus(env) {
  let job = null;
  try { job = JSON.parse((await getState(env, 'xp_rate_backdate')) || 'null'); } catch { /* none */ }
  if (!job) return { running: false };
  return { running: job.ids.length > 0, total: job.total, done: job.done, items: job.items, fixed: job.fixed, keys: job.keys.slice(0, 30),
    started: job.started, finished: job.finished || null, field: xpRateField(env) };
}

export async function rateBackdateStep(env) {
  let job = null;
  try { job = JSON.parse((await getState(env, 'xp_rate_backdate')) || 'null'); } catch { /* none */ }
  if (!job || !job.ids.length) return { idle: true, ...(await rateBackdateStatus(env)) };
  const part = job.ids.slice(0, RATE_STEP_ITEMS);
  const r = await rateStep(env, part);
  job.ids = job.ids.slice(part.length);
  job.done += part.length; job.items += r.items; job.fixed += r.fixed; job.keys = [...new Set([...job.keys, ...r.keys])].slice(0, 200);
  if (!job.ids.length) job.finished = new Date().toISOString();
  await setState(env, 'xp_rate_backdate', JSON.stringify(job));
  return rateBackdateStatus(env);
}

// Recalculates XP already earned on these issues, keeping each worklog's
// engineer ELO as it was when the time was logged.
export async function recalcIssues(env, issueIds) {
  const ids = [...new Set(issueIds.map(String))];
  let changed = 0;
  for (const part of chunk(ids, CHUNK)) {
    await env.DB.prepare(`UPDATE jobs SET fetched_at = 0 WHERE issue_id IN (${placeholders(part.length)})`).bind(...part).run();
    const { results } = await env.DB.prepare(
      `SELECT worklog_id, account_id, issue_id, work_date, seconds, description, logged_at, start_time FROM xp_ledger
        WHERE issue_id IN (${placeholders(part.length)})`
    ).bind(...part).all();
    const wls = results.map((r) => ({ id: r.worklog_id, accountId: r.account_id, issueId: r.issue_id, startDate: r.work_date,
      seconds: r.seconds, description: r.description || '', loggedAt: r.logged_at, startTime: r.start_time }));
    if (wls.length) changed += (await processWorklogs(env, wls)).changed;
  }
  return { changed };
}

// Puts all of someone's logged time on their saved XP rate. Each log keeps the
// job and engineer ELO it was earned with, so only time on items with no
// difficulty set (where the XP rate applies) changes. Their weekly history follows.
export async function backdateRate(env, accountId, { preview = false } = {}) {
  const emp = await env.DB.prepare('SELECT account_id, name, baseline, opening_xp FROM employees WHERE account_id = ?').bind(accountId).first();
  if (!emp) throw new Error('No such person.');
  const baseline = emp.baseline ?? DEFAULT_BASELINE;
  const { results } = await env.DB.prepare(
    'SELECT worklog_id, work_date, seconds, job_elo, engineer_elo, override, rate, xp, overtime_seconds FROM xp_ledger WHERE account_id = ?'
  ).bind(accountId).all();

  const now = new Date().toISOString();
  const stmts = [];
  const rows = [];
  let before = 0;
  let after = 0;
  for (const r of results) {
    const rate = xpRate({ jobElo: r.job_elo, engineerElo: r.engineer_elo ?? DEFAULT_ELO, baseline, override: r.override ?? 1 });
    const xp = xpWith(rate, r.seconds, r.overtime_seconds);
    before += r.xp || 0;
    after += xp;
    rows.push({ date: r.work_date, xp });
    if (xp !== r.xp || rate !== r.rate) {
      stmts.push(env.DB.prepare('UPDATE xp_ledger SET rate = ?, xp = ?, updated_at = ? WHERE worklog_id = ?').bind(rate, xp, now, r.worklog_id));
    }
  }
  const summary = { name: emp.name, rate: baseline, logs: results.length, changed: stmts.length, before, after };
  if (preview || !stmts.length) return summary;

  // Each finished week's total is the opening XP plus everything logged up to its Sunday.
  const { results: snaps } = await env.DB.prepare('SELECT week_start, xp FROM weekly_snapshots WHERE account_id = ?').bind(accountId).all();
  for (const snap of snaps) {
    const sunday = londonDate(Date.parse(`${snap.week_start}T12:00:00Z`) + 6 * 86_400_000);
    const xp = (emp.opening_xp || 0) + rows.reduce((sum, r) => sum + (r.date <= sunday ? r.xp : 0), 0);
    if (xp !== snap.xp) {
      stmts.push(env.DB.prepare('UPDATE weekly_snapshots SET xp = ?, level = ? WHERE account_id = ? AND week_start = ?')
        .bind(xp, levelFromXp(xp), accountId, snap.week_start));
    }
  }
  await runBatches(env, stmts);
  await ledgerChanged(env);
  return summary;
}

// Each finished week's record (its XP to date, and the time logged in it) worked out again
// from the ledger, from one day on, for people whose time has been put right.
export async function refreshSnapshots(env, accountIds, fromDate) {
  for (const accountId of [...new Set(accountIds)]) {
    const emp = await env.DB.prepare('SELECT opening_xp FROM employees WHERE account_id = ?').bind(accountId).first();
    if (!emp) continue;
    const { results: snaps } = await env.DB.prepare('SELECT week_start, xp, seconds, worklogs, days_logged FROM weekly_snapshots WHERE account_id = ? AND week_start >= ?')
      .bind(accountId, mondayOf(fromDate)).all();
    if (!snaps.length) continue;
    const { results: rows } = await env.DB.prepare('SELECT work_date, xp, seconds FROM xp_ledger WHERE account_id = ?').bind(accountId).all();
    const stmts = [];
    for (const snap of snaps) {
      const sunday = londonDate(Date.parse(`${snap.week_start}T12:00:00Z`) + 6 * 86_400_000);
      const xp = (emp.opening_xp || 0) + rows.reduce((t, r) => t + (r.work_date <= sunday ? r.xp || 0 : 0), 0);
      const inWeek = rows.filter((r) => r.work_date >= snap.week_start && r.work_date <= sunday);
      const seconds = inWeek.reduce((t, r) => t + r.seconds, 0);
      const days = new Set(inWeek.map((r) => r.work_date)).size;
      if (xp !== snap.xp || seconds !== snap.seconds || inWeek.length !== snap.worklogs || days !== snap.days_logged) {
        stmts.push(env.DB.prepare('UPDATE weekly_snapshots SET xp = ?, level = ?, seconds = ?, worklogs = ?, days_logged = ? WHERE account_id = ? AND week_start = ?')
          .bind(xp, levelFromXp(xp), seconds, inWeek.length, days, accountId, snap.week_start));
      }
    }
    await runBatches(env, stmts);
  }
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
// Emails waiting to go, a few at once so a batch goes quickly. Each is claimed before it's sent,
// so two runs at the same moment never send the same one twice. Stops at the first the relay refuses.
export async function sendAlerts(env, { limit = 15 } = {}) {
  if (!env.ALERT_WEBHOOK_URL) return { skipped: 'No mail relay configured' };
  const n = Math.max(1, Math.min(45, Number(limit) || 15));
  const nowMs = Date.now();
  const claim = `claim:${nowMs}:${Math.random().toString(36).slice(2, 10)}`;
  // A claim left by a run that stopped part-way is let go after five minutes.
  await env.DB.prepare("UPDATE alerts SET sent_at = NULL WHERE sent_at LIKE 'claim:%' AND sent_at < ?").bind(`claim:${nowMs - 300_000}`).run().catch(() => {});
  await env.DB.prepare(`UPDATE alerts SET sent_at = ? WHERE id IN (SELECT id FROM alerts WHERE sent_at IS NULL AND (not_before IS NULL OR not_before <= ?) ORDER BY id LIMIT ${n}) AND sent_at IS NULL`)
    .bind(claim, new Date(nowMs).toISOString()).run();
  const { results } = await env.DB.prepare('SELECT id, subject, body, recipient FROM alerts WHERE sent_at = ? ORDER BY id').bind(claim).all();
  if (!results.length) return { sent: 0 };
  let sent = 0;
  let stopped = false;
  let problem = null;
  for (let i = 0; i < results.length; i += 5) {
    const part = results.slice(i, i + 5);
    if (stopped) { await env.DB.prepare(`UPDATE alerts SET sent_at = NULL WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part.map((x) => x.id)).run(); continue; }
    const done = await Promise.all(part.map(async (alert) => {
      let ok = false;
      try {
        const res = await fetch(env.ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret: env.ALERT_WEBHOOK_SECRET || '', to: alert.recipient || env.ALERT_EMAIL || '', subject: alert.subject, body: alert.body }),
        });
        // The relay answers in words: Sent, Rejected (the secret doesn't match) or Error: and why.
        const said = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        ok = res.ok && !/^(rejected|error)/i.test(said);
        if (!ok) problem = !res.ok ? `The mail relay answered ${res.status}${said ? `: ${said.slice(0, 160)}` : ''}`
          : /^rejected/i.test(said) ? 'The mail relay rejected the hub: ALERT_WEBHOOK_SECRET doesn\'t match SHARED_SECRET in the relay script.'
            : `The mail relay couldn't send it: ${said.slice(0, 200)}`;
      } catch (err) { problem = `The mail relay couldn't be reached: ${String(err.message).slice(0, 160)}`; }
      await env.DB.prepare('UPDATE alerts SET sent_at = ? WHERE id = ?').bind(ok ? new Date().toISOString() : null, alert.id).run();
      return ok;
    }));
    sent += done.filter(Boolean).length;
    if (done.includes(false)) stopped = true;
  }
  // How the last go went, for Admin.
  await setState(env, 'alert_send_last', JSON.stringify({ at: new Date().toISOString(), sent, tried: results.length, error: problem })).catch(() => {});
  return { sent, tried: results.length, error: problem };
}

// Emails someone's action has just raised go straight away, after the reply, rather than
// waiting for the next background run.
export async function sendRaisedSince(env, sinceIso) {
  if (!env.ALERT_WEBHOOK_URL) return { idle: true };
  const waiting = await env.DB.prepare("SELECT 1 AS n FROM alerts WHERE sent_at IS NULL AND created_at >= ? AND (not_before IS NULL OR not_before <= ?) LIMIT 1")
    .bind(sinceIso, new Date().toISOString()).first().catch(() => null);
  if (!waiting?.n) return { idle: true };
  return sendAlerts(env, { limit: 45 });
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

// Once a day, just after midnight: the day's time from Tempo, so anything logged
// ahead of time is counted now its day has come, and anything dated later than
// today is taken back out until then.
export async function catchUpToday(env) {
  const today = londonDate();
  if ((await getState(env, 'ledger_day')) === today) return { idle: true };
  await setState(env, 'ledger_day', today);
  const worklogs = await fetchWorklogs(env, { from: today, to: today });
  const result = await processWorklogs(env, worklogs);
  await env.DB.prepare('DELETE FROM deleted_worklogs WHERE deleted_at < ?').bind(new Date(Date.now() - 60 * 86_400_000).toISOString()).run().catch(() => {});
  const out = await env.DB.batch([
    env.DB.prepare('DELETE FROM xp_ledger WHERE work_date > ?').bind(today),
    env.DB.prepare('DELETE FROM unmatched_worklogs WHERE work_date > ?').bind(today),
  ]);
  // Each morning everyone's week so far is worked out again, so a change to
  // contracted hours, or time logged ahead and then removed, is caught.
  let overtime = 0;
  try {
    const { results: people } = await env.DB.prepare('SELECT account_id FROM employees WHERE active = 1').all();
    const monday = mondayOfDay(today);
    const lastMonday = mondayOfDay(londonDate(Date.parse(`${monday}T12:00:00Z`) - 86_400_000));
    overtime = (await applyOvertime(env, people.flatMap((p) => [{ accountId: p.account_id, monday }, { accountId: p.account_id, monday: lastMonday }]))).changed;
  } catch (err) { console.warn('Overtime not worked out:', err.message); }
  if (out[0].meta?.changes || overtime) await ledgerChanged(env);
  return { fetched: worklogs.length, changed: result.changed, removed: out[0].meta?.changes || 0, overtime };
}

// Re-check one of the last two months' days per run, removing time deleted in Tempo.
export async function reconcileNextDay(env) {
  const offset = Number((await getState(env, 'reconcile_offset')) || 0);
  await setState(env, 'reconcile_offset', (offset + 1) % RECONCILE_DAYS);
  return reconcileDay(env, londonDate(Date.now() - offset * 86_400_000));
}

// Today and yesterday are re-read every few minutes, so time removed in Tempo
// comes off balances quickly rather than when its day next comes round. So are a few
// older days that have just had time logged or changed on them: time is often moved
// about on a day, and what was taken off goes with what was put on.
export async function reconcileRecent(env) {
  const out = [];
  for (const back of [0, 1]) out.push(await reconcileDay(env, londonDate(Date.now() - back * 86_400_000)));
  let dirty = [];
  try { dirty = JSON.parse((await getState(env, 'reconcile_dirty')) || '[]'); } catch { dirty = []; }
  const now = dirty.slice(0, 3);
  await setState(env, 'reconcile_dirty', JSON.stringify(dirty.slice(3)));
  for (const d of now) out.push(await reconcileDay(env, d));
  return out;
}

async function markDirty(env, days) {
  const recent = [londonDate(), londonDate(Date.now() - 86_400_000)];
  const add = [...new Set(days)].filter((d) => !recent.includes(d));
  if (!add.length) return;
  let dirty = [];
  try { dirty = JSON.parse((await getState(env, 'reconcile_dirty')) || '[]'); } catch { dirty = []; }
  await setState(env, 'reconcile_dirty', JSON.stringify([...new Set([...dirty, ...add])].slice(-60)));
}

// Time logged in the last few minutes may not be in Tempo's search yet, so it isn't
// taken as deleted just because the search hasn't caught up.
const FRESH_MS = 10 * 60 * 1000;
const fresh = (r) => [r.logged_at, r.updated_at].some((t) => t && Date.now() - Date.parse(t) < FRESH_MS);

// One person's time over some days, read straight from Tempo: anything the hub holds
// that Tempo no longer has is taken off. Run when they look at a week on My time.
// force (the Check against Tempo button) takes off even time changed in the last few minutes.
export async function reconcileUser(env, accountId, from, to, { force = false } = {}) {
  const ledgerStart = await getState(env, 'ledger_start');
  if (!ledgerStart || !accountId) return { skipped: true };
  const start = from < ledgerStart ? ledgerStart : from;
  if (start > to) return { skipped: true };
  const worklogs = await fetchUserWorklogs(env, accountId, { from: start, to });
  const before = await env.DB.prepare('SELECT worklog_id FROM xp_ledger WHERE account_id = ? AND work_date BETWEEN ? AND ?').bind(accountId, start, to).all();
  const had = new Set(before.results.map((r) => r.worklog_id));
  // Time Tempo has that the hub put aside as removed is Tempo's to decide: it comes back.
  const back = worklogs.filter((w) => !had.has(w.id)).map((w) => w.id);
  if (force && back.length) await env.DB.prepare(`DELETE FROM deleted_worklogs WHERE worklog_id IN (${back.slice(0, 90).map(() => '?').join(',')})`).bind(...back.slice(0, 90)).run().catch(() => {});
  await processWorklogs(env, worklogs);
  const live = new Set(worklogs.map((w) => w.id));
  const { results } = await env.DB.prepare('SELECT worklog_id, account_id, work_date, seconds, description, logged_at, updated_at FROM xp_ledger WHERE account_id = ? AND work_date BETWEEN ? AND ?')
    .bind(accountId, start, to).all();
  const goneRows = results.filter((r) => !live.has(r.worklog_id) && (force || !fresh(r)));
  await runBatches(env, goneRows.flatMap((r) => [
    env.DB.prepare('DELETE FROM xp_ledger WHERE worklog_id = ?').bind(r.worklog_id),
    env.DB.prepare('DELETE FROM unmatched_worklogs WHERE worklog_id = ?').bind(r.worklog_id),
  ]));
  if (goneRows.length) {
    await applyOvertime(env, [...new Set(goneRows.map((r) => mondayOfDay(r.work_date)))].map((monday) => ({ accountId, monday }))).catch((err) => console.warn('Overtime not worked out:', err.message));
    await refreshSnapshots(env, [accountId], goneRows.map((r) => r.work_date).sort()[0]).catch((err) => console.warn('Weekly records not updated:', err.message));
    await ledgerChanged(env);
  }
  // Checked by hand: the weekly records are put right too, even if nothing needed taking off
  // now (it may have been taken off before the records were kept in step).
  if (force && !goneRows.length) await refreshSnapshots(env, [accountId], start).catch((err) => console.warn('Weekly records not updated:', err.message));
  const counted = worklogs.filter((w) => w.startDate >= start && w.startDate <= to);
  return {
    fetched: worklogs.length, deleted: goneRows.length,
    removed: goneRows.map((r) => ({ date: r.work_date, seconds: r.seconds, description: r.description || '' })),
    added: counted.filter((w) => !had.has(w.id)).length,
    tempoSeconds: counted.reduce((t, w) => t + w.seconds, 0),
    hubSeconds: results.filter((r) => live.has(r.worklog_id)).reduce((t, r) => t + r.seconds, 0),
  };
}

export async function reconcileDay(env, day) {
  const ledgerStart = await getState(env, 'ledger_start');
  if (!ledgerStart) return { skipped: 'Ledger not started yet' };
  if (day < ledgerStart) return { skipped: `${day} is before the ledger start` };

  const worklogs = await fetchWorklogs(env, { from: day, to: day });
  await processWorklogs(env, worklogs);

  const live = new Set(worklogs.map((w) => w.id));
  const { results } = await env.DB.prepare('SELECT worklog_id, account_id, logged_at, updated_at FROM xp_ledger WHERE work_date = ?').bind(day).all();
  const goneRows = results.filter((r) => !live.has(r.worklog_id) && !fresh(r));
  const gone = goneRows.map((r) => r.worklog_id);
  await runBatches(env, gone.flatMap((id) => [
    env.DB.prepare('DELETE FROM xp_ledger WHERE worklog_id = ?').bind(id),
    env.DB.prepare('DELETE FROM unmatched_worklogs WHERE worklog_id = ?').bind(id),
  ]));
  // A deleted worklog can take someone back under their hours, so the week is worked out again.
  if (gone.length) {
    await applyOvertime(env, goneRows.map((r) => ({ accountId: r.account_id, monday: mondayOfDay(day) }))).catch((err) => console.warn('Overtime not worked out:', err.message));
    await refreshSnapshots(env, goneRows.map((r) => r.account_id), day).catch((err) => console.warn('Weekly records not updated:', err.message));
    await ledgerChanged(env);
  }
  return { day, fetched: worklogs.length, deleted: gone.length };
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
  if (!weekStart && (await getState(env, 'snapshot_week')) === monday) return { skipped: `${monday} already recorded` };
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM weekly_snapshots WHERE week_start = ?').bind(monday).first();
  if (existing.n > 0) {
    if (!weekStart) await setState(env, 'snapshot_week', monday);
    return { skipped: `${monday} already recorded` };
  }

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
  if (!weekStart) await setState(env, 'snapshot_week', monday);
  return { week: monday, engineers: stmts.length };
}

// ---------- Scheduled run (every 2 minutes) ----------

// The free Workers plan allows 50 outside calls per run. Each run does the
// Tempo sync, then the next job in turn; a job with nothing to do (no calls
// made) hands over to the one after, so quiet jobs never waste a run.
const RECONCILE_EVERY_MS = 10 * 60 * 1000;
const RECONCILE_RECENT_MS = 3 * 60 * 1000;
const SLOTS = ['orders', 'categories', 'elo', 'bitbucket', 'mes', 'mes-sync', 'stage-split', 'stage-types', 'tracker', 'hourly-scan', 'hourly-jobs', 'hourly-quotes', 'contracts', 'psc', 'ims', 'staff', 'lists', 'wip', 'wip-history', 'invoice-history', 'capacity', 'customers', 'alerts'];

export async function runScheduled(rawEnv) {
  if (!(await getState(rawEnv, 'ledger_start'))) return;
  // Every row read is counted against the job that read it.
  const reads = {};
  const writes = {};
  const queries = {};
  let current = 'Scheduler';
  const env = { ...rawEnv, DB: metered(rawEnv.DB, (rows, sql, written) => {
    if (rows) {
      reads[current] = (reads[current] || 0) + rows;
      const q = `${current}: ${queryName(sql)}`;
      queries[q] = (queries[q] || 0) + rows;
    }
    if (written) writes[current] = (writes[current] || 0) + written;
  }) };
  const errors = [];
  const attempt = async (label, fn) => {
    const before = current;
    current = label;
    try { return await fn(); } catch (err) { errors.push(`${label}: ${err.message}`); console.error(label, err); return null; }
    finally { current = before; }
  };
  const finish = async () => {
    current = 'Scheduler';
    await setState(env, 'last_scheduled_run', new Date().toISOString());
    await setState(env, 'last_error', errors.length ? `${new Date().toISOString()} ${errors.join(' | ')}` : '');
    try { await addReads(rawEnv, 'd1_reads_bg', reads, { runs: 1, queries, writes }); } catch (err) { console.warn('Read count not saved:', err.message); }
  };

  // Once the month's reads or writes are nearly used up, background work stops until
  // the month ends so the hub itself keeps working. Tempo still syncs, as it's cheap.
  const today = utcDay();
  const month = await monthSoFar(rawEnv);
  const allowed = (await getState(env, 'd1_carry_on_month')) === utcMonth();
  const fmt = (v) => Math.round(v).toLocaleString('en-GB');
  // Waiting emails go first thing every run, whatever else the run does or doesn't get to.
  if (env.ALERT_WEBHOOK_URL) {
    const waiting = await env.DB.prepare('SELECT 1 AS n FROM alerts WHERE sent_at IS NULL AND (not_before IS NULL OR not_before <= ?) LIMIT 1').bind(new Date().toISOString()).first().catch(() => null);
    if (waiting?.n) await attempt('Alert email', () => sendAlerts(env, { limit: 6 }));
  }
  if (overBudget(month) && !allowed) {
    await attempt('Tempo sync', () => pollRecent(env, { force: true }));
    if ((await getState(env, 'd1_paused_month')) !== utcMonth()) {
      await setState(env, 'd1_paused_month', utcMonth());
      await raiseAlert(env, {
        kind: 'd1-reads',
        dedupe: `d1-month:${utcMonth()}`,
        subject: 'Hub background jobs paused for the rest of the month',
        body: `This month the database has read ${fmt(month.reads)} of ${fmt(MONTHLY_READ_LIMIT)} rows and written ${fmt(month.writes)} of ${fmt(MONTHLY_WRITE_LIMIT)}. `
          + `Background jobs stop at ${Math.round(BACKGROUND_SHARE * 100)}% of either, so they are paused until the month ends to keep the rest for people using the hub. Tempo time still syncs.`
          + '\n\nAdmin, Database use shows the detail, and can let them carry on.',
      });
      await attempt('Alert email', () => sendAlerts(env));
    }
    return finish();
  }
  // A day using far more than its even share of the month is flagged once, without stopping anything.
  const used = await readsToday(rawEnv, 'd1_reads_bg');
  const web = await readsToday(rawEnv, 'd1_reads_web');
  const share = (limit) => (limit / daysInMonth()) * PACE_ALERT;
  const dayReads = (used.total || 0) + (web.total || 0), dayWrites = (used.writes || 0) + (web.writes || 0);
  if (dayReads > share(MONTHLY_READ_LIMIT) || dayWrites > share(MONTHLY_WRITE_LIMIT)) {
    const top = Object.entries(used.jobs || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
    await raiseAlert(env, {
      kind: 'd1-reads',
      dedupe: `d1-pace:${today}`,
      subject: 'The hub is using its database much faster than usual today',
      body: `Today (UTC) the database has read ${fmt(dayReads)} rows and written ${fmt(dayWrites)}, more than twice an even share of the month's `
        + `${fmt(MONTHLY_READ_LIMIT)} reads and ${fmt(MONTHLY_WRITE_LIMIT)} writes. Nothing has been stopped.\n\nBusiest background jobs today:\n`
        + top.map(([name, rows]) => `  ${name}: ${fmt(rows)}`).join('\n') + '\n\nAdmin, Database use shows the detail.',
    });
  }
  if (new Date().getUTCMinutes() < 2) await attempt('Tidy read counts', () => tidyReads(rawEnv));
  if (new Date().getUTCHours() === 3 && new Date().getUTCMinutes() < 2) await attempt('Tidy usage', async () => (await import('./usage.js')).tidy(env));

  // These make no outside calls, and the freeze must come before Monday's first time is counted.
  const Elo = await import('./elo.js');
  await attempt('Weekly snapshot', () => snapshotWeek(env));
  await attempt('Weekly ELO freeze', () => Elo.freezeWeek(env));
  await attempt('Tempo sync', () => pollRecent(env, { force: true }));
  await attempt('Time logged ahead', () => catchUpToday(env));
  // While XP is being backdated, a few more past days are read on every run.
  await attempt('XP backdate', async () => (await import('./backdate.js')).step(env));
  await attempt('XP rate history', () => rateBackdateStep(env));
  await attempt('Overtime without lunch', () => overtimeWithoutLunch(env));
  // New time puts its author in Promtek Staff Involved within minutes, a few at a time
  // so the job that follows still has its calls. Its own turn below clears any backlog.
  await attempt('Staff involved', async () => { const Staff = await import('./staff.js'); return Staff.run(env, { raiseAlert, londonDate, limit: Staff.EVERY_RUN }); });
  // PSC tickets changed in the last couple of minutes, so their notifications go straight out.
  await attempt('PSC changes', async () => (await import('./psc.js')).quickRead(env));
  // Orders and invoices changed in the last few minutes, so the WIP stays current.
  await attempt('WIP', async () => (await import('./wip.js')).quick(env));
  // Attachments on customer jobs filed in the job's Drive folder, once switched on in Job documents.
  if ((await getState(env, 'drive_filing')) === 'on') await attempt('Drive filing', async () => (await import('./drive-filing.js')).run(env));
  // One of the last 14 days is re-read every 10 minutes, so each day is checked every couple of hours.
  if (Date.now() - Number((await getState(env, 'reconcile_at')) || 0) >= RECONCILE_EVERY_MS) {
    await setState(env, 'reconcile_at', Date.now());
    await attempt('Deletion check', () => reconcileNextDay(env));
  }
  if (Date.now() - Number((await getState(env, 'reconcile_recent_at')) || 0) >= RECONCILE_RECENT_MS) {
    await setState(env, 'reconcile_recent_at', Date.now());
    await attempt('Deletion check, today', () => reconcileRecent(env));
  }

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
      return typeof r?.skipped === 'string' || r?.idle ? { idle: true } : r;
    },
    bitbucket: async () => attempt('Bitbucket', async () => {
      const r = await (await import('./devtime.js')).poll(env);
      if (r.error) throw new Error(r.error);
      return r;
    }),
    mes: async () => {
      const Mes = await import('./mes.js');
      await attempt('MES tickets', () => Mes.scan(env));
      await attempt('MES estimate links', () => Mes.linkNew(env));
      await attempt('Condor ratings', () => Mes.rateStep(env));
    },
    'hourly-scan': () => onceAnHour('hourly-scan', async () => {
      await attempt('Day reminders', async () => (await import('./devtime.js')).reminders(env));
      await attempt('Timer reminders', async () => (await import('./tracker.js')).eveningReminder(env));
      await attempt('Completed jobs', async () => (await import('./jobs.js')).scanCompleted(env));
      await attempt('Feedback round-up', async () => (await import('./feedback.js')).roundUp(env));
      await attempt('Notification emails', async () => (await import('./notify.js')).digest(env));
      await attempt('Tool box talk reminders', async () => (await import('./training.js')).daily(env));
      await attempt('COSHH reviews', async () => (await import('./coshh.js')).remindReviews(env));
      await attempt('COSHH page', async () => (await import('./coshh.js')).hourly(env));
      await attempt('Tool box talks finished', async () => (await import('./training.js')).concludeTalks(env));
      await attempt('Birthdays', async () => (await import('./eotq.js')).birthdayAlerts(env));
    }),
    'hourly-jobs': () => onceAnHour('hourly-jobs', () => attempt('Estimates and disputes', async () => (await import('./disputes.js')).hourly(env))),
    'hourly-quotes': () => onceAnHour('hourly-quotes', async () => {
      await attempt('Quotes', async () => (await import('./quotes.js')).hourly(env));
      await attempt('Company chart', async () => (await import('./orgdocs.js')).hourly(env));
      if (new Date().getUTCHours() >= 7) await attempt('Job documents', async () => (await import('./docs.js')).weeklyLeads(env));
      if (new Date().getUTCHours() === 7) await attempt('Vehicle expiries', async () => (await import('./vehicles.js')).checkExpiries(env));
      if (new Date().getUTCHours() === 5) await attempt('Jira lists retry', async () => (await import('./customer-lists.js')).daily(env));
      if (new Date().getUTCHours() === 4) await attempt('XP rate check', () => checkXpRates(env));
    }),
    tracker: async () => {
      const r = await attempt('Timer stretches', async () => (await import('./tracker.js')).retry(env));
      return r?.idle ? { idle: true } : r;
    },
    'stage-types': async () => {
      const r = await attempt('Stage types', async () => (await import('./jobs.js')).fillStageTypes(env));
      return r?.idle ? { idle: true } : r;
    },
    'stage-split': async () => {
      const r = await attempt('Stage estimates', async () => (await import('./quotes.js')).splitStep(env));
      return r?.idle ? { idle: true } : r;
    },
    'mes-sync': async () => {
      const pending = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM mes_estimates WHERE jira_synced = 0) + (SELECT COUNT(*) FROM mes_plan WHERE jira_synced = 0)
              + (SELECT COUNT(*) FROM mes_schedule WHERE jira_synced = 0) + (SELECT COUNT(*) FROM mes_note_kinds WHERE jira_synced = 0)
              + (SELECT COUNT(*) FROM mes_note_edits WHERE note_synced = 0) AS n`
      ).first();
      if (!pending?.n) return { idle: true };
      await attempt('MES to Jira', async () => (await import('./mes.js')).hourly(env));
      await attempt('Release notes to Jira', async () => (await import('./release-notes.js')).hourly(env));
      await attempt('MES timeline', async () => (await import('./mes-plan.js')).syncSchedule(env, { max: 20 }));
    },
    psc: async () => {
      const r = await attempt('Service items', async () => (await import('./psc.js')).run(env));
      return r?.idle ? { idle: true } : r;
    },
    ims: async () => {
      const r = await attempt('IMS', async () => (await import('./ims.js')).run(env));
      return r?.idle ? { idle: true } : r;
    },
    staff: async () => {
      const r = await attempt('Staff involved', async () => (await import('./staff.js')).run(env, { raiseAlert, londonDate }));
      return r?.idle ? { idle: true } : r;
    },
    lists: async () => {
      const r = await attempt('Jira lists', async () => (await import('./customer-lists.js')).run(env));
      return r?.idle ? { idle: true } : r;
    },
    contracts: async () => {
      const r = await attempt('Service contracts', async () => (await import('./contracts.js')).run(env));
      return r?.idle ? { idle: true } : r;
    },
    wip: async () => {
      const r = await attempt('WIP full read', async () => (await import('./wip.js')).full(env));
      return r?.idle ? { idle: true } : r;
    },
    'invoice-history': async () => {
      const r = await attempt('Invoice history', async () => (await import('./invoice-stats.js')).step(env));
      return r?.idle ? { idle: true } : r;
    },
    capacity: async () => {
      const r = await attempt('Capacity', async () => (await import('./capacity.js')).run(env));
      return r?.idle ? { idle: true } : r;
    },
    customers: async () => {
      const r = await attempt('Customers', async () => (await import('./customers.js')).run(env));
      return r?.idle ? { idle: true } : r;
    },
    'wip-history': async () => {
      const r = await attempt('WIP history from Jira', async () => (await import('./wip-history.js')).step(env));
      return r?.idle ? { idle: true } : r;
    },
    alerts: async () => {
      // Without a mail relay there is nothing to send, so the waiting alerts aren't counted every run.
      if (!env.ALERT_WEBHOOK_URL) return { idle: true };
      const waiting = await env.DB.prepare('SELECT 1 AS n FROM alerts WHERE sent_at IS NULL LIMIT 1').first();
      if (!waiting?.n) return { idle: true };
      await attempt('Alert email', () => sendAlerts(env));
    },
  };

  let pointer = Number(await getState(env, 'slot_pointer')) || 0;
  for (let tries = 0; tries < SLOTS.length; tries++) {
    const slot = SLOTS[pointer % SLOTS.length];
    pointer = (pointer + 1) % SLOTS.length;
    current = SLOT_NAMES[slot] || slot;
    const r = await jobs[slot]();
    current = 'Scheduler';
    if (!r?.idle) break;
  }
  await setState(env, 'slot_pointer', pointer);
  // Emails go out every run (a few, within the run's outside calls), so a notification raised by
  // this run, a PSC change say, goes within minutes rather than waiting for its turn.
  if (env.ALERT_WEBHOOK_URL) {
    const waiting = await env.DB.prepare('SELECT 1 AS n FROM alerts WHERE sent_at IS NULL AND (not_before IS NULL OR not_before <= ?) LIMIT 1').bind(new Date().toISOString()).first().catch(() => null);
    if (waiting?.n) await attempt('Alert email', () => sendAlerts(env, { limit: 6 }));
  }
  await finish();
}

// How each job is named in Admin's database reads.
const SLOT_NAMES = {
  orders: 'Job backfill', categories: 'Finished categories', elo: 'ELO ratings', bitbucket: 'Bitbucket', mes: 'Condor Dev tickets',
  'mes-sync': 'Condor Dev to Jira', 'stage-split': 'Stage estimates', 'stage-types': 'Stage types', tracker: 'Timer stretches',
  'hourly-scan': 'Hourly: profiles and reminders', 'hourly-jobs': 'Hourly: estimates and disputes', 'hourly-quotes': 'Hourly: quotes and chart',
  contracts: 'Service contracts', psc: 'PSC items', ims: 'IMS', staff: 'Staff involved', lists: 'Customer lists', wip: 'WIP full read', 'wip-history': 'WIP history from Jira', 'invoice-history': 'Invoice history', capacity: 'Capacity', customers: 'Customers', alerts: 'Alert email',
};
