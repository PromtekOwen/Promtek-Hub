// Progress and effort reporting, built from the XP ledger and weekly snapshots.
import { londonDate, mondayOf } from './sync.js';
import { progressFor, rankFor } from './progression.js';

const STANDARD_WEEK_SECONDS = 37.5 * 3600;

// SQLite expression giving the Monday of a work_date.
const WEEK_OF = "date(l.work_date, '-' || ((strftime('%w', l.work_date) + 6) % 7) || ' days')";

export function weeksBack(count) {
  const thisMonday = mondayOf(londonDate());
  return Array.from({ length: count }, (_, i) =>
    londonDate(Date.parse(`${thisMonday}T12:00:00Z`) - (count - 1 - i) * 7 * 86_400_000));
}

// Week-by-week effort for everyone: hours, XP, worklogs, days logged and how
// long after the work people recorded it.
export async function teamWeeks(env, { weeks = 8, team = null } = {}) {
  const from = weeksBack(weeks)[0];
  const params = [from];
  let filter = '';
  if (team) { filter = ' AND e.team = ?'; params.push(team); }

  const { results } = await env.DB.prepare(
    `SELECT e.account_id, e.name, e.team, e.role, ${WEEK_OF} AS week_start,
            SUM(l.seconds) AS seconds, SUM(l.xp) AS xp, COUNT(*) AS worklogs,
            COUNT(DISTINCT l.work_date) AS days_logged,
            AVG(CASE WHEN l.logged_at IS NOT NULL
                     THEN julianday(substr(l.logged_at, 1, 10)) - julianday(l.work_date) END) AS avg_lag_days
       FROM employees e JOIN xp_ledger l ON l.account_id = e.account_id
      WHERE l.work_date >= ?${filter}
      GROUP BY e.account_id, week_start
      ORDER BY e.name, week_start`
  ).bind(...params).all();

  const { results: people } = await env.DB.prepare(
    `SELECT account_id, name, team, role FROM employees${team ? ' WHERE team = ?' : ''} ORDER BY name`
  ).bind(...(team ? [team] : [])).all();

  const byPerson = new Map(people.map((p) => [p.account_id, { ...p, weeks: {} }]));
  for (const row of results) {
    const person = byPerson.get(row.account_id);
    if (person) person.weeks[row.week_start] = row;
  }
  return { weeks: weeksBack(weeks), standardWeekSeconds: STANDARD_WEEK_SECONDS, people: [...byPerson.values()] };
}

// One engineer in detail: weekly trend, snapshots and their most recent time logs.
export async function engineerReport(env, accountId, { weeks = 12 } = {}) {
  const from = weeksBack(weeks)[0];
  const [employee, byWeek, snapshots, topJobs, recent] = await Promise.all([
    env.DB.prepare('SELECT * FROM employees WHERE account_id = ?').bind(accountId).first(),
    env.DB.prepare(
      `SELECT ${WEEK_OF} AS week_start, SUM(l.seconds) AS seconds, SUM(l.xp) AS xp, COUNT(*) AS worklogs,
              COUNT(DISTINCT l.work_date) AS days_logged,
              AVG(CASE WHEN l.logged_at IS NOT NULL
                       THEN julianday(substr(l.logged_at, 1, 10)) - julianday(l.work_date) END) AS avg_lag_days
         FROM xp_ledger l WHERE l.account_id = ? AND l.work_date >= ?
        GROUP BY week_start ORDER BY week_start`
    ).bind(accountId, from).all(),
    env.DB.prepare(
      'SELECT week_start, xp, level, elo FROM weekly_snapshots WHERE account_id = ? ORDER BY week_start DESC LIMIT 52'
    ).bind(accountId).all(),
    env.DB.prepare(
      `SELECT j.issue_key, j.summary, SUM(l.seconds) AS seconds, SUM(l.xp) AS xp
         FROM xp_ledger l LEFT JOIN jobs j ON j.issue_id = l.issue_id
        WHERE l.account_id = ? AND l.work_date >= ?
        GROUP BY l.issue_id ORDER BY seconds DESC LIMIT 10`
    ).bind(accountId, from).all(),
    env.DB.prepare(
      `SELECT l.work_date, l.seconds, l.xp, l.rate, l.job_elo, l.engineer_elo, l.override, l.logged_at,
              l.description, j.issue_key, j.summary
         FROM xp_ledger l LEFT JOIN jobs j ON j.issue_id = l.issue_id
        WHERE l.account_id = ? ORDER BY l.work_date DESC, l.created_at DESC LIMIT 100`
    ).bind(accountId).all(),
  ]);
  if (!employee) return null;

  const totals = await env.DB.prepare(
    'SELECT COALESCE(SUM(xp), 0) AS xp, COALESCE(SUM(seconds), 0) AS seconds FROM xp_ledger WHERE account_id = ?'
  ).bind(accountId).first();
  const xp = employee.opening_xp + totals.xp;

  return {
    employee: {
      accountId: employee.account_id, name: employee.name, email: employee.email,
      team: employee.team, role: employee.role, elo: employee.elo,
      rank: rankFor(employee.elo), progress: progressFor(xp), totalSeconds: totals.seconds,
    },
    weeks: weeksBack(weeks),
    byWeek: byWeek.results,
    snapshots: snapshots.results,
    topJobs: topJobs.results,
    recent: recent.results,
  };
}

// Friendly leaderboard. period: 'week' | 'month' | 'all'
export async function leaderboard(env, { period = 'week', accountId = null } = {}) {
  let rows;
  if (period === 'all') {
    const { results } = await env.DB.prepare(
      `SELECT e.account_id, e.name, e.opening_xp + COALESCE(SUM(l.xp), 0) AS xp
         FROM employees e LEFT JOIN xp_ledger l ON l.account_id = e.account_id
        GROUP BY e.account_id ORDER BY xp DESC`
    ).all();
    rows = results;
  } else {
    const from = period === 'month'
      ? londonDate().slice(0, 8) + '01'
      : mondayOf(londonDate());
    const { results } = await env.DB.prepare(
      `SELECT e.account_id, e.name, COALESCE(SUM(l.xp), 0) AS xp, COALESCE(SUM(l.seconds), 0) AS seconds
         FROM employees e LEFT JOIN xp_ledger l
           ON l.account_id = e.account_id AND l.work_date >= ?
        GROUP BY e.account_id ORDER BY xp DESC`
    ).bind(from).all();
    rows = results;
  }

  const ranked = rows.map((r, i) => ({
    position: i + 1,
    accountId: r.account_id,
    name: r.name,
    xp: r.xp,
    level: progressFor(r.xp).level,
    isYou: r.account_id === accountId,
  }));
  const you = ranked.find((r) => r.isYou) || null;
  return { period, top: ranked.slice(0, 10), you, total: ranked.length, all: ranked };
}

// ---------- CSV export ----------

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (headers, rows) =>
  [headers.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');

export async function exportCsv(env, { type, from, to, accountId }) {
  const start = from || '2000-01-01';
  const end = to || londonDate();

  if (type === 'ledger') {
    const params = [start, end];
    let filter = '';
    if (accountId) { filter = ' AND l.account_id = ?'; params.push(accountId); }
    const { results } = await env.DB.prepare(
      `SELECT l.work_date, e.name, e.team, j.issue_key, j.summary, l.seconds, l.xp, l.rate,
              l.job_elo, l.engineer_elo, l.override, l.logged_at, l.description, l.worklog_id
         FROM xp_ledger l
         LEFT JOIN employees e ON e.account_id = l.account_id
         LEFT JOIN jobs j ON j.issue_id = l.issue_id
        WHERE l.work_date BETWEEN ? AND ?${filter}
        ORDER BY l.work_date, e.name`
    ).bind(...params).all();
    return {
      filename: `promtek-hub-time-logs-${start}-to-${end}.csv`,
      csv: toCsv(
        ['Date', 'Engineer', 'Team', 'Issue', 'Summary', 'Hours', 'XP', 'XP per minute', 'Job ELO', 'Engineer ELO', 'XP rate multiplier', 'Logged at', 'Description', 'Tempo worklog'],
        results.map((r) => [r.work_date, r.name, r.team, r.issue_key, r.summary, (r.seconds / 3600).toFixed(2),
          r.xp, r.rate?.toFixed(3), r.job_elo, r.engineer_elo, r.override, r.logged_at, r.description, r.worklog_id])
      ),
    };
  }

  if (type === 'weekly') {
    const { results } = await env.DB.prepare(
      `SELECT ${WEEK_OF} AS week_start, e.name, e.team,
              SUM(l.seconds) AS seconds, SUM(l.xp) AS xp, COUNT(*) AS worklogs,
              COUNT(DISTINCT l.work_date) AS days_logged,
              AVG(CASE WHEN l.logged_at IS NOT NULL
                       THEN julianday(substr(l.logged_at, 1, 10)) - julianday(l.work_date) END) AS avg_lag_days
         FROM employees e JOIN xp_ledger l ON l.account_id = e.account_id
        WHERE l.work_date BETWEEN ? AND ?
        GROUP BY e.account_id, week_start ORDER BY week_start, e.name`
    ).bind(start, end).all();
    return {
      filename: `promtek-hub-weekly-${start}-to-${end}.csv`,
      csv: toCsv(
        ['Week beginning', 'Engineer', 'Team', 'Hours', 'XP', 'Worklogs', 'Days logged', 'Average days between working and logging'],
        results.map((r) => [r.week_start, r.name, r.team, (r.seconds / 3600).toFixed(2), r.xp, r.worklogs,
          r.days_logged, r.avg_lag_days == null ? '' : r.avg_lag_days.toFixed(1)])
      ),
    };
  }

  if (type === 'snapshots') {
    const { results } = await env.DB.prepare(
      `SELECT s.week_start, e.name, e.team, s.xp, s.level, s.elo, s.seconds, s.worklogs, s.days_logged, s.avg_lag_days
         FROM weekly_snapshots s LEFT JOIN employees e ON e.account_id = s.account_id
        ORDER BY s.week_start, e.name`
    ).all();
    return {
      filename: 'promtek-hub-weekly-snapshots.csv',
      csv: toCsv(
        ['Week beginning', 'Engineer', 'Team', 'Total XP', 'Level', 'ELO', 'Hours that week', 'Worklogs', 'Days logged', 'Average logging delay (days)'],
        results.map((r) => [r.week_start, r.name, r.team, r.xp, r.level, r.elo, (r.seconds / 3600).toFixed(2),
          r.worklogs, r.days_logged, r.avg_lag_days == null ? '' : r.avg_lag_days.toFixed(1)])
      ),
    };
  }

  throw new Error('Unknown export type.');
}
