// Condor development (the MES project): estimating by comparison with finished
// tickets, release triage, and a Condor development rating kept apart from
// customer ELO, since internal tickets are on a different scale.
import { searchJql, getIssue, jira } from './jira.js';
import { fetchIssueWorklogs } from './tempo.js';
import { getState, setState, londonDate, raiseAlert, recalcIssues } from './sync.js';
import { outcomeScore, expectedScore, matchWeight, K_FACTOR, PROVISIONAL_K, PROVISIONAL_MATCHES } from './elo.js';
import { approvedFor, factorOn } from './modifiers.js';
import { DEFAULT_ELO } from './progression.js';

const PROJECT = 'MES';
const MODULE_FIELD = 'customfield_15583';
const FIELDS = ['summary', 'issuetype', 'status', 'statuscategorychangedate', 'resolutiondate', 'aggregatetimespent', 'parent', 'created', 'updated', MODULE_FIELD];
const SCAN_BATCH = 50;
const SETTLE_DAYS = 3;
const MAX_QUESTIONS = 3;
const MIN_REF_SECONDS = 15 * 60;
export const PRIORITIES = ['Must', 'Should', 'Could'];
export const TAGS = ['Database change', 'Needs investigation', 'Customer testing needed', 'UI only', 'Touches several modules'];
export const DIFFICULTY_HINTS = {
  1: 'A small change in familiar code',
  2: 'Routine work in a module the team knows',
  3: 'A typical feature or fix with some thinking in it',
  4: 'Tricky: unfamiliar code, several parts, or careful testing',
  5: 'New ground: design decisions, unknowns, or risk of breaking things',
};

const round25 = (h) => Math.max(0.25, Math.round(h * 4) / 4);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const ticketElo = (difficulty) => (difficulty == null ? null : 750 + 250 * Number(difficulty));

export function moduleOf(issue) {
  const v = issue.fields?.[MODULE_FIELD];
  if (Array.isArray(v)) return v.map((x) => x?.value ?? x).filter(Boolean).join(', ') || null;
  if (v && typeof v === 'object') return v.value ?? null;
  return v || null;
}

const doneDateOf = (f) => (f.statuscategorychangedate || f.resolutiondate || f.updated || '').slice(0, 10) || null;

// ---------- Keeping a local copy of MES ----------

function ticketRow(issue) {
  const f = issue.fields || {};
  const done = f.status?.statusCategory?.key === 'done';
  return [String(issue.id), issue.key, f.summary || '', f.issuetype?.name || null, moduleOf(issue), f.status?.name || null,
    done ? 1 : 0, done ? doneDateOf(f) : null, f.aggregatetimespent || 0, f.parent?.id ? String(f.parent.id) : null,
    (f.created || '').slice(0, 10) || null, new Date().toISOString()];
}

async function saveTickets(env, issues) {
  for (const issue of issues) {
    await env.DB.prepare(
      `INSERT INTO mes_tickets (issue_id, issue_key, summary, type, module, status, done, done_date, actual_seconds, parent_id, created, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, summary = excluded.summary, type = excluded.type,
         module = excluded.module, status = excluded.status, done = excluded.done, done_date = excluded.done_date,
         actual_seconds = excluded.actual_seconds, parent_id = excluded.parent_id, updated_at = excluded.updated_at`
    ).bind(...ticketRow(issue)).run();
  }
}

// Works forwards through MES by last update, two years back on the first run.
export async function scan(env) {
  let cursor = await getState(env, 'mes_cursor');
  if (!cursor) cursor = `${londonDate(Date.now() - 730 * 86_400_000).replace(/-/g, '/')} 00:00`;
  const issues = await searchJql(env, `project = ${PROJECT} AND issuetype not in subTaskIssueTypes() AND updated >= "${cursor}" ORDER BY updated ASC`,
    FIELDS, { limit: SCAN_BATCH });
  await saveTickets(env, issues);
  let next = cursor;
  if (issues.length) {
    next = String(issues[issues.length - 1].fields?.updated || '').slice(0, 16).replace('T', ' ').replace(/-/g, '/') || cursor;
    if (issues.length >= SCAN_BATCH && next <= cursor) {
      const t = Date.parse(`${cursor.replace(/\//g, '-').replace(' ', 'T')}:00Z`) + 60_000;
      next = new Date(t).toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '/');
    }
  }
  await setState(env, 'mes_cursor', next);
  return { read: issues.length, cursor: next };
}

// ---------- Estimating by comparison ----------

// Finished tickets with real time on them, as alike as there are enough of.
export async function referencePool(env, ticket) {
  const { results } = await env.DB.prepare(
    `SELECT issue_id, issue_key, summary, type, module, actual_seconds FROM mes_tickets
      WHERE done = 1 AND actual_seconds >= ? AND issue_id != ? AND type != 'Epic'`
  ).bind(MIN_REF_SECONDS, String(ticket.issue_id)).all();
  const tiers = [
    (r) => r.module && r.module === ticket.module && r.type === ticket.type,
    (r) => r.module && r.module === ticket.module,
    (r) => r.type === ticket.type,
    () => true,
  ];
  for (const keep of tiers) {
    const pool = results.filter(keep);
    if (pool.length >= 5 || keep === tiers[3]) return pool.map((r) => ({ ...r, hours: r.actual_seconds / 3600 })).sort((a, b) => a.hours - b.hours);
  }
  return [];
}

// Each answer narrows the range; the next question is about the middle of what's left.
export function compare(pool, answers) {
  let low = 0, high = Infinity, same = null;
  for (const a of answers) {
    const ref = pool.find((r) => r.issue_id === String(a.refId));
    if (!ref) continue;
    if (a.answer === 'smaller') high = Math.min(high, ref.hours);
    else if (a.answer === 'bigger') low = Math.max(low, ref.hours);
    else if (a.answer === 'same') same = ref;
  }
  const asked = new Set(answers.map((a) => String(a.refId)));
  const left = pool.filter((r) => r.hours > low && r.hours < high && !asked.has(r.issue_id));
  if (!same && answers.length < MAX_QUESTIONS && left.length) return { next: left[Math.floor(left.length / 2)] };
  if (!pool.length) return { estimate: null };
  let hours, lo, hi;
  if (same) { hours = same.hours; lo = hours * 0.75; hi = hours * 1.33; }
  else {
    lo = low || pool[0].hours / 2;
    hi = high === Infinity ? pool[pool.length - 1].hours * 1.5 : high;
    hours = Math.sqrt(lo * hi);
  }
  return { estimate: { hours: round25(hours), low: round25(lo), high: round25(hi) } };
}

async function ticketFor(env, issueIdOrKey) {
  let t = await env.DB.prepare('SELECT * FROM mes_tickets WHERE issue_id = ? OR issue_key = ?').bind(String(issueIdOrKey), String(issueIdOrKey).toUpperCase()).first();
  if (!t) {
    const issue = await getIssue(env, issueIdOrKey, FIELDS);
    if (!issue || !String(issue.key).startsWith(`${PROJECT}-`)) throw new Error('That ticket could not be found in MES.');
    await saveTickets(env, [issue]);
    t = await env.DB.prepare('SELECT * FROM mes_tickets WHERE issue_id = ?').bind(String(issue.id)).first();
  }
  return t;
}

export async function nextQuestion(env, { issueId, answers = [] }) {
  const ticket = await ticketFor(env, issueId);
  const pool = await referencePool(env, ticket);
  const r = compare(pool, answers);
  const ref = r.next && { id: r.next.issue_id, key: r.next.issue_key, summary: r.next.summary, type: r.next.type, module: r.next.module, hours: r.next.hours };
  return { ticket, poolSize: pool.length, next: ref || null, estimate: r.estimate || null, asked: answers.length, maxQuestions: MAX_QUESTIONS };
}

const canEstimate = (viewer) => viewer.isAdmin || viewer.team === 'Condor';
const canTriage = (viewer) => viewer.isAdmin || (viewer.role === 'lead' && viewer.team === 'Condor');

export async function saveEstimate(env, viewer, input) {
  if (!canEstimate(viewer)) throw new Error('Only the Condor team can estimate MES tickets.');
  const ticket = await ticketFor(env, input.issueId);
  const difficulty = Number(input.difficulty);
  if (!(difficulty >= 1 && difficulty <= 5)) throw new Error('Choose how hard it is, from 1 to 5.');
  const tags = (input.tags || []).filter((t) => TAGS.includes(t));
  let result, method, timebox = 0;
  if (input.method === 'timebox') {
    const h = Number(input.timeboxHours);
    if (!(h > 0 && h <= 40)) throw new Error('Give the time to spend finding the cause, in hours.');
    result = { hours: round25(h), low: null, high: null };
    method = 'timebox'; timebox = 1;
  } else if (input.method === 'three-point') {
    const [b, l, w] = ['best', 'likely', 'worst'].map((k) => Number(input[k]));
    if (!(l > 0)) throw new Error('Give at least the likely hours.');
    const pert = b > 0 && w > 0 ? (b + 4 * l + w) / 6 : l;
    result = { hours: round25(pert), low: b > 0 ? b : null, high: w > 0 ? w : null };
    method = 'three-point';
  } else {
    const pool = await referencePool(env, ticket);
    const r = compare(pool, input.answers || []);
    if (!r.estimate) throw new Error('Answer the comparisons first.');
    result = r.estimate;
    method = 'compare';
  }
  const elo = ticketElo(difficulty);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mes_estimates (issue_id, issue_key, hours, low, high, difficulty, ticket_elo, method, timebox, comparisons, tags, estimated_by, jira_synced, jira_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
       ON CONFLICT(issue_id) DO UPDATE SET hours = excluded.hours, low = excluded.low, high = excluded.high, difficulty = excluded.difficulty,
         ticket_elo = excluded.ticket_elo, method = excluded.method, timebox = excluded.timebox, comparisons = excluded.comparisons,
         tags = excluded.tags, estimated_by = excluded.estimated_by, jira_synced = 0, jira_error = NULL, updated_at = excluded.updated_at`
    ).bind(ticket.issue_id, ticket.issue_key, result.hours, result.low, result.high, difficulty, elo, method, timebox,
      JSON.stringify(input.answers || []), JSON.stringify(tags), viewer.accountId || viewer.email, now),
    env.DB.prepare('INSERT INTO mes_estimate_log (issue_id, hours, difficulty, method, timebox, estimated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(ticket.issue_id, result.hours, difficulty, method, timebox, viewer.accountId || viewer.email, now),
  ]);
  // The ticket was always this hard, so XP already logged on it is recalculated.
  const { results: children } = await env.DB.prepare('SELECT issue_id FROM jobs WHERE parent_id = ?').bind(ticket.issue_id).all();
  await recalcIssues(env, [ticket.issue_id, ...children.map((c) => c.issue_id)]).catch(() => {});
  const jiraSynced = await syncEstimate(env, ticket.issue_id);
  return { ok: true, ...result, ticketElo: elo, jiraSynced };
}

// Original Estimate in Jira mirrors the hub, for the timeline.
async function syncEstimate(env, issueId) {
  const e = await env.DB.prepare('SELECT * FROM mes_estimates WHERE issue_id = ?').bind(issueId).first();
  if (!e || e.jira_synced) return true;
  try {
    await jira(env, `/rest/api/3/issue/${encodeURIComponent(e.issue_key)}`, {
      method: 'PUT', body: JSON.stringify({ fields: { timetracking: { originalEstimate: `${e.hours}h` } } }),
    });
    await env.DB.prepare('UPDATE mes_estimates SET jira_synced = 1, jira_error = NULL WHERE issue_id = ?').bind(issueId).run();
    return true;
  } catch (err) {
    await env.DB.prepare('UPDATE mes_estimates SET jira_error = ? WHERE issue_id = ?').bind(err.message.slice(0, 300), issueId).run();
    return false;
  }
}

// ---------- Lists and triage ----------

async function versions(env) {
  const list = await jira(env, `/rest/api/3/project/${PROJECT}/versions`);
  return (list || []).filter((v) => !v.released && !v.archived)
    .map((v) => ({ id: String(v.id), name: v.name, startDate: v.startDate || null, releaseDate: v.releaseDate || null }))
    .sort((a, b) => (a.releaseDate || '9999').localeCompare(b.releaseDate || '9999'));
}

export async function outstanding(env, viewer, { filter = 'untriaged', query = '' } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT t.*, e.hours, e.low, e.high, e.difficulty, e.timebox, e.method, p.version_id, p.version_name, p.priority
       FROM mes_tickets t LEFT JOIN mes_estimates e ON e.issue_id = t.issue_id LEFT JOIN mes_plan p ON p.issue_id = t.issue_id
      WHERE t.done = 0 AND t.type != 'Epic' ORDER BY t.created DESC LIMIT 1000`
  ).all();
  const q = query.trim().toLowerCase();
  const rows = results.filter((r) => {
    if (q && !`${r.issue_key} ${r.summary} ${r.module || ''}`.toLowerCase().includes(q)) return false;
    if (filter === 'untriaged') return !r.priority;
    if (filter === 'unestimated') return r.hours == null;
    return true;
  });
  return {
    tickets: rows.slice(0, 200), total: rows.length, versions: await versions(env).catch(() => []),
    canTriage: canTriage(viewer), canEstimate: canEstimate(viewer), priorities: PRIORITIES, tags: TAGS, hints: DIFFICULTY_HINTS,
  };
}

export async function triage(env, viewer, input) {
  if (!canTriage(viewer)) throw new Error('Kieran, Simon or an admin decides what goes in a release.');
  const ticket = await ticketFor(env, input.issueId);
  const priority = input.versionId ? (PRIORITIES.includes(input.priority) ? input.priority : null) : 'Not this time';
  if (input.versionId && !priority) throw new Error('Choose Must, Should or Could.');
  const vs = await versions(env);
  const version = input.versionId ? vs.find((v) => v.id === String(input.versionId)) : null;
  if (input.versionId && !version) throw new Error('That release is no longer open in Jira.');
  await env.DB.prepare(
    `INSERT INTO mes_plan (issue_id, issue_key, version_id, version_name, priority, triaged_by, triaged_at, jira_synced) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(issue_id) DO UPDATE SET version_id = excluded.version_id, version_name = excluded.version_name, priority = excluded.priority,
       triaged_by = excluded.triaged_by, triaged_at = excluded.triaged_at, jira_synced = 0, jira_error = NULL`
  ).bind(ticket.issue_id, ticket.issue_key, version?.id || null, version?.name || null, priority, viewer.email, new Date().toISOString()).run();
  return { ok: true, jiraSynced: await syncPlan(env, ticket.issue_id) };
}

// The ticket's Fix Version in Jira follows the triage decision.
async function syncPlan(env, issueId) {
  const p = await env.DB.prepare('SELECT * FROM mes_plan WHERE issue_id = ?').bind(issueId).first();
  if (!p || p.jira_synced) return true;
  try {
    await jira(env, `/rest/api/3/issue/${encodeURIComponent(p.issue_key)}`, {
      method: 'PUT', body: JSON.stringify({ update: { fixVersions: [{ set: p.version_id ? [{ id: p.version_id }] : [] }] } }),
    });
    await env.DB.prepare('UPDATE mes_plan SET jira_synced = 1, jira_error = NULL WHERE issue_id = ?').bind(issueId).run();
    return true;
  } catch (err) {
    await env.DB.prepare('UPDATE mes_plan SET jira_error = ? WHERE issue_id = ?').bind(err.message.slice(0, 300), issueId).run();
    return false;
  }
}

// ---------- The Condor development rating ----------

export async function rateStep(env, { limit = 5, worklogsFor = fetchIssueWorklogs } = {}) {
  let from = await getState(env, 'mes_rating_from');
  if (!from) { from = londonDate(); await setState(env, 'mes_rating_from', from); }
  const settled = londonDate(Date.now() - SETTLE_DAYS * 86_400_000);
  const { results: tickets } = await env.DB.prepare(
    `SELECT t.*, e.hours, e.ticket_elo, e.timebox FROM mes_tickets t
       LEFT JOIN mes_estimates e ON e.issue_id = t.issue_id LEFT JOIN mes_matches m ON m.issue_id = t.issue_id
      WHERE t.done = 1 AND m.issue_id IS NULL AND t.done_date >= ? AND t.done_date <= ? ORDER BY t.done_date LIMIT ?`
  ).bind(from, settled, limit).all();
  if (!tickets.length) return { rated: 0 };
  const { results: emps } = await env.DB.prepare('SELECT account_id, condor_elo, active FROM employees').all();
  const employees = new Map(emps.map((e) => [e.account_id, e]));
  const { results: counts } = await env.DB.prepare("SELECT account_id, COUNT(*) AS n FROM mes_rating_events WHERE kind = 'match' AND reversed_at IS NULL GROUP BY account_id").all();
  const rated = new Map(counts.map((c) => [c.account_id, c.n]));
  let done = 0;
  for (const t of tickets) {
    await env.DB.batch(await rateTicket(env, t, { employees, rated, worklogsFor }));
    done++;
  }
  return { rated: done };
}

async function rateTicket(env, t, { employees, rated, worklogsFor }) {
  const now = new Date().toISOString();
  const skip = (reason, extra = {}) => [env.DB.prepare(
    `INSERT INTO mes_matches (issue_id, issue_key, summary, status, reason, ticket_elo, estimate_seconds, actual_seconds, done_date, created_at)
     VALUES (?, ?, ?, 'skipped', ?, ?, ?, ?, ?, ?)`
  ).bind(t.issue_id, t.issue_key, t.summary, reason, t.ticket_elo ?? null, t.hours ? Math.round(t.hours * 3600) : null, extra.actual ?? t.actual_seconds, t.done_date, now)];
  if (t.hours == null) return skip('No estimate');
  // A time-box was for finding the cause, not doing the fix.
  if (t.timebox) return skip('Only time-boxed for investigation');

  const { results: subs } = await env.DB.prepare('SELECT issue_id FROM jobs WHERE parent_id = ?').bind(t.issue_id).all();
  const seconds = new Map(), days = new Map();
  let total = 0;
  for (const id of [t.issue_id, ...subs.map((s) => s.issue_id)]) {
    for (const wl of await worklogsFor(env, id)) {
      if (!wl.accountId || !wl.seconds) continue;
      seconds.set(wl.accountId, (seconds.get(wl.accountId) || 0) + wl.seconds);
      if (!days.has(wl.accountId)) days.set(wl.accountId, []);
      days.get(wl.accountId).push([wl.startDate, wl.seconds]);
      total += wl.seconds;
    }
  }
  const actual = Math.max(t.actual_seconds || 0, total);
  if (!actual) return skip('No time logged', { actual });
  const people = [...seconds].filter(([id]) => employees.get(id)?.active);
  if (!people.length) return skip('Nobody with a profile logged time on it', { actual });

  const estimate = Math.round(t.hours * 3600);
  const score = outcomeScore(actual, estimate);
  const weight = matchWeight(actual / estimate);
  const mods = await approvedFor(env, people.map(([id]) => id));
  const stmts = [];
  let ticketDelta = 0;
  for (const [accountId, secs] of people) {
    const emp = employees.get(accountId);
    const before = emp.condor_elo ?? DEFAULT_ELO;
    const share = secs / total;
    const expected = expectedScore(before, t.ticket_elo);
    const k = (rated.get(accountId) || 0) < PROVISIONAL_MATCHES ? PROVISIONAL_K : K_FACTOR;
    const m = mods.get(accountId) || [];
    const factor = m.length ? days.get(accountId).reduce((a, [d, s]) => a + s * factorOn(m, d), 0) / secs : 1;
    const delta = Math.round(k * weight * factor * share * (score - expected) * 10) / 10;
    ticketDelta -= delta;
    emp.condor_elo = before + delta;
    rated.set(accountId, (rated.get(accountId) || 0) + 1);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mes_rating_events (account_id, issue_id, kind, seconds, share, expected, score, k, weight, modifier_factor, delta, elo_before, elo_after, created_at)
         VALUES (?, ?, 'match', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(accountId, t.issue_id, secs, share, expected, score, k, weight, factor < 1 ? factor : null, delta, before, before + delta, now),
      env.DB.prepare('UPDATE employees SET condor_elo = COALESCE(condor_elo, ?) + ? WHERE account_id = ?').bind(DEFAULT_ELO, delta, accountId),
    );
  }
  stmts.unshift(env.DB.prepare(
    `INSERT INTO mes_matches (issue_id, issue_key, summary, status, ticket_elo, ticket_elo_after, estimate_seconds, actual_seconds, ratio, score, weight, people, done_date, created_at)
     VALUES (?, ?, ?, 'rated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(t.issue_id, t.issue_key, t.summary, t.ticket_elo, t.ticket_elo + ticketDelta, estimate, actual, actual / estimate, score, weight, people.length, t.done_date, now));
  return stmts;
}

export async function ratingHistory(env, viewer, accountId) {
  const target = accountId || viewer.accountId;
  if (!target) return null;
  if (target !== viewer.accountId && !canTriage(viewer)) throw new Error('Only Condor leads and admins can see someone else\'s rating.');
  const emp = await env.DB.prepare('SELECT account_id, name, condor_elo, manager_id FROM employees WHERE account_id = ?').bind(target).first();
  const { results } = await env.DB.prepare(
    `SELECT e.*, m.issue_key, m.summary, m.done_date, m.ticket_elo AS job_elo, m.estimate_seconds, m.actual_seconds
       FROM mes_rating_events e LEFT JOIN mes_matches m ON m.issue_id = e.issue_id WHERE e.account_id = ? ORDER BY e.id`
  ).bind(target).all();
  const seesModifiers = viewer.isAdmin || viewer.accountId === target || viewer.accountId === emp?.manager_id;
  if (!seesModifiers) for (const e of results) e.modifier_factor = null;
  return { name: emp?.name, elo: emp?.condor_elo ?? DEFAULT_ELO, start: results[0]?.elo_before ?? DEFAULT_ELO, events: results };
}

export async function team(env, viewer) {
  if (!canTriage(viewer)) return [];
  const { results } = await env.DB.prepare(
    `SELECT e.account_id, e.name, e.condor_elo, (SELECT COUNT(*) FROM mes_rating_events r WHERE r.account_id = e.account_id AND r.kind = 'match') AS jobs
       FROM employees e WHERE e.active = 1 AND e.team = 'Condor' ORDER BY e.name`
  ).all();
  return results.map((r) => ({ ...r, condor_elo: r.condor_elo ?? DEFAULT_ELO }));
}

export async function hourly(env) {
  const { results: est } = await env.DB.prepare('SELECT issue_id FROM mes_estimates WHERE jira_synced = 0').all();
  for (const e of est) await syncEstimate(env, e.issue_id);
  const { results: plans } = await env.DB.prepare('SELECT issue_id FROM mes_plan WHERE jira_synced = 0').all();
  for (const p of plans) await syncPlan(env, p.issue_id);
  const stuck = (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM (SELECT issue_id FROM mes_estimates WHERE jira_synced = 0 UNION ALL SELECT issue_id FROM mes_plan WHERE jira_synced = 0)"
  ).first()).n;
  if (stuck) {
    await raiseAlert(env, { kind: 'mes-jira', dedupe: `mes-jira:${londonDate()}`, subject: `${stuck} MES ${stuck === 1 ? 'change is' : 'changes are'} waiting to reach Jira`,
      body: 'Estimates or release decisions made in Condor Dev could not be written to Jira yet. They are safe in the hub and retried every hour.' });
  }
  return { estimates: est.length, plans: plans.length, stuck };
}

export { canEstimate, canTriage };
export const _test = { median };
