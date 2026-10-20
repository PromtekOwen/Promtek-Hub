// Progress and effort reporting, built from the XP ledger and weekly snapshots.
import { londonDate, mondayOf, ledgerStamp, remembered } from './sync.js';
import { progressFor, rankFor, RANKS } from './progression.js';
import { peakElos, rankWithPeak } from './elo.js';
import { teamsOf } from './permissions.js';

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
  // People can be in several teams; older records only have the one.
  if (team) { filter = ' AND (e.teams LIKE ? OR (e.teams IS NULL AND e.team = ?))'; params.push(`%"${team}"%`, team); }

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
    `SELECT account_id, name, team, role FROM employees${team ? ' WHERE (teams LIKE ? OR (teams IS NULL AND team = ?))' : ''} ORDER BY name`
  ).bind(...(team ? [`%"${team}"%`, team] : [])).all();

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
      rank: rankWithPeak(employee.elo, (await peakElos(env)).get(accountId) ?? null),
      progress: progressFor(xp), totalSeconds: totals.seconds,
    },
    weeks: weeksBack(weeks),
    byWeek: byWeek.results,
    snapshots: snapshots.results,
    topJobs: topJobs.results,
    recent: recent.results,
  };
}

// Friendly leaderboard. metric: 'xp' | 'elo'.
// XP periods: 'week' | 'month' | 'all'. For a week or month, each person's level
// is shown as it went, from where they started the period to where they are now.
// ELO periods: 'month' | 'quarter' | 'all'. Everyone is ranked by their ELO now,
// with how far finished jobs have moved it over the period.
export async function leaderboard(env, { period = 'week', metric = 'xp', accountId = null, team = null } = {}) {
  if (metric === 'elo') return eloLeaderboard(env, { period, accountId, team });
  // Everyone's totals from the ledger are kept until the ledger changes, so the board
  // reads the ledger once per change rather than on every visit.
  const from = period === 'month' ? londonDate().slice(0, 8) + '01' : period === 'all' ? '0000-00-00' : mondayOf(londonDate());
  const sums = await remembered(env, `leaderboard:${from}`, await ledgerStamp(env), async () => (await env.DB.prepare(
    `SELECT account_id, COALESCE(SUM(CASE WHEN work_date >= ? THEN xp END), 0) AS xp,
            COALESCE(SUM(CASE WHEN work_date >= ? THEN seconds END), 0) AS seconds, COALESCE(SUM(xp), 0) AS ledger
       FROM xp_ledger GROUP BY account_id`
  ).bind(from, from).all()).results);
  const byId = new Map(sums.map((r) => [r.account_id, r]));
  const { results: people } = await env.DB.prepare('SELECT account_id, name, teams, team, opening_xp FROM employees').all();
  let rows = people.map((e) => {
    const t = byId.get(e.account_id) || { xp: 0, seconds: 0, ledger: 0 };
    const total = (e.opening_xp || 0) + t.ledger;
    return { ...e, xp: period === 'all' ? total : t.xp, seconds: t.seconds, total };
  }).sort((a, b) => b.xp - a.xp);

  if (team) rows = rows.filter((r) => teamsOf(r).includes(team));
  const ranked = rows.map((r, i) => ({
    position: i + 1,
    accountId: r.account_id,
    name: r.name,
    xp: r.xp,
    level: progressFor(r.total).level,
    levelFrom: period === 'all' ? null : progressFor(r.total - r.xp).level,
    isYou: r.account_id === accountId,
  }));
  const you = ranked.find((r) => r.isYou) || null;
  return { metric: 'xp', period, top: ranked.slice(0, 10), you, total: ranked.length, all: ranked };
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

function eloPeriodStart(period) {
  if (period === 'month') return `${londonDate().slice(0, 8)}01T00:00:00`;
  if (period === 'quarter') return isoDaysAgo(91);
  if (period === 'year') return isoDaysAgo(365);
  return null;
}

// Everyone with an ELO: active people who have a rating or have had a job rated.
async function eloPeople(env, team) {
  const { results } = await env.DB.prepare(
    `SELECT e.account_id, e.name, e.teams, e.team, e.elo FROM employees e
      WHERE e.active = 1 AND (e.elo IS NOT NULL OR EXISTS (SELECT 1 FROM elo_events v WHERE v.account_id = e.account_id))`
  ).all();
  return team ? results.filter((r) => teamsOf(r).includes(team)) : results;
}

async function eloLeaderboard(env, { period = 'quarter', accountId = null, team = null }) {
  if (!['month', 'quarter', 'all'].includes(period)) period = 'quarter';
  const since = eloPeriodStart(period);
  const people = await eloPeople(env, team);
  // Movement counts finished jobs and any undoing of them, not ratings set by hand.
  const { results: moves } = await env.DB.prepare(
    `SELECT account_id, SUM(delta) AS change, SUM(CASE WHEN kind = 'match' AND reversed_at IS NULL THEN 1 ELSE 0 END) AS jobs
       FROM elo_events WHERE kind != 'adjustment'${since ? ' AND created_at >= ?' : ''} GROUP BY account_id`
  ).bind(...(since ? [since] : [])).all();
  const { results: ever } = await env.DB.prepare(
    "SELECT account_id, COUNT(*) AS n FROM elo_events WHERE kind = 'match' AND reversed_at IS NULL GROUP BY account_id"
  ).all();
  const moveBy = new Map(moves.map((m) => [m.account_id, m]));
  const rated = new Map(ever.map((m) => [m.account_id, m.n]));
  const peaks = await peakElos(env);
  const ranked = people
    .map((p) => ({ ...p, elo: p.elo ?? 1099 }))
    .sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name))
    .map((p, i) => ({
      position: i + 1,
      accountId: p.account_id,
      name: p.name,
      elo: Math.round(p.elo),
      rank: rankWithPeak(p.elo, peaks.get(p.account_id) ?? null)?.name || null,
      change: Math.round(moveBy.get(p.account_id)?.change || 0),
      jobs: moveBy.get(p.account_id)?.jobs || 0,
      ratedJobs: rated.get(p.account_id) || 0,
      isYou: p.account_id === accountId,
    }));
  const you = ranked.find((r) => r.isYou) || null;
  return { metric: 'elo', period, top: ranked.slice(0, 10), you, total: ranked.length, all: ranked };
}

// Long-term ELO for a team: each person's rating week by week, how far it has
// moved, and the jobs behind the biggest moves. Built from the ELO events, so it
// reaches back to when the ELO engine started rating jobs.
export async function eloReport(env, { weeks = 26, team = null } = {}) {
  const list = weeksBack(weeks);
  const ends = list.map((w, i) => (i === list.length - 1
    ? new Date().toISOString()
    : `${list[i + 1]}T00:00:00`));
  const start = `${list[0]}T00:00:00`;
  const people = await eloPeople(env, team);
  const ids = new Set(people.map((p) => p.account_id));
  const { results: events } = await env.DB.prepare(
    `SELECT e.id, e.account_id, e.kind, e.delta, e.elo_before, e.elo_after, e.reversed_at, e.created_at,
            m.issue_key, m.summary
       FROM elo_events e LEFT JOIN elo_matches m ON m.category_id = e.category_id
      ORDER BY e.created_at, e.id`
  ).all();
  const byPerson = new Map();
  for (const e of events) {
    if (!ids.has(e.account_id)) continue;
    if (!byPerson.has(e.account_id)) byPerson.set(e.account_id, []);
    byPerson.get(e.account_id).push(e);
  }
  const peaks = await peakElos(env);

  // A person's ELO at a moment: the rating after their last change before it, or
  // the rating before their first change after it, or their rating now.
  const eloAt = (list, now, at) => {
    let last = null;
    for (const e of list) { if (e.created_at < at) last = e; else break; }
    if (last) return last.elo_after;
    return list.length ? list[0].elo_before : now;
  };

  const rows = people.map((p) => {
    const evs = byPerson.get(p.account_id) || [];
    const now = p.elo ?? (evs.length ? evs[evs.length - 1].elo_after : 1099);
    const series = ends.map((at) => Math.round(eloAt(evs, now, at)));
    const from = Math.round(eloAt(evs, now, start));
    const inWindow = evs.filter((e) => e.created_at >= start);
    const jobs = inWindow.filter((e) => e.kind === 'match' && !e.reversed_at);
    const movement = inWindow.filter((e) => e.kind !== 'adjustment').reduce((t, e) => t + e.delta, 0);
    const best = jobs.reduce((b, e) => (!b || e.delta > b.delta ? e : b), null);
    const worst = jobs.reduce((b, e) => (!b || e.delta < b.delta ? e : b), null);
    const swing = (e) => (e ? { key: e.issue_key, summary: e.summary, delta: Math.round(e.delta * 10) / 10, at: e.created_at.slice(0, 10) } : null);
    const rankNow = rankWithPeak(now, peaks.get(p.account_id) ?? null)?.name || null;
    return {
      accountId: p.account_id, name: p.name, team: p.team,
      elo: Math.round(now), from, change: Math.round(movement),
      rank: rankNow, rankFrom: rankFor(from)?.name || null,
      jobs: jobs.length, ratedEver: evs.some((e) => e.kind === 'match'),
      best: best && best.delta > 0 ? swing(best) : null,
      worst: worst && worst.delta < 0 ? swing(worst) : null,
      series,
    };
  }).sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name));

  const avg = (xs) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null);
  const order = RANKS.map(([, name]) => name);
  return {
    weeks: list,
    people: rows,
    average: list.map((_, i) => (rows.length ? Math.round(avg(rows.map((r) => r.series[i]))) : null)),
    summary: {
      averageNow: rows.length ? Math.round(avg(rows.map((r) => r.elo))) : null,
      averageFrom: rows.length ? Math.round(avg(rows.map((r) => r.from))) : null,
      up: rows.filter((r) => r.change > 0).length,
      down: rows.filter((r) => r.change < 0).length,
      still: rows.filter((r) => r.change === 0).length,
      jobs: rows.reduce((t, r) => t + r.jobs, 0),
      rankUps: rows.filter((r) => r.rankFrom && r.rank && order.indexOf(r.rank) > order.indexOf(r.rankFrom)).length,
      rankDowns: rows.filter((r) => r.rankFrom && r.rank && order.indexOf(r.rank) < order.indexOf(r.rankFrom)).length,
    },
    ranks: order.map((name) => ({ name, n: rows.filter((r) => r.rank === name).length })).filter((x) => x.n),
  };
}

// ---------- CSV export ----------

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (headers, rows) =>
  [headers.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');

export async function exportCsv(env, { type, from, to, accountId, stageOptions = null }) {
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

  if (type === 'jobs') {
    const { results } = await env.DB.prepare(
      `SELECT done_date, project_name, team, epic_key, issue_key, kind, discipline, summary, status,
              story_points, score_scope, score_tech, score_dep, score_risk, weighted_score, job_elo,
              estimate_seconds, actual_seconds, child_count, legacy, confidence
         FROM completed_jobs ORDER BY done_date DESC, epic_key, kind`
    ).all();
    return {
      filename: 'promtek-hub-completed-jobs.csv',
      csv: toCsv(
        ['Finished', 'Customer', 'Team', 'Epic', 'Item', 'Level', 'Discipline', 'Summary', 'Status',
          'Story points', 'Scope/size', 'Technical complexity', 'Dependency', 'Risk', 'Weighted score', 'Job ELO',
          'Estimate hours', 'Actual hours', 'Actual vs estimate', 'Children', 'Legacy structure', 'Confidence'],
        results.map((r) => [r.done_date, r.project_name, r.team, r.epic_key, r.issue_key, r.kind, r.discipline,
          r.summary, r.status, r.story_points, r.score_scope, r.score_tech, r.score_dep, r.score_risk,
          r.weighted_score?.toFixed(2), r.job_elo,
          r.estimate_seconds ? (r.estimate_seconds / 3600).toFixed(2) : '',
          r.actual_seconds ? (r.actual_seconds / 3600).toFixed(2) : '',
          r.estimate_seconds && r.actual_seconds ? (r.actual_seconds / r.estimate_seconds).toFixed(2) : '',
          r.child_count, r.legacy ? 'yes' : 'no', r.confidence])
      ),
    };
  }

  // The same stage library as the screen, with the same filters.
  if (type === 'stages') {
    const { stageLibrary } = await import('./jobs.js');
    const lib = await stageLibrary(env, { ...(stageOptions || {}), minJobs: 1 });
    const split = lib.groupBy === 'customer' ? 'Customer' : lib.groupBy === 'team' ? 'Team' : null;
    return {
      filename: 'promtek-hub-stage-library.csv',
      csv: toCsv(
        ['Category', 'Stage', ...(split ? [split] : []), 'Times done', 'From older orders', 'Typical hours', 'Shortest', 'Longest', 'Typical share of category', 'Last seen'],
        lib.stages.map((r) => [r.discipline, r.stage, ...(split ? [r.by] : []), r.times, r.fromOlderOrders, r.medianHours.toFixed(2),
          r.lowHours.toFixed(2), r.highHours.toFixed(2), r.medianShare == null ? '' : (r.medianShare * 100).toFixed(1) + '%', r.lastSeen])
      ),
    };
  }

  // Everyone's ELO at the end of each week, a row per person and week.
  if (type === 'elo') {
    const weeks = Math.min(104, Math.max(4, Number(stageOptions?.weeks) || 52));
    const r = await eloReport(env, { weeks, team: stageOptions?.team || null });
    return {
      filename: `promtek-hub-elo-${r.weeks[0]}-to-${londonDate()}.csv`,
      csv: toCsv(
        ['Week beginning', 'Engineer', 'Team', 'ELO at the end of the week', 'Rank now'],
        r.weeks.flatMap((w, i) => r.people.map((p) => [w, p.name, p.team, p.series[i], p.rank])),
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
