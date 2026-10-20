// Service items (PSCs): every support request in the PSC project and the
// customer projects, how long each waited for the team to first look at it,
// when it last moved, and anything missing that the team needs to fill in.
//
// Jira is read in a few searches by the background job and kept in the hub's
// database, so the tile opens straight away. The first look is the first time
// an item is moved to In Progress in Jira, read from its history.
import { jira, searchPage, customerProjects } from './jira.js';
import { raiseAlert, getState, setState, londonDate } from './sync.js';
import { leadsOfTeam } from './permissions.js';
import { orgMatcher, tokenCounts, holidaysFor } from './contracts.js';

export const PSC_TYPES = ['Incident', 'Further Investigation', 'PSC', 'Problem', 'Change', 'Service Request', 'Snag', 'Sub-Snag'];
export const ORDER_TYPES = ['Snag', 'Sub-Snag'];                        // order work, shown only when asked for
export const RESOLVED_STATUSES = ['Resolved [Promtek]', 'Verified [Customer]'];
// Statuses left off the tile altogether (compared without capitals).
export const HIDDEN_STATUSES = ['admin'];
const ORG_FIELD = 'customfield_12900';
const PSC_PROJECT = 'PSC';
export const DEFAULTS = { targets: { platinum: 1, gold: 2, silver: 4, none: 8 }, shiftStart: 8, shiftEnd: 17, staleDays: 2 };

// What each contract promises, from the Maintenance Level Agreements. The rank
// sets the order items are looked at in; the cover decides when the clock for a
// first look starts; the rest is shown to whoever picks the item up.
export const TIERS = {
  platinum: { name: 'Platinum', rank: 0, cover: 'anytime', coverText: '1 to 3 shifts, any day', callout: 'Same day',
    calloutRate: 90, mileage: 0.9, tmRate: 80, tokens: 15, remote: true, portal: true, line: true, rollover: true, serviceItems: true,
    visits: 'Two service and two calibration visits a year', obsolescence: true },
  gold: { name: 'Gold', rank: 1, cover: 'weekdays', coverText: '1 to 3 shifts, weekdays', callout: '1 working day',
    calloutRate: 100, mileage: 1.0, tmRate: 90, tokens: 10, remote: true, portal: true, line: true, rollover: false, serviceItems: false,
    visits: 'One service and one calibration visit a year', obsolescence: true },
  silver: { name: 'Silver', rank: 2, cover: 'shift', coverText: '1 shift, weekdays', callout: '2 working days',
    calloutRate: 110, mileage: 1.1, tmRate: 100, tokens: 5, remote: true, portal: false, line: false, rollover: false, serviceItems: false,
    visits: 'One service visit a year', obsolescence: true },
  none: { name: 'No contract', rank: 3, cover: 'shift', coverText: 'Office hours, weekdays', callout: 'By arrangement', chargeable: true },
};
// The days no contract covers: Christmas Eve, Christmas Day, Boxing Day, New Year's Eve and New Year's Day.
const NEVER_COVERED = ['12-24', '12-25', '12-26', '12-31', '01-01'];
export const OUT_OF_HOURS_SURCHARGE = 750;

export function tierOf(contract) {
  if (!contract) return 'none';
  const t = String(contract.tier || '').toLowerCase();
  return t.includes('platinum') ? 'platinum' : t.includes('gold') ? 'gold' : t.includes('silver') ? 'silver' : 'none';
}

const SYNC_EVERY_MS = 10 * 60 * 1000;
const RETRY_EVERY_MS = 5 * 60 * 1000;
const FULL_EVERY_MS = 24 * 3600 * 1000;
const REFRESH_GAP_MS = 60 * 1000;
const RECENT_DAYS = 30;
// Moved on whenever deriveItem changes what it works out.
const DERIVE_VERSION = '2';
const RUN_CALLS = 30;
const ORGS_FOR_MS = 6 * 3600 * 1000;
const FIELDS = ['summary', 'status', 'issuetype', 'project', 'created', 'updated', 'resolutiondate', 'assignee', 'reporter', 'priority', ORG_FIELD, 'comment', 'parent', 'issuelinks'];

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
  let saved = {};
  try { saved = JSON.parse((await getState(env, 'psc_settings')) || '{}'); } catch { /* defaults */ }
  return {
    targets: { ...DEFAULTS.targets, ...(saved.targets || {}) },
    shiftStart: saved.shiftStart ?? DEFAULTS.shiftStart,
    shiftEnd: saved.shiftEnd ?? DEFAULTS.shiftEnd,
    staleDays: saved.staleDays ?? DEFAULTS.staleDays,
  };
}

// ---------- time ----------
// The team covers support around the clock, so waits are counted in real time.
export function elapsedMs(fromIso, toIso) {
  const d = ms(toIso) - ms(fromIso);
  return d > 0 ? d : 0;
}

const londonParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' });
function london(t) {
  const p = Object.fromEntries(londonParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, md: `${p.month}-${p.day}`, hour: Number(p.hour), weekday: !['Sat', 'Sun'].includes(p.weekday) };
}

// Whether a customer on this tier is covered at a moment.
export function inCover(tier, t, { settings, bankHolidays = new Set(), bankHolidayCover = false }) {
  const l = london(t);
  if (NEVER_COVERED.includes(l.md)) return false;
  if (bankHolidays.has(l.date) && !bankHolidayCover) return false;
  const cover = TIERS[tier]?.cover || 'shift';
  if (cover === 'anytime') return true;
  if (!l.weekday) return false;
  if (cover === 'weekdays') return true;
  return l.hour >= settings.shiftStart && l.hour < settings.shiftEnd;
}

// When the clock for a first look starts: when it was raised, or when the customer's cover next begins.
export function coverStart(tier, iso, opts) {
  let t = ms(iso);
  if (inCover(tier, t, opts)) return new Date(t).toISOString();
  t = Math.ceil(t / 3600000) * 3600000;
  for (let i = 0; i < 24 * 21; i++, t += 3600000) if (inCover(tier, t, opts)) return new Date(t).toISOString();
  return iso;
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

// The first look is the first time the item was moved to an In Progress status,
// whoever (or whatever) moved it. One closed without ever being In Progress
// counts from when it was closed; one raised straight into In Progress, from when it was raised.
export const IN_PROGRESS = /in progress/i;
export function firstLook(issue) {
  const f = issue.fields || {};
  const moves = [];
  for (const h of issue.changelog?.histories || []) {
    for (const item of h.items || []) {
      if (String(item.field || '').toLowerCase() === 'status') moves.push({ at: h.created, by: h.author?.displayName || 'Automation', to: item.toString || '', from: item.fromString || '' });
    }
  }
  moves.sort((a, b) => ms(a.at) - ms(b.at));
  const started = moves.find((m) => IN_PROGRESS.test(m.to));
  if (started) return { at: started.at, by: started.by, how: `moved it to ${started.to}` };
  if (!moves.length && IN_PROGRESS.test(f.status?.name || '')) return { at: f.created, by: f.reporter?.displayName || null, how: `raised it as ${f.status.name}` };
  if (f.status?.statusCategory?.key === 'done' || RESOLVED_STATUSES.includes(f.status?.name)) {
    const closed = moves.find((m) => RESOLVED_STATUSES.includes(m.to)) || moves[moves.length - 1];
    if (closed) return { at: closed.at, by: closed.by, how: `moved it to ${closed.to}` };
    if (f.resolutiondate) return { at: f.resolutiondate, by: null, how: 'closed it' };
  }
  return null;
}

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
  const first = firstLook(issue);
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
    links: JSON.stringify((f.issuelinks || []).map((l) => l.outwardIssue?.key || l.inwardIssue?.key).filter(Boolean)),
    parent_key: f.parent?.key || null,
    synced_at: now,
  };
}

async function saveItems(env, rows) {
  const cols = ['issue_id', 'issue_key', 'project_key', 'org', 'summary', 'issuetype', 'status', 'done', 'priority', 'assignee_id', 'assignee_name',
    'reporter_name', 'reporter_team', 'created_at', 'updated_at', 'resolved_at', 'team_first_at', 'team_first_by', 'team_first_how', 'team_last_at',
    'team_last_by', 'team_last_what', 'customer_last_at', 'customer_last_by', 'timeline', 'links', 'parent_key', 'synced_at'];
  const sql = `INSERT INTO psc_items (${cols.join(', ')}) VALUES (${placeholders(cols.length)})
    ON CONFLICT(issue_id) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`;
  for (const part of chunk(rows, 40)) await env.DB.batch(part.map((r) => env.DB.prepare(sql).bind(...cols.map((c) => r[c] ?? null))));
  if (rows.length) await changed(env);
}

// ---------- what the list is built from, kept between page loads ----------

// Anything that changes what the list shows moves this on, so pages and the
// open list can tell whether there is anything new without reading it all.
export async function changed(env) {
  await setState(env, 'psc_version', String(Date.now()));
}
export const version = async (env) => (await getState(env, 'psc_version')) || '0';

// The list is worked out from every item, "I'm on it" and the contracts. That
// is kept in memory and reused until something changes, so opening the tile,
// switching tabs or opening an item doesn't read it all again. How long items
// have waited is worked out fresh on every request, so nothing goes stale while
// it's kept. It's read afresh at least hourly to pick up contract changes.
const CONTEXT_FOR_MS = 60 * 60 * 1000;
let kept = null;
async function context(env, { fresh = false } = {}) {
  const v = await version(env);
  if (!fresh && kept && kept.version === v && Date.now() - kept.at < CONTEXT_FOR_MS) return kept.ctx;
  const ctx = await readContext(env);
  kept = { version: v, at: Date.now(), ctx };
  return ctx;
}

export const BASE_JQL = `issuetype in (${quoted(PSC_TYPES)}) AND (statusCategory != Done OR resolved >= -${RECENT_DAYS}d)`;

// Reads a search a page at a time, saving each page as it comes. A full read
// can be bigger than one run's calls, so it remembers where it got to and the
// next run carries on from there.
async function readPages(env, b, jql, { resumeKey = null, started }) {
  let token = resumeKey ? (await getState(env, resumeKey)) || null : null;
  let count = 0;
  for (;;) {
    const params = { fields: FIELDS.join(','), expand: 'changelog', maxResults: '100' };
    if (token) params.nextPageToken = token;
    let data;
    try {
      data = await searchPage(b.env, (path) => b.call(path), jql, params);
    } catch (err) {
      // A remembered place Jira no longer recognises: start the read again.
      if (token && resumeKey && err.status === 400) { await setState(env, resumeKey, ''); token = null; continue; }
      throw err;
    }
    const rows = (data.issues || []).map((i) => deriveItem(i, started));
    await saveItems(env, rows);
    count += rows.length;
    token = data.nextPageToken || null;
    if (resumeKey) {
      await setState(env, resumeKey, token || '');
      await setState(env, 'psc_full_count', Number((await getState(env, 'psc_full_count')) || 0) + rows.length);
    }
    if (!token) return { count, done: true };
  }
}

export async function sync(env, b, { full = false } = {}) {
  const last = Number((await getState(env, 'psc_items_at')) || 0);
  const fullAt = Number((await getState(env, 'psc_full_at')) || 0);
  let fullStarted = (await getState(env, 'psc_full_started')) || '';
  // When how items are read changes, every item is read again so they all agree.
  const deriveChanged = (await getState(env, 'psc_derive')) !== DERIVE_VERSION;
  const fullDue = full || deriveChanged || !fullAt || Date.now() - fullAt >= FULL_EVERY_MS;

  // Start (or carry on with) a full read.
  if (fullStarted || fullDue) {
    if (!fullStarted) {
      fullStarted = new Date().toISOString();
      await setState(env, 'psc_full_started', fullStarted);
      await setState(env, 'psc_full_token', '');
      await setState(env, 'psc_full_count', 0);
    }
    const r = await readPages(env, b, `${BASE_JQL} ORDER BY created ASC`, { resumeKey: 'psc_full_token', started: fullStarted });
    // Items no longer found (deleted, moved out, or closed long ago) leave the list.
    await env.DB.prepare('DELETE FROM psc_items WHERE synced_at < ?').bind(fullStarted).run();
    await setState(env, 'psc_derive', DERIVE_VERSION);
    await changed(env);
    await setState(env, 'psc_full_started', '');
    await setState(env, 'psc_full_at', Date.now());
    await setState(env, 'psc_items_at', Date.now());
    return r.count;
  }

  // Otherwise just what has changed since the last read.
  const since = ` AND updated >= -${Math.ceil((Date.now() - last) / 60000) + 5}m`;
  const r = await readPages(env, b, `${BASE_JQL}${since} ORDER BY updated ASC`, { started: new Date().toISOString() });
  await setState(env, 'psc_items_at', Date.now());
  return r.count;
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
  } else if (w.kind === 'progress') {
    // Moves it to In Progress, which is what counts as its first look.
    const { transitions = [] } = await b.call(`/rest/api/3/issue/${w.issue_key}/transitions`);
    const go = transitions.find((t) => IN_PROGRESS.test(t.to?.name || t.name || ''));
    if (!go) throw new Error('Jira offers no way to move it to In Progress from where it is.');
    await b.call(`/rest/api/3/issue/${w.issue_key}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: go.id } }) });
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
    await changed(env);
    try { await refreshOne(env, b, key); } catch { /* the next read picks it up */ }
    return { ok: true, saved: true };
  } catch (err) {
    await env.DB.prepare('UPDATE psc_writes SET attempts = 1, error = ? WHERE id = ?').bind(String(err.message).slice(0, 400), w.id).run();
    await changed(env);
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
      await changed(env);
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

async function readContext(env) {
  const settings = await loadSettings(env);
  const [{ results: items }, { results: actions }, { results: manual }, { results: contracts }, { results: tokens }, { results: emps }] = await Promise.all([
    env.DB.prepare('SELECT * FROM psc_items').all(),
    env.DB.prepare('SELECT * FROM psc_actions WHERE issue_id IN (SELECT issue_id FROM psc_items) ORDER BY at').all(),
    env.DB.prepare('SELECT * FROM contract_org_map').all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT * FROM contracts WHERE status IN ('In Contract', 'Required Renewal')").all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT * FROM contract_items WHERE kind = 'token'").all().catch(() => ({ results: [] })),
    env.DB.prepare('SELECT account_id, name, email, teams, team FROM employees WHERE active = 1').all(),
  ]);
  let projects = [];
  try { projects = await customerProjects(env); } catch { /* names fall back to keys */ }
  let bankHolidays = new Set();
  try { bankHolidays = new Set((await holidaysFor(env)).map((h) => h.date)); } catch { /* none known */ }
  const match = orgMatcher(projects, manual);
  // Items in the Admin status are kept for the contracts tile, but aren't PSC work to show here.
  const shown = pairCopies(items, match).filter((r) => !HIDDEN_STATUSES.includes(String(r.status || '').trim().toLowerCase()));
  return { settings, items: shown, actions, match, projects, contracts, tokens, emps, bankHolidays };
}

// A PSC board item with an Organization is copied into the customer's project
// (by a Jira app that keeps the two in step). The copy is the one shown; the
// original is hidden, and lends the copy its raised time, reporter and history.
// They're paired by an issue link, or failing that by customer and summary.
const sameText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
export function pairCopies(items, match) {
  const byKey = new Map(items.map((r) => [r.issue_key, r]));
  const taken = new Set();
  const out = items.map((r) => ({ ...r }));
  const outByKey = new Map(out.map((r) => [r.issue_key, r]));
  for (const r of out) {
    if (r.project_key !== PSC_PROJECT || !r.org) continue;
    const customer = r.org.split(' | ').map(match).find(Boolean) || null;
    let links = [];
    try { links = JSON.parse(r.links || '[]'); } catch { /* none */ }
    let copy = links.map((k) => outByKey.get(k)).find((c) => c && c.project_key !== PSC_PROJECT && !taken.has(c.issue_key));
    if (!copy) {
      // The copy's own links can point back at the original too.
      copy = out.find((c) => c.project_key !== PSC_PROJECT && !taken.has(c.issue_key) && (() => {
        try { return JSON.parse(c.links || '[]').includes(r.issue_key); } catch { return false; }
      })());
    }
    if (!copy && customer) copy = out.find((c) => c.project_key === customer && !taken.has(c.issue_key) && sameText(c.summary) === sameText(r.summary));
    if (copy) {
      taken.add(copy.issue_key);
      copy.source = byKey.get(r.issue_key);
      r.copiedTo = copy.issue_key;
    }
    r.hidden = true;
    r.uncopied = !copy;
  }
  return out;
}

// The copy's details, with the original's raised time, reporter and history folded in.
function merged(row) {
  const src = row.source;
  if (!src) return row;
  const earliest = (...xs) => xs.filter(Boolean).sort((a, b) => ms(a.at) - ms(b.at))[0] || null;
  const latest = (...xs) => xs.filter(Boolean).sort((a, b) => ms(b.at) - ms(a.at))[0] || null;
  const copyFirst = row.team_first_at && row.team_first_how !== 'raised by the team' ? { at: row.team_first_at, by: row.team_first_by, how: row.team_first_how } : null;
  const srcFirst = src.team_first_at ? { at: src.team_first_at, by: src.team_first_by, how: src.team_first_how } : null;
  const first = earliest(srcFirst, copyFirst);
  const copyLast = row.team_last_at && row.team_last_what !== 'raised it' ? { at: row.team_last_at, by: row.team_last_by, what: row.team_last_what } : null;
  const last = latest(src.team_last_at && { at: src.team_last_at, by: src.team_last_by, what: src.team_last_what }, copyLast);
  const cust = latest(src.customer_last_at && { at: src.customer_last_at, by: src.customer_last_by }, row.customer_last_at && !row.reporter_team && { at: row.customer_last_at, by: row.customer_last_by });
  // Comments and status changes come through on both; keep one of each.
  const events = [...JSON.parse(src.timeline || '[]'), ...JSON.parse(row.timeline || '[]').filter((e) => e.kind !== 'created')];
  const kept = [];
  for (const e of events.sort((a, b) => ms(a.at) - ms(b.at))) {
    if (kept.some((k) => k.kind === e.kind && sameText(k.text) === sameText(e.text) && Math.abs(ms(k.at) - ms(e.at)) < 15 * 60000)) continue;
    kept.push(e);
  }
  return {
    ...row,
    created_at: ms(src.created_at) < ms(row.created_at) ? src.created_at : row.created_at,
    reporter_name: src.reporter_name, reporter_team: src.reporter_team,
    team_first_at: first?.at || null, team_first_by: first?.by || null, team_first_how: first?.how || null,
    team_last_at: last?.at || null, team_last_by: last?.by || null, team_last_what: last?.what || null,
    customer_last_at: cust?.at || null, customer_last_by: cust?.by || null,
    timeline: JSON.stringify(kept.reverse().slice(0, 30)),
    ids: [row.issue_id, src.issue_id],
  };
}

// Everything the tile shows about one item, worked out now.
export function describe(original, ctx, now = new Date().toISOString()) {
  const row = merged(original);
  const ids = row.ids || [row.issue_id];
  const { settings } = ctx;
  const acts = ctx.actions.filter((a) => ids.includes(a.issue_id));
  const first = row.team_first_at ? { at: row.team_first_at, by: row.team_first_by, how: row.team_first_how } : null;
  const lastCandidates = [
    row.team_last_at && { at: row.team_last_at, by: row.team_last_by, what: row.team_last_what },
    acts.length && { at: acts[acts.length - 1].at, by: acts[acts.length - 1].name, what: 'picked it up' },
  ].filter(Boolean).sort((a, b) => ms(b.at) - ms(a.at));
  const lastTeam = lastCandidates[0] || null;
  const resolved = Boolean(row.done) || RESOLVED_STATUSES.includes(row.status);
  const hour = 3600000;

  // Which customer: the project, or for the PSC project, its Organization; and the live contract they're on.
  const isPsc = row.project_key === PSC_PROJECT;
  const customerKey = isPsc ? (row.org ? row.org.split(' | ').map(ctx.match).find(Boolean) || null : null) : row.project_key;
  const customerName = customerKey ? (ctx.projects.find((p) => p.key === customerKey)?.name || customerKey) : (row.org || null);
  const contract = customerKey ? ctx.contracts.filter((c) => c.project_key === customerKey)
    .sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))[0] || null : null;
  const tier = tierOf(contract);
  const coverOpts = { settings, bankHolidays: ctx.bankHolidays || new Set(), bankHolidayCover: Boolean(contract?.bank_holiday) };

  // The first look is due a set time after the customer's cover starts; from then the clock runs around the clock.
  const target = (settings.targets[tier] ?? DEFAULTS.targets[tier]) * hour;
  const raisedInCover = inCover(tier, ms(row.created_at), coverOpts);
  const clockFrom = coverStart(tier, row.created_at, coverOpts);
  const dueAt = new Date(ms(clockFrom) + target).toISOString();
  const waitMs = elapsedMs(row.created_at, first ? first.at : now);
  const lateNow = first ? ms(first.at) > ms(dueAt) : ms(now) > ms(dueAt);
  const customerWaiting = !resolved && first && row.customer_last_at && ms(row.customer_last_at) > ms(lastTeam?.at || 0) + 1000;
  const customerWaitMs = customerWaiting ? elapsedMs(row.customer_last_at, now) : 0;
  const quietMs = !resolved && lastTeam ? elapsedMs(lastTeam.at, now) : 0;
  const stale = !resolved && first && !customerWaiting && quietMs > settings.staleDays * 24 * hour;
  const missing = [];
  if (!resolved && isPsc && !row.org) missing.push('org');
  if (!resolved && !row.assignee_id) missing.push('assignee');
  if (!resolved && !first) missing.push('response');

  let state = 'active';
  if (resolved) state = 'resolved';
  else if (!first) state = lateNow ? 'late' : 'new';
  else if (customerWaiting) state = 'waiting';
  else if (stale) state = 'quiet';
  const rank = { late: 0, waiting: 1, new: 2, quiet: 3, active: 4, resolved: 5 }[state];

  return {
    id: row.issue_id, key: row.issue_key, project: row.project_key, summary: row.summary, type: row.issuetype, status: row.status,
    priority: row.priority, assignee: row.assignee_name, assigneeId: row.assignee_id, reporter: row.reporter_name,
    created: row.created_at, resolvedAt: row.resolved_at, org: row.org, customer: customerName, customerKey,
    orderWork: ORDER_TYPES.includes(row.issuetype),
    contract: contract ? { key: contract.issue_key, tier: contract.tier, status: contract.status, bankHoliday: Boolean(contract.bank_holiday),
      end: contract.end_date, tokensFree: tokenCounts(ctx.tokens.filter((t) => t.contract_key === contract.issue_key)).free } : null,
    tier, tierName: TIERS[tier].name, tierRank: TIERS[tier].rank,
    cover: { raisedInCover, inCoverNow: inCover(tier, ms(now), coverOpts), clockFrom },
    raisedByTeam: Boolean(row.reporter_team),
    response: first ? { at: first.at, by: first.by, how: first.how, waitMs, late: lateNow, dueAt, targetMs: target }
      : { at: null, waitMs, late: lateNow, dueAt, targetMs: target, leftMs: ms(dueAt) - ms(now) },
    lastTeam, customerLast: row.customer_last_at ? { at: row.customer_last_at, by: row.customer_last_by } : null,
    customerWaiting: Boolean(customerWaiting), customerWaitMs, quietMs, stale: Boolean(stale),
    missing, state, rank,
    copyOf: row.source?.issue_key || null,
    uncopied: Boolean(original.uncopied),
  };
}

// Late first, then new items due within the hour, then customers waiting, then other new items by when
// they're due; within each, the higher contract first.
const urgency = (d) => (d.state === 'new' && d.response.leftMs < 3600000 ? 0.5 : d.rank);
export function byAttention(a, b) {
  if (urgency(a) !== urgency(b)) return urgency(a) - urgency(b);
  if (a.state === 'new') return ms(a.response.dueAt) - ms(b.response.dueAt) || a.tierRank - b.tierRank;
  return a.tierRank - b.tierRank || ms(a.created) - ms(b.created);
}

const canSee = (viewer) => Boolean(viewer.isAdmin || viewer.can?.oversight || viewer.teams?.includes('Service'));
function mustSee(viewer) {
  if (!canSee(viewer)) { const err = new Error('PSC is for the Service team.'); err.status = 403; throw err; }
}

export async function overview(env, viewer) {
  mustSee(viewer);
  const ctx = await context(env);
  const now = new Date().toISOString();
  const items = ctx.items.filter((r) => !r.hidden || r.uncopied).map((r) => describe(r, ctx, now)).sort(byAttention);
  const people = ctx.emps.filter((e) => e.account_id).map((e) => ({ id: e.account_id, name: e.name,
    service: String(e.teams || e.team || '').includes('Service') })).sort((a, b) => Number(b.service) - Number(a.service) || a.name.localeCompare(b.name));
  const { results: pending } = await env.DB.prepare('SELECT issue_key, label, error, attempts FROM psc_writes WHERE done_at IS NULL ORDER BY id').all();
  return {
    version: await version(env),
    items, people, pending, settings: ctx.settings, me: viewer.accountId, tiers: TIERS, surcharge: OUT_OF_HOURS_SURCHARGE,
    reading: (await getState(env, 'psc_full_started')) ? { count: Number((await getState(env, 'psc_full_count')) || 0) } : null,
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
  const m = merged(row);
  const ids = m.ids || [row.issue_id];
  const timeline = JSON.parse(m.timeline || '[]');
  for (const a of ctx.actions.filter((x) => ids.includes(x.issue_id))) timeline.push({ at: a.at, by: a.name, team: true, kind: 'hub', text: 'Picked it up in the hub' });
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
  await changed(env);
  // Picking it up assigns it and moves it to In Progress, which starts its first look.
  let result = { ok: true, saved: true };
  if (row.assignee_id !== viewer.accountId) {
    result = await queueWrite(env, viewer, row.issue_key, 'assign', { accountId: viewer.accountId }, `Assigning to ${viewer.employee?.name || viewer.email}`);
  }
  const started = row.done || RESOLVED_STATUSES.includes(row.status) || IN_PROGRESS.test(row.status || '');
  if (!started) {
    const moved = await queueWrite(env, viewer, row.issue_key, 'progress', {}, 'Moving to In Progress');
    if (!moved.saved) result = moved;
  }
  return result;
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
  const b = budget(env, 35);
  try { await sync(env, b); } catch (err) { if (!(err instanceof OutOfCalls)) throw err; }
  const reading = Boolean(await getState(env, 'psc_full_started'));
  return { ok: true, reading, count: reading ? Number((await getState(env, 'psc_full_count')) || 0) : null };
}

// ---------- background job ----------

async function serviceLeads(env) {
  const leads = (await leadsOfTeam(env, 'Service')).map((e) => e.email).filter(Boolean);
  return leads.length ? leads : [null];
}

const hoursText = (msv) => { const m = Math.round(msv / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`; };

async function alerts(env, ctx) {
  const now = new Date().toISOString();
  for (const row of ctx.items.filter((r) => !r.hidden || r.uncopied)) {
    const d = describe(row, ctx, now);
    if (d.orderWork || d.state === 'resolved') continue;
    if (d.state === 'late') {
      for (const to of await serviceLeads(env)) {
        await raiseAlert(env, { kind: 'psc-response', dedupe: `psc-response:${d.key}:${to || 'default'}`, recipient: to,
          subject: `${d.tier !== 'none' ? `${d.tierName}: ` : ''}${d.key} has waited ${hoursText(d.response.waitMs)} for a first response`,
          body: `${d.key}: ${d.summary}\nCustomer: ${d.customer || 'not set'} (${d.tierName}${d.tier !== 'none' ? `, callout ${TIERS[d.tier].callout.toLowerCase()}` : ', chargeable'})\nRaised by ${d.reporter || 'unknown'} at ${new Date(d.created).toLocaleString('en-GB', { timeZone: 'Europe/London' })}.\n\nNo one from the team has looked at it yet. Open PSC in the hub to pick it up.` });
      }
    }
    if (d.customerWaiting && d.customerWaitMs > d.response.targetMs) {
      const owner = d.assigneeId ? ctx.emps.find((e) => e.account_id === d.assigneeId)?.email : null;
      for (const to of owner ? [owner] : await serviceLeads(env)) {
        await raiseAlert(env, { kind: 'psc-waiting', dedupe: `psc-waiting:${d.key}:${d.customerLast.at}:${to || 'default'}`, recipient: to,
          subject: `${d.customer || 'A customer'} is waiting on ${d.key}`,
          body: `${d.customerLast.by} replied on ${d.key} (${d.summary}) ${hoursText(d.customerWaitMs)} ago, and the team hasn't answered since.\n\nOpen PSC in the hub to see it.` });
      }
    }
  }
}

export async function run(env, { force = false } = {}) {
  const last = Number((await getState(env, 'psc_items_at')) || 0);
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM psc_writes WHERE done_at IS NULL AND attempts < 10').all();
  // Jira changes that failed are tried again every few minutes, not on every run.
  const retryDue = Boolean(results[0]?.n) && Date.now() - Number((await getState(env, 'psc_retry_at')) || 0) >= RETRY_EVERY_MS;
  const reading = Boolean(await getState(env, 'psc_full_started'));
  if (!force && !reading && Date.now() - last < SYNC_EVERY_MS && !retryDue) return { idle: true };
  const b = budget(env, RUN_CALLS);
  const out = {};
  try {
    if (results[0]?.n) { await setState(env, 'psc_retry_at', Date.now()); await retryWrites(env, b); }
    if (force || reading || Date.now() - last >= SYNC_EVERY_MS) out.read = await sync(env, b);
    // Alerts look at every item, so they're worked out once a read has finished, or at most
    // every 10 minutes during a long one, rather than after every page.
    const stillReading = Boolean(await getState(env, 'psc_full_started'));
    if (force || !stillReading || Date.now() - Number((await getState(env, 'psc_alerts_at')) || 0) >= SYNC_EVERY_MS) {
      await alerts(env, await context(env, { fresh: true }));
      await setState(env, 'psc_alerts_at', Date.now());
    }
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
  const all = ctx.items.filter((r) => !r.hidden || r.uncopied).map((r) => describe(r, ctx, now)).filter((d) => !d.orderWork);
  const since = Date.now() - RECENT_DAYS * 86400000;
  // Items the team raised itself (from a call, say) were answered before they existed, so they're left out of response times.
  const recent = all.filter((d) => ms(d.created) >= since && d.response.at && !d.raisedByTeam);
  const waits = recent.map((d) => d.response.waitMs).sort((a, b) => a - b);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  const open = all.filter((d) => d.state !== 'resolved');
  const byTier = Object.keys(TIERS).map((t) => {
    const r = recent.filter((d) => d.tier === t);
    const w = r.map((d) => d.response.waitMs).sort((a, b) => a - b);
    return { tier: t, name: TIERS[t].name, target: ctx.settings.targets[t], count: r.length, inTarget: r.filter((d) => !d.response.late).length,
      medianMs: w.length ? w[Math.floor(w.length / 2)] : null, open: open.filter((d) => d.tier === t).length };
  });
  const count = (list, key) => { const m = new Map(); for (const d of list) { const k = key(d); m.set(k, (m.get(k) || 0) + 1); } return [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n); };
  const ageDays = (d) => (Date.now() - ms(d.created)) / 86400000;
  const weeks = [];
  for (let w = 3; w >= 0; w--) {
    const end = Date.now() - w * 7 * 86400000, start = end - 7 * 86400000;
    const inWeek = all.filter((d) => ms(d.created) >= start && ms(d.created) < end);
    const answered = inWeek.filter((d) => d.response.at && !d.raisedByTeam);
    weeks.push({ start: new Date(start).toISOString().slice(0, 10), raised: inWeek.length,
      inTarget: answered.filter((d) => !d.response.late).length, answered: answered.length,
      resolved: all.filter((d) => d.resolvedAt && ms(d.resolvedAt) >= start && ms(d.resolvedAt) < end).length });
  }
  return {
    settings: ctx.settings,
    response: { count: waits.length, medianMs: median, inTarget: recent.filter((d) => !d.response.late).length, unanswered: open.filter((d) => !d.response.at).length },
    byTier,
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
  return { settings: await loadSettings(env), defaults: DEFAULTS, tiers: TIERS, error: (await getState(env, 'psc_error')) || null,
    syncedAt: Number((await getState(env, 'psc_items_at')) || 0) || null };
}

export async function saveSettings(env, viewer, input) {
  if (!viewer.isAdmin) { const err = new Error('Admin only.'); err.status = 403; throw err; }
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const t = input.targets || {};
  const s = {
    targets: Object.fromEntries(Object.keys(DEFAULTS.targets).map((k) => [k, n(t[k], 0.25, 200, DEFAULTS.targets[k])])),
    shiftStart: n(input.shiftStart, 0, 23, DEFAULTS.shiftStart),
    shiftEnd: n(input.shiftEnd, 1, 24, DEFAULTS.shiftEnd),
    staleDays: n(input.staleDays, 0.5, 30, DEFAULTS.staleDays),
  };
  if (s.shiftEnd <= s.shiftStart) throw new Error('The day shift has to end after it starts.');
  const before = await loadSettings(env);
  await setState(env, 'psc_settings', JSON.stringify(s));
  await changed(env);
  return { ok: true, before, after: s };
}
