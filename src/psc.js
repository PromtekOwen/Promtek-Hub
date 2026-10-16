// Service items (PSCs): every support request in the PSC project and the
// customer projects, how long each waited for the team to first look at it,
// when it last moved, and anything missing that the team needs to fill in.
//
// Jira is read in a few searches by the background job and kept in the hub's
// database, so the tile opens straight away. Time logged and "I'm on it" come
// from the hub itself, so they count the moment they happen.
import { jira, searchPage, customerProjects } from './jira.js';
import { raiseAlert, getState, setState, londonDate } from './sync.js';
import { leadsOfTeam } from './permissions.js';
import { orgMatcher, holidaysFor, tokenCounts } from './contracts.js';

export const PSC_TYPES = ['Incident', 'Further Investigation', 'PSC', 'Problem', 'Change', 'Service Request', 'Snag', 'Sub-Snag'];
export const ORDER_TYPES = ['Snag', 'Sub-Snag'];                        // order work, shown only when asked for
export const RESOLVED_STATUSES = ['Resolved [Promtek]', 'Verified [Customer]'];
const ORG_FIELD = 'customfield_12900';
const PSC_PROJECT = 'PSC';
export const DEFAULTS = { responseHours: 4, staleDays: 2, dayStart: 8, dayEnd: 17 };

const SYNC_EVERY_MS = 10 * 60 * 1000;
const FULL_EVERY_MS = 24 * 3600 * 1000;
const REFRESH_GAP_MS = 60 * 1000;
const RECENT_DAYS = 30;
const RUN_CALLS = 30;
const ORGS_FOR_MS = 6 * 3600 * 1000;
const FIELDS = ['summary', 'status', 'issuetype', 'project', 'created', 'updated', 'resolutiondate', 'assignee', 'reporter', 'priority', ORG_FIELD, 'comment', 'parent'];

const placeholders = (n) => Array(n).fill('?').join(',');
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const quoted = (xs) => xs.map((x) => `"${x}"`).join(', ');
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const later = (a, b) => (!a ? b : !b ? a : ms(a) >= ms(b) ? a : b);

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

// ---------- settings ----------

export async function loadSettings(env) {
  try { return { ...DEFAULTS, ...JSON.parse((await getState(env, 'psc_settings')) || '{}') }; } catch { return { ...DEFAULTS }; }
}

// ---------- working hours ----------

// London's offset from UTC on a date, in minutes (60 in summer, 0 in winter).
const offsets = new Map();
function londonOffset(date) {
  if (offsets.has(date)) return offsets.get(date);
  const noon = Date.UTC(...date.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)), 12);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date(noon)));
  const off = (hour - 12) * 60;
  offsets.set(date, off);
  return off;
}

// Working time between two moments: weekdays between the day's start and end
// hours in London, leaving out bank holidays.
export function workingMs(fromIso, toIso, settings, holidays = new Set()) {
  const from = ms(fromIso), to = ms(toIso);
  if (!(to > from)) return 0;
  const day = (t) => londonDate(t);
  let d = day(from);
  const last = day(to);
  let total = 0;
  for (let guard = 0; guard < 800 && d <= last; guard++) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(d)) {
      const off = londonOffset(d) * 60000;
      const base = Date.parse(`${d}T00:00:00Z`) - off;
      const open = base + settings.dayStart * 3600000, close = base + settings.dayEnd * 3600000;
      total += Math.max(0, Math.min(close, to) - Math.max(open, from));
    }
    d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  }
  return total;
}

// ---------- reading an item from Jira ----------

// Plain text from Jira's document format.
export function adfText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content || []).map(adfText).join('');
  return ['paragraph', 'heading', 'listItem', 'blockquote'].includes(node.type) ? `${inner}\n` : inner;
}

const isTeam = (u) => u?.accountType === 'atlassian';
const isApp = (u) => u?.accountType === 'app';
const orgNames = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((o) => (typeof o === 'object' ? o.name ?? o.value : o)).filter(Boolean).map(String);

// The team's first and last touch, the customer's last word, and a short history.
export function deriveItem(issue, now = new Date().toISOString()) {
  const f = issue.fields || {};
  const created = f.created;
  const reporterTeam = isTeam(f.reporter);
  const events = [{ at: created, by: f.reporter?.displayName || 'Unknown', team: reporterTeam, kind: 'created', text: 'Raised' }];
  for (const c of f.comment?.comments || []) {
    if (isApp(c.author)) continue;
    events.push({ at: c.created, by: c.author?.displayName || 'Unknown', team: isTeam(c.author), kind: 'comment',
      internal: c.jsdPublic === false, text: adfText(c.body).trim().replace(/\n{3,}/g, '\n\n').slice(0, 400) });
  }
  for (const h of issue.changelog?.histories || []) {
    if (isApp(h.author)) continue;
    for (const item of h.items || []) {
      const field = String(item.field || '').toLowerCase();
      if (field === 'status') events.push({ at: h.created, by: h.author?.displayName || 'Unknown', team: isTeam(h.author), kind: 'status', text: `${item.fromString || '?'} → ${item.toString || '?'}` });
      else if (field === 'assignee') events.push({ at: h.created, by: h.author?.displayName || 'Unknown', team: isTeam(h.author), kind: 'assignee', text: item.toString ? `Assigned to ${item.toString}` : 'Unassigned' });
    }
  }
  events.sort((a, b) => ms(a.at) - ms(b.at));
  const team = events.filter((e) => e.team && (e.kind !== 'created'));
  const first = reporterTeam ? { at: created, by: f.reporter?.displayName, how: 'raised by the team' } : team[0] ? { at: team[0].at, by: team[0].by, how: team[0].kind } : null;
  const lastTeam = reporterTeam ? [events[0], ...team].pop() : team[team.length - 1];
  const customer = events.filter((e) => !e.team && (e.kind === 'comment' || e.kind === 'created'));
  const lastCustomer = customer[customer.length - 1];
  const statusCat = f.status?.statusCategory?.key;
  return {
    issue_id: String(issue.id),
    issue_key: issue.key,
    project_key: f.project?.key || issue.key.split('-')[0],
    org: orgNames(f[ORG_FIELD]).join(' | ') || null,
    summary: f.summary || '',
    issuetype: f.issuetype?.name || '',
    status: f.status?.name || '',
    done: statusCat === 'done' ? 1 : 0,
    priority: f.priority?.name || null,
    assignee_id: f.assignee?.accountId || null,
    assignee_name: f.assignee?.displayName || null,
    reporter_name: f.reporter?.displayName || null,
    reporter_team: reporterTeam ? 1 : 0,
    created_at: created,
    updated_at: f.updated || null,
    resolved_at: f.resolutiondate || null,
    team_first_at: first?.at || null,
    team_first_by: first?.by || null,
    team_first_how: first?.how || null,
    team_last_at: lastTeam?.at || null,
    team_last_by: lastTeam?.by || null,
    team_last_what: lastTeam ? (lastTeam.kind === 'created' ? 'raised it' : lastTeam.kind === 'comment' ? 'commented' : lastTeam.kind === 'status' ? `moved it to ${lastTeam.text.split(' → ')[1]}` : lastTeam.text.toLowerCase()) : null,
    customer_last_at: lastCustomer?.at || null,
    customer_last_by: lastCustomer?.by || null,
    timeline: JSON.stringify(events.slice(-25).reverse()),
    synced_at: now,
  };
}

async function saveItems(env, rows) {
  const cols = ['issue_id', 'issue_key', 'project_key', 'org', 'summary', 'issuetype', 'status', 'done', 'priority', 'assignee_id', 'assignee_name',
    'reporter_name', 'reporter_team', 'created_at', 'updated_at', 'resolved_at', 'team_first_at', 'team_first_by', 'team_first_how', 'team_last_at',
    'team_last_by', 'team_last_what', 'customer_last_at', 'customer_last_by', 'timeline', 'synced_at'];
  const sql = `INSERT INTO psc_items (${cols.join(', ')}) VALUES (${placeholders(cols.length)})
    ON CONFLICT(issue_id) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`;
  for (const part of chunk(rows, 40)) await env.DB.batch(part.map((r) => env.DB.prepare(sql).bind(...cols.map((c) => r[c] ?? null))));
}

async function searchItems(b, jql) {
  const out = [];
  let token = null;
  do {
    const params = { fields: FIELDS.join(','), expand: 'changelog', maxResults: '50' };
    if (token) params.nextPageToken = token;
    const data = await searchPage(b.env, (path) => b.call(path), jql, params);
    out.push(...(data.issues || []));
    token = data.nextPageToken || null;
  } while (token);
  return out;
}

export async function sync(env, b, { full = false } = {}) {
  const last = Number((await getState(env, 'psc_items_at')) || 0);
  const isFull = full || !last || Date.now() - Number((await getState(env, 'psc_full_at')) || 0) >= FULL_EVERY_MS;
  const since = isFull ? '' : ` AND updated >= -${Math.ceil((Date.now() - last) / 60000) + 5}m`;
  const jql = `issuetype in (${quoted(PSC_TYPES)}) AND (statusCategory != Done OR resolved >= -${RECENT_DAYS}d)${since} ORDER BY updated DESC`;
  const started = new Date().toISOString();
  const issues = await searchItems(b, jql);
  const rows = issues.map((i) => deriveItem(i, started));
  await saveItems(env, rows);
  if (isFull) {
    // Items no longer found (deleted, moved out, or closed long ago) leave the list.
    await env.DB.prepare('DELETE FROM psc_items WHERE synced_at < ?').bind(started).run();
    await setState(env, 'psc_full_at', Date.now());
  }
  await setState(env, 'psc_items_at', Date.now());
  return rows.length;
}

async function refreshOne(env, b, key) {
  const issue = await b.call(`/rest/api/3/issue/${key}?fields=${FIELDS.join(',')}&expand=changelog`);
  await saveItems(env, [deriveItem(issue)]);
}

// ---------- writing to Jira, safely ----------

async function applyWrite(b, w) {
  const p = JSON.parse(w.payload);
  if (w.kind === 'assign') {
    await b.call(`/rest/api/3/issue/${w.issue_key}/assignee`, { method: 'PUT', body: JSON.stringify({ accountId: p.accountId }) });
  } else if (w.kind === 'org') {
    await b.call(`/rest/api/3/issue/${w.issue_key}`, { method: 'PUT', body: JSON.stringify({ fields: { [ORG_FIELD]: [Number(p.orgId)] } }) });
  } else throw new Error(`Unknown change ${w.kind}`);
}

async function queueWrite(env, viewer, key, kind, payload, label) {
  const at = new Date().toISOString();
  const res = await env.DB.prepare('INSERT INTO psc_writes (issue_key, kind, payload, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(key, kind, JSON.stringify(payload), label, viewer.employee?.name || viewer.email, at).run();
  const w = { id: res.meta.last_row_id, issue_key: key, kind, payload: JSON.stringify(payload), label, attempts: 0 };
  const b = budget(env, 6);
  try {
    await applyWrite(b, w);
    await env.DB.prepare('UPDATE psc_writes SET done_at = ? WHERE id = ?').bind(new Date().toISOString(), w.id).run();
    try { await refreshOne(env, b, key); } catch { /* the next read picks it up */ }
    return { ok: true, saved: true };
  } catch (err) {
    await env.DB.prepare('UPDATE psc_writes SET attempts = 1, error = ? WHERE id = ?').bind(String(err.message).slice(0, 400), w.id).run();
    return { ok: true, saved: false, message: 'Jira didn\'t take it just now. The hub keeps it and tries again.' };
  }
}

async function retryWrites(env, b) {
  const { results } = await env.DB.prepare('SELECT * FROM psc_writes WHERE done_at IS NULL AND attempts < 10 ORDER BY id LIMIT 10').all();
  for (const w of results) {
    if (b.left() < 3) break;
    try {
      await applyWrite(b, w);
      await env.DB.prepare('UPDATE psc_writes SET done_at = ?, error = NULL WHERE id = ?').bind(new Date().toISOString(), w.id).run();
      await refreshOne(env, b, w.issue_key).catch(() => {});
    } catch (err) {
      if (err instanceof OutOfCalls) break;
      const attempts = w.attempts + 1;
      await env.DB.prepare('UPDATE psc_writes SET attempts = ?, error = ? WHERE id = ?').bind(attempts, String(err.message).slice(0, 400), w.id).run();
      if (attempts === 3) {
        await raiseAlert(env, { kind: 'psc-write', dedupe: `psc-write:${w.id}`, subject: `The hub couldn't update ${w.issue_key} in Jira`,
          body: `${w.label || w.kind} on ${w.issue_key}, asked for by ${w.created_by}, hasn't gone through:\n\n${err.message}\n\nThe hub keeps trying.` });
      }
    }
  }
}

// ---------- putting it together ----------

async function context(env) {
  const settings = await loadSettings(env);
  const [{ results: items }, { results: actions }, { results: logs }, { results: manual }, { results: contracts }, { results: tokens }, { results: emps }] = await Promise.all([
    env.DB.prepare('SELECT * FROM psc_items').all(),
    env.DB.prepare('SELECT * FROM psc_actions ORDER BY at').all(),
    env.DB.prepare(`SELECT l.issue_id, l.account_id, l.seconds, COALESCE(l.logged_at, l.created_at) AS at, e.name FROM xp_ledger l
      LEFT JOIN employees e ON e.account_id = l.account_id WHERE l.issue_id IN (SELECT issue_id FROM psc_items) ORDER BY at`).all(),
    env.DB.prepare('SELECT * FROM contract_org_map').all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT * FROM contracts WHERE status IN ('Contract Confirmed', 'In Contract', 'Required Renewal')").all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT * FROM contract_items WHERE kind = 'token'").all().catch(() => ({ results: [] })),
    env.DB.prepare('SELECT account_id, name, email, teams, team FROM employees WHERE active = 1').all(),
  ]);
  let projects = [];
  try { projects = await customerProjects(env); } catch { /* names fall back to keys */ }
  const holidays = new Set((await holidaysFor(env)).map((h) => h.date));
  return { settings, items, actions, logs, match: orgMatcher(projects, manual), projects, contracts, tokens, emps, holidays };
}

// Everything the tile shows about one item, worked out now.
export function describe(row, ctx, now = new Date().toISOString()) {
  const { settings, holidays } = ctx;
  const logs = ctx.logs.filter((l) => l.issue_id === row.issue_id);
  const acts = ctx.actions.filter((a) => a.issue_id === row.issue_id);
  const touches = [
    row.team_first_at && { at: row.team_first_at, by: row.team_first_by, how: row.team_first_how },
    logs[0] && { at: logs[0].at, by: logs[0].name, how: 'logged time' },
    acts[0] && { at: acts[0].at, by: acts[0].name, how: 'picked it up' },
  ].filter(Boolean).filter((t) => ms(t.at) >= ms(row.created_at) - 60000).sort((a, b) => ms(a.at) - ms(b.at));
  const first = touches[0] || null;
  const lastCandidates = [
    row.team_last_at && { at: row.team_last_at, by: row.team_last_by, what: row.team_last_what },
    logs.length && { at: logs[logs.length - 1].at, by: logs[logs.length - 1].name, what: 'logged time' },
    acts.length && { at: acts[acts.length - 1].at, by: acts[acts.length - 1].name, what: 'picked it up' },
  ].filter(Boolean).sort((a, b) => ms(b.at) - ms(a.at));
  const lastTeam = lastCandidates[0] || null;
  const resolved = Boolean(row.done) || RESOLVED_STATUSES.includes(row.status);
  const hour = 3600000;
  const target = settings.responseHours * hour;
  const waitMs = first ? workingMs(row.created_at, first.at, settings, holidays) : workingMs(row.created_at, now, settings, holidays);
  const customerWaiting = !resolved && first && row.customer_last_at && ms(row.customer_last_at) > ms(lastTeam?.at || 0) + 1000;
  const customerWaitMs = customerWaiting ? workingMs(row.customer_last_at, now, settings, holidays) : 0;
  const quietMs = !resolved && lastTeam ? workingMs(lastTeam.at, now, settings, holidays) : 0;
  const stale = !resolved && first && !customerWaiting && quietMs > settings.staleDays * (settings.dayEnd - settings.dayStart) * hour;

  // Which customer: the project, or for the PSC project, its Organization.
  const isPsc = row.project_key === PSC_PROJECT;
  const customerKey = isPsc ? (row.org ? row.org.split(' | ').map(ctx.match).find(Boolean) || null : null) : row.project_key;
  const customerName = customerKey ? (ctx.projects.find((p) => p.key === customerKey)?.name || customerKey) : (row.org || null);
  const contract = customerKey ? ctx.contracts.filter((c) => c.project_key === customerKey).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))[0] : null;
  const missing = [];
  if (!resolved && isPsc && !row.org) missing.push('org');
  if (!resolved && !row.assignee_id) missing.push('assignee');
  if (!resolved && !first) missing.push('response');

  let state = 'active';
  if (resolved) state = 'resolved';
  else if (!first) state = waitMs > target ? 'late' : 'new';
  else if (customerWaiting) state = 'waiting';
  else if (stale) state = 'quiet';
  const rank = { late: 0, waiting: 1, new: 2, quiet: 3, active: 4, resolved: 5 }[state];

  return {
    id: row.issue_id, key: row.issue_key, project: row.project_key, summary: row.summary, type: row.issuetype, status: row.status,
    priority: row.priority, assignee: row.assignee_name, assigneeId: row.assignee_id, reporter: row.reporter_name,
    created: row.created_at, resolvedAt: row.resolved_at, org: row.org, customer: customerName, customerKey,
    orderWork: ORDER_TYPES.includes(row.issuetype),
    contract: contract ? { key: contract.issue_key, tier: contract.tier, status: contract.status, bankHoliday: Boolean(contract.bank_holiday),
      tokensFree: tokenCounts(ctx.tokens.filter((t) => t.contract_key === contract.issue_key)).free } : null,
    raisedByTeam: Boolean(row.reporter_team),
    response: first ? { at: first.at, by: first.by, how: first.how, workingMs: waitMs, late: waitMs > target }
      : { at: null, workingMs: waitMs, late: waitMs > target, targetMs: target },
    lastTeam, customerLast: row.customer_last_at ? { at: row.customer_last_at, by: row.customer_last_by } : null,
    customerWaiting: Boolean(customerWaiting), customerWaitMs, quietMs, stale: Boolean(stale),
    logged: logs.reduce((a, l) => a + l.seconds, 0),
    missing, state, rank,
  };
}

const canSee = (viewer) => Boolean(viewer.isAdmin || viewer.can?.oversight || viewer.teams?.includes('Service'));
function mustSee(viewer) {
  if (!canSee(viewer)) { const err = new Error('PSC is for the Service team.'); err.status = 403; throw err; }
}

export async function overview(env, viewer) {
  mustSee(viewer);
  const ctx = await context(env);
  const now = new Date().toISOString();
  const items = ctx.items.map((r) => describe(r, ctx, now))
    .sort((a, b) => a.rank - b.rank || ms(a.created) - ms(b.created));
  const people = ctx.emps.filter((e) => e.account_id).map((e) => ({ id: e.account_id, name: e.name,
    service: String(e.teams || e.team || '').includes('Service') })).sort((a, b) => Number(b.service) - Number(a.service) || a.name.localeCompare(b.name));
  const { results: pending } = await env.DB.prepare('SELECT issue_key, label, error, attempts FROM psc_writes WHERE done_at IS NULL ORDER BY id').all();
  return {
    items, people, pending, settings: ctx.settings, me: viewer.accountId,
    syncedAt: Number((await getState(env, 'psc_items_at')) || 0) ? new Date(Number(await getState(env, 'psc_items_at'))).toISOString() : null,
    isAdmin: Boolean(viewer.isAdmin),
  };
}

export async function item(env, viewer, key) {
  mustSee(viewer);
  const ctx = await context(env);
  const row = ctx.items.find((r) => r.issue_key === key);
  if (!row) throw new Error('That item isn\'t in the list any more.');
  const d = describe(row, ctx);
  const timeline = JSON.parse(row.timeline || '[]');
  for (const l of ctx.logs.filter((x) => x.issue_id === row.issue_id)) timeline.push({ at: l.at, by: l.name || 'Someone', team: true, kind: 'time', text: `Logged ${Math.round(l.seconds / 60)} minutes` });
  for (const a of ctx.actions.filter((x) => x.issue_id === row.issue_id)) timeline.push({ at: a.at, by: a.name, team: true, kind: 'hub', text: 'Picked it up in the hub' });
  timeline.sort((a, b) => ms(b.at) - ms(a.at));
  return { item: d, timeline: timeline.slice(0, 40) };
}

// ---------- actions ----------

async function rowFor(env, key) {
  const row = await env.DB.prepare('SELECT * FROM psc_items WHERE issue_key = ?').bind(String(key)).first();
  if (!row) throw new Error('That item isn\'t in the list any more.');
  return row;
}

export async function pickUp(env, viewer, key) {
  mustSee(viewer);
  if (!viewer.accountId) throw new Error('Your hub profile needs a Jira account first.');
  const row = await rowFor(env, key);
  await env.DB.prepare('INSERT INTO psc_actions (issue_id, issue_key, account_id, name, action, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(row.issue_id, row.issue_key, viewer.accountId, viewer.employee?.name || viewer.email, 'pickup', new Date().toISOString()).run();
  if (row.assignee_id === viewer.accountId) return { ok: true, saved: true };
  return queueWrite(env, viewer, row.issue_key, 'assign', { accountId: viewer.accountId }, `Assigning to ${viewer.employee?.name || viewer.email}`);
}

export async function assign(env, viewer, key, accountId) {
  mustSee(viewer);
  const row = await rowFor(env, key);
  const who = await env.DB.prepare('SELECT name FROM employees WHERE account_id = ?').bind(String(accountId || '')).first();
  if (!who) throw new Error('Choose someone from the list.');
  return queueWrite(env, viewer, row.issue_key, 'assign', { accountId }, `Assigning to ${who.name}`);
}

export async function setOrg(env, viewer, key, orgId) {
  mustSee(viewer);
  const row = await rowFor(env, key);
  const orgs = await organizations(env);
  const org = orgs.find((o) => String(o.id) === String(orgId));
  if (!org) throw new Error('Choose an Organization from the list.');
  return queueWrite(env, viewer, row.issue_key, 'org', { orgId: org.id }, `Setting the Organization to ${org.name}`);
}

// The service desk's Organizations, kept for six hours.
export async function organizations(env, { fresh = false } = {}) {
  const saved = await getState(env, 'psc_orgs');
  const cached = saved ? JSON.parse(saved) : null;
  if (!fresh && cached && Date.now() - cached.at < ORGS_FOR_MS) return cached.list;
  const list = [];
  let start = 0;
  for (let page = 0; page < 20; page++) {
    const data = await jira(env, `/rest/servicedeskapi/organization?start=${start}&limit=50`);
    list.push(...(data.values || []).map((o) => ({ id: String(o.id), name: o.name })));
    if (data.isLastPage || !data.values?.length) break;
    start += data.values.length;
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  await setState(env, 'psc_orgs', JSON.stringify({ at: Date.now(), list }));
  return list;
}

export async function orgOptions(env, viewer) {
  mustSee(viewer);
  try { return { orgs: await organizations(env) }; } catch (err) { return { orgs: [], error: `Couldn't load the Organizations from Jira: ${err.message}` }; }
}

export async function refresh(env, viewer) {
  mustSee(viewer);
  const last = Number((await getState(env, 'psc_refresh_at')) || 0);
  if (Date.now() - last < REFRESH_GAP_MS) return { ok: true, skipped: true };
  await setState(env, 'psc_refresh_at', Date.now());
  const b = budget(env, 20);
  try { await sync(env, b); } catch (err) { if (!(err instanceof OutOfCalls)) throw err; }
  return { ok: true };
}

// ---------- background job ----------

async function serviceLeads(env) {
  const leads = (await leadsOfTeam(env, 'Service')).map((e) => e.email).filter(Boolean);
  return leads.length ? leads : [null];
}

const hoursText = (msv) => { const m = Math.round(msv / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`; };

async function alerts(env, ctx) {
  const now = new Date().toISOString();
  for (const row of ctx.items) {
    const d = describe(row, ctx, now);
    if (d.orderWork || d.state === 'resolved') continue;
    if (d.state === 'late') {
      for (const to of await serviceLeads(env)) {
        await raiseAlert(env, { kind: 'psc-response', dedupe: `psc-response:${d.key}:${to || 'default'}`, recipient: to,
          subject: `${d.key} has waited ${hoursText(d.response.workingMs)} for a first response`,
          body: `${d.key}: ${d.summary}\nCustomer: ${d.customer || 'not set'}${d.contract ? ` (${d.contract.tier || 'contract'})` : ''}\nRaised by ${d.reporter || 'unknown'} at ${new Date(d.created).toLocaleString('en-GB', { timeZone: 'Europe/London' })}.\n\nNo one from the team has looked at it yet. Open PSC in the hub to pick it up.` });
      }
    }
    if (d.customerWaiting && d.customerWaitMs > ctx.settings.responseHours * 3600000) {
      const owner = d.assigneeId ? ctx.emps.find((e) => e.account_id === d.assigneeId)?.email : null;
      for (const to of owner ? [owner] : await serviceLeads(env)) {
        await raiseAlert(env, { kind: 'psc-waiting', dedupe: `psc-waiting:${d.key}:${d.customerLast.at}:${to || 'default'}`, recipient: to,
          subject: `${d.customer || 'A customer'} is waiting on ${d.key}`,
          body: `${d.customerLast.by} replied on ${d.key} (${d.summary}) ${hoursText(d.customerWaitMs)} of working time ago, and the team hasn't answered since.\n\nOpen PSC in the hub to see it.` });
      }
    }
  }
}

export async function run(env, { force = false } = {}) {
  const last = Number((await getState(env, 'psc_items_at')) || 0);
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM psc_writes WHERE done_at IS NULL AND attempts < 10').all();
  if (!force && Date.now() - last < SYNC_EVERY_MS && !results[0]?.n) return { idle: true };
  const b = budget(env, RUN_CALLS);
  const out = {};
  try {
    await retryWrites(env, b);
    if (force || Date.now() - last >= SYNC_EVERY_MS) out.read = await sync(env, b);
    await alerts(env, await context(env));
    await setState(env, 'psc_error', '');
  } catch (err) {
    if (!(err instanceof OutOfCalls)) { await setState(env, 'psc_error', `${new Date().toISOString()} ${err.message}`); throw err; }
    out.partial = true;
  }
  out.calls = b.used;
  return out;
}

// ---------- insights ----------

export async function insights(env, viewer) {
  mustSee(viewer);
  const ctx = await context(env);
  const now = new Date().toISOString();
  const all = ctx.items.map((r) => describe(r, ctx, now)).filter((d) => !d.orderWork);
  const since = Date.now() - RECENT_DAYS * 86400000;
  // Items the team raised itself (from a call, say) were answered before they existed, so they're left out of response times.
  const recent = all.filter((d) => ms(d.created) >= since && d.response.at && !d.raisedByTeam);
  const waits = recent.map((d) => d.response.workingMs).sort((a, b) => a - b);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  const target = ctx.settings.responseHours * 3600000;
  const open = all.filter((d) => d.state !== 'resolved');
  const count = (list, key) => { const m = new Map(); for (const d of list) { const k = key(d); m.set(k, (m.get(k) || 0) + 1); } return [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n); };
  const ageDays = (d) => (Date.now() - ms(d.created)) / 86400000;
  const weeks = [];
  for (let w = 3; w >= 0; w--) {
    const end = Date.now() - w * 7 * 86400000, start = end - 7 * 86400000;
    const inWeek = all.filter((d) => ms(d.created) >= start && ms(d.created) < end);
    const answered = inWeek.filter((d) => d.response.at && !d.raisedByTeam);
    weeks.push({ start: new Date(start).toISOString().slice(0, 10), raised: inWeek.length,
      inTarget: answered.filter((d) => d.response.workingMs <= target).length, answered: answered.length,
      resolved: all.filter((d) => d.resolvedAt && ms(d.resolvedAt) >= start && ms(d.resolvedAt) < end).length });
  }
  return {
    settings: ctx.settings,
    response: { count: waits.length, medianMs: median, inTarget: waits.filter((x) => x <= target).length, unanswered: open.filter((d) => !d.response.at).length },
    weeks,
    states: { late: open.filter((d) => d.state === 'late').length, waiting: open.filter((d) => d.state === 'waiting').length,
      quiet: open.filter((d) => d.state === 'quiet').length, open: open.length },
    ages: [['Under 2 days', 0, 2], ['2 to 7 days', 2, 7], ['1 to 4 weeks', 7, 28], ['Over 4 weeks', 28, 1e9]]
      .map(([label, a, b2]) => ({ label, n: open.filter((d) => ageDays(d) >= a && ageDays(d) < b2).length })),
    byCustomer: count(open, (d) => d.customer || 'No customer set').slice(0, 10),
    byAssignee: count(open, (d) => d.assignee || 'Unassigned'),
    oldestQuiet: open.filter((d) => d.lastTeam).sort((a, b) => ms(a.lastTeam.at) - ms(b.lastTeam.at)).slice(0, 5)
      .map((d) => ({ key: d.key, summary: d.summary, customer: d.customer, lastTeam: d.lastTeam })),
  };
}

// ---------- settings ----------

export async function getSettings(env, viewer) {
  if (!viewer.isAdmin) { const err = new Error('Admin only.'); err.status = 403; throw err; }
  return { settings: await loadSettings(env), defaults: DEFAULTS, error: (await getState(env, 'psc_error')) || null,
    syncedAt: Number((await getState(env, 'psc_items_at')) || 0) || null };
}

export async function saveSettings(env, viewer, input) {
  if (!viewer.isAdmin) { const err = new Error('Admin only.'); err.status = 403; throw err; }
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const s = {
    responseHours: n(input.responseHours, 0.5, 80, DEFAULTS.responseHours),
    staleDays: n(input.staleDays, 0.5, 30, DEFAULTS.staleDays),
    dayStart: n(input.dayStart, 0, 23, DEFAULTS.dayStart),
    dayEnd: n(input.dayEnd, 1, 24, DEFAULTS.dayEnd),
  };
  if (s.dayEnd <= s.dayStart) throw new Error('The working day has to end after it starts.');
  const before = await loadSettings(env);
  await setState(env, 'psc_settings', JSON.stringify(s));
  return { ok: true, before, after: s };
}
