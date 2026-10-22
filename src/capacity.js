// Capacity: everything open in Jira that is assigned to someone, by person and team, with
// how long they've had it, its status and how long it has been in that status, what they
// have actually been working on (their time logs and the items they've touched), and how
// their week's hours are going against what they work.
//
// One search of every open assigned item every quarter of an hour, plus the assignment
// and status history of anything new or changed, kept in the hub's database so the tile
// itself never waits on Jira.
import { customerProjects } from './jira.js';
import { getState, setState, londonDate } from './sync.js';
import { budget, search, OutOfCalls, chunk, marks, IN } from './wip.js';
import { TEAMS } from './permissions.js';

const RUN_CALLS = 30;
const SYNC_EVERY_MS = 15 * 60 * 1000;
const LOG_IDS = 100;
const QUIET_DAYS = 14;
const STUCK_DAYS = 30;
const DEFAULT_HOURS = 37.5;
const FIELDS = ['summary', 'status', 'issuetype', 'project', 'assignee', 'parent', 'created', 'updated', 'duedate', 'priority', 'timeestimate'];
const JQL = 'assignee is not EMPTY AND statusCategory != Done ORDER BY updated DESC';
const INTERNAL = ['PMB', 'PROMTEKIT', 'ASSET', 'GOALS', 'LEGAL', 'HEALTH', 'COMPLIANCE', 'FINANCE', 'INNOV', 'IS', 'MARKETING', 'SUGGEST', 'QA'];

const dayMs = 86_400_000;
const daysSince = (iso, today) => (iso ? Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(iso)) / dayMs)) : null);
const dateOnly = (v) => (v ? londonDate(Date.parse(v)) : null);

function itemStatement(env, i, now) {
  const f = i.fields || {};
  return env.DB.prepare(
    `INSERT INTO capacity_items (issue_id, issue_key, project_key, summary, issuetype, subtask, status, status_cat, priority, assignee_id, assignee_name,
       parent_key, parent_summary, created, updated, due, estimate_left, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, project_key = excluded.project_key, summary = excluded.summary,
       issuetype = excluded.issuetype, subtask = excluded.subtask, status = excluded.status, status_cat = excluded.status_cat, priority = excluded.priority,
       assignee_id = excluded.assignee_id, assignee_name = excluded.assignee_name, parent_key = excluded.parent_key, parent_summary = excluded.parent_summary,
       created = excluded.created, updated = excluded.updated, due = excluded.due, estimate_left = excluded.estimate_left, seen_at = excluded.seen_at`
  ).bind(String(i.id), i.key, f.project?.key || i.key.split('-')[0], f.summary || '', f.issuetype?.name || '', f.issuetype?.subtask ? 1 : 0,
    f.status?.name || '', f.status?.statusCategory?.key || null, f.priority?.name || null, f.assignee?.accountId || null, f.assignee?.displayName || null,
    f.parent?.key || null, f.parent?.fields?.summary || null, f.created || null, f.updated || null, f.duedate || null,
    Number.isFinite(f.timeestimate) ? f.timeestimate : null, now);
}

// When each item reached its current person and its current status, from its change history.
async function readHistories(env, b, rows) {
  for (const part of chunk(rows, LOG_IDS)) {
    const logs = new Map(part.map((r) => [r.issue_id, []]));
    let token = null;
    do {
      const body = { issueIdsOrKeys: part.map((r) => r.issue_id), fieldIds: ['assignee', 'status'], maxResults: 1000 };
      if (token) body.nextPageToken = token;
      const data = await b.call('/rest/api/3/changelog/bulkfetch', { method: 'POST', body: JSON.stringify(body) });
      for (const log of data?.issueChangeLogs || data?.values || []) {
        const list = logs.get(String(log.issueId ?? log.id)) || [];
        for (const h of log.changeHistories || log.histories || []) for (const it of h.items || []) list.push({ at: h.created, field: it.fieldId || it.field, to: it.to, toString: it.toString });
        logs.set(String(log.issueId ?? log.id), list);
      }
      token = data?.nextPageToken || null;
    } while (token);
    const stmts = part.map((r) => {
      const list = (logs.get(r.issue_id) || []).sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
      const assigned = list.filter((e) => e.field === 'assignee' && e.to === r.assignee_id).pop();
      const status = list.filter((e) => e.field === 'status').pop();
      return env.DB.prepare('UPDATE capacity_items SET assigned_at = ?, status_at = ?, log_stamp = ? WHERE issue_id = ?')
        .bind(assigned?.at || r.created, status?.at || r.created, `${r.assignee_id}|${r.status}`, r.issue_id);
    });
    await env.DB.batch(stmts);
  }
}

export async function run(env, { force = false } = {}) {
  const last = Number((await getState(env, 'capacity_sync_at')) || 0);
  const behind = await env.DB.prepare("SELECT 1 AS n FROM capacity_items WHERE log_stamp IS NOT (assignee_id || '|' || status) LIMIT 1").first();
  if (!force && Date.now() - last < SYNC_EVERY_MS && !behind) return { idle: true };
  const b = budget(env, RUN_CALLS);
  const out = {};
  try {
    if (force || Date.now() - last >= SYNC_EVERY_MS) {
      const now = new Date().toISOString();
      const { issues, more } = await search(b, JQL, FIELDS, { pages: 25 });
      for (const part of chunk(issues.map((i) => itemStatement(env, i, now)), 50)) await env.DB.batch(part);
      // Anything not seen is done or no longer assigned. A search cut short leaves the rest alone.
      if (!more) await env.DB.prepare('DELETE FROM capacity_items WHERE seen_at < ?').bind(now).run();
      await setState(env, 'capacity_sync_at', String(Date.now()));
      out.items = issues.length;
    }
    const { results } = await env.DB.prepare(
      "SELECT issue_id, assignee_id, status, created FROM capacity_items WHERE log_stamp IS NOT (assignee_id || '|' || status) LIMIT 400"
    ).all();
    if (results.length) {
      try { await readHistories(env, b, results); } catch (err) {
        if (err instanceof OutOfCalls || ![400, 404, 405].includes(err.status)) throw err;
        // Without Jira's bulk history read, each item counts from when it was created.
        await env.DB.prepare("UPDATE capacity_items SET assigned_at = COALESCE(assigned_at, created), status_at = COALESCE(status_at, created), log_stamp = assignee_id || '|' || status WHERE log_stamp IS NOT (assignee_id || '|' || status)").run();
      }
    }
    out.histories = results.length;
    await setState(env, 'capacity_error', '');
  } catch (err) {
    if (!(err instanceof OutOfCalls)) { await setState(env, 'capacity_error', `${new Date().toISOString()} ${err.message}`); throw err; }
    out.partial = true;
  }
  out.calls = b.used;
  return out;
}

// ---------- what team leads see ----------

const refuse = (message, status = 403) => { const err = new Error(message); err.status = status; return err; };
export function canSee(viewer) {
  return Boolean(viewer?.isAdmin || viewer?.can?.oversight);
}
// Admin and management see every team; a team lead sees the teams they lead.
function teamsFor(viewer) {
  if (viewer.isAdmin || viewer.groups?.includes('management') || !viewer.scopeTeams) return TEAMS;
  return TEAMS.filter((t) => viewer.scopeTeams.includes(t));
}
const parse = (v, d) => { try { return JSON.parse(v || '') ?? d; } catch { return d; } };

function mondayOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * dayMs).toISOString().slice(0, 10);
}
function awayOn(away, day) {
  return (away || []).find((a) => day >= a.from && day <= (a.until || a.from)) || null;
}

export async function overview(env, viewer, { team = null } = {}) {
  if (!canSee(viewer)) throw refuse('Capacity is for team leads and management.');
  const teams = teamsFor(viewer);
  if (!teams.length) throw refuse('You don\'t lead a team.');
  const today = londonDate();
  const monday = mondayOf(today);
  const { results: emps } = await env.DB.prepare(
    `SELECT e.account_id, e.name, e.teams, e.team, c.hours_per_week, c.days, c.away FROM employees e
       LEFT JOIN mes_capacity c ON c.account_id = e.account_id WHERE e.active = 1 AND e.account_id NOT LIKE 'pending-%' ORDER BY e.name`
  ).all();
  const teamOf = (e) => { const t = parse(e.teams, []); return t.length ? t : e.team ? [e.team] : []; };
  const people = emps.map((e) => ({ ...e, teamList: teamOf(e).filter((t) => TEAMS.includes(t)) }))
    .filter((e) => e.teamList.some((t) => teams.includes(t)));
  const ids = people.map((p) => p.account_id);

  const items = [];
  for (const part of chunk(ids, IN)) {
    items.push(...(await env.DB.prepare(`SELECT * FROM capacity_items WHERE assignee_id IN (${marks(part.length)})`).bind(...part).all()).results);
  }
  // Time logged this week, over the last four weeks, and on what, in the last fortnight.
  const since = new Date(Date.parse(`${today}T12:00:00Z`) - 27 * dayMs).toISOString().slice(0, 10);
  const recentSince = new Date(Date.parse(`${today}T12:00:00Z`) - 13 * dayMs).toISOString().slice(0, 10);
  const logs = [];
  for (const part of chunk(ids, IN - 2)) {
    logs.push(...(await env.DB.prepare(
      `SELECT l.account_id, l.issue_id, l.work_date, l.seconds, j.issue_key, j.summary FROM xp_ledger l LEFT JOIN jobs j ON j.issue_id = l.issue_id
        WHERE l.account_id IN (${marks(part.length)}) AND l.work_date >= ? AND l.work_date <= ?`
    ).bind(...part, since, today).all()).results);
  }
  const pscIds = new Set();
  const waiting = new Map();
  {
    const { results } = await env.DB.prepare('SELECT issue_id, team_last_at, customer_last_at FROM psc_items WHERE done = 0').all();
    for (const r of results) {
      pscIds.add(r.issue_id);
      if (r.customer_last_at && (!r.team_last_at || r.customer_last_at > r.team_last_at)) waiting.set(r.issue_id, r.customer_last_at);
    }
  }
  let customers = new Set();
  try { customers = new Set((await customerProjects(env)).map((p) => p.key.toUpperCase())); } catch { /* by project names below */ }
  const kindOf = (i) => {
    if (i.project_key === 'PSC' || pscIds.has(i.issue_id)) return 'psc';
    if (i.project_key === 'MES') return 'condor';
    if (INTERNAL.includes(i.project_key)) return 'internal';
    return customers.size && !customers.has(i.project_key) ? 'internal' : 'job';
  };

  const byPerson = new Map(people.map((p) => [p.account_id, { items: [], logs: [] }]));
  for (const i of items) byPerson.get(i.assignee_id)?.items.push(i);
  for (const l of logs) byPerson.get(l.account_id)?.logs.push(l);

  const out = people.map((p) => {
    const mine = byPerson.get(p.account_id);
    const hours = p.hours_per_week ?? DEFAULT_HOURS;
    const away = parse(p.away, []);
    const awayNow = awayOn(away, today);
    const nextAway = away.filter((a) => a.from > today).sort((a, b) => a.from.localeCompare(b.from))[0] || null;
    const week = mine.logs.filter((l) => l.work_date >= monday).reduce((t, l) => t + l.seconds, 0);
    const fourWeeks = mine.logs.reduce((t, l) => t + l.seconds, 0) / 4;
    // What they're on: the items with the latest time logged, and assigned items changed lately.
    const touched = new Map();
    for (const l of mine.logs.filter((x) => x.work_date >= recentSince)) {
      const t = touched.get(l.issue_id) || { id: l.issue_id, key: l.issue_key, summary: l.summary, seconds: 0, last: l.work_date, logged: true };
      t.seconds += l.seconds; if (l.work_date > t.last) t.last = l.work_date;
      touched.set(l.issue_id, t);
    }
    const lastLog = new Map([...touched.values()].map((t) => [t.id, t.last]));
    for (const i of mine.items) {
      const upd = dateOnly(i.updated);
      if (!upd || upd < recentSince) continue;
      const t = touched.get(i.issue_id);
      if (t) { if (upd > t.last) t.last = upd; t.status = i.status; t.statusCat = i.status_cat; }
      else touched.set(i.issue_id, { id: i.issue_id, key: i.issue_key, summary: i.summary, seconds: 0, last: upd, logged: false, status: i.status, statusCat: i.status_cat });
    }
    const active = [...touched.values()].filter((t) => t.key).sort((a, b) => b.last.localeCompare(a.last) || b.seconds - a.seconds).slice(0, 5);
    const list = mine.items.map((i) => {
      const lastActivity = [dateOnly(i.updated), lastLog.get(i.issue_id)].filter(Boolean).sort().pop() || null;
      const assignedDays = daysSince(i.assigned_at || i.created, today);
      const statusDays = daysSince(i.status_at || i.created, today);
      const quietDays = daysSince(lastActivity, today);
      const kind = kindOf(i);
      return {
        id: i.issue_id, key: i.issue_key, summary: i.summary, type: i.issuetype, kind, status: i.status, statusCat: i.status_cat, priority: i.priority,
        parentKey: i.parent_key, parentSummary: i.parent_summary, assignedAt: dateOnly(i.assigned_at || i.created), assignedDays, statusDays,
        lastActivity, quietDays, due: i.due, overdue: Boolean(i.due && i.due < today), estimateLeft: i.estimate_left,
        quiet: assignedDays >= QUIET_DAYS && quietDays !== null && quietDays >= QUIET_DAYS && !/hold|waiting|blocked/i.test(i.status || ''),
        stuck: statusDays >= STUCK_DAYS && !/hold|waiting|backlog|to do|open/i.test(i.status || ''),
        customerWaiting: waiting.has(i.issue_id) ? dateOnly(waiting.get(i.issue_id)) : null,
      };
    }).sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || '') || a.assignedDays - b.assignedDays);
    const count = (k) => list.filter((x) => x.kind === k).length;
    return {
      id: p.account_id, name: p.name, teams: p.teamList, hoursPerWeek: hours,
      away: awayNow, nextAway,
      counts: { job: count('job'), psc: count('psc'), condor: count('condor'), internal: count('internal'), total: list.length },
      flags: { quiet: list.filter((x) => x.quiet).length, overdue: list.filter((x) => x.overdue).length, stuck: list.filter((x) => x.stuck).length,
        waiting: list.filter((x) => x.customerWaiting).length },
      estimateLeft: list.reduce((t, x) => t + (x.estimateLeft || 0), 0),
      week, weekTarget: hours * 3600, fourWeekAverage: Math.round(fourWeeks), active, items: list,
    };
  });
  // Unassigned support requests, the first thing a lead hands out.
  const { results: unassigned } = await env.DB.prepare(
    `SELECT issue_key, summary, org, status, priority, created_at FROM psc_items WHERE done = 0 AND assignee_id IS NULL ORDER BY created_at LIMIT 50`
  ).all();
  const syncedAt = Number((await getState(env, 'capacity_sync_at')) || 0);
  return {
    teams, team: team && teams.includes(team) ? team : null, today, monday, people: out,
    unassigned: unassigned.map((u) => ({ key: u.issue_key, summary: u.summary, org: u.org, status: u.status, priority: u.priority, days: daysSince(u.created_at, today) })),
    syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null, error: (await getState(env, 'capacity_error')) || null,
    rules: { quietDays: QUIET_DAYS, stuckDays: STUCK_DAYS },
  };
}
