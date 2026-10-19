// Condor development (the MES project): estimating by comparison with finished
// tickets, release triage, and a Condor development rating kept apart from
// customer ELO, since internal tickets are on a different scale.
import { searchJql, getIssue, jira } from './jira.js';
import { fetchIssueWorklogs } from './tempo.js';
import { getState, setState, londonDate, raiseAlert, recalcIssues } from './sync.js';
import { outcomeScore, expectedScore, matchWeight, K_FACTOR, PROVISIONAL_K, PROVISIONAL_MATCHES } from './elo.js';
import { approvedFor, factorOn } from './modifiers.js';
import { DEFAULT_ELO } from './progression.js';
import { managesPerson } from './permissions.js';

const PROJECT = 'MES';
export const MODULE_FIELD = 'customfield_15583';
// "Include in release notes" (Yes or No) and the Release Note itself.
export const INCLUDE_FIELD = 'customfield_15584';
export const NOTE_FIELD = 'customfield_15684';
export const FIELDS = ['summary', 'issuetype', 'status', 'assignee', 'statuscategorychangedate', 'resolutiondate', 'aggregatetimespent', 'parent', 'created', 'updated', 'fixVersions', 'subtasks', MODULE_FIELD, INCLUDE_FIELD];
const SCAN_BATCH = 50;
const SETTLE_DAYS = 3;
const MAX_QUESTIONS = 3;
const MIN_REF_SECONDS = 15 * 60;
const MIN_POOL = 5;               // comparisons narrow to like-for-like once there are this many
const ENOUGH_FINISHED = 15;       // until then, open tickets with time logged count as well
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

export function includeOf(issue) {
  let v = issue.fields?.[INCLUDE_FIELD];
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === 'object') v = v.value;
  const t = String(v ?? '').trim().toLowerCase();
  return t === 'yes' ? 'yes' : t === 'no' ? 'no' : null;
}

const doneDateOf = (f) => (f.statuscategorychangedate || f.resolutiondate || f.updated || '').slice(0, 10) || null;

// ---------- Keeping a local copy of MES ----------

function ticketRow(issue) {
  const f = issue.fields || {};
  const done = f.status?.statusCategory?.key === 'done';
  return [String(issue.id), issue.key, f.summary || '', f.issuetype?.name || null, moduleOf(issue), f.status?.name || null,
    done ? 1 : 0, done ? doneDateOf(f) : null, f.aggregatetimespent || 0, f.parent?.id ? String(f.parent.id) : null,
    (f.created || '').slice(0, 10) || null, new Date().toISOString(), f.assignee?.accountId || null, f.status?.statusCategory?.key || null, includeOf(issue),
    JSON.stringify((f.fixVersions || []).map((v) => String(v.id))), JSON.stringify((f.subtasks || []).map((x) => String(x.id)))];
}

export async function saveTickets(env, issues) {
  for (const issue of issues) {
    await env.DB.prepare(
      `INSERT INTO mes_tickets (issue_id, issue_key, summary, type, module, status, done, done_date, actual_seconds, parent_id, created, updated_at, assignee_id, status_category, release_notes, fix_versions, subtask_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, summary = excluded.summary, type = excluded.type,
         module = excluded.module, status = excluded.status, done = excluded.done, done_date = excluded.done_date,
         actual_seconds = excluded.actual_seconds, parent_id = excluded.parent_id, updated_at = excluded.updated_at,
         assignee_id = excluded.assignee_id, status_category = excluded.status_category, release_notes = excluded.release_notes,
         fix_versions = excluded.fix_versions, subtask_ids = excluded.subtask_ids`
    ).bind(...ticketRow(issue)).run();
  }
}

// Works forwards through MES by last update, two years back on the first run,
// a few batches per run so it never uses too many of a run's outside calls.
export async function scan(env, { maxBatches = 5 } = {}) {
  let cursor = await getState(env, 'mes_cursor');
  if (!cursor) cursor = `${londonDate(Date.now() - 730 * 86_400_000).replace(/-/g, '/')} 00:00`;
  let read = 0, batches = 0, full = true;
  while (full && batches < maxBatches) {
    batches++;
    const issues = await searchJql(env, `project = ${PROJECT} AND issuetype not in subTaskIssueTypes() AND updated >= "${cursor}" ORDER BY updated ASC`,
      FIELDS, { limit: SCAN_BATCH });
    await saveTickets(env, issues);
    read += issues.length;
    full = issues.length >= SCAN_BATCH;
    let next = cursor;
    if (issues.length) {
      next = String(issues[issues.length - 1].fields?.updated || '').slice(0, 16).replace('T', ' ').replace(/-/g, '/') || cursor;
      if (full && next <= cursor) {
        const t = Date.parse(`${cursor.replace(/\//g, '-').replace(' ', 'T')}:00Z`) + 60_000;
        next = new Date(t).toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '/');
      }
    }
    cursor = next;
    await setState(env, 'mes_cursor', cursor);
  }
  return { read, cursor, caughtUp: !full };
}

// ---------- Estimating by comparison ----------

// Tickets with real time on them, as alike as there are enough of: the same
// module and type first, then the same module, then the same type. Finished
// tickets are the yardstick; until there are enough of those, open tickets with
// time logged count too. Time logged on sub-tasks counts towards their parent.
const sameText = (a, b) => Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
export async function referencePool(env, ticket) {
  const { results } = await env.DB.prepare(
    `SELECT issue_id, issue_key, summary, type, module, actual_seconds, done FROM mes_tickets
      WHERE actual_seconds >= ? AND issue_id != ? AND type != 'Epic'`
  ).bind(MIN_REF_SECONDS, String(ticket.issue_id)).all();
  const finished = results.filter((r) => r.done);
  const base = finished.length >= ENOUGH_FINISHED ? finished : results;
  const tiers = [
    (r) => sameText(r.module, ticket.module) && sameText(r.type, ticket.type),
    (r) => sameText(r.module, ticket.module),
    (r) => sameText(r.type, ticket.type),
    () => true,
  ];
  for (const keep of tiers) {
    const pool = base.filter(keep);
    if (pool.length >= MIN_POOL || keep === tiers[3]) {
      return pool.map((r) => ({ ...r, done: Boolean(r.done), hours: r.actual_seconds / 3600 })).sort((a, b) => a.hours - b.hours);
    }
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
  const ref = r.next && { id: r.next.issue_id, key: r.next.issue_key, summary: r.next.summary, type: r.next.type, module: r.next.module, hours: r.next.hours, done: r.next.done };
  return { ticket, poolSize: pool.length, next: ref || null, estimate: r.estimate || null, asked: answers.length, maxQuestions: MAX_QUESTIONS };
}

const canEstimate = (viewer) => Boolean(viewer.isAdmin || viewer.can?.condorPlan || viewer.teams?.includes('Condor'));
const canTriage = (viewer) => Boolean(viewer.can?.condorPlan);

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

export async function versions(env) {
  const list = await jira(env, `/rest/api/3/project/${PROJECT}/versions`);
  return (list || []).filter((v) => !v.released && !v.archived)
    .map((v) => ({ id: String(v.id), name: v.name, startDate: v.startDate || null, releaseDate: v.releaseDate || null }))
    .sort((a, b) => (a.releaseDate || '9999').localeCompare(b.releaseDate || '9999'));
}

// The Condor team, for choosing who does a ticket.
export async function condorTeam(env) {
  const { results } = await env.DB.prepare(
    `SELECT account_id AS id, name FROM employees WHERE active = 1 AND account_id IS NOT NULL
       AND (teams LIKE '%"Condor"%' OR (teams IS NULL AND team = 'Condor')) ORDER BY name`
  ).all();
  return results;
}

// Hub's choice first, then Jira's Yes or No.
export const NOTE_KINDS = ['none', 'sentence', 'paragraph', 'photo'];
const kindOf = (r) => r.note_kind || (r.release_notes === 'no' ? 'none' : r.release_notes === 'yes' ? 'paragraph' : null);

const TICKET_SELECT = `SELECT t.*, e.hours, e.low, e.high, e.difficulty, e.timebox, e.method, p.version_id, p.version_name, p.priority, p.decided_for,
            p.triaged_at, k.kind AS note_kind, emp.name AS assignee_name
       FROM mes_tickets t LEFT JOIN mes_estimates e ON e.issue_id = t.issue_id LEFT JOIN mes_plan p ON p.issue_id = t.issue_id
       LEFT JOIN mes_note_kinds k ON k.issue_id = t.issue_id LEFT JOIN employees emp ON emp.account_id = t.assignee_id`;

const shape = (r) => ({ ...r, notes_kind: kindOf(r) });

export async function outstanding(env, viewer, { filter = 'untriaged', query = '', releaseId = null } = {}) {
  const { results } = await env.DB.prepare(`${TICKET_SELECT} WHERE t.done = 0 AND t.type != 'Epic' ORDER BY t.created DESC LIMIT 1000`).all();
  const q = query.trim().toLowerCase();
  const R = releaseId ? String(releaseId) : null;
  const rows = results.filter((r) => {
    if (q && !`${r.issue_key} ${r.summary} ${r.module || ''}`.toLowerCase().includes(q)) return false;
    // Waiting for this release's triage: never decided, or decided for another
    // release and not settled in one (a "not this time", or moved here from it).
    if (filter === 'untriaged') {
      if (R && JSON.parse(r.fix_versions || '[]').includes(R) && r.decided_for === R) return false;
      return !r.priority || (r.decided_for !== R && (!r.version_id || r.version_id === R));
    }
    if (filter === 'unestimated') return r.hours == null;
    return true;
  }).map(shape);
  const known = (await env.DB.prepare('SELECT COUNT(*) AS n FROM mes_tickets').first()).n;
  const cursor = await getState(env, 'mes_cursor');
  // Still reading history if the scan's position is more than a day behind.
  const catchingUp = !cursor || cursor < `${londonDate(Date.now() - 86_400_000).replace(/-/g, '/')} 00:00`;
  const release = R ? await env.DB.prepare('SELECT board_id, sprints FROM mes_releases WHERE version_id = ?').bind(R).first() : null;
  const inRelease = R ? results.filter((r) => r.version_id === R || JSON.parse(r.fix_versions || '[]').includes(R)).length : 0;
  return {
    release: release ? { boardId: release.board_id, sprints: JSON.parse(release.sprints || '[]') } : null, inRelease,
    known, catchingUp, readUpTo: cursor ? cursor.slice(0, 10).replace(/\//g, '-') : null,
    tickets: rows.slice(0, 200), total: rows.length, versions: await versions(env).catch(() => []),
    team: await condorTeam(env), noteKinds: NOTE_KINDS,
    canTriage: canTriage(viewer), canEstimate: canEstimate(viewer), priorities: PRIORITIES, tags: TAGS, hints: DIFFICULTY_HINTS,
  };
}

// ---------- Mid-release review ----------
// What's left of a release that has started, read fresh from Jira, furthest
// along first (Jira's own status order), so the team can reassess what still fits.

const reviewKey = (versionId) => `mes_mid_review:${versionId}`;

export async function midRelease(env, viewer, versionId) {
  if (!canTriage(viewer)) throw new Error('A Condor lead, management or an admin reviews a release.');
  const vs = await versions(env);
  const version = vs.find((v) => v.id === String(versionId));
  if (!version) throw new Error('That release is no longer open in Jira.');
  const issues = await searchJql(env,
    `project = ${PROJECT} AND fixVersion = ${Number(version.id)} AND statusCategory != Done AND issuetype not in subTaskIssueTypes() ORDER BY status DESC, rank ASC`,
    FIELDS, { limit: 300 });
  await saveTickets(env, issues);
  let from = await getState(env, reviewKey(version.id));
  if (!from) { from = new Date().toISOString(); await setState(env, reviewKey(version.id), from); }
  const order = new Map(issues.map((x, i) => [String(x.id), i]));
  const ids = [...order.keys()];
  // D1 takes at most 100 values in one query, so a big release is read in parts.
  const rows = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    rows.push(...(await env.DB.prepare(`${TICKET_SELECT} WHERE t.issue_id IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results);
  }
  const names = new Map(issues.map((x) => [String(x.id), x.fields?.assignee?.displayName || null]));
  const tickets = rows.map((r) => ({ ...shape(r), assignee_name: r.assignee_name || names.get(r.issue_id) || null,
    reviewed: r.decided_for === version.id && r.triaged_at >= from }))
    .sort((a, b) => order.get(a.issue_id) - order.get(b.issue_id));
  const i = vs.indexOf(version);
  return { version, next: vs[i + 1] || null, from, tickets, total: tickets.length, reviewed: tickets.filter((t) => t.reviewed).length,
    team: await condorTeam(env), noteKinds: NOTE_KINDS, priorities: PRIORITIES, tags: TAGS, hints: DIFFICULTY_HINTS, canEstimate: canEstimate(viewer), canTriage: true };
}

export async function restartReview(env, viewer, versionId) {
  if (!canTriage(viewer)) throw new Error('A Condor lead, management or an admin reviews a release.');
  await setState(env, reviewKey(String(versionId)), new Date().toISOString());
  return { ok: true };
}

export async function triage(env, viewer, input) {
  if (!canTriage(viewer)) throw new Error('A Condor lead, management or an admin decides what goes in a release.');
  const ticket = await ticketFor(env, input.issueId);
  const vs = await versions(env);
  const releaseId = String(input.releaseId || input.versionId || '') || null;
  const mid = input.mode === 'mid';
  const keep = PRIORITIES.includes(input.priority);
  if (!keep && input.priority !== 'none') throw new Error('Choose Must, Should, Could or Not this time.');
  const release = releaseId ? vs.find((v) => v.id === releaseId) : null;
  if (releaseId && !release) throw new Error('That release is no longer open in Jira.');

  // Who does it: needed for anything going in a release, so the plan can give it to them.
  const team = await condorTeam(env);
  let assigneeId = input.assigneeId ? String(input.assigneeId) : null;
  if (assigneeId && !team.some((p) => p.id === assigneeId)) throw new Error('Choose someone from the Condor team.');
  if (keep && !assigneeId && !ticket.assignee_id) throw new Error('Choose who will do it.');
  // Every ticket in a release has an estimate, so the plan knows how long it takes.
  if (keep && !(await env.DB.prepare('SELECT 1 AS y FROM mes_estimates WHERE issue_id = ?').bind(ticket.issue_id).first())) {
    throw new Error('Estimate it first, so the plan knows how long it takes.');
  }
  if (assigneeId === ticket.assignee_id) assigneeId = null;

  // What goes in the release notes.
  const kind = input.notes === undefined ? undefined : input.notes;
  if (kind !== undefined && kind !== null && !NOTE_KINDS.includes(kind)) throw new Error('Choose how it appears in the release notes.');
  if (keep && !kind) {
    const known = await env.DB.prepare('SELECT kind FROM mes_note_kinds WHERE issue_id = ?').bind(ticket.issue_id).first();
    if (!known && !ticket.release_notes) throw new Error('Choose how it appears in the release notes.');
  }

  let version = null, priority = input.priority, movedTo = null;
  if (keep) version = release;
  else if (mid) {
    // Not this time, part-way through: it goes to the next release for that release's triage.
    const i = vs.indexOf(release);
    movedTo = vs[i + 1] || null;
    version = movedTo;
    priority = 'Not this time';
  } else priority = 'Not this time';

  await env.DB.prepare(
    `INSERT INTO mes_plan (issue_id, issue_key, version_id, version_name, priority, decided_for, triaged_by, triaged_at, assignee_id, jira_synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(issue_id) DO UPDATE SET version_id = excluded.version_id, version_name = excluded.version_name, priority = excluded.priority,
       decided_for = excluded.decided_for, triaged_by = excluded.triaged_by, triaged_at = excluded.triaged_at, assignee_id = excluded.assignee_id,
       jira_synced = 0, jira_error = NULL`
  ).bind(ticket.issue_id, ticket.issue_key, version?.id || null, version?.name || null, priority, releaseId, viewer.email, new Date().toISOString(), assigneeId).run();
  // The plan uses the new person and release straight away, before Jira is read again.
  await env.DB.prepare('UPDATE mes_tickets SET assignee_id = COALESCE(?, assignee_id), fix_versions = ? WHERE issue_id = ?')
    .bind(assigneeId, JSON.stringify(version ? [version.id] : []), ticket.issue_id).run();
  let notesSynced = true;
  if (kind) notesSynced = await (await import('./release-notes.js')).setKind(env, viewer, ticket, kind);
  const jiraSynced = await syncPlan(env, ticket.issue_id);
  return { ok: true, jiraSynced: jiraSynced && notesSynced, movedTo: movedTo ? movedTo.name : null, outOfRelease: mid && !keep && !movedTo };
}

// The ticket's Fix Version, and its assignee when triage chose one, follow the decision.
export async function syncPlan(env, issueId) {
  const p = await env.DB.prepare('SELECT * FROM mes_plan WHERE issue_id = ?').bind(issueId).first();
  if (!p || p.jira_synced) return true;
  const body = { update: { fixVersions: [{ set: p.version_id ? [{ id: p.version_id }] : [] }] } };
  if (p.assignee_id) body.fields = { assignee: { accountId: p.assignee_id } };
  try {
    await jira(env, `/rest/api/3/issue/${encodeURIComponent(p.issue_key)}`, { method: 'PUT', body: JSON.stringify(body) });
    await env.DB.prepare('UPDATE mes_plan SET jira_synced = 1, jira_error = NULL WHERE issue_id = ?').bind(issueId).run();
    return true;
  } catch (err) {
    await env.DB.prepare('UPDATE mes_plan SET jira_error = ? WHERE issue_id = ?').bind(err.message.slice(0, 300), issueId).run();
    return false;
  }
}

// ---------- The Condor development rating ----------

export async function rateStep(env, { limit = 2, worklogsFor = fetchIssueWorklogs } = {}) {
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

  // Time logged on sub-tasks belongs to the ticket they're under.
  const { results: subs } = await env.DB.prepare('SELECT issue_id FROM jobs WHERE parent_id = ?').bind(t.issue_id).all();
  let subIds = [];
  try { subIds = JSON.parse(t.subtask_ids || '[]'); } catch { /* none known */ }
  const seconds = new Map(), days = new Map();
  let total = 0;
  for (const id of [...new Set([t.issue_id, ...subs.map((s) => s.issue_id), ...subIds.map(String)])]) {
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
  if (target !== viewer.accountId && !canTriage(viewer)) throw new Error('Only leads, management and admins can see someone else\'s rating.');
  const emp = await env.DB.prepare('SELECT account_id, name, condor_elo, manager_id, teams, team FROM employees WHERE account_id = ?').bind(target).first();
  const { results } = await env.DB.prepare(
    `SELECT e.*, m.issue_key, m.summary, m.done_date, m.ticket_elo AS job_elo, m.estimate_seconds, m.actual_seconds
       FROM mes_rating_events e LEFT JOIN mes_matches m ON m.issue_id = e.issue_id WHERE e.account_id = ? ORDER BY e.id`
  ).bind(target).all();
  const seesModifiers = viewer.accountId === target || managesPerson(viewer, emp);
  if (!seesModifiers) for (const e of results) e.modifier_factor = null;
  return { name: emp?.name, elo: emp?.condor_elo ?? DEFAULT_ELO, start: results[0]?.elo_before ?? DEFAULT_ELO, events: results };
}

export async function team(env, viewer) {
  if (!canTriage(viewer)) return [];
  const { results } = await env.DB.prepare(
    `SELECT e.account_id, e.name, e.condor_elo, (SELECT COUNT(*) FROM mes_rating_events r WHERE r.account_id = e.account_id AND r.kind = 'match') AS jobs
       FROM employees e WHERE e.active = 1 AND (e.teams LIKE '%"Condor"%' OR (e.teams IS NULL AND e.team = 'Condor')) ORDER BY e.name`
  ).all();
  return results.map((r) => ({ ...r, condor_elo: r.condor_elo ?? DEFAULT_ELO }));
}

export async function hourly(env) {
  const { results: est } = await env.DB.prepare('SELECT issue_id FROM mes_estimates WHERE jira_synced = 0 LIMIT 10').all();
  for (const e of est) await syncEstimate(env, e.issue_id);
  const { results: plans } = await env.DB.prepare('SELECT issue_id FROM mes_plan WHERE jira_synced = 0 LIMIT 10').all();
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
