// Every customer project has a Quote List, a PSC & Snag List and a Service item.
// This keeps each customer's quotes and service items under the right one, and
// each list's status saying whether anything under it is still open:
//
//   Quote          → the Quote List         "Active Quotes" / "No Open Quotes"
//   PSC types      → the PSC & Snag List    "Open Issues" / "No Open Issues"
//   Service Request → the Service item
//
// Snags and Sub-Snags belong to orders, so they are never moved. Quotes are read
// from Jira here; PSCs come from the PSC sync. Every move is written to the audit
// log with the parent it had before, so it can be traced and put back.
import { jira, searchPage } from './jira.js';
import { customerFilter } from './jobs.js';
import { getState, setState, raiseAlert, londonDate } from './sync.js';

export const TEAM_FIELD = 'customfield_14562';
export const LISTS = {
  quotes: { type: 'Quote List', open: 'Active Quotes', none: 'No Open Quotes', label: 'Quote List' },
  pscs: { type: 'PSC & Snag List', open: 'Open Issues', none: 'No Open Issues', label: 'PSC & Snag List' },
  service: { type: 'Service', label: 'Service item' },
};
// Which list each kind of service item belongs under. Snags and Sub-Snags stay with their orders.
export const PSC_HOME = { Incident: 'pscs', 'Further Investigation': 'pscs', PSC: 'pscs', Problem: 'pscs', Change: 'pscs', 'Service Request': 'service' };

const RUN_EVERY_MS = 10 * 60 * 1000;
const LISTS_EVERY_MS = 24 * 3600 * 1000;
const RUN_CALLS = 24;
const MAX_TRIES = 3;
const QUOTE_FIELDS = ['summary', 'status', 'project', 'parent', 'assignee', 'reporter', 'created', 'updated', TEAM_FIELD];

class OutOfCalls extends Error {}
function budget(env, max) {
  let used = 0;
  return {
    env,
    async call(path, init) {
      if (used >= max) throw new OutOfCalls('Call budget used');
      used++;
      return jira(env, path, init);
    },
    get used() { return used; },
    left: () => max - used,
  };
}

export const teamValue = (v) => (Array.isArray(v) ? v[0]?.value : v?.value) || null;
// Condor work is Projecting work too, so a Projecting filter includes it.
export const teamMatches = (filter, team) => !filter || team === filter || (filter === 'Projecting' && team === 'Condor');

// ---------- reading Jira ----------

// The list items in every customer project. The first made of each kind is the one used.
export async function readLists(env, b) {
  const kinds = Object.entries(LISTS);
  const jql = `${customerFilter} AND issuetype in (${kinds.map(([, l]) => `"${l.type}"`).join(', ')}) ORDER BY created ASC`;
  const found = new Map();
  let token = null;
  do {
    const params = { fields: 'summary,status,issuetype,project', maxResults: '100' };
    if (token) params.nextPageToken = token;
    const data = await searchPage(b.env, (path) => b.call(path), jql, params);
    for (const i of data.issues || []) {
      const kind = kinds.find(([, l]) => l.type.toLowerCase() === String(i.fields?.issuetype?.name || '').toLowerCase())?.[0];
      const project = i.fields?.project?.key || i.key.split('-')[0];
      if (kind && !found.has(`${project}|${kind}`)) found.set(`${project}|${kind}`, { project, kind, id: String(i.id), key: i.key, status: i.fields?.status?.name || null });
    }
    token = data.nextPageToken || null;
  } while (token);
  const now = new Date().toISOString();
  const stmts = [...found.values()].map((l) => env.DB.prepare(
    `INSERT INTO customer_lists (project_key, kind, issue_id, issue_key, status, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_key, kind) DO UPDATE SET issue_id = excluded.issue_id, issue_key = excluded.issue_key, status = excluded.status, checked_at = excluded.checked_at`
  ).bind(l.project, l.kind, l.id, l.key, l.status, now));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await setState(env, 'lists_read_at', String(Date.now()));
  return found.size;
}

const jqlTime = (iso) => {
  const d = new Date(Date.parse(iso) - 5 * 60 * 1000);
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
};

function quoteRow(issue, now) {
  const f = issue.fields || {};
  return [String(issue.id), issue.key, f.project?.key || issue.key.split('-')[0], f.summary || '', f.status?.name || null,
    f.status?.statusCategory?.key === 'done' ? 1 : 0, teamValue(f[TEAM_FIELD]), f.assignee?.accountId || null, f.assignee?.displayName || null,
    f.reporter?.displayName || null, f.parent?.key || null, f.created || null, f.updated || null, now];
}

export async function saveQuotes(env, issues) {
  const now = new Date().toISOString();
  const stmts = issues.map((i) => env.DB.prepare(
    `INSERT INTO jira_quotes (issue_id, issue_key, project_key, summary, status, done, team, assignee_id, assignee_name, reporter_name, parent_key, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, project_key = excluded.project_key, summary = excluded.summary, status = excluded.status,
       done = excluded.done, team = excluded.team, assignee_id = excluded.assignee_id, assignee_name = excluded.assignee_name, reporter_name = excluded.reporter_name,
       parent_key = excluded.parent_key, created_at = excluded.created_at, updated_at = excluded.updated_at, synced_at = excluded.synced_at`
  ).bind(...quoteRow(i, now)));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

// Quotes changed since the last read. The first read takes every open quote and
// the last 90 days of closed ones; a long first read carries on next run.
export async function readQuotes(env, b) {
  const since = await getState(env, 'lists_quotes_since');
  const started = new Date().toISOString();
  const jql = since
    ? `${customerFilter} AND issuetype = Quote AND updated >= "${jqlTime(since)}" ORDER BY updated ASC`
    : `${customerFilter} AND issuetype = Quote AND (statusCategory != Done OR updated >= -90d) ORDER BY updated ASC`;
  let token = (await getState(env, 'lists_quotes_token')) || null;
  let read = 0;
  for (;;) {
    const params = { fields: QUOTE_FIELDS.join(','), maxResults: '100' };
    if (token) params.nextPageToken = token;
    let data;
    try {
      data = await searchPage(b.env, (path) => b.call(path), jql, params);
    } catch (err) {
      if (token && err.status === 400) { token = null; await setState(env, 'lists_quotes_token', ''); continue; }
      throw err;
    }
    await saveQuotes(env, data.issues || []);
    read += (data.issues || []).length;
    token = data.nextPageToken || null;
    await setState(env, 'lists_quotes_token', token || '');
    if (!token) break;
  }
  await setState(env, 'lists_quotes_since', started);
  return read;
}

// ---------- what needs moving ----------

// Open items move whatever their age; closed ones only if they were made after
// this started, so old history in Jira is left as it was.
export async function movesNeeded(env) {
  const since = (await getState(env, 'lists_since')) || new Date().toISOString();
  const { results: quotes } = await env.DB.prepare(
    `SELECT q.issue_key, q.project_key, q.parent_key, l.issue_key AS target FROM jira_quotes q
       JOIN customer_lists l ON l.project_key = q.project_key AND l.kind = 'quotes'
      WHERE (q.parent_key IS NULL OR q.parent_key != l.issue_key) AND (q.done = 0 OR q.created_at >= ?)`
  ).bind(since).all();
  const types = Object.keys(PSC_HOME);
  const { results: pscs } = await env.DB.prepare(
    `SELECT p.issue_key, p.project_key, p.parent_key, p.issuetype, l.issue_key AS pscs_list, s.issue_key AS service_item FROM psc_items p
       LEFT JOIN customer_lists l ON l.project_key = p.project_key AND l.kind = 'pscs'
       LEFT JOIN customer_lists s ON s.project_key = p.project_key AND s.kind = 'service'
      WHERE p.issuetype IN (${types.map(() => '?').join(',')}) AND (p.done = 0 OR p.created_at >= ?)`
  ).bind(...types, since).all();
  const moves = quotes.map((q) => ({ key: q.issue_key, project: q.project_key, kind: 'quotes', from: q.parent_key, to: q.target }));
  for (const p of pscs) {
    const kind = PSC_HOME[p.issuetype];
    const to = kind === 'service' ? p.service_item : p.pscs_list;
    if (to && p.parent_key !== to) moves.push({ key: p.issue_key, project: p.project_key, kind, from: p.parent_key, to });
  }
  // Leave alone anything Jira has refused often enough.
  const { results: stuck } = await env.DB.prepare('SELECT issue_key, to_parent FROM list_moves WHERE status = ? AND tries >= ?').bind('failed', MAX_TRIES).all();
  const skip = new Set(stuck.map((s) => `${s.issue_key}|${s.to_parent}`));
  return moves.filter((m) => !skip.has(`${m.key}|${m.to}`));
}

async function move(env, b, m) {
  const now = new Date().toISOString();
  try {
    await b.call(`/rest/api/3/issue/${encodeURIComponent(m.key)}`, { method: 'PUT', body: JSON.stringify({ fields: { parent: { key: m.to } } }) });
  } catch (err) {
    if (err instanceof OutOfCalls) throw err;
    await env.DB.prepare(
      `INSERT INTO list_moves (issue_key, project_key, kind, from_parent, to_parent, status, error, tries, at) VALUES (?, ?, ?, ?, ?, 'failed', ?, 1, ?)
       ON CONFLICT(issue_key) DO UPDATE SET to_parent = excluded.to_parent, status = 'failed', error = excluded.error,
         tries = CASE WHEN list_moves.to_parent = excluded.to_parent THEN list_moves.tries + 1 ELSE 1 END, at = excluded.at`
    ).bind(m.key, m.project, m.kind, m.from, m.to, err.message.slice(0, 300), now).run();
    return false;
  }
  const table = m.kind === 'quotes' ? 'jira_quotes' : 'psc_items';
  await env.DB.batch([
    env.DB.prepare(`UPDATE ${table} SET parent_key = ? WHERE issue_key = ?`).bind(m.to, m.key),
    env.DB.prepare(
      `INSERT INTO list_moves (issue_key, project_key, kind, from_parent, to_parent, status, error, tries, at) VALUES (?, ?, ?, ?, ?, 'moved', NULL, 0, ?)
       ON CONFLICT(issue_key) DO UPDATE SET project_key = excluded.project_key, kind = excluded.kind, from_parent = excluded.from_parent,
         to_parent = excluded.to_parent, status = 'moved', error = NULL, tries = 0, at = excluded.at`
    ).bind(m.key, m.project, m.kind, m.from, m.to, now),
    env.DB.prepare(
      `INSERT INTO audit_log (at, actor_email, actor_name, area, action, subject_type, subject_id, subject_label, changes, note) VALUES (?, NULL, 'Promtek Hub', ?, ?, 'jira', ?, ?, ?, NULL)`
    ).bind(now, 'Jira lists', `Moved under the ${LISTS[m.kind].label}`, m.key, m.key, JSON.stringify([{ label: 'Parent', before: m.from || 'none', after: m.to }])),
  ]);
  return true;
}

// ---------- list statuses ----------

export async function statusesNeeded(env) {
  const { results } = await env.DB.prepare(
    `SELECT l.project_key, l.kind, l.issue_key, l.status, l.status_error,
            CASE l.kind WHEN 'quotes' THEN (SELECT COUNT(*) FROM jira_quotes q WHERE q.parent_key = l.issue_key AND q.done = 0)
                        ELSE (SELECT COUNT(*) FROM psc_items p WHERE p.parent_key = l.issue_key AND p.done = 0) END AS open
       FROM customer_lists l WHERE l.kind IN ('quotes', 'pscs')`
  ).all();
  return results.map((r) => ({ ...r, want: r.open ? LISTS[r.kind].open : LISTS[r.kind].none }))
    .filter((r) => String(r.status || '').toLowerCase() !== r.want.toLowerCase() && !(r.status_error || '').startsWith(`${r.want}:`));
}

async function setListStatus(env, b, l) {
  const now = new Date().toISOString();
  const data = await b.call(`/rest/api/3/issue/${encodeURIComponent(l.issue_key)}/transitions`);
  const t = (data.transitions || []).find((x) => String(x.to?.name || x.name).toLowerCase() === l.want.toLowerCase());
  if (!t) {
    // Remembered so it isn't asked again until the list or what's under it changes.
    await env.DB.prepare('UPDATE customer_lists SET status_error = ?, checked_at = ? WHERE project_key = ? AND kind = ?')
      .bind(`${l.want}: no way to move ${l.issue_key} from "${l.status}" to "${l.want}" in Jira`, now, l.project_key, l.kind).run();
    return false;
  }
  await b.call(`/rest/api/3/issue/${encodeURIComponent(l.issue_key)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: t.id } }) });
  await env.DB.prepare('UPDATE customer_lists SET status = ?, status_error = NULL, checked_at = ? WHERE project_key = ? AND kind = ?')
    .bind(l.want, now, l.project_key, l.kind).run();
  return true;
}

// ---------- the run ----------

export async function run(env, { force = false } = {}) {
  const last = Number((await getState(env, 'lists_at')) || 0);
  if (!force && Date.now() - last < RUN_EVERY_MS) return { idle: true };
  await setState(env, 'lists_at', String(Date.now()));
  if (!(await getState(env, 'lists_since'))) await setState(env, 'lists_since', new Date().toISOString());
  const b = budget(env, RUN_CALLS);
  const out = { moved: 0, failed: 0, statuses: 0 };
  try {
    const listsAt = Number((await getState(env, 'lists_read_at')) || 0);
    if (Date.now() - listsAt > LISTS_EVERY_MS) out.lists = await readLists(env, b);
    out.quotes = await readQuotes(env, b);
    for (const m of await movesNeeded(env)) {
      if (b.left() < 2) break;
      if (await move(env, b, m)) out.moved++; else out.failed++;
    }
    for (const l of await statusesNeeded(env)) {
      if (b.left() < 2) break;
      if (await setListStatus(env, b, l)) out.statuses++;
    }
    await setState(env, 'lists_error', '');
  } catch (err) {
    if (!(err instanceof OutOfCalls)) { await setState(env, 'lists_error', `${new Date().toISOString()} ${err.message}`); throw err; }
    out.partial = true;
  }
  const { results } = await env.DB.prepare("SELECT issue_key, error FROM list_moves WHERE status = 'failed' AND tries >= ? ORDER BY at DESC LIMIT 5").bind(MAX_TRIES).all();
  if (results.length) {
    await raiseAlert(env, { kind: 'jira-lists', dedupe: `jira-lists:${londonDate()}`,
      subject: `${results.length === 5 ? 'Several' : results.length} ${results.length === 1 ? 'item' : 'items'} couldn't be moved under their list in Jira`,
      body: `${results.map((r) => `${r.issue_key}: ${r.error}`).join('\n')}\n\nThe hub has stopped trying for these. Move them by hand in Jira, or fix what Jira says and they'll be tried again tomorrow.` });
  }
  out.calls = b.used;
  return out;
}

// Gives refused moves another go each day, in case the reason has been fixed.
export async function daily(env) {
  await env.DB.prepare("UPDATE list_moves SET tries = ? - 1 WHERE status = 'failed' AND tries >= ?").bind(MAX_TRIES, MAX_TRIES).run();
  await env.DB.prepare('UPDATE customer_lists SET status_error = NULL').run();
}

// ---------- the open quotes list ----------

export async function openQuotes(env) {
  const { results } = await env.DB.prepare(
    `SELECT q.issue_key AS key, q.project_key AS project, q.summary, q.status, q.team, q.assignee_name AS assignee, q.reporter_name AS reporter,
            q.created_at AS created, q.updated_at AS updated, q.parent_key AS parent, h.id AS hubId, h.team AS hubTeam, h.customer AS hubCustomer
       FROM jira_quotes q LEFT JOIN quotes h ON h.quote_key = q.issue_key WHERE q.done = 0 ORDER BY q.created_at DESC LIMIT 1000`
  ).all();
  const { results: moved } = await env.DB.prepare(
    "SELECT kind, COUNT(*) AS n FROM list_moves WHERE status = 'moved' AND at >= ? GROUP BY kind"
  ).bind(new Date(Date.now() - 7 * 86_400_000).toISOString()).all();
  const { results: failed } = await env.DB.prepare(
    "SELECT issue_key, error FROM list_moves WHERE status = 'failed' AND kind = 'quotes' ORDER BY at DESC LIMIT 10"
  ).all();
  return {
    quotes: results.map((r) => ({ ...r, team: r.team || r.hubTeam || null })),
    readAt: Number((await getState(env, 'lists_at')) || 0) || null,
    error: (await getState(env, 'lists_error')) || null,
    movedThisWeek: Object.fromEntries(moved.map((m) => [m.kind, m.n])),
    notMoved: failed,
  };
}
