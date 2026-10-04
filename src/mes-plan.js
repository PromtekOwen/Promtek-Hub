// Release planning for Condor development. Each person's working days are filled
// in priority order, keeping a reserve free for emergencies; when Musts or
// Shoulds no longer fit, the least important work is suggested for the next release.
import { jira } from './jira.js';
import { getState, setState, londonDate } from './sync.js';
import { versions, syncPlan, canTriage } from './mes.js';
import { ensureRelease, knownSprints, sprintFor, placeTickets } from './mes-sprints.js';

const PRIORITY_ORDER = { Must: 0, Should: 1, Could: 2 };
const DEFAULT_RESERVE = 0.2;
const DEFAULT_HOURS = 37.5;
const OVERRUN_ALLOWANCE = 0.2;     // a ticket past its estimate keeps a fifth of it, at least an hour
const MAX_MOVES = 10;
const JIRA_WRITES_INLINE = 30;     // the rest carry on in the background, inside each run's limits

const dayMs = 86_400_000;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const weekday = (d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };

function personDay(p, date) {
  if (!p.days.includes(String(weekday(date)))) return 0;
  if ((p.away || []).some((a) => date >= a.from && date <= (a.until || a.from))) return 0;
  return p.hoursPerWeek / p.days.length;
}

function remainingOf(t) {
  if (t.estimateHours == null) return null;
  const left = t.estimateHours - (t.loggedHours || 0);
  if (left > 0.25) return { hours: left, overrun: false };
  return { hours: Math.max(1, t.estimateHours * OVERRUN_ALLOWANCE), overrun: true };
}

// The plan itself, with no Jira or database in it, so it can be checked by hand.
export function plan({ start, release, today, reserve = DEFAULT_RESERVE, people, tickets }) {
  const from = start && start > today ? start : today;
  const usable = 1 - reserve;
  const horizon = addDays(release, 365);
  const cursor = new Map(people.map((p) => [p.id, { date: from, used: 0 }]));

  // Lays hours onto a person's working days from where they're up to.
  const place = (p, hours, commit) => {
    let { date, used } = cursor.get(p.id);
    let left = hours, startDate = null, due = null;
    while (left > 1e-9 && date <= horizon) {
      const room = personDay(p, date) * usable - used;
      if (room > 1e-9) {
        if (!startDate) startDate = date;
        const take = Math.min(room, left);
        left -= take; used += take; due = date;
        if (left > 1e-9) { date = addDays(date, 1); used = 0; }
      } else { date = addDays(date, 1); used = 0; }
    }
    if (commit) cursor.set(p.id, { date, used });
    return { start: startDate, due, ok: left <= 1e-9 };
  };

  const ordered = [...tickets].sort((a, b) =>
    (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3)
    || (b.statusCategory === 'indeterminate') - (a.statusCategory === 'indeterminate')
    || Boolean(b.assigneeId) - Boolean(a.assigneeId)
    || String(a.created || '').localeCompare(String(b.created || '')));

  const schedule = [], needsEstimate = [];
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const t of ordered) {
    const rem = remainingOf(t);
    if (!rem) { needsEstimate.push(t); continue; }
    const assigned = t.assigneeId && byId.get(t.assigneeId);
    const candidates = assigned ? [assigned] : people;
    let best = null;
    for (const p of candidates) {
      const trial = place(p, rem.hours, false);
      if (!trial.ok) continue;
      if (!best || trial.due < best.trial.due) best = { p, trial };
    }
    if (!best) { schedule.push({ ...t, hours: rem.hours, overrun: rem.overrun, personId: assigned?.id || null, start: null, due: null, fits: false, why: assigned ? 'Their time is full' : 'Nobody has time' }); continue; }
    const placed = place(best.p, rem.hours, true);
    schedule.push({ ...t, hours: rem.hours, overrun: rem.overrun, personId: best.p.id, start: placed.start, due: placed.due, fits: placed.due <= release,
      plannedAssignee: !t.assigneeId });
  }

  let capacity = 0;
  for (const p of people) for (let d = from; d <= release; d = addDays(d, 1)) capacity += personDay(p, d);
  const planned = schedule.filter((s) => s.fits).reduce((a, s) => a + s.hours, 0);
  return { from, release, reserve, schedule, needsEstimate, capacity, usable: capacity * usable, planned };
}

// Takes out the least important work, one ticket at a time, keeping a move only
// if it lets more of the Musts and Shoulds fit; a move that doesn't help isn't suggested.
// How late the Musts and Shoulds would finish, in hours times days past the release.
const lateness = (r, below) => r.schedule.filter((s) => !s.fits && PRIORITY_ORDER[s.priority] < below)
  .reduce((a, s) => a + s.hours * (s.due ? Math.max(1, (Date.parse(s.due) - Date.parse(r.release)) / dayMs) : 365), 0);

export function suggest(input, { declined = new Set() } = {}) {
  const moved = [];
  const tried = new Set(declined);
  let tickets = input.tickets;
  let result = plan(input);
  for (let i = 0; i < MAX_MOVES * 3 && moved.length < MAX_MOVES; i++) {
    const blocked = result.schedule.filter((s) => !s.fits && s.priority !== 'Could');
    if (!blocked.length) break;
    const worst = Math.min(...blocked.map((b) => PRIORITY_ORDER[b.priority]));
    const candidate = result.schedule
      .filter((s) => s.fits && PRIORITY_ORDER[s.priority] > worst && !tried.has(s.id) && s.statusCategory !== 'indeterminate')
      .sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority] || b.due.localeCompare(a.due))[0];
    if (!candidate) break;
    tried.add(candidate.id);
    const without = tickets.filter((t) => t.id !== candidate.id);
    const trial = plan({ ...input, tickets: without });
    // Only worth it if more important work finishes sooner; a Should never makes way for another Should.
    const rank = PRIORITY_ORDER[candidate.priority];
    if (lateness(trial, rank) >= lateness(result, rank) - 1e-9) continue;
    const above = blocked.filter((b) => PRIORITY_ORDER[b.priority] < rank);
    const helped = above.filter((b) => trial.schedule.find((x) => x.id === b.id)?.fits).map((b) => b.key);
    moved.push({ ...candidate, reason: `to make room for ${(helped.length ? helped : above.map((b) => b.key)).slice(0, 3).join(', ')}` });
    tickets = without;
    result = trial;
  }
  const stillOut = result.schedule.filter((s) => !s.fits);
  const suggestions = [
    ...moved,
    ...stillOut.filter((s) => s.priority === 'Could' && !declined.has(s.id)).map((s) => ({ ...s, reason: "it won't fit before the release" })),
  ];
  return { result, suggestions, stillOut: stillOut.filter((s) => s.priority !== 'Could') };
}

// ---------- Data ----------

async function people(env) {
  const { results } = await env.DB.prepare(
    `SELECT e.account_id, e.name, c.hours_per_week, c.days, c.away, c.included FROM employees e
       LEFT JOIN mes_capacity c ON c.account_id = e.account_id WHERE e.active = 1 AND (e.teams LIKE '%"Condor"%' OR (e.teams IS NULL AND e.team = 'Condor')) ORDER BY e.name`
  ).all();
  return results.map((r) => ({ id: r.account_id, name: r.name, hoursPerWeek: r.hours_per_week ?? DEFAULT_HOURS, days: r.days || '12345',
    away: JSON.parse(r.away || '[]'), included: r.included == null ? true : Boolean(r.included) }));
}

async function releaseTickets(env, versionId) {
  const { results } = await env.DB.prepare(
    `SELECT t.issue_id AS id, t.issue_key AS key, t.summary, t.type, t.module, t.status, t.status_category AS statusCategory,
            t.assignee_id AS assigneeId, t.created, t.actual_seconds, e.hours AS estimateHours, e.timebox, p.priority
       FROM mes_plan p JOIN mes_tickets t ON t.issue_id = p.issue_id LEFT JOIN mes_estimates e ON e.issue_id = t.issue_id
      WHERE p.version_id = ? AND t.done = 0`
  ).bind(versionId).all();
  return results.map((r) => ({ ...r, loggedHours: (r.actual_seconds || 0) / 3600 }));
}

export async function reserveOf(env) {
  const raw = await getState(env, 'mes_reserve');
  const v = Number(raw);
  return raw !== null && raw !== '' && v >= 0 && v <= 0.5 ? v : DEFAULT_RESERVE;
}

export async function view(env, viewer, versionId) {
  const vs = await versions(env);
  const version = vs.find((v) => v.id === String(versionId)) || vs[0];
  const team = await people(env);
  if (!version) return { versions: vs, version: null, people: team, canPlan: canTriage(viewer) };
  const today = londonDate();
  const reserve = await reserveOf(env);
  const tickets = await releaseTickets(env, version.id);
  const { results: dec } = await env.DB.prepare("SELECT issue_id FROM mes_suggestion_decisions WHERE version_id = ? AND decision = 'declined'").bind(version.id).all();
  const included = team.filter((p) => p.included);
  const release = version.releaseDate || addDays(today, 90);
  const input = { start: version.startDate, release, today, reserve, people: included, tickets };
  const current = plan(input);
  const { suggestions, stillOut } = suggest(input, { declined: new Set(dec.map((d) => d.issue_id)) });
  const next = vs[vs.indexOf(version) + 1] || null;
  const accepted = await env.DB.prepare(
    'SELECT COUNT(*) AS n, MAX(accepted_at) AS at, SUM(CASE WHEN jira_synced = 0 THEN 1 ELSE 0 END) AS waiting FROM mes_schedule WHERE version_id = ?'
  ).bind(version.id).first();
  const names = new Map(team.map((p) => [p.id, p.name]));
  const sprintInfo = await knownSprints(env, version.id);
  const sprints = sprintInfo?.sprints || [];
  for (const s of current.schedule) s.sprint = s.fits && s.start && sprints.length ? sprintFor(sprints, s.start)?.name || null : null;
  const mine = viewer.accountId;
  const canPlan = canTriage(viewer);
  const visible = (s) => canPlan || s.personId === mine;
  return {
    versions: vs, version: { ...version, releaseDate: release, assumedDate: !version.releaseDate }, next, reserve, canPlan,
    people: canPlan ? team : [], names: Object.fromEntries(names),
    capacity: current.capacity, usable: current.usable, planned: current.planned,
    schedule: current.schedule.filter(visible), needsEstimate: canPlan ? current.needsEstimate : [],
    suggestions: canPlan ? suggestions : [], stillOut: canPlan ? stillOut : [],
    accepted: { count: accepted?.n || 0, at: accepted?.at || null, waiting: accepted?.waiting || 0 },
    sprints,
    noRelease: !version.releaseDate,
  };
}

// ---------- Changes ----------

const DAYS = /^[1-7]{1,7}$/;
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

export async function saveCapacity(env, viewer, input) {
  if (!canTriage(viewer)) throw new Error('A Condor lead, management or an admin sets capacity.');
  const hours = Number(input.hoursPerWeek);
  if (!(hours >= 0 && hours <= 60)) throw new Error('Hours a week need to be between 0 and 60.');
  const days = [...new Set(String(input.days || '').split(''))].filter((d) => '12345'.includes(d)).sort().join('');
  if (hours > 0 && !DAYS.test(days)) throw new Error('Choose at least one day.');
  const away = (input.away || []).filter((a) => isDate(a.from) && (!a.until || (isDate(a.until) && a.until >= a.from)))
    .map((a) => ({ from: a.from, until: a.until || a.from, note: String(a.note || '').slice(0, 60) })).slice(0, 50);
  await env.DB.prepare(
    `INSERT INTO mes_capacity (account_id, hours_per_week, days, away, included, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET hours_per_week = excluded.hours_per_week, days = excluded.days, away = excluded.away,
       included = excluded.included, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(String(input.accountId), hours, days || '12345', JSON.stringify(away), input.included === false ? 0 : 1, viewer.email, new Date().toISOString()).run();
  return { ok: true };
}

export async function saveReserve(env, viewer, percent) {
  if (!canTriage(viewer)) throw new Error('A Condor lead, management or an admin sets the reserve.');
  const p = Number(percent);
  if (!(p >= 0 && p <= 50)) throw new Error('Keep between 0% and 50% free.');
  await setState(env, 'mes_reserve', String(p / 100));
  return { ok: true };
}

export async function decide(env, viewer, { issueId, versionId, decision }) {
  if (!canTriage(viewer)) throw new Error('A Condor lead, management or an admin decides this.');
  const vs = await versions(env);
  const i = vs.findIndex((v) => v.id === String(versionId));
  if (i < 0) throw new Error('That release is no longer open in Jira.');
  const now = new Date().toISOString();
  if (decision === 'accept') {
    const next = vs[i + 1] || null;
    await env.DB.prepare(
      'UPDATE mes_plan SET version_id = ?, version_name = ?, triaged_by = ?, triaged_at = ?, jira_synced = 0, jira_error = NULL WHERE issue_id = ?'
    ).bind(next?.id || null, next?.name || null, viewer.email, now, String(issueId)).run();
    await env.DB.prepare('DELETE FROM mes_schedule WHERE issue_id = ?').bind(String(issueId)).run();
  }
  await env.DB.prepare(
    `INSERT INTO mes_suggestion_decisions (issue_id, version_id, decision, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(issue_id, version_id) DO UPDATE SET decision = excluded.decision, decided_by = excluded.decided_by, decided_at = excluded.decided_at`
  ).bind(String(issueId), String(versionId), decision === 'accept' ? 'accepted' : 'declined', viewer.email, now).run();
  const synced = decision === 'accept' ? await syncPlan(env, String(issueId)) : true;
  return { ok: true, jiraSynced: synced };
}

// Jira's timeline uses a "Start date" field whose ID differs between sites, so
// it is looked up by name rather than assumed.
async function startDateField(env) {
  const cached = await getState(env, 'jira_start_field');
  if (cached && cached !== 'none') return cached;
  const fields = await jira(env, '/rest/api/3/field');
  const f = (fields || []).find((x) => x.custom && String(x.name).toLowerCase() === 'start date');
  await setState(env, 'jira_start_field', f?.id || 'none');
  return f?.id || null;
}

export async function accept(env, viewer, versionId) {
  if (!canTriage(viewer)) throw new Error('A Condor lead, management or an admin accepts the plan.');
  const v = await view(env, viewer, versionId);
  if (!v.version) throw new Error('There is no open release to plan.');
  const now = new Date().toISOString();
  const rows = v.schedule.filter((s) => s.fits);
  const stmts = [env.DB.prepare('DELETE FROM mes_schedule WHERE version_id = ?').bind(v.version.id)];
  for (const s of rows) {
    stmts.push(env.DB.prepare(
      `INSERT INTO mes_schedule (issue_id, issue_key, version_id, account_id, start_date, due_date, hours, set_assignee, accepted_by, accepted_at, jira_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(issue_id) DO UPDATE SET version_id = excluded.version_id, account_id = excluded.account_id, start_date = excluded.start_date,
         due_date = excluded.due_date, hours = excluded.hours, set_assignee = excluded.set_assignee, accepted_by = excluded.accepted_by,
         accepted_at = excluded.accepted_at, jira_synced = 0, jira_error = NULL`
    ).bind(s.id, s.key, v.version.id, s.personId, s.start, s.due, s.hours, s.plannedAssignee ? 1 : 0, viewer.email, now));
  }
  await env.DB.batch(stmts);
  // Sprint moves come first; dates beyond what fits in this request carry on in the background.
  let placed = null;
  if (v.sprints.length) {
    try { placed = await placeTickets(env, v.version.id, v.schedule); } catch (err) { placed = { error: err.message }; }
  }
  const synced = await syncSchedule(env, { max: v.sprints.length ? 15 : JIRA_WRITES_INLINE });
  return { ok: true, planned: rows.length, written: synced.written, waiting: synced.waiting, startField: synced.startField, sprints: placed };
}

// Turns a triaged release into its board and three sprints, then places the tickets.
export async function makeSprints(env, viewer, versionId) {
  if (!canTriage(viewer)) throw new Error('A Condor lead, management or an admin makes the sprints.');
  const made = await ensureRelease(env, viewer, versionId);
  const v = await view(env, viewer, versionId);
  const placed = await placeTickets(env, versionId, v.schedule);
  return { board: made.board, sprints: placed.sprints || made.sprints, moved: placed.moved,
    notPlaced: v.schedule.filter((s) => !s.fits).length, needsEstimate: v.needsEstimate.length };
}

// Start date, due date and, where nobody was assigned, the planned person.
export async function syncSchedule(env, { max = 20 } = {}) {
  const { results } = await env.DB.prepare('SELECT * FROM mes_schedule WHERE jira_synced = 0 ORDER BY start_date LIMIT ?').bind(max).all();
  if (!results.length) return { written: 0, waiting: 0, idle: true };
  const startField = await startDateField(env).catch(() => null);
  let written = 0;
  for (const r of results) {
    const fields = { duedate: r.due_date };
    if (startField) fields[startField] = r.start_date;
    if (r.set_assignee && r.account_id) fields.assignee = { accountId: r.account_id };
    try {
      await jira(env, `/rest/api/3/issue/${encodeURIComponent(r.issue_key)}`, { method: 'PUT', body: JSON.stringify({ fields }) });
      await env.DB.prepare('UPDATE mes_schedule SET jira_synced = 1, jira_error = NULL WHERE issue_id = ?').bind(r.issue_id).run();
      written++;
    } catch (err) {
      await env.DB.prepare('UPDATE mes_schedule SET jira_error = ? WHERE issue_id = ?').bind(err.message.slice(0, 300), r.issue_id).run();
    }
  }
  const waiting = (await env.DB.prepare('SELECT COUNT(*) AS n FROM mes_schedule WHERE jira_synced = 0').first()).n;
  return { written, waiting, startField: Boolean(startField) };
}
