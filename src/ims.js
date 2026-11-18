// The Integrated Management System, as one. Each area of internal management has its own
// Jira project, and an item that concerns several areas has a copy in each of their
// projects, joined by Sync links. The hub reads them all, shows each such item once, and
// keeps the copies in step: a change made to one copy (in Jira or the hub) is made to the
// others. The IMS Main Board (PROMTEK) holds the management meetings.
//
// Keeping copies in step: for each group of copies the hub remembers the last value of
// each field it knows they all had. When a copy differs from that, it was changed, and the
// change goes to the others. Copies that already disagreed when the hub first saw them are
// left as they are and shown, for someone to choose which is right. A copy the hub hasn't
// seen before is brought in line with the others, never the other way round.
import { jira } from './jira.js';
import { getState, setState } from './sync.js';
import { canTile } from './permissions.js';
import { record } from './audit.js';

export const AREAS = [
  { key: 'GOALS', id: '17545', name: 'Strategic Objectives', main: 'PROMTEK-2' },
  { key: 'LEGAL', id: '17482', name: 'Legal & Policy', main: 'PROMTEK-3' },
  { key: 'HEALTH', id: '17446', name: 'Health & Safety', main: 'PROMTEK-4' },
  { key: 'COMPLIANCE', id: '17512', name: 'Compliance & Training', main: 'PROMTEK-5' },
  { key: 'FINANCE', id: '17546', name: 'Finance & Accounting', main: 'PROMTEK-7' },
  { key: 'INNOV', id: '17182', name: 'Innovation Pipeline', main: 'PROMTEK-8' },
  { key: 'IS', id: '17481', name: 'Information Security', main: 'PROMTEK-9' },
  { key: 'MARKETING', id: '17644', name: 'Marketing', main: 'PROMTEK-10' },
  { key: 'SUGGEST', id: '16679', name: 'Operational Improvements', main: 'PROMTEK-19' },
  { key: 'QA', id: '17578', name: 'Quality Assurance', main: 'PROMTEK-20' },
];
export const MAIN = 'PROMTEK';
export const MEETING_LIST = 'PROMTEK-21';
const AREA_KEYS = AREAS.map((a) => a.key);
const areaByName = (n) => AREAS.find((a) => a.name.toLowerCase() === String(n || '').trim().toLowerCase()
  || (a.key === 'COMPLIANCE' && /^complia\w*\s*&\s*training$/i.test(String(n || '').trim())));
export const isArea = (k) => AREA_KEYS.includes(String(k || '').split('-')[0]);
// Not work: the structure the work sits in, and the IMS Main Board's own items.
export const NOT_WORK = ['Folder', 'Legacy Reference Tasks', 'Archive', 'Meeting', 'Meeting List', 'IMS Main', 'Employee'];
// The gap analysis's own items, made and followed on the Gap analysis tab.
export const GAP_TYPES = ['Gap Analysis', 'Gap Area', 'Skill Assessment', 'Training Requirement'];
const SYNC_LINKS = /^(sync|cloners)$/i;

const READ_EVERY_MS = 10 * 60 * 1000;
const FULL_EVERY_MS = 24 * 3600 * 1000;
const RUN_CALLS = 30;
const WRITES_PER_RUN = 8;
const MAX_TRIES = 5;
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const ms = (iso) => (iso ? Date.parse(iso) : 0);
const ph = (n) => Array(n).fill('?').join(',');

class OutOfCalls extends Error {}
function budget(env, max) {
  let used = 0;
  return {
    env,
    async call(path, init) { if (used >= max) throw new OutOfCalls('Call budget used'); used++; return jira(env, path, init); },
    left: () => max - used,
  };
}

export function mustSee(viewer) {
  if (!canTile(viewer, 'ims')) throw refuse('The IMS isn\'t open to you.', 403);
}

// ---------- the fields, found by name ----------

const FIELD_NAMES = {
  imsType: ['IMS Task Type', 'customfield_15113'],
  subTypes: ['IMS Task Sub-Type(s)', 'customfield_14948'],
  categories: ['Included IMS Categories', 'customfield_14816'],
  rootCause: ['Root Cause', 'customfield_14618'],
  rootRequired: ['Is Root Cause Required?', null],
  origin: ['IMS Origin Item', 'customfield_15917'],
  start: ['Start date', 'customfield_14140'],
  target: ['Target end', 'customfield_14158'],
  staff: ['Promtek Staff Involved', 'customfield_14523'],
  containment: ['Containment', 'customfield_14558'],
  analysis: ['Analysis & Planning of Corrective Actions', 'customfield_14559'],
  actions: ['Corrective & Preventative Actions Taken', 'customfield_14687'],
  persons: ['Persons Involved Info', 'customfield_14685'],
  finalise: ['Finalise Teamwork', 'customfield_14686'],
  incidentAt: ['Date & Time of Incident', null],
  location: ['Location of Incident', null],
  happened: ['What Happened?', null],
  severity: ['Incident Severity', null],
  injury: ['Description of Injury/Damage', null],
  factors: ['Contributing Factors', null],
  businessArea: ['Business Area', null],
  customer: ['Customer', null],
  address: ['Customer Address', null],
  changeDesc: ['Change Description', null],
  changeDocs: ['Change Documentation', null],
  fiveWhys: ['5 Whys', 'customfield_16920'],
};
// Carried onto each copy as they are, beyond the fields kept in step.
const COPIED_AS_IS = ['incidentAt', 'location', 'happened', 'severity', 'injury', 'factors', 'businessArea', 'customer', 'address', 'changeDesc', 'changeDocs'];
let fieldCache = null;
export async function fieldMap(env, call = (p) => jira(env, p)) {
  if (fieldCache && Date.now() - fieldCache.at < 6 * 3600 * 1000) return fieldCache.map;
  const saved = JSON.parse((await getState(env, 'ims_fields_v3')) || 'null');
  if (saved && Date.now() - saved.at < 24 * 3600 * 1000) { fieldCache = saved; return saved.map; }
  const map = {};
  let all = [];
  try { const got = await call('/rest/api/3/field'); all = Array.isArray(got) ? got : []; } catch { /* the known IDs */ }
  for (const [k, [name, fallback]] of Object.entries(FIELD_NAMES)) {
    const found = all.filter((f) => String(f.name).toLowerCase() === name.toLowerCase());
    map[k] = (found.find((f) => f.id === fallback) || found[0])?.id || fallback;
  }
  fieldCache = { at: Date.now(), map };
  await setState(env, 'ims_fields_v3', JSON.stringify(fieldCache));
  return map;
}

// The fields kept in step across copies, and how each is read and written.
// kind: select (one option), multi (several), user, priority, date, text (any shape, compared by hash), labels, status
export const SYNCED = {
  summary: { kind: 'plain', label: 'Summary', get: (f) => f.summary || '' },
  description: { kind: 'text', label: 'Description', get: (f) => f.description },
  status: { kind: 'status', label: 'Status', get: (f) => f.status?.name || '' },
  assignee: { kind: 'user', label: 'Assignee', get: (f) => f.assignee?.accountId || null },
  priority: { kind: 'priority', label: 'Priority', get: (f) => f.priority?.name || null },
  labels: { kind: 'labels', label: 'Labels', get: (f) => [...(f.labels || [])].sort() },
  imsType: { kind: 'select', label: 'IMS Task Type', field: 'imsType' },
  subTypes: { kind: 'multi', label: 'Sub-type', field: 'subTypes' },
  categories: { kind: 'multi', label: 'Areas', field: 'categories' },
  rootCause: { kind: 'multi', label: 'Root cause', field: 'rootCause' },
  rootRequired: { kind: 'multi', label: 'Root cause required', field: 'rootRequired' },
  start: { kind: 'date', label: 'Start date', field: 'start' },
  target: { kind: 'date', label: 'Target end', field: 'target' },
  containment: { kind: 'text', label: 'Containment', field: 'containment' },
  analysis: { kind: 'text', label: 'Analysis & planning', field: 'analysis' },
  actions: { kind: 'text', label: 'Corrective & preventative actions', field: 'actions' },
  persons: { kind: 'text', label: 'Persons involved', field: 'persons' },
  finalise: { kind: 'text', label: 'Finalise teamwork', field: 'finalise' },
  fiveWhys: { kind: 'text', label: '5 Whys', field: 'fiveWhys' },
};

const optionValues = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((o) => (typeof o === 'object' ? o?.value ?? o?.name : o)).filter((x) => x != null).map(String);
const hash = (s) => { let h = 5381; const t = String(s); for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(36); };

// Each synced field as a comparable value.
export function syncValue(name, fields, F) {
  const def = SYNCED[name];
  const raw = def.get ? def.get(fields) : fields[F[def.field]];
  switch (def.kind) {
    case 'select': return optionValues(raw)[0] || null;
    case 'multi': return optionValues(raw).sort();
    case 'date': return raw ? String(raw).slice(0, 10) : null;
    case 'text': return raw == null || raw === '' ? null : `#${hash(JSON.stringify(raw))}`;
    default: return raw ?? null;
  }
}

// ---------- reading Jira ----------

export function rowOf(issue, F, now = new Date().toISOString()) {
  const f = issue.fields || {};
  const vals = Object.fromEntries(Object.keys(SYNCED).map((k) => [k, syncValue(k, f, F)]));
  const links = (f.issuelinks || []).map((l) => {
    const other = l.outwardIssue || l.inwardIssue;
    return other ? { key: other.key, type: l.type?.name || '', dir: l.outwardIssue ? 'out' : 'in', how: l.outwardIssue ? l.type?.outward : l.type?.inward } : null;
  }).filter(Boolean);
  return {
    issue_id: String(issue.id), issue_key: issue.key, project_key: f.project?.key || issue.key.split('-')[0],
    issuetype: f.issuetype?.name || '', subtask: f.issuetype?.subtask ? 1 : 0,
    status: f.status?.name || '', status_cat: f.status?.statusCategory?.key || null, summary: f.summary || '',
    parent_key: f.parent?.key || null, assignee_id: f.assignee?.accountId || null, assignee_name: f.assignee?.displayName || null,
    created_at: f.created || null, updated_at: f.updated || null, resolved_at: f.resolutiondate || null,
    ims_type: vals.imsType, sub_types: JSON.stringify(vals.subTypes), categories: JSON.stringify(vals.categories),
    root_cause: JSON.stringify(vals.rootCause), root_required: vals.rootRequired[0] || null,
    start_date: vals.start, target_end: vals.target, priority: vals.priority, labels: JSON.stringify(vals.labels),
    links: JSON.stringify(links), origin_key: optionValues(f[F.origin])[0] || (typeof f[F.origin] === 'string' ? f[F.origin] : null),
    vals: JSON.stringify(vals), synced_at: now,
  };
}

const COLS = ['issue_id', 'issue_key', 'project_key', 'issuetype', 'subtask', 'status', 'status_cat', 'summary', 'parent_key', 'assignee_id', 'assignee_name',
  'created_at', 'updated_at', 'resolved_at', 'ims_type', 'sub_types', 'categories', 'root_cause', 'root_required', 'start_date', 'target_end',
  'priority', 'labels', 'links', 'origin_key', 'vals', 'synced_at'];
async function saveRows(env, rows) {
  const sql = `INSERT INTO ims_items (${COLS.join(', ')}) VALUES (${ph(COLS.length)})
    ON CONFLICT(issue_id) DO UPDATE SET ${COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`;
  const prev = new Map();
  try {
    for (let i = 0; i < rows.length; i += 90) {
      const part = rows.slice(i, i + 90).map((r) => r.issue_id);
      const { results } = await env.DB.prepare(`SELECT issue_id, assignee_id FROM ims_items WHERE issue_id IN (${ph(part.length)})`).bind(...part).all();
      for (const r of results) prev.set(String(r.issue_id), r);
    }
  } catch { prev.clear(); }
  for (let i = 0; i < rows.length; i += 40) await env.DB.batch(rows.slice(i, i + 40).map((r) => env.DB.prepare(sql).bind(...COLS.map((c) => r[c] ?? null))));
  if (rows.length) await changed(env);
  if (rows.length && (prev.size || await env.DB.prepare('SELECT 1 FROM ims_items LIMIT 1 OFFSET ?').bind(rows.length).first().catch(() => null))) {
    try { await (await import('./notify.js')).imsChanges(env, prev, rows); } catch (err) { console.warn('IMS notifications:', err.message); }
  }
}

export async function changed(env) { await setState(env, 'ims_version', String(Date.now())); kept = null; }

const PROJECTS_JQL = `project in (${[...AREA_KEYS, MAIN].map((k) => `"${k}"`).join(', ')})`;
async function fieldsList(env, b) {
  const F = await fieldMap(env, (p) => b.call(p));
  return { F, list: ['summary', 'status', 'issuetype', 'project', 'parent', 'assignee', 'created', 'updated', 'resolutiondate', 'priority', 'labels', 'issuelinks', 'description',
    ...Object.values(F).filter(Boolean)].join(',') };
}

// Reads changed items (or everything, once a day, a few pages a run). Returns the keys read.
export async function read(env, b) {
  const { F, list } = await fieldsList(env, b);
  const fullAt = Number((await getState(env, 'ims_full_at')) || 0);
  let started = (await getState(env, 'ims_full_started')) || '';
  const full = Boolean(started) || Date.now() - fullAt >= FULL_EVERY_MS;
  if (full && !started) { started = new Date().toISOString(); await setState(env, 'ims_full_started', started); await setState(env, 'ims_full_token', ''); }
  const last = Number((await getState(env, 'ims_read_at')) || 0);
  const jql = full ? `${PROJECTS_JQL} ORDER BY created ASC`
    : `${PROJECTS_JQL} AND updated >= -${Math.ceil((Date.now() - (last || Date.now() - 86400000)) / 60000) + 5}m ORDER BY updated ASC`;
  let token = full ? (await getState(env, 'ims_full_token')) || null : null;
  const keys = [];
  for (;;) {
    const params = new URLSearchParams({ jql, fields: list, maxResults: '100' });
    if (token) params.set('nextPageToken', token);
    const data = await b.call(`/rest/api/3/search/jql?${params}`);
    const rows = (data?.issues || []).map((i) => rowOf(i, F, full ? started : new Date().toISOString()));
    await saveRows(env, rows);
    keys.push(...rows.map((r) => r.issue_key));
    token = data?.nextPageToken || null;
    if (full) await setState(env, 'ims_full_token', token || '');
    if (!token) break;
    if (b.left() < 6) return { keys, more: true };
  }
  if (full) {
    // Items no longer found (deleted, or moved out of the IMS) leave.
    await env.DB.prepare('DELETE FROM ims_items WHERE synced_at < ?').bind(started).run();
    await setState(env, 'ims_full_started', '');
    await setState(env, 'ims_full_at', Date.now());
  }
  await setState(env, 'ims_read_at', Date.now());
  return { keys, full };
}

// ---------- copies of the same item ----------

// The copies joined to these keys by Sync (or clone) links, or naming the same IMS Origin Item, in IMS areas.
export async function groupsFor(env, keys) {
  const seen = new Map();
  let frontier = [...new Set(keys.filter(isArea))];
  const origins = new Set();
  while (frontier.length) {
    const next = [];
    for (let i = 0; i < frontier.length; i += 90) {
      const part = frontier.slice(i, i + 90);
      const { results } = await env.DB.prepare(`SELECT * FROM ims_items WHERE issue_key IN (${ph(part.length)})`).bind(...part).all();
      // Copies naming one of these as their origin.
      const { results: named } = await env.DB.prepare(`SELECT issue_key FROM ims_items WHERE origin_key IN (${ph(part.length)})`).bind(...part).all();
      for (const n of named) if (!seen.has(n.issue_key)) next.push(n.issue_key);
      for (const r of results) {
        if (seen.has(r.issue_key)) continue;
        seen.set(r.issue_key, r);
        for (const l of JSON.parse(r.links || '[]')) if (SYNC_LINKS.test(l.type) && isArea(l.key) && !seen.has(l.key)) next.push(l.key);
        if (r.origin_key && isArea(r.origin_key) && !origins.has(r.origin_key)) { origins.add(r.origin_key); next.push(r.origin_key); }
      }
    }
    // Others naming the same origin.
    const newOrigins = [...origins].filter((o) => !seen.has(`origin:${o}`));
    for (const o of newOrigins) {
      seen.set(`origin:${o}`, null);
      const { results } = await env.DB.prepare('SELECT issue_key FROM ims_items WHERE origin_key = ?').bind(o).all();
      for (const r of results) if (!seen.has(r.issue_key)) next.push(r.issue_key);
    }
    frontier = [...new Set(next)].filter((k) => !seen.has(k));
  }
  const rows = [...seen.values()].filter(Boolean);
  // Split into connected groups, joined only between items of the same type.
  const byKey = new Map(rows.map((r) => [r.issue_key, r]));
  const parent = new Map(rows.map((r) => [r.issue_key, r.issue_key]));
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const join = (a, b) => { if (byKey.has(a) && byKey.has(b) && byKey.get(a).issuetype === byKey.get(b).issuetype) parent.set(find(a), find(b)); };
  for (const r of rows) {
    for (const l of JSON.parse(r.links || '[]')) if (SYNC_LINKS.test(l.type)) join(r.issue_key, l.key);
    if (r.origin_key) join(r.issue_key, r.origin_key);
  }
  const groups = new Map();
  for (const r of rows) { const root = find(r.issue_key); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(r); }
  return [...groups.values()].map((members) => {
    members.sort((a, b) => ms(a.created_at) - ms(b.created_at) || a.issue_key.localeCompare(b.issue_key));
    return { key: members[0].issue_key, members };
  });
}

// Puts each item's group on it, so the list can be read without working the groups out again.
async function stampGroups(env, groups) {
  const stmts = [];
  for (const g of groups) for (const m of g.members) if (m.group_key !== g.key) stmts.push(env.DB.prepare('UPDATE ims_items SET group_key = ? WHERE issue_key = ?').bind(g.key, m.issue_key));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

// ---------- keeping copies in step ----------

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// What each group's copies need, given their values and what was last agreed.
// Returns { base, writes: [{ field, value, from, to: [keys] }], conflicts: [field] }.
// Copies still waiting for a change from the hub aren't taken as having been changed themselves.
export function plan(group, baseRows, waiting = new Set()) {
  const members = group.members.map((m) => ({ ...m, v: JSON.parse(m.vals || '{}') }));
  const base = Object.fromEntries(baseRows.map((r) => [r.field, { value: JSON.parse(r.value ?? 'null'), conflict: Boolean(r.conflict) }]));
  const out = { base: {}, writes: [], conflicts: [] };
  const known = members.filter((m) => m.sync_seen);
  for (const field of Object.keys(SYNCED)) {
    const b = base[field];
    if (!b || b.conflict) {
      // Not agreed yet: agreed now if every copy the hub knows (or all, at first) has the same value.
      const pool = known.length ? known : members;
      const values = pool.map((m) => m.v[field]);
      if (values.every((v) => same(v, values[0]))) {
        out.base[field] = { value: values[0], conflict: false };
        const behind = members.filter((m) => !same(m.v[field], values[0])).map((m) => m.issue_key);
        if (behind.length) out.writes.push({ field, value: values[0], from: pool[0].issue_key, to: behind });
      } else {
        out.base[field] = { value: null, conflict: true };
        out.conflicts.push(field);
      }
      continue;
    }
    // A copy the hub knew, now different from what was agreed: it was changed.
    const moved = known.filter((m) => !waiting.has(m.issue_key) && !same(m.v[field], b.value));
    let value = b.value;
    let from = null;
    if (moved.length) {
      const latest = [...moved].sort((x, y) => ms(y.updated_at) - ms(x.updated_at))[0];
      value = latest.v[field]; from = latest.issue_key;
    }
    const to = members.filter((m) => !same(m.v[field], value)).map((m) => m.issue_key);
    if (to.length) out.writes.push({ field, value, from: from || known[0]?.issue_key || members[0].issue_key, to });
    if (!same(value, b.value)) out.base[field] = { value, conflict: false };
  }
  return out;
}

async function baseOf(env, key) {
  return (await env.DB.prepare('SELECT * FROM ims_sync WHERE group_key = ?').bind(key).all()).results;
}

async function saveBase(env, key, base) {
  const now = new Date().toISOString();
  const stmts = Object.entries(base).map(([field, b]) => env.DB.prepare(`INSERT INTO ims_sync (group_key, field, value, conflict, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(group_key, field) DO UPDATE SET value = excluded.value, conflict = excluded.conflict, at = excluded.at`).bind(key, field, JSON.stringify(b.value ?? null), b.conflict ? 1 : 0, now));
  if (stmts.length) await env.DB.batch(stmts);
}

// Works out what each group needs, and queues it.
export async function syncGroups(env, groups) {
  let queued = 0;
  for (const g of groups) {
    const before = await baseOf(env, g.key);
    const oldCats = before.find((r) => r.field === 'categories' && !r.conflict);
    if (g.members.length < 2) {
      // On its own: only its areas are watched, so an area added later gets a copy.
      const m = g.members[0];
      const cats = JSON.parse(m.vals || '{}').categories || [];
      if (!oldCats || !same(JSON.parse(oldCats.value || '[]'), cats)) await saveBase(env, g.key, { categories: { value: cats, conflict: false } });
      if (oldCats && m.status_cat !== 'done') queued += await queueMissingCopies(env, g, added(JSON.parse(oldCats.value || '[]'), cats));
      if (!m.sync_seen) await env.DB.prepare('UPDATE ims_items SET sync_seen = 1 WHERE issue_key = ?').bind(m.issue_key).run();
      continue;
    }
    const { results: w } = await env.DB.prepare(`SELECT target_key FROM ims_writes WHERE kind = 'sync' AND done_at IS NULL AND attempts < ${MAX_TRIES} AND group_key = ?`).bind(g.key).all();
    const p = plan(g, before, new Set(w.map((x) => x.target_key)));
    await saveBase(env, g.key, p.base);
    // One queued change per copy, with every field it needs.
    const per = new Map();
    for (const w of p.writes) for (const t of w.to) {
      const e = per.get(t) || { fields: {}, from: w.from };
      e.fields[w.field] = w.value;
      per.set(t, e);
    }
    for (const [target, e] of per) {
      await env.DB.prepare('DELETE FROM ims_writes WHERE target_key = ? AND kind = ? AND done_at IS NULL').bind(target, 'sync').run();
      await env.DB.prepare('INSERT INTO ims_writes (group_key, kind, source_key, target_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(g.key, 'sync', e.from, target, JSON.stringify(e.fields), new Date().toISOString()).run();
      queued++;
    }
    await env.DB.prepare(`UPDATE ims_items SET sync_seen = 1 WHERE issue_key IN (${ph(g.members.length)})`).bind(...g.members.map((m) => m.issue_key)).run();
    // Areas added since last time get a copy (areas that were already missing when the hub first looked are left).
    const newCats = p.base.categories && !p.base.categories.conflict ? p.base.categories.value : null;
    if (oldCats && newCats && g.members[0].status_cat !== 'done') queued += await queueMissingCopies(env, g, added(JSON.parse(oldCats.value || '[]'), newCats));
  }
  return { queued };
}

// Sub-tasks kept in step: one under each copy of their parent. A sub-task is kept in step once
// the hub made it, it has copies already, or it was made in Jira after the hub started doing this;
// sub-tasks from before are left where they are.
export async function queueSubtaskCopies(env, groups) {
  let from = await getState(env, 'ims_subtasks_from');
  if (!from) { from = new Date().toISOString(); await setState(env, 'ims_subtasks_from', from); }
  const { results: all } = await env.DB.prepare('SELECT issue_key, group_key, project_key, status_cat, subtask, parent_key, origin_key, created_at FROM ims_items').all();
  const byKey = new Map(all.map((r) => [r.issue_key, r]));
  const gOf = (r) => r.group_key || r.issue_key;
  const parents = new Set();
  for (const g of groups) for (const m of g.members) {
    if (!m.subtask) parents.add(g.key);
    else if (byKey.has(m.parent_key)) parents.add(gOf(byKey.get(m.parent_key)));
  }
  if (!parents.size) return 0;
  const copiesOf = new Map();
  const kidsOf = new Map();
  for (const r of all) {
    if (!r.subtask && parents.has(gOf(r))) copiesOf.set(gOf(r), [...(copiesOf.get(gOf(r)) || []), r]);
  }
  for (const r of all) {
    if (!r.subtask || !byKey.has(r.parent_key)) continue;
    const pg = gOf(byKey.get(r.parent_key));
    if (!parents.has(pg)) continue;
    const m = kidsOf.get(pg) || new Map();
    m.set(gOf(r), [...(m.get(gOf(r)) || []), r]);
    kidsOf.set(pg, m);
  }
  const { results: queued } = await env.DB.prepare("SELECT group_key, target_key FROM ims_writes WHERE kind = 'copy' AND (done_at IS NULL OR error IS NULL)").all();
  const waiting = new Set(queued.map((w) => `${w.group_key}|${w.target_key}`));
  const at = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
  let n = 0;
  for (const [pg, kids] of kidsOf) {
    const copies = (copiesOf.get(pg) || []).filter((c) => isArea(c.issue_key) && c.status_cat !== 'done');
    if (!copies.length) continue;
    for (const [gk, members] of kids) {
      const kept = members.length > 1 || members.some((m) => m.origin_key) || members.every((m) => at(m.created_at) >= from);
      if (!kept) continue;
      const have = new Set(members.map((m) => m.project_key));
      for (const c of copies) {
        if (have.has(c.project_key) || waiting.has(`${gk}|${c.project_key}`)) continue;
        await env.DB.prepare('INSERT INTO ims_writes (group_key, kind, source_key, target_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(gk, 'copy', gk, c.project_key, '{}', new Date().toISOString()).run();
        have.add(c.project_key); waiting.add(`${gk}|${c.project_key}`);
        n++;
      }
    }
  }
  return n;
}

const added = (before, after) => (after || []).filter((x) => !(before || []).includes(x));

async function queueMissingCopies(env, g, categories) {
  if (g.members.some((m) => m.subtask)) return 0;  // sub-tasks follow their parent's copies instead
  const have = new Set(g.members.map((m) => m.project_key));
  let n = 0;
  for (const name of categories || []) {
    const area = areaByName(name);
    if (!area || have.has(area.key)) continue;
    const exists = await env.DB.prepare("SELECT 1 FROM ims_writes WHERE kind = 'copy' AND group_key = ? AND target_key = ? AND (done_at IS NULL OR error IS NULL)").bind(g.key, area.key).first();
    if (exists) continue;
    await env.DB.prepare('INSERT INTO ims_writes (group_key, kind, source_key, target_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(g.key, 'copy', g.key, area.key, '{}', new Date().toISOString()).run();
    n++;
  }
  return n;
}

// The value Jira takes for a field, from the copy the change came from.
function writeValue(name, raw) {
  const def = SYNCED[name];
  switch (def.kind) {
    case 'select': return raw ? { value: raw.value ?? raw } : null;
    case 'multi': return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((o) => ({ value: o?.value ?? o }));
    case 'user': return raw?.accountId ? { accountId: raw.accountId } : null;
    case 'priority': return raw?.id ? { id: raw.id } : raw?.name ? { name: raw.name } : null;
    default: return raw ?? null;
  }
}
const rawOf = (name, f, F) => (SYNCED[name].get ? (name === 'summary' ? f.summary : name === 'description' ? f.description
  : name === 'assignee' ? f.assignee : name === 'priority' ? f.priority : name === 'labels' ? f.labels : null) : f[F[SYNCED[name].field]]);
const jiraFieldId = (name, F) => (SYNCED[name].field ? F[SYNCED[name].field] : name);

async function moveTo(call, key, status) {
  const t = (await call(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`))?.transitions || [];
  const to = t.find((x) => String(x.to?.name).toLowerCase() === String(status).toLowerCase());
  if (!to) throw new Error(`${key} can't be moved to ${status} from where it is.`);
  await call(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: to.id } }) });
}

// Makes one copy match: the fields given, taken from the source copy as Jira has them now.
async function applySync(env, call, w, F) {
  const wanted = JSON.parse(w.payload || '{}');
  const names = Object.keys(wanted).filter((n) => n !== 'status');
  if (names.length) {
    const src = await call(`/rest/api/3/issue/${encodeURIComponent(w.source_key)}?fields=${names.map((n) => jiraFieldId(n, F)).join(',')}`);
    const fields = {};
    for (const n of names) {
      if (n === 'categories') continue;  // each copy keeps its own areas list in step below
      fields[jiraFieldId(n, F)] = writeValue(n, rawOf(n, src?.fields || {}, F));
    }
    if (wanted.categories) fields[F.categories] = writeValue('categories', wanted.categories);
    await call(`/rest/api/3/issue/${encodeURIComponent(w.target_key)}`, { method: 'PUT', body: JSON.stringify({ fields }) });
  }
  if (wanted.status) await moveTo(call, w.target_key, wanted.status);
}

// ---------- making copies ----------

const typeIds = new Map();
async function typeIdIn(call, project, name) {
  const k = `${project}|${name}`;
  if (!typeIds.has(k)) {
    const p = await call(`/rest/api/3/project/${encodeURIComponent(project)}`);
    for (const t of p?.issueTypes || []) typeIds.set(`${project}|${t.name}`, String(t.id));
    const subs = (p?.issueTypes || []).filter((t) => t.subtask);
    const sub = subs.find((t) => t.name === SUBTASK_TYPE) || subs.find((t) => /^sub-?task$/i.test(t.name)) || subs[0];
    if (sub) typeIds.set(`${project}|:subtask`, { id: String(sub.id), name: sub.name });
  }
  return typeIds.get(k) || null;
}
// The type a sub-task is made as: the parent area's own sub-task type.
export const SUBTASK_TYPE = 'Internal Sub-Task';
async function subtaskTypeIn(call, project, preferred) {
  const id = preferred ? await typeIdIn(call, project, preferred) : null;
  if (id && typeof id === 'string') return { id, name: preferred };
  return (await typeIdIn(call, project, ':subtask')) || null;
}

// Makes an issue, leaving off any field Jira won't take (named back), but never the essentials.
async function postIssue(call, fields, keep = ['project', 'issuetype', 'summary', 'parent']) {
  try { return { made: await call('/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) }), left: [] }; } catch (err) {
    if (err.status !== 400) throw err;
    let bad = {};
    try { bad = JSON.parse(String(err.message).replace(/^[^{]*/, '')).errors || {}; } catch { bad = {}; }
    const left = Object.keys(bad).filter((k) => k in fields && !keep.includes(k));
    if (!left.length) throw err;
    for (const k of left) delete fields[k];
    return { made: await call('/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) }), left };
  }
}

// The copy of a parent item in an area: the one in the parent's group made in that area's project.
async function parentCopyIn(env, parentKey, areaKey) {
  if (!parentKey) return null;
  const p = await env.DB.prepare('SELECT issue_key, group_key, project_key FROM ims_items WHERE issue_key = ?').bind(parentKey).first();
  if (!p) return null;
  if (p.project_key === areaKey) return p.issue_key;
  const g = p.group_key || p.issue_key;
  const c = await env.DB.prepare('SELECT issue_key FROM ims_items WHERE (group_key = ? OR issue_key = ?) AND project_key = ? AND subtask = 0 ORDER BY created_at LIMIT 1').bind(g, g, areaKey).first();
  return c?.issue_key || null;
}

// A copy of the group's first item in another area's project, linked to it, in a folder of the same name if there is one.
async function makeCopy(env, call, groupKey, areaKey, F) {
  const src = await call(`/rest/api/3/issue/${encodeURIComponent(groupKey)}?fields=${['summary', 'description', 'issuetype', 'assignee', 'priority', 'labels', 'parent', 'status',
    ...['imsType', 'subTypes', 'categories', 'rootCause', 'rootRequired', 'start', 'target', 'staff', 'containment', 'analysis', 'actions', 'persons', 'finalise', 'fiveWhys', ...COPIED_AS_IS].map((k) => F[k]).filter(Boolean)].join(',')}`);
  const f = src?.fields || {};
  const isSub = Boolean(f.issuetype?.subtask);
  // A sub-task goes under its parent's copy in that area, as that area's sub-task type.
  let underParent = null;
  if (isSub) {
    underParent = await parentCopyIn(env, f.parent?.key, areaKey);
    if (!underParent) throw new Error(`Waiting for ${f.parent?.key || 'its parent'} to have a copy in ${areaKey}.`);
    const twin = await env.DB.prepare('SELECT issue_key, group_key FROM ims_items WHERE parent_key = ? AND subtask = 1 AND lower(summary) = lower(?) LIMIT 1').bind(underParent, f.summary || '').first();
    if (twin && (twin.group_key || twin.issue_key) !== groupKey) {
      // Already there (made in Jira by hand, say): joined to the others rather than made twice.
      await call(`/rest/api/3/issue/${encodeURIComponent(twin.issue_key)}`, { method: 'PUT', body: JSON.stringify({ fields: { [F.origin]: groupKey } }) }).catch(() => {});
      const { syncLinkType, linkBody } = await import('./psc-handoff.js');
      await call('/rest/api/3/issueLink', { method: 'POST', body: JSON.stringify(linkBody(await syncLinkType(env), groupKey, twin.issue_key)) });
      return twin.issue_key;
    }
  }
  const type = isSub ? await subtaskTypeIn(call, areaKey, f.issuetype?.name) : null;
  const typeId = isSub ? type?.id : await typeIdIn(call, areaKey, f.issuetype?.name);
  if (!typeId) throw new Error(`${areaKey} has no ${isSub ? 'sub-task' : f.issuetype?.name} type.`);
  const fields = { project: { key: areaKey }, issuetype: { id: typeId }, summary: f.summary, [F.origin]: groupKey };
  if (underParent) fields.parent = { key: underParent };
  if (f.description) fields.description = f.description;
  for (const n of ['imsType', 'subTypes', 'categories', 'rootCause', 'rootRequired', 'start', 'target', 'containment', 'analysis', 'actions', 'persons', 'finalise', 'fiveWhys']) {
    const id = jiraFieldId(n, F); if (id && f[id] != null) fields[id] = writeValue(n, f[id]);
  }
  if (F.staff && f[F.staff]?.length) fields[F.staff] = f[F.staff].map((u) => ({ accountId: u.accountId }));
  for (const n of COPIED_AS_IS) {
    const v = F[n] ? f[F[n]] : null;
    if (v == null || v === '') continue;
    fields[F[n]] = Array.isArray(v) ? v.map((o) => (o && typeof o === 'object' && 'value' in o ? { value: o.value } : o)) : v && typeof v === 'object' && 'value' in v ? { value: v.value } : v;
  }
  if (f.assignee) fields.assignee = { accountId: f.assignee.accountId };
  if (f.labels?.length) fields.labels = f.labels;
  if (!isSub && f.parent?.fields?.summary) {
    const folder = await env.DB.prepare("SELECT issue_key FROM ims_items WHERE project_key = ? AND issuetype = 'Folder' AND lower(summary) = lower(?) LIMIT 1").bind(areaKey, f.parent.fields.summary).first();
    if (folder) fields.parent = { key: folder.issue_key };
  }
  let made;
  if (isSub) made = (await postIssue(call, fields)).made;
  else {
    try { made = await call('/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) }); } catch (err) {
      if (err.status !== 400) throw err;
      delete fields.parent;
      made = await call('/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
    }
  }
  const { syncLinkType, linkBody } = await import('./psc-handoff.js');
  await call('/rest/api/3/issueLink', { method: 'POST', body: JSON.stringify(linkBody(await syncLinkType(env), groupKey, made.key)) });
  if (f.status?.name && f.status.statusCategory?.key !== 'new') await moveTo(call, made.key, f.status.name).catch(() => {});
  return made.key;
}

// Carries out queued changes and copies, a few each run.
export async function applyWrites(env, b, { limit = WRITES_PER_RUN } = {}) {
  const { results } = await env.DB.prepare(`SELECT * FROM ims_writes WHERE done_at IS NULL AND attempts < ${MAX_TRIES} ORDER BY id LIMIT ?`).bind(limit).all();
  if (!results.length) return { idle: true };
  const F = await fieldMap(env, (p) => b.call(p));
  let done = 0;
  const touched = [];
  for (const w of results) {
    if (b.left() < 5) break;
    try {
      if (w.kind === 'copy') touched.push(await makeCopy(env, (p, i) => b.call(p, i), w.group_key, w.target_key, F));
      else { await applySync(env, (p, i) => b.call(p, i), w, F); touched.push(w.target_key); }
      await env.DB.prepare('UPDATE ims_writes SET done_at = ?, error = NULL, attempts = attempts + 1 WHERE id = ?').bind(new Date().toISOString(), w.id).run();
      done++;
    } catch (err) {
      if (err instanceof OutOfCalls) break;
      await env.DB.prepare('UPDATE ims_writes SET attempts = attempts + 1, error = ? WHERE id = ?').bind(String(err.message).slice(0, 300), w.id).run();
    }
  }
  return { done, touched };
}

// ---------- the background job ----------

export async function run(env, { force = false } = {}) {
  const last = Number((await getState(env, 'ims_read_at')) || 0);
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM ims_writes WHERE done_at IS NULL AND attempts < ?').bind(MAX_TRIES).first().catch(() => null);
  const reading = Boolean(await getState(env, 'ims_full_started'));
  if (!force && !reading && !pending?.n && Date.now() - last < READ_EVERY_MS) return { idle: true };
  const b = budget(env, RUN_CALLS);
  const out = {};
  try {
    if (pending?.n) out.writes = await applyWrites(env, b);
    if (force || reading || Date.now() - last >= READ_EVERY_MS) {
      const r = await read(env, b);
      out.read = r.keys.length;
      // Copies are compared once a full read is finished, or straight away for what changed.
      if (!r.more) {
        const keys = r.full ? (await env.DB.prepare('SELECT issue_key FROM ims_items').all()).results.map((x) => x.issue_key) : r.keys;
        const groups = await groupsFor(env, keys);
        await stampGroups(env, groups);
        out.sync = await syncGroups(env, groups);
        out.subtasks = await queueSubtaskCopies(env, groups).catch((err) => { console.warn('IMS sub-tasks:', err.message); return null; });
        out.main = await moveMainItems(env, b);
        out.onboarding = await startOnboarding(env, b);
        out.gaps = await import('./gaps.js').then((G) => G.sweep(env)).catch(() => null);
      }
    }
  } catch (err) {
    if (!(err instanceof OutOfCalls)) { await setState(env, 'ims_error', `${new Date().toISOString()} ${err.message}`); throw err; }
    out.partial = true;
  }
  return out;
}

// ---------- what the tile shows ----------

let kept = null;
async function allRows(env) {
  const v = (await getState(env, 'ims_version')) || '0';
  if (kept?.v === v) return kept.rows;
  const { results } = await env.DB.prepare('SELECT * FROM ims_items').all();
  kept = { v, rows: results };
  return results;
}

const listOf = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const hasWhys = (r) => { try { return Boolean(JSON.parse(r.vals || '{}').fiveWhys); } catch { return false; } };
const isDone = (r) => r.status_cat === 'done';

// Each item once: its group's first copy, with where the others are.
export function collapse(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!isArea(r.issue_key)) continue;
    const g = r.group_key || r.issue_key;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const byKey = new Map(rows.map((r) => [r.issue_key, r]));
  const children = new Map();
  for (const r of rows) if (r.parent_key) { const c = children.get(r.parent_key) || []; c.push(r); children.set(r.parent_key, c); }
  const out = [];
  for (const [key, members] of groups) {
    members.sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const rep = members.find((m) => m.issue_key === key) || members[0];
    // Each sub-task once, however many copies of it there are.
    const kidGroups = new Map();
    for (const c of members.flatMap((m) => children.get(m.issue_key) || [])) if (c.subtask && !kidGroups.has(c.group_key || c.issue_key)) kidGroups.set(c.group_key || c.issue_key, c);
    const kids = [...kidGroups.values()];
    const folder = rep.parent_key ? byKey.get(rep.parent_key) : null;
    out.push({
      key: rep.issue_key, summary: rep.summary, type: rep.issuetype, subtask: Boolean(rep.subtask), status: rep.status, done: isDone(rep),
      imsType: rep.ims_type, subTypes: listOf(rep.sub_types), categories: listOf(rep.categories), rootCause: listOf(rep.root_cause), rootRequired: rep.root_required,
      assignee: rep.assignee_name, assigneeId: rep.assignee_id, created: rep.created_at, resolved: rep.resolved_at, updated: members.map((m) => m.updated_at).sort().pop(),
      start: rep.start_date, target: rep.target_end, priority: rep.priority, parent: rep.parent_key, folder: folder?.issuetype === 'Folder' ? folder.summary : null,
      parentType: rep.subtask ? folder?.issuetype || null : null,
      whys: hasWhys(rep),
      areas: [...new Set(members.map((m) => m.project_key))],
      copies: members.map((m) => ({ key: m.issue_key, project: m.project_key, status: m.status })),
      subtasks: { done: kids.filter(isDone).length, all: kids.length },
    });
  }
  return out;
}

export async function list(env, viewer, { done = false } = {}) {
  mustSee(viewer);
  const rows = await allRows(env);
  const items = collapse(rows).filter((i) => !NOT_WORK.includes(i.type) && !GAP_TYPES.includes(i.type) && inIms(i) && (done || !i.done));
  // How each area stands, from everything open in it: red for an open incident,
  // non-conformity or 8D report, blue for other open work, green for nothing open.
  const areaState = areaStates(rows);
  const writes = await env.DB.prepare('SELECT target_key, kind, error FROM ims_writes WHERE done_at IS NULL').all().catch(() => ({ results: [] }));
  const conflicts = await liveConflicts(env, 'SELECT group_key, COUNT(*) AS n FROM ims_sync WHERE conflict = 1 GROUP BY group_key');
  const conflictMap = Object.fromEntries(conflicts.results.map((c) => [c.group_key, c.n]));
  for (const i of items) if (conflictMap[i.key]) i.conflicts = conflictMap[i.key];
  return {
    areas: AREAS.map(({ key, name }) => ({ key, name, ...areaState[key] })), items, me: viewer.accountId || null,
    readAt: Number((await getState(env, 'ims_read_at')) || 0) || null,
    reading: Boolean(await getState(env, 'ims_full_started')),
    pending: writes.results.length, failing: writes.results.filter((w) => w.error).length,
    disagreeing: conflicts.results.length,
    main: await mainNote(env),
    onboarding: await getState(env, 'ims_onboarding_note').then((x) => JSON.parse(x || 'null')).catch(() => null),
  };
}

// ---------- 5 Whys ----------

// Kept in Jira as a table: the problem, then each why in turn; the last is the root cause.
const cleanWhys = (w) => {
  if (!w || typeof w !== 'object') return null;
  const problem = String(w.problem || '').trim().slice(0, 2000);
  const list = (Array.isArray(w.list) ? w.list : []).map((x) => String(x || '').trim().slice(0, 2000)).filter(Boolean).slice(0, 12);
  return problem || list.length ? { problem, list } : null;
};
export function whysAdf(w) {
  const c = cleanWhys(w);
  if (!c) return null;
  const rows = [['Problem', c.problem || '-'], ...c.list.map((x, n) => [n === c.list.length - 1 ? `Why ${n + 1} (root cause)` : `Why ${n + 1}`, x])];
  return docOf(adfTable(['', 'Answer'], rows, { boldFirstColumn: true }));
}
const textOf = (node) => (!node ? '' : node.type === 'text' ? node.text || '' : node.type === 'hardBreak' ? '\n'
  : (node.content || []).map(textOf).join(node.type === 'tableCell' || node.type === 'doc' ? '\n' : '').trim());
// Back from Jira: the table if it's one the hub wrote (or laid out the same way), otherwise its text.
export function whysFrom(adf) {
  if (!adf) return null;
  if (typeof adf === 'string') return adf.trim() ? { problem: '', list: [], text: adf.trim() } : null;
  const table = (adf.content || []).find((n) => n.type === 'table');
  if (table) {
    const out = { problem: '', list: [] };
    for (const r of table.content || []) {
      const [label, answer] = (r.content || []).map((cell) => textOf(cell).trim());
      if (/^problem/i.test(label || '')) out.problem = answer || '';
      else if (/^why/i.test(label || '') && answer) out.list.push(answer);
    }
    if (out.problem === '-') out.problem = '';
    if (out.problem || out.list.length) return out;
  }
  const text = textOf(adf).trim();
  return text ? { problem: '', list: [], text } : null;
}
const whysText = (w) => { const c = cleanWhys(w); return c ? [c.problem && `Problem: ${c.problem}`, ...c.list.map((x, n) => `Why ${n + 1}: ${x}`)].filter(Boolean).join(' / ').slice(0, 500) : 'Cleared'; };

// ---------- the numbers ----------

// Operational Improvements also holds product ideas and features; only its IMS work counts.
export const SUGGEST_TYPES = ['IMS Task', '8D Report', 'Incident'];
// A sub-task goes by the item it's under.
export const inIms = (i) => !(i.areas.length && i.areas.every((a) => a === 'SUGGEST') && !SUGGEST_TYPES.includes(i.subtask && i.parentType ? i.parentType : i.type));
// What the numbers count: IMS work, sub-tasks included (many non-conformities are raised as sub-tasks), but not meeting sub-tasks.
const NOT_COUNTED = ['Meeting (Subtask)', ...GAP_TYPES];
export const counted = (i) => !NOT_WORK.includes(i.type) && !NOT_COUNTED.includes(i.type) && inIms(i);
// Non-conformities and incidents; 8D reports are counted on their own. Any of them turns an area red.
export const is8D = (i) => i.type === '8D Report';
export const isNC = (i) => !is8D(i) && (i.imsType === 'Non-Conformity' || i.type === 'Incident');
export const isRed = (i) => isNC(i) || is8D(i);

// How each area stands, from everything open in it: red for an open incident, non-conformity
// or 8D report, blue for other open work, green for nothing open.
export function areaStates(rows) {
  const open = collapse(rows).filter((i) => counted(i) && !i.done);
  return Object.fromEntries(AREAS.map((a) => {
    const here = open.filter((i) => i.areas.includes(a.key));
    return [a.key, { open: here.length, nc: here.filter(isNC).length, eightD: here.filter(is8D).length, state: here.some(isRed) ? 'red' : here.length ? 'blue' : 'green' }];
  }));
}

// The IMS Main Board's Category item for each area follows it: Active Incident while an incident,
// non-conformity or 8D report is open there, Active Tasks while other work is, Clear when nothing is.
// So it only comes down a step once everything at the step above is closed. Moved by hand, it's put back.
export const MAIN_STATUS = { red: 'Active Incident', blue: 'Active Tasks', green: 'Clear' };
export async function moveMainItems(env, b) {
  const { results: rows } = await env.DB.prepare('SELECT * FROM ims_items').all();
  const states = areaStates(rows);
  const byKey = new Map(rows.map((r) => [r.issue_key, r]));
  const moved = []; const failed = [];
  for (const a of AREAS) {
    const item = byKey.get(a.main);
    if (!item) continue;
    const want = MAIN_STATUS[states[a.key].state];
    if (String(item.status || '').toLowerCase() === want.toLowerCase()) continue;
    if (b.left() < 3) break;
    try {
      await moveTo((p, i) => b.call(p, i), a.main, want);
      await env.DB.prepare('UPDATE ims_items SET status = ? WHERE issue_key = ?').bind(want, a.main).run();
      moved.push({ key: a.main, area: a.key, from: item.status, to: want });
      await record(env, { email: 'hub', employee: { name: 'The hub' } }, { area: 'IMS', action: `moved the ${a.name} category to ${want}`, subjectType: 'ims', subjectId: a.main,
        label: `${a.main} ${a.name}`, changes: [{ label: 'Status', before: item.status, after: want }] }).catch(() => {});
    } catch (err) {
      if (err instanceof OutOfCalls) throw err;
      failed.push({ key: a.main, area: a.key, to: want, error: String(err.message || err).slice(0, 200) });
    }
  }
  if (moved.length) await changed(env);
  const prev = await mainNote(env);
  await setState(env, 'ims_main_note', JSON.stringify({ at: Date.now(), moved: moved.length ? moved : prev?.moved || [], movedAt: moved.length ? Date.now() : prev?.movedAt || null, failed }));
  return { moved: moved.length, failed: failed.length };
}
// Preboarding: Jira's automation adds its sub-tasks; once every one is done, Onboarding is added
// alongside Preboarding, which starts Jira's next automation. Done once: an item with Onboarding is left.
export const PREBOARDING = 'Preboarding';
export const ONBOARDING = 'Onboarding';
export const PREBOARDING_AREA = 'IS';
export async function startOnboarding(env, b) {
  const { results: rows } = await env.DB.prepare('SELECT * FROM ims_items').all();
  const waiting = rows.filter((r) => !r.subtask && listOf(r.sub_types).includes(PREBOARDING) && !listOf(r.sub_types).includes(ONBOARDING));
  if (!waiting.length) return { added: 0 };
  const F = await fieldMap(env, (p) => b.call(p));
  if (!F.subTypes) return { added: 0 };
  const done = new Set();
  let added = 0; const failed = [];
  for (const r of waiting) {
    const groupKey = r.group_key || r.issue_key;
    if (done.has(groupKey)) continue;
    done.add(groupKey);
    const members = rows.filter((m) => (m.group_key || m.issue_key) === groupKey && !m.subtask);
    const keys = new Set(members.map((m) => m.issue_key));
    const kids = rows.filter((k) => k.subtask && keys.has(k.parent_key) && k.issuetype !== 'Meeting (Subtask)');
    if (!kids.length || !kids.every((k) => k.status_cat === 'done')) continue;
    const subs = [...new Set([...listOf(r.sub_types), ONBOARDING])].sort();
    if (b.left() < members.length + 2) break;
    try {
      for (const m of members) await b.call(`/rest/api/3/issue/${encodeURIComponent(m.issue_key)}`, { method: 'PUT', body: JSON.stringify({ fields: { [F.subTypes]: subs.map((value) => ({ value })) } }) });
    } catch (err) {
      if (err instanceof OutOfCalls) throw err;
      failed.push({ key: groupKey, error: String(err.message || err).slice(0, 200) });
      continue;
    }
    for (const m of members) {
      const vals = { ...JSON.parse(m.vals || '{}'), subTypes: subs };
      await env.DB.prepare('UPDATE ims_items SET sub_types = ?, vals = ? WHERE issue_key = ?').bind(JSON.stringify(subs), JSON.stringify(vals), m.issue_key).run();
    }
    await saveBase(env, groupKey, { subTypes: { value: subs, conflict: false } });
    await record(env, { email: 'hub', employee: { name: 'The hub' } }, { area: 'IMS', action: 'added Onboarding, the preboarding sub-tasks being done', subjectType: 'ims', subjectId: groupKey,
      label: `${groupKey} ${r.summary}`.slice(0, 120), changes: [{ label: 'Sub-type', before: listOf(r.sub_types).join(', '), after: subs.join(', ') }] }).catch(() => {});
    added++;
  }
  if (added) await changed(env);
  await setState(env, 'ims_onboarding_note', JSON.stringify({ at: Date.now(), failed }));
  return { added, failed: failed.length };
}

async function mainNote(env) {
  try { return JSON.parse((await getState(env, 'ims_main_note')) || 'null'); } catch { return null; }
}

// Copies made before the Sync links were in place: the same summary and type, raised in
// different areas within the hour. Counted once in the numbers, and listed to be linked up.
const COPY_WINDOW_MS = 60 * 60 * 1000;
export function likelyCopies(items, { subtasks = false } = {}) {
  const bySum = new Map();
  for (const i of items) {
    if (i.subtask && !subtasks) continue;
    const k = `${String(i.summary || '').trim().toLowerCase()}|${i.type}`;
    (bySum.get(k) || bySum.set(k, []).get(k)).push(i);
  }
  const sets = [];
  for (const list of bySum.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => ms(a.created) - ms(b.created));
    let cur = [list[0]];
    const flush = () => { if (cur.length > 1 && new Set(cur.flatMap((x) => x.areas)).size > 1) sets.push(cur); };
    for (const i of list.slice(1)) {
      // A copy lives in another area: one sharing an area with the set is its own item.
      if (ms(i.created) - ms(cur[0].created) <= COPY_WINDOW_MS && !cur.some((x) => x.areas.some((a) => i.areas.includes(a)))) cur.push(i);
      else { flush(); cur = [i]; }
    }
    flush();
  }
  return sets;
}
function mergeCopies(items) {
  const gone = new Set();
  const merged = new Map();
  for (const set of likelyCopies(items, { subtasks: true })) {
    const [first, ...rest] = set;
    merged.set(first.key, { ...first, areas: [...new Set(set.flatMap((x) => x.areas))], alsoKeys: rest.map((x) => x.key) });
    rest.forEach((x) => gone.add(x.key));
  }
  return items.filter((i) => !gone.has(i.key)).map((i) => merged.get(i.key) || i);
}

const monthOf = (iso) => (iso ? iso.slice(0, 7) : null);
export function lastMonths(n, now = new Date()) {
  const out = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
}
const endOf = (m) => Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1) - 1;
// Counts with the items behind them, so any number can be opened.
const tally = (pairs) => {
  const m = new Map();
  for (const [name, key] of pairs) { const e = m.get(name) || { name, n: 0, keys: [] }; e.n++; e.keys.push(key); m.set(name, e); }
  return [...m.values()].sort((a, b) => (a.name === 'Not set') - (b.name === 'Not set') || b.n - a.n);
};
const NOT_SET = 'Not set';
const rootNeeded = (i) => /^yes$/i.test(i.rootRequired || '') || ['Incident', '8D Report'].includes(i.type);
const rootCounts = (i) => !/^no$/i.test(i.rootRequired || '') || ['Incident', '8D Report'].includes(i.type);

export function statsOf(allItems, { area = null, month = null, now = new Date() } = {}) {
  let work = mergeCopies(allItems.filter(counted));
  if (area) work = work.filter((i) => i.areas.includes(area));
  const months = lastMonths(24, now);
  const shown = months.slice(-12);
  const end = month ? Math.min(endOf(month), +now) : +now;
  const endDay = new Date(end).toISOString().slice(0, 10);
  const closedBy = (i, t) => i.done && (!i.resolved || ms(i.resolved) <= t);
  const openAt = (i, t) => ms(i.created) <= t && !closedBy(i, t);
  const inPeriod = (iso) => Boolean(iso) && (month ? monthOf(iso) === month : shown.includes(monthOf(iso)));
  const open = work.filter((i) => openAt(i, end));
  const raised = work.filter((i) => inPeriod(i.created));
  const closed = work.filter((i) => i.done && inPeriod(i.resolved));
  const nc = (xs) => xs.filter(isNC);
  const e8 = (xs) => xs.filter(is8D);
  const days = closed.map((i) => (ms(i.resolved) - ms(i.created)) / 86400000).filter((d) => d >= 0).sort((a, b) => a - b);
  const keys = (xs) => xs.map((i) => i.key);
  const sets = {
    open: keys(open), overdue: keys(open.filter((i) => i.target && i.target < endDay)), raised: keys(raised), closed: keys(closed),
    ncRaised: keys(nc(raised)), ncClosed: keys(nc(closed)), ncOpen: keys(nc(open)), ncOld: keys(nc(open).filter((i) => ms(i.created) < end - 30 * 86400000)),
    eightRaised: keys(e8(raised)), eightClosed: keys(e8(closed)), eightOpen: keys(e8(open)), eightOld: keys(e8(open).filter((i) => ms(i.created) < end - 30 * 86400000)),
    rootMissing: keys([...new Set([...open, ...closed])].filter((i) => rootNeeded(i) && !i.rootCause.length)),
    // A root cause chosen without a 5 Whys to show how it was reached: encouraged, not required.
    noWhys: keys([...new Set([...open, ...closed])].filter((i) => rootCounts(i) && i.rootCause.length && !i.whys)),
  };
  const used = new Set(Object.values(sets).flat());
  const breakdown = (xs, f) => { const t = tally(xs.flatMap((i) => { const v = f(i); return (v.length ? v : [NOT_SET]).map((n) => [n, i.key]); })); t.forEach((e) => e.keys.forEach((k) => used.add(k))); return t; };
  const out = {
    months: shown.map((m) => {
      const t = Math.min(endOf(m), +now);
      return { month: m, raised: work.filter((i) => monthOf(i.created) === m).length, closed: work.filter((i) => i.done && monthOf(i.resolved) === m).length,
        ncRaised: nc(work).filter((i) => monthOf(i.created) === m).length, ncClosed: nc(work).filter((i) => i.done && monthOf(i.resolved) === m).length,
        eightRaised: e8(work).filter((i) => monthOf(i.created) === m).length, eightClosed: e8(work).filter((i) => i.done && monthOf(i.resolved) === m).length,
        open: work.filter((i) => openAt(i, t)).length, ncOpen: nc(work).filter((i) => openAt(i, t)).length, eightOpen: e8(work).filter((i) => openAt(i, t)).length };
    }),
    asAt: endDay,
    totals: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.length])),
    medianDaysToClose: days.length ? Math.round(days[Math.floor(days.length / 2)]) : null,
    sets,
    openByType: breakdown(open, (i) => (i.imsType ? [i.imsType] : [])),
    raisedByType: breakdown(raised, (i) => (i.imsType ? [i.imsType] : [])),
    // Items marked as not needing a root cause are left out of the root cause charts.
    // "Not set" only counts items that need a root cause, not those nobody has decided on.
    rootCauses: breakdown(raised.filter((i) => rootCounts(i) && (i.rootCause.length || rootNeeded(i))), (i) => i.rootCause),
    rootCausesOpen: breakdown(open.filter((i) => rootCounts(i) && (i.rootCause.length || rootNeeded(i))), (i) => i.rootCause),
    subTypes: breakdown(open, (i) => i.subTypes),
    openByAssignee: breakdown(open, (i) => (i.assignee ? [i.assignee] : [])).map((e) => (e.name === NOT_SET ? { ...e, name: 'Unassigned' } : e)),
    openByArea: AREAS.map((a) => {
      const here = open.filter((i) => i.areas.includes(a.key));
      return { key: a.key, name: a.name, n: here.length, keys: keys(here), incidents: here.filter(isRed).length, incidentKeys: keys(here.filter(isRed)),
        eightD: here.filter(is8D).length, eightDKeys: keys(here.filter(is8D)) };
    }),
    // The most recent of each, raised by the end of the period.
    latest: Object.fromEntries([
      ['incident', (i) => i.type === 'Incident'],
      ['nc', (i) => i.imsType === 'Non-Conformity' && !is8D(i) && i.type !== 'Incident'],
      ['eightD', is8D],
    ].map(([k, f]) => {
      const last = work.filter((i) => f(i) && ms(i.created) <= end).sort((a, b) => ms(b.created) - ms(a.created))[0];
      if (last) used.add(last.key);
      return [k, last ? { key: last.key, summary: last.summary, created: last.created, days: Math.max(0, Math.floor((end - ms(last.created)) / 86400000)), done: last.done } : null];
    })),
  };
  out.openByArea.forEach((a) => a.keys.forEach((k) => used.add(k)));
  const byKey = new Map(work.map((i) => [i.key, i]));
  out.items = Object.fromEntries([...used].map((k) => byKey.get(k)).filter(Boolean).map((i) => [i.key, {
    key: i.key, summary: i.summary, type: i.type, imsType: i.imsType, status: i.status, done: i.done, areas: i.areas, assignee: i.assignee, assigneeId: i.assigneeId,
    rootCause: i.rootCause, rootRequired: i.rootRequired, whys: Boolean(i.whys), subTypes: i.subTypes, created: i.created, resolved: i.resolved, target: i.target, alsoKeys: i.alsoKeys || [],
  }]));
  return out;
}

export async function stats(env, viewer, { area = null, month = null } = {}) {
  mustSee(viewer);
  if (area && !AREA_KEYS.includes(area)) throw refuse('That isn\'t an IMS area.');
  if (month && !/^\d{4}-\d{2}$/.test(month)) throw refuse('Give the month as YYYY-MM.');
  const items = collapse(await allRows(env));
  return { area, month, ...statsOf(items, { area, month }) };
}

// Everything to tidy by hand: items whose copies disagree, and copies that were never linked.
export async function cleanup(env, viewer) {
  mustSee(viewer);
  const rows = await allRows(env);
  const items = collapse(rows);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const rowByKey = new Map(rows.map((r) => [r.issue_key, r]));
  const { results } = await liveConflicts(env, 'SELECT group_key, field FROM ims_sync WHERE conflict = 1 ORDER BY group_key');
  const groups = new Map();
  for (const r of results) (groups.get(r.group_key) || groups.set(r.group_key, []).get(r.group_key)).push(r.field);
  const show = (v) => (Array.isArray(v) ? v.join(', ') : v == null || v === '' ? 'Not set' : String(v));
  const disagree = [...groups].map(([g, fields]) => {
    const i = byKey.get(g);
    if (!i) return null;
    const latest = [...i.copies].sort((a, b) => String(rowByKey.get(b.key)?.updated_at || '').localeCompare(String(rowByKey.get(a.key)?.updated_at || '')))[0]?.key || null;
    return { key: g, summary: i.summary, type: i.type, done: i.done, areas: i.areas, latest,
      fields: fields.map((f) => ({ field: f, label: SYNCED[f]?.label || f,
        values: i.copies.map((c) => ({ key: c.key, project: c.project, value: f === 'status' ? c.status : f === 'assignee' ? (rowByKey.get(c.key)?.assignee_name || 'Unassigned') : show(JSON.parse(rowByKey.get(c.key)?.vals || '{}')[f]) })) })) };
  }).filter(Boolean).sort((a, b) => Number(a.done) - Number(b.done) || a.key.localeCompare(b.key));
  const unlinked = likelyCopies(items.filter((i) => !NOT_WORK.includes(i.type) && inIms(i)))
    .map((set) => set.map((i) => ({ key: i.key, summary: i.summary, type: i.type, status: i.status, done: i.done, areas: i.areas, created: i.created })));
  return { disagree, unlinked };
}

// ---------- one item ----------

export async function item(env, viewer, key) {
  mustSee(viewer);
  const k = String(key || '').toUpperCase();
  if (!isArea(k) && !k.startsWith(`${MAIN}-`)) throw refuse('That isn\'t an IMS item.');
  const row = await env.DB.prepare('SELECT * FROM ims_items WHERE issue_key = ?').bind(k).first();
  if (!row) throw refuse('That item isn\'t in the IMS list. It may be new: try again in a few minutes.', 404);
  const groupKey = row.group_key || row.issue_key;
  const { results: members } = await env.DB.prepare('SELECT * FROM ims_items WHERE group_key = ? OR issue_key = ?').bind(groupKey, groupKey).all();
  const keys = members.map((m) => m.issue_key);
  const { results: kids } = await env.DB.prepare(`SELECT issue_key, group_key, summary, status, status_cat, issuetype, assignee_name, project_key, target_end, vals, created_at FROM ims_items WHERE subtask = 1 AND parent_key IN (${ph(keys.length)}) ORDER BY created_at`).bind(...keys).all();
  // Each sub-task once, with the areas it has a copy in.
  const subs = new Map();
  for (const x of kids) {
    if (NOT_WORK.includes(x.issuetype)) continue;
    const gk = x.group_key || x.issue_key;
    const s = subs.get(gk);
    if (s) { s.areas = [...new Set([...s.areas, x.project_key])]; s.copies.push(x.issue_key); continue; }
    subs.set(gk, { key: x.issue_key, summary: x.summary, status: x.status, done: x.status_cat === 'done', assignee: x.assignee_name, target: x.target_end, whys: hasWhys(x),
      areas: [x.project_key], copies: [x.issue_key] });
  }
  for (const s of subs.values()) {
    // Shown from the copy in this item's own area where there is one.
    const own = kids.find((x) => s.copies.includes(x.issue_key) && x.project_key === row.project_key);
    if (own) Object.assign(s, { key: own.issue_key, status: own.status, done: own.status_cat === 'done', assignee: own.assignee_name });
  }
  // A sub-task's parent, for the way back.
  let parent = null;
  if (row.subtask && row.parent_key) {
    const p = await env.DB.prepare('SELECT issue_key, group_key, summary, issuetype FROM ims_items WHERE issue_key = ?').bind(row.parent_key).first();
    if (p && !NOT_WORK.includes(p.issuetype)) parent = { key: p.issue_key, summary: p.summary, type: p.issuetype };
  }
  const base = await baseOf(env, groupKey);
  const conflicts = base.filter((b) => b.conflict).map((b) => ({
    field: b.field, label: SYNCED[b.field]?.label || b.field,
    values: members.map((m) => ({ key: m.issue_key, project: m.project_key, value: JSON.parse(m.vals || '{}')[b.field] })),
  }));
  const { results: waiting } = await env.DB.prepare(`SELECT kind, target_key, error FROM ims_writes WHERE done_at IS NULL AND (group_key = ? OR target_key IN (${ph(keys.length)}))`).bind(groupKey, ...keys).all();
  const { viewItem } = await import('./jiraview.js');
  const view = await viewItem(env, groupKey);
  const rep = collapse(members.map((m) => ({ ...m, group_key: groupKey })))[0];
  const meetings = JSON.parse(row.links || '[]').filter((l) => l.key.startsWith(`${MAIN}-`));
  const F = await fieldMap(env);
  let whys = null;
  let whysOnScreen = Boolean(F.fiveWhys);
  let moves = null;
  if (F.fiveWhys) {
    const got = await jira(env, `/rest/api/3/issue/${encodeURIComponent(groupKey)}?fields=${F.fiveWhys}`).catch(() => null);
    whys = whysFrom(got?.fields?.[F.fiveWhys]);
  }
  if (row.subtask) {
    // A sub-task's screen may not have the 5 Whys, and its workflow its own statuses.
    const meta = await jira(env, `/rest/api/3/issue/${encodeURIComponent(groupKey)}/editmeta`).catch(() => null);
    if (meta?.fields && F.fiveWhys) whysOnScreen = F.fiveWhys in meta.fields;
    const t = await jira(env, `/rest/api/3/issue/${encodeURIComponent(groupKey)}/transitions`).catch(() => null);
    if (t?.transitions) moves = [...new Set([rep.status, ...t.transitions.map((x) => x.to?.name).filter(Boolean)])];
  }
  return { whys, whysField: Boolean(F.fiveWhys), whysOnScreen, moves, parent, item: rep, copies: members.map((m) => ({ key: m.issue_key, project: m.project_key, status: m.status, updated: m.updated_at })),
    subtasks: [...subs.values()], conflicts, waiting, view, meetings };
}

// ---------- changing it, everywhere ----------

const EDITABLE = ['summary', 'status', 'assignee', 'imsType', 'subTypes', 'categories', 'rootCause', 'rootRequired', 'start', 'target', 'fiveWhys'];

// Writes the change to every copy now; anything Jira refuses is queued and tried again.
export async function edit(env, viewer, { key, changes = {} }) {
  mustSee(viewer);
  const row = await env.DB.prepare('SELECT * FROM ims_items WHERE issue_key = ?').bind(String(key || '')).first();
  if (!row) throw refuse('That item isn\'t in the IMS list.', 404);
  const names = Object.keys(changes).filter((n) => EDITABLE.includes(n));
  if (!names.length) throw refuse('Nothing to change.');
  if (names.includes('summary') && String(changes.summary || '').trim().length < 3) throw refuse('Give it a summary.');
  if (names.includes('categories') && !(changes.categories || []).length) throw refuse('Leave it in at least one area.');
  const F = await fieldMap(env);
  const groupKey = row.group_key || row.issue_key;
  const { results: members } = await env.DB.prepare('SELECT * FROM ims_items WHERE group_key = ? OR issue_key = ?').bind(groupKey, groupKey).all();
  const fields = {};
  const base = {};
  for (const n of names) {
    if (n === 'status') continue;
    const v = changes[n];
    const def = SYNCED[n];
    if (n === 'fiveWhys') {
      // Written as a table; the copies' text is compared by its hash, as Jira gives it back.
      const adf = whysAdf(v);
      fields[jiraFieldId(n, F)] = adf;
      base[n] = { value: adf ? `#${hash(JSON.stringify(adf))}` : null, conflict: false };
      continue;
    }
    const val = def.kind === 'multi' ? (Array.isArray(v) ? v.map(String) : []) : def.kind === 'date' ? (v || null) : n === 'summary' ? String(v).trim().slice(0, 250) : (v || null);
    fields[jiraFieldId(n, F)] = def.kind === 'select' ? (val ? { value: val } : null) : def.kind === 'multi' ? val.map((x) => ({ value: x }))
      : def.kind === 'user' ? (val ? { accountId: val } : null) : val;
    base[n] = { value: def.kind === 'multi' ? [...val].sort() : val, conflict: false };
  }
  if (changes.status) base.status = { value: String(changes.status), conflict: false };
  const b = budget(env, 40);
  const failed = [];
  for (const m of members) {
    try {
      if (Object.keys(fields).length) await b.call(`/rest/api/3/issue/${encodeURIComponent(m.issue_key)}`, { method: 'PUT', body: JSON.stringify({ fields }) });
      if (changes.status && m.status !== changes.status) await moveTo((p, i) => b.call(p, i), m.issue_key, changes.status);
    } catch (err) {
      failed.push(`${m.issue_key}: ${err.message}`);
      await env.DB.prepare('INSERT INTO ims_writes (group_key, kind, source_key, target_key, payload, created_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(groupKey, 'sync', members.find((x) => x !== m)?.issue_key || m.issue_key, m.issue_key, JSON.stringify(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.value]))), new Date().toISOString(), String(err.message).slice(0, 300)).run();
    }
  }
  // What everyone now agrees on; the next read fills in the rest.
  await saveBase(env, groupKey, base);
  for (const m of members) {
    const vals = { ...JSON.parse(m.vals || '{}'), ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.value])) };
    await env.DB.prepare(`UPDATE ims_items SET vals = ?, summary = COALESCE(?, summary), ims_type = ?, sub_types = ?, categories = ?, root_cause = ?, root_required = ?,
      start_date = ?, target_end = ?, assignee_id = ?, status = COALESCE(?, status) WHERE issue_key = ?`).bind(JSON.stringify(vals), changes.summary ? String(changes.summary).trim() : null,
      vals.imsType ?? null, JSON.stringify(vals.subTypes || []), JSON.stringify(vals.categories || []), JSON.stringify(vals.rootCause || []), (vals.rootRequired || [])[0] || null,
      vals.start ?? null, vals.target ?? null, vals.assignee ?? null, changes.status || null, m.issue_key).run();
  }
  if (names.includes('categories')) await queueMissingCopies(env, { key: groupKey, members }, added(JSON.parse(row.categories || '[]'), changes.categories));
  await changed(env);
  await record(env, viewer, { area: 'IMS', action: 'changed an IMS item', subjectType: 'ims', subjectId: groupKey, label: `${groupKey} ${row.summary}`.slice(0, 120),
    changes: names.map((n) => ({ label: SYNCED[n].label, before: '', after: n === 'fiveWhys' ? whysText(changes[n]) : Array.isArray(changes[n]) ? changes[n].join(', ') : String(changes[n] ?? '') })) }).catch(() => {});
  return { ok: true, copies: members.length, failed };
}

// ---------- sub-tasks ----------

// A sub-task under an item: made under its first copy, then copied under each of the others,
// so every area's copy has it and the copies are kept in step like any other item.
export async function addSubtask(env, viewer, input = {}) {
  mustSee(viewer);
  const row = await env.DB.prepare('SELECT * FROM ims_items WHERE issue_key = ?').bind(String(input.parent || '').toUpperCase()).first();
  if (!row || !isArea(row.issue_key)) throw refuse('That item isn\'t in the IMS list.', 404);
  if (row.subtask) throw refuse('A sub-task can\'t have sub-tasks of its own.');
  const summary = String(input.summary || '').trim().replace(/\s+/g, ' ').slice(0, 250);
  if (summary.length < 3) throw refuse('Give the sub-task a summary.');
  const rootRequired = String(input.rootRequired || '');
  if (rootRequired && !['Yes', 'No'].includes(rootRequired)) throw refuse('Say whether a root cause is required.');
  const groupKey = row.group_key || row.issue_key;
  const { results: members } = await env.DB.prepare('SELECT * FROM ims_items WHERE (group_key = ? OR issue_key = ?) AND subtask = 0 ORDER BY created_at').bind(groupKey, groupKey).all();
  const home = members.find((m) => m.issue_key === groupKey) || members[0] || row;
  const b = budget(env, 40);
  const call = (p, i) => b.call(p, i);
  const F = await fieldMap(env, (p) => b.call(p));
  const type = await subtaskTypeIn(call, home.project_key, SUBTASK_TYPE);
  if (!type) throw refuse(`${AREAS.find((a) => a.key === home.project_key)?.name || home.project_key} has no sub-task type in Jira.`);
  const meta = await createMeta(env, home.project_key, type.name).catch(() => null);
  const onForm = (id) => !meta || Object.values(meta.byName).some((f) => f.id === id);
  const { adfFrom } = await import('./jiraview.js');
  const description = String(input.description || '').trim();
  const fields = { project: { key: home.project_key }, issuetype: { id: type.id }, parent: { key: home.issue_key }, summary };
  if (description) fields.description = adfFrom(description);
  if (input.assigneeId) fields.assignee = { accountId: String(input.assigneeId) };
  if (isoDay(input.start) && F.start && onForm(F.start)) fields[F.start] = input.start;
  if (isoDay(input.target) && F.target && onForm(F.target)) fields[F.target] = input.target;
  const cats = listOf(home.categories);
  if (cats.length && F.categories && onForm(F.categories)) fields[F.categories] = cats.map((value) => ({ value }));
  const rr = meta?.byName['is root cause required?'] || (F.rootRequired ? { id: F.rootRequired, schema: { type: 'array', items: 'option' } } : null);
  if (rootRequired && rr && onForm(rr.id)) fields[rr.id] = valueFor(rr, rootRequired);
  const whys = whysAdf(input.whys);
  const whysId = meta?.byName['5 whys']?.id || F.fiveWhys;
  if (whys && whysId) fields[whysId] = whys;
  const { made, left } = await postIssue(call, fields);
  const skipped = left.map((k) => (k === whysId ? '5 Whys' : k === rr?.id ? 'Root cause required' : Object.values(meta?.byName || {}).find((f) => f.id === k)?.name || k));
  // It names itself as its origin, so the copies made from it are one sub-task.
  await call(`/rest/api/3/issue/${made.key}`, { method: 'PUT', body: JSON.stringify({ fields: { [F.origin]: made.key } }) }).catch(() => {});
  // In the list straight away, under its parent.
  try {
    const { list } = await fieldsList(env, b);
    const got = await call(`/rest/api/3/issue/${made.key}?fields=${list}`);
    if (got?.key) {
      const r = rowOf(got, F);
      r.origin_key ||= made.key;
      await saveRows(env, [r]);
      await env.DB.prepare('UPDATE ims_items SET group_key = ?, sync_seen = 1 WHERE issue_key = ?').bind(made.key, made.key).run();
    }
  } catch { /* the next read brings it in */ }
  const areas = [...new Set(members.map((m) => m.project_key))].filter((k) => k !== home.project_key && isArea(`${k}-1`));
  for (const a of areas) {
    await env.DB.prepare('INSERT INTO ims_writes (group_key, kind, source_key, target_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(made.key, 'copy', made.key, a, '{}', new Date().toISOString()).run();
  }
  if (areas.length && b.left() > 8) await applyWrites(env, b, { limit: areas.length }).catch(() => {});
  await setState(env, 'ims_read_at', Date.now() - READ_EVERY_MS);
  await changed(env);
  await record(env, viewer, { area: 'IMS', action: 'added a sub-task', subjectType: 'ims', subjectId: made.key, label: `${made.key} ${summary}`.slice(0, 120),
    changes: [{ label: 'Under', before: '', after: groupKey }] }).catch(() => {});
  return { ok: true, key: made.key, copies: areas.length, skipped: [...new Set(skipped)] };
}

// Copies that disagreed when first seen: one is chosen, and the others follow it.
export async function resolveConflict(env, viewer, { group, field, from }) {
  mustSee(viewer);
  if (!SYNCED[field]) throw refuse('That isn\'t a field the hub keeps in step.');
  const src = await env.DB.prepare('SELECT * FROM ims_items WHERE issue_key = ? AND (group_key = ? OR issue_key = ?)').bind(String(from), String(group), String(group)).first();
  if (!src) throw refuse('Choose one of this item\'s copies.');
  const value = JSON.parse(src.vals || '{}')[field];
  await saveBase(env, group, { [field]: { value, conflict: false } });
  const { results: members } = await env.DB.prepare('SELECT * FROM ims_items WHERE group_key = ? OR issue_key = ?').bind(group, group).all();
  for (const m of members) {
    if (m.issue_key === src.issue_key || same(JSON.parse(m.vals || '{}')[field], value)) continue;
    await env.DB.prepare('INSERT INTO ims_writes (group_key, kind, source_key, target_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(group, 'sync', src.issue_key, m.issue_key, JSON.stringify({ [field]: value }), new Date().toISOString()).run();
  }
  await changed(env);
  return { ok: true };
}

// Disagreements someone has dismissed are left as they are and out of the lists, until
// another field starts to disagree. Kept as { group: [fields] }.
async function dismissedMap(env) {
  try { return JSON.parse((await getState(env, 'ims_dismissed')) || '{}') || {}; } catch { return {}; }
}
async function liveConflicts(env, sql, binds = []) {
  const [{ results }, gone] = await Promise.all([env.DB.prepare(sql).bind(...binds).all().catch(() => ({ results: [] })), dismissedMap(env)]);
  if (!Object.keys(gone).length) return { results };
  if (results[0] && 'field' in results[0]) return { results: results.filter((r) => !(gone[r.group_key] || []).includes(r.field)) };
  // Counted by item: an item stays while any of its disagreements hasn't been dismissed.
  const { results: rows } = await env.DB.prepare('SELECT group_key, field FROM ims_sync WHERE conflict = 1').all().catch(() => ({ results: [] }));
  const open = new Map();
  for (const r of rows) if (!(gone[r.group_key] || []).includes(r.field)) open.set(r.group_key, (open.get(r.group_key) || 0) + 1);
  return { results: results.filter((r) => open.has(r.group_key)).map((r) => ({ ...r, n: open.get(r.group_key) })) };
}
export async function dismiss(env, viewer, { key }) {
  mustSee(viewer);
  const g = String(key || '').toUpperCase();
  const { results } = await env.DB.prepare('SELECT field FROM ims_sync WHERE conflict = 1 AND group_key = ?').bind(g).all();
  if (!results.length) return { ok: true };
  const gone = await dismissedMap(env);
  gone[g] = [...new Set([...(gone[g] || []), ...results.map((r) => r.field)])];
  await setState(env, 'ims_dismissed', JSON.stringify(gone));
  await record(env, viewer, { area: 'IMS', action: 'dismissed copies that disagree', subjectType: 'ims', subjectId: g, label: g }).catch(() => {});
  return { ok: true };
}

// Every disagreement settled the same way: each item's most recently updated copy is taken as right.
export async function resolveAll(env, viewer, { field = null, group = null } = {}) {
  mustSee(viewer);
  if (field && !SYNCED[field]) throw refuse('That isn\'t a field the hub keeps in step.');
  const where = [field && 'field = ?', group && 'group_key = ?'].filter(Boolean).map((w) => ` AND ${w}`).join('');
  const { results } = group
    ? await env.DB.prepare(`SELECT group_key, field FROM ims_sync WHERE conflict = 1${where}`).bind(...[field, String(group)].filter(Boolean)).all()
    : await liveConflicts(env, `SELECT group_key, field FROM ims_sync WHERE conflict = 1${where}`, field ? [field] : []);
  let n = 0;
  for (const r of results) {
    const src = await env.DB.prepare('SELECT issue_key FROM ims_items WHERE group_key = ? OR issue_key = ? ORDER BY updated_at DESC, issue_key LIMIT 1').bind(r.group_key, r.group_key).first();
    if (!src) continue;
    await resolveConflict(env, viewer, { group: r.group_key, field: r.field, from: src.issue_key });
    n++;
  }
  await record(env, viewer, { area: 'IMS', action: group ? 'made its copies match the latest' : 'made every copy match its latest version', subjectType: 'ims', subjectId: group || field || 'all', label: `${n} disagreements` }).catch(() => {});
  return { ok: true, settled: n };
}

export async function comment(env, viewer, { key, text }) {
  mustSee(viewer);
  const k = String(key || '').toUpperCase();
  if (!isArea(k) && !k.startsWith(`${MAIN}-`)) throw refuse('That isn\'t an IMS item.');
  const words = String(text || '').trim();
  if (words.length < 2) throw refuse('Write the comment first.');
  const { adfFrom } = await import('./jiraview.js');
  await jira(env, `/rest/api/3/issue/${encodeURIComponent(k)}/comment`, { method: 'POST', body: JSON.stringify({ body: adfFrom(words, viewer.employee?.name || viewer.email) }) });
  return { ok: true };
}

// ---------- what can be chosen ----------

export async function options(env, viewer) {
  mustSee(viewer);
  const saved = JSON.parse((await getState(env, 'ims_options_v2')) || 'null');
  let allowed = saved && Date.now() - saved.at < 12 * 3600 * 1000 ? saved.allowed : null;
  if (!allowed) {
    allowed = {};
    const F = await fieldMap(env);
    const sample = await env.DB.prepare("SELECT issue_key FROM ims_items WHERE issuetype = 'IMS Task' ORDER BY updated_at DESC LIMIT 1").first();
    if (sample) {
      const meta = await jira(env, `/rest/api/3/issue/${encodeURIComponent(sample.issue_key)}/editmeta`).catch(() => null);
      for (const n of ['imsType', 'subTypes', 'categories', 'rootCause', 'rootRequired']) {
        const vals = meta?.fields?.[F[n]]?.allowedValues;
        if (vals) allowed[n] = vals.map((v) => v.value).filter(Boolean);
      }
    }
    await setState(env, 'ims_options_v2', JSON.stringify({ at: Date.now(), allowed }));
  }
  // Anything not offered by Jira is filled from what's in use.
  const rows = await allRows(env);
  const used = (col, multi) => [...new Set(rows.flatMap((r) => (multi ? listOf(r[col]) : [r[col]])).filter(Boolean))].sort();
  allowed.imsType ||= used('ims_type');
  allowed.subTypes ||= used('sub_types', true);
  for (const x of [PREBOARDING, ONBOARDING]) if (!allowed.subTypes.includes(x)) allowed.subTypes = [...allowed.subTypes, x].sort();
  allowed.rootCause ||= used('root_cause', true);
  allowed.rootRequired ||= ['Yes', 'No'];
  allowed.categories ||= AREAS.map((a) => a.name);
  const { results: people } = await env.DB.prepare("SELECT account_id, name, email, job_title, extension FROM employees WHERE active = 1 AND account_id NOT LIKE 'pending%' ORDER BY name").all();
  const statuses = [...new Set(rows.filter((r) => r.issuetype === 'IMS Task').map((r) => r.status))].sort();
  const folders = rows.filter((r) => r.issuetype === 'Folder' && isArea(r.issue_key)).map((r) => ({ key: r.issue_key, project: r.project_key, name: r.summary })).sort((a, b) => a.name.localeCompare(b.name));
  return { allowed, people: people.map((p) => ({ id: p.account_id, name: p.name, email: p.email || '', job: p.job_title || '', phone: p.extension || '' })), statuses, folders, areas: AREAS.map(({ key, name }) => ({ key, name })),
    meetings: meetingRows(rows).slice(0, 30).map(({ key, summary, date }) => ({ key, summary, date })) };
}

// ---------- raising an item ----------

// The types an IMS item can be raised as, and what each asks for beyond the usual.
export const RAISE_TYPES = ['IMS Task', 'Incident', '8D Report', 'Change Management'];
const ROOT_BY_DEFAULT = ['Incident', '8D Report'];

// What Jira asks for when raising a type in a project: each field's ID, shape and options,
// found by name. Read once every six hours.
const metaKept = new Map();
export async function createMeta(env, project, typeName) {
  const k = `${project}|${typeName}`;
  const kept = metaKept.get(k);
  if (kept && Date.now() - kept.at < 6 * 3600 * 1000) return kept.meta;
  if (!/^[A-Z][A-Z0-9_]*$/.test(project)) throw refuse('That isn\'t an IMS area.');
  const typeId = await typeIdIn((p) => jira(env, p), project, typeName);
  if (!typeId) return null;
  const byName = {};
  let at = 0;
  for (let page = 0; page < 5; page++) {
    const res = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/issue/createmeta/${project}/issuetypes/${typeId}?startAt=${at}&maxResults=100`, {
      headers: { Authorization: `Basic ${btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`)}`, Accept: 'application/json' },
    }).catch(() => null);
    if (!res?.ok) break;
    const data = await res.json();
    const list = data.fields || data.values || [];
    for (const f of list) byName[String(f.name).toLowerCase()] = { id: f.fieldId || f.key, name: f.name, schema: f.schema || {}, required: Boolean(f.required),
      allowed: (f.allowedValues || []).map((v) => v.value ?? v.name).filter((v) => v != null) };
    at += list.length;
    if (!list.length || at >= (data.total ?? data.maxResults ?? at)) break;
  }
  const meta = { typeId, byName };
  metaKept.set(k, { at: Date.now(), meta });
  return meta;
}

// The type-specific choices for the form: severities, business areas, customers.
export async function raiseForm(env, viewer, { type, home }) {
  mustSee(viewer);
  if (!RAISE_TYPES.includes(type)) throw refuse('Choose what type of item it is.');
  if (!AREA_KEYS.includes(home)) throw refuse('Choose its main area.');
  const meta = await createMeta(env, home, type);
  if (!meta) return { type, home, missing: true };
  const opt = (name) => meta.byName[name.toLowerCase()]?.allowed || [];
  const has = (name) => Boolean(meta.byName[name.toLowerCase()]);
  const out = { type, home, missing: false, fields: Object.fromEntries(Object.values(meta.byName).map((f) => [f.name, true])) };
  out.severity = opt('Incident Severity');
  out.businessArea = opt('Business Area');
  out.customers = opt('Customer');
  if (!out.customers.length && has('Customer')) {
    const { customerProjects } = await import('./jira.js');
    out.customers = (await customerProjects(env).catch(() => [])).map((p) => p.name).sort();
    out.customerFree = true;
  }
  const { results } = await env.DB.prepare("SELECT account_id, name, email, job_title, extension FROM employees WHERE active = 1 AND account_id NOT LIKE 'pending%' ORDER BY name").all();
  out.people = results.map((e) => ({ id: e.account_id, name: e.name, email: e.email || '', job: e.job_title || '', phone: e.extension || '' }));
  return out;
}

// A table in Jira's document format: a header row, then a row for each entry.
export function adfTable(headers, rows, { boldFirstColumn = false } = {}) {
  const cell = (type, text, bold) => ({ type, attrs: {}, content: [{ type: 'paragraph', content: text ? [{ type: 'text', text: String(text), ...(bold ? { marks: [{ type: 'strong' }] } : {}) }] : [] }] });
  return {
    type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' },
    content: [
      { type: 'tableRow', content: headers.map((h) => cell('tableHeader', h, true)) },
      ...rows.map((r) => ({ type: 'tableRow', content: r.map((v, i) => cell('tableCell', v, boldFirstColumn && i === 0)) })),
    ],
  };
}
const docOf = (...nodes) => ({ type: 'doc', version: 1, content: nodes.filter(Boolean) });
const wikiTable = (headers, rows) => [`|| ${headers.join(' || ')} ||`, ...rows.map((r) => `| ${r.map((v) => String(v || ' ').replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n');
const clip = (v, n = 2000) => String(v ?? '').trim().slice(0, n);
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
const rowsOf = (list, keys, n = 30) => (Array.isArray(list) ? list : []).slice(0, n)
  .map((r) => keys.map((k) => clip(r?.[k], 500))).filter((r) => r.some(Boolean));

// One value in the shape its Jira field takes.
export function valueFor(meta, v) {
  const s = meta.schema || {};
  const custom = String(s.custom || '');
  if (v && typeof v === 'object' && v.type === 'table') {
    if (/textarea/.test(custom) || s.type === 'doc') return docOf(v);
    return wikiTable(v.content[0].content.map((c) => c.content[0].content[0]?.text || ''), v.content.slice(1).map((r) => r.content.map((c) => c.content[0].content[0]?.text || '')));
  }
  if (s.type === 'option') return { value: String(v) };
  if (s.type === 'array' && s.items === 'option') return (Array.isArray(v) ? v : [v]).filter(Boolean).map((x) => ({ value: String(x) }));
  if (s.type === 'array' && s.items === 'user') return (Array.isArray(v) ? v : [v]).filter(Boolean).map((x) => ({ accountId: String(x) }));
  if (s.type === 'user') return { accountId: String(v) };
  if (s.type === 'date') return isoDay(v) || null;
  if (s.type === 'datetime') {
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString().replace('Z', '+0000') : null;
  }
  if (/textarea/.test(custom) || s.type === 'doc') return docOf(...String(v).split(/\n{2,}/).map((p) => ({ type: 'paragraph', content: p.split('\n').flatMap((l, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(l ? [{ type: 'text', text: l }] : [])]) })));
  return String(v);
}

// The extra fields an Incident, 8D Report or Change Management item asks for, by Jira's names.
function typeFields(typeName, input) {
  const out = {};
  const set = (name, v) => { if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) out[name] = v; };
  const containment = (rows) => adfTable(['Title', 'Description', 'Owners', 'Actioned Date'], rowsOf(rows, ['title', 'description', 'owners', 'actioned']));
  const analysis = (rows) => adfTable(['Root Cause Analysis', 'Description', 'Investigators', 'Actioned Date'], rowsOf(rows, ['rca', 'description', 'investigators', 'actioned']));
  if (typeName === 'Incident') {
    const x = input.incident || {};
    set('Date & Time of Incident', x.at ? String(x.at) : '');
    set('Location of Incident', clip(x.location, 250));
    set('What Happened?', clip(x.happened, 30000));
    set('Incident Severity', clip(x.severity, 100));
    set('Description of Injury/Damage', clip(x.injury, 30000));
    set('Containment', containment(x.containment));
    set('Contributing Factors', clip(x.factors, 30000));
    set('Analysis & Planning of Corrective Actions', analysis(x.analysis));
  }
  if (typeName === '8D Report') {
    const x = input.eightD || {};
    set('Business Area', (Array.isArray(x.businessArea) ? x.businessArea : []).map(String).slice(0, 10));
    set('Customer', clip(x.customer, 250));
    set('Customer Address', clip(x.address, 1000));
    set('Persons Involved Info', adfTable(['Name', 'Job Title', 'Telephone', 'Email'], rowsOf(x.persons, ['name', 'job', 'phone', 'email'])));
    set('Containment', containment(x.containment));
    set('Contributing Factors', clip(x.factors, 30000));
    set('Analysis & Planning of Corrective Actions', analysis(x.analysis));
    set('Corrective & Preventative Actions Taken', adfTable(['Title', 'Description', 'Owners', 'Due Date', 'Actioned Date', 'Reviewed Date'],
      rowsOf(x.actions, ['title', 'description', 'owners', 'due', 'actioned', 'reviewed'])));
    set('Finalise Teamwork', adfTable(['', '', ''], [['Initiated by', '', ''], ['Approved by', '', ''], ['Closed by', '', ''], ['Verified by', '', '']], { boldFirstColumn: true }));
  }
  if (typeName === 'Change Management') {
    const d = input.change?.description || {};
    const docs = input.change?.docs || {};
    set('Change Description', adfTable(['Information Required', 'Change Details'], [
      ['System / Service Affected', clip(d.system, 500)], ['Type of Change', clip(d.type, 500)], ['Scope / Components Affected', clip(d.scope, 1000)],
      ['Summary of Change', clip(d.summary, 2000)], ['Requested By', clip(d.requestedBy, 250)]], { boldFirstColumn: true }));
    set('Change Documentation', adfTable(['Information Required', 'Documentation / Link Details'], [
      ['ISMS Procedure Reference', clip(docs.procedure, 500)], ['Implementation / SOP Link', clip(docs.sop, 1000)], ['Approval Evidence (File or Comment)', clip(docs.approval, 1000)],
      ['Related Jira Issues / Tickets', clip(docs.related, 500)], ['Audit or Change Record Reference', clip(docs.audit, 500)]], { boldFirstColumn: true }));
  }
  return out;
}

export async function create(env, viewer, input) {
  mustSee(viewer);
  const areas = [...new Set((input.areas || []).map(String))].filter((k) => AREA_KEYS.includes(k));
  if (!areas.length) throw refuse('Choose at least one area.');
  const home = AREA_KEYS.includes(input.home) && areas.includes(input.home) ? input.home : areas[0];
  const summary = String(input.summary || '').trim().replace(/\s+/g, ' ');
  if (summary.length < 3) throw refuse('Give it a summary.');
  const typeName = RAISE_TYPES.includes(input.type) ? input.type : 'IMS Task';
  // Root cause is always needed for incidents and 8D reports; for the rest, someone says.
  const rootRequired = ROOT_BY_DEFAULT.includes(typeName) ? 'Yes' : String(input.rootRequired || '');
  if (!['Yes', 'No'].includes(rootRequired)) throw refuse('Say whether a root cause is required.');
  if ((input.subTypes || []).includes(PREBOARDING) && !(areas.length === 1 && areas[0] === PREBOARDING_AREA)) throw refuse('Preboarding is only for items in Information Security on its own.');
  if (typeName === 'Incident') {
    const x = input.incident || {};
    if (!x.at) throw refuse('Give the date and time of the incident.');
    if (!clip(x.happened)) throw refuse('Say what happened.');
    if (!x.severity) throw refuse('Choose the incident severity.');
  }
  const F = await fieldMap(env);
  const meta = await createMeta(env, home, typeName);
  if (!meta) throw refuse(`${AREAS.find((a) => a.key === home)?.name || home} has no ${typeName} type in Jira.`);
  const byName = (n) => meta.byName[String(n).toLowerCase()];
  const { adfFrom } = await import('./jiraview.js');
  const description = typeName === 'Incident' ? '' : String(input.description || '').trim();
  const fields = { project: { key: home }, issuetype: { id: meta.typeId }, summary, ...(description || typeName !== 'Incident' ? { description: adfFrom(description || summary) } : {}) };
  const names = AREAS.filter((a) => areas.includes(a.key)).map((a) => a.name);
  fields[F.categories] = names.map((value) => ({ value }));
  if (input.imsType) fields[F.imsType] = { value: String(input.imsType) };
  if (input.subTypes?.length) fields[F.subTypes] = input.subTypes.map((value) => ({ value: String(value) }));
  if (input.rootCause?.length) fields[F.rootCause] = input.rootCause.map((value) => ({ value: String(value) }));
  const whys = whysAdf(input.whys);
  const whysId = byName('5 Whys')?.id || F.fiveWhys;
  if (whys && whysId) fields[whysId] = whys;
  const rr = byName('Is Root Cause Required?') || (F.rootRequired ? { id: F.rootRequired, schema: { type: 'array', items: 'option' } } : null);
  if (rr) fields[rr.id] = valueFor(rr, rootRequired);
  if (isoDay(input.start)) fields[F.start] = input.start;
  if (isoDay(input.target)) fields[F.target] = input.target;
  if (input.assigneeId) fields.assignee = { accountId: String(input.assigneeId) };
  const staff = (Array.isArray(input.staffIds) ? input.staffIds : []).map(String).filter((x) => /^[\w:-]{6,128}$/.test(x)).slice(0, 30);
  const staffMeta = byName('Promtek Staff Involved') || (F.staff ? { id: F.staff, schema: { type: 'array', items: 'user' } } : null);
  if (staff.length && staffMeta) fields[staffMeta.id] = valueFor(staffMeta, staff);
  const skipped = [];
  for (const [name, v] of Object.entries(typeFields(typeName, input))) {
    const m = byName(name);
    if (!m) { skipped.push(name); continue; }
    const val = valueFor(m, v);
    if (val != null && val !== '') fields[m.id] = val;
  }
  let made;
  try { made = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) }); } catch (err) {
    if (err.status !== 400) throw err;
    // Jira named the fields it wouldn't take: they're left off and noted, rather than losing the item.
    let bad = {};
    try { bad = JSON.parse(String(err.message).replace(/^[^{]*/, '')).errors || {}; } catch { bad = {}; }
    const keys = Object.keys(bad).filter((k) => k in fields && !['project', 'issuetype', 'summary'].includes(k));
    if (!keys.length) throw err;
    for (const k of keys) { skipped.push(Object.values(meta.byName).find((f) => f.id === k)?.name || (k === F.fiveWhys ? '5 Whys' : k)); delete fields[k]; }
    made = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
  }
  // The item names itself as its origin, so Jira's old copy rules leave it alone.
  await jira(env, `/rest/api/3/issue/${made.key}`, { method: 'PUT', body: JSON.stringify({ fields: { [F.origin]: made.key } }) }).catch(() => {});
  if (input.meeting && String(input.meeting).startsWith(`${MAIN}-`)) await linkMeeting(env, made.key, String(input.meeting)).catch(() => {});
  // A copy in each other area, now if there are calls to spare, otherwise next run.
  for (const a of areas.filter((x) => x !== home)) {
    await env.DB.prepare('INSERT INTO ims_writes (group_key, kind, source_key, target_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(made.key, 'copy', made.key, a, '{}', new Date().toISOString()).run();
  }
  const b = budget(env, 30);
  await applyWrites(env, b, { limit: areas.length }).catch(() => {});
  await setState(env, 'ims_read_at', Date.now() - READ_EVERY_MS);
  await record(env, viewer, { area: 'IMS', action: `raised ${typeName === 'Incident' ? 'an incident' : `a${/^[AEIOU8]/.test(typeName) ? 'n' : ''} ${typeName}`}`, subjectType: 'ims', subjectId: made.key, label: `${made.key} ${summary}`.slice(0, 120),
    changes: [{ label: 'Areas', before: '', after: names.join(', ') }] }).catch(() => {});
  return { ok: true, key: made.key, copies: areas.length - 1, skipped: [...new Set(skipped)] };
}

// ---------- management meetings ----------

function meetingRows(rows) {
  return rows.filter((r) => r.project_key === MAIN && r.issuetype === 'Meeting')
    .map((r) => ({ key: r.issue_key, summary: r.summary, status: r.status, date: r.start_date || r.created_at?.slice(0, 10), done: r.status === 'For Reference' || isDone(r) }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export async function meetings(env, viewer) {
  mustSee(viewer);
  const rows = await allRows(env);
  const raised = new Map();
  for (const r of rows) {
    if (!isArea(r.issue_key)) continue;
    for (const l of listOf(r.links)) if (l.key.startsWith(`${MAIN}-`)) raised.set(l.key, (raised.get(l.key) || 0) + 1);
  }
  return { meetings: meetingRows(rows).map((m) => ({ ...m, raised: raised.get(m.key) || 0 })) };
}

export async function meeting(env, viewer, key) {
  mustSee(viewer);
  const k = String(key || '').toUpperCase();
  if (!k.startsWith(`${MAIN}-`)) throw refuse('That isn\'t a meeting.');
  const rows = await allRows(env);
  const m = meetingRows(rows).find((x) => x.key === k);
  if (!m) throw refuse('That meeting isn\'t in the list.', 404);
  const { viewItem } = await import('./jiraview.js');
  const view = await viewItem(env, k);
  const items = collapse(rows).filter((i) => i.copies.some((c) => listOf(rows.find((r) => r.issue_key === c.key)?.links).some((l) => l.key === k)));
  return { meeting: m, view, items };
}

export async function newMeeting(env, viewer, { summary, date }) {
  mustSee(viewer);
  const title = String(summary || '').trim();
  if (title.length < 3) throw refuse('Give the meeting a name.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw refuse('Choose the date it\'s on.');
  const F = await fieldMap(env);
  const typeId = await typeIdIn((p) => jira(env, p), MAIN, 'Meeting');
  if (!typeId) throw refuse('The IMS Main Board has no Meeting type.');
  const made = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields: {
    project: { key: MAIN }, issuetype: { id: typeId }, summary: title, parent: { key: MEETING_LIST }, [F.start]: date,
  } }) });
  await setState(env, 'ims_read_at', Date.now() - READ_EVERY_MS);
  // Each meeting has a gap analysis ready for it (one still empty from the last meeting moves on to this one).
  await import('./gaps.js').then((G) => G.forMeeting(env, viewer, { key: made.key, summary: title })).catch(() => {});
  await record(env, viewer, { area: 'IMS', action: 'added a management meeting', subjectType: 'ims', subjectId: made.key, label: `${made.key} ${title}` }).catch(() => {});
  return { ok: true, key: made.key };
}

// The minutes, as attachments, and the meeting marked For Reference.
export async function minutes(env, viewer, key, form) {
  mustSee(viewer);
  const k = String(key || '').toUpperCase();
  if (!k.startsWith(`${MAIN}-`)) throw refuse('That isn\'t a meeting.');
  const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0);
  if (!files.length) throw refuse('Choose the minutes to upload.');
  if (files.length > 10) throw refuse('Upload up to 10 files at a time.');
  for (const f of files) if (f.size > 20 * 1024 * 1024) throw refuse(`${f.name} is over 20 MB.`);
  const auth = `Basic ${btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`)}`;
  for (const f of files) {
    const body = new FormData();
    body.append('file', f, f.name || 'minutes');
    const res = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(k)}/attachments`, { method: 'POST', headers: { Authorization: auth, 'X-Atlassian-Token': 'no-check', Accept: 'application/json' }, body });
    if (!res.ok) throw refuse(`Jira didn't take ${f.name} (${res.status}).`, 502);
  }
  let moved = false;
  if (String(form.get('complete') || '') === '1') { try { await moveTo((p, i) => jira(env, p, i), k, 'For Reference'); moved = true; } catch { /* it may be there already */ } }
  await setState(env, 'ims_read_at', Date.now() - READ_EVERY_MS);
  await record(env, viewer, { area: 'IMS', action: 'uploaded meeting minutes', subjectType: 'ims', subjectId: k, label: k, changes: [{ label: 'Files', before: '', after: files.map((f) => f.name).join(', ') }] }).catch(() => {});
  return { ok: true, files: files.length, moved };
}

export async function linkMeeting(env, key, meetingKey) {
  const { issueLinkTypes = [] } = (await jira(env, '/rest/api/3/issueLinkType')) || {};
  const t = issueLinkTypes.find((x) => /active\s*\/\s*legacy/i.test(x.name)) || issueLinkTypes.find((x) => /^relates$/i.test(x.name));
  if (!t) return;
  await jira(env, '/rest/api/3/issueLink', { method: 'POST', body: JSON.stringify({ type: { id: t.id }, inwardIssue: { key }, outwardIssue: { key: meetingKey } }) });
}

export async function linkToMeeting(env, viewer, { key, meeting: m }) {
  mustSee(viewer);
  if (!isArea(String(key)) || !String(m || '').startsWith(`${MAIN}-`)) throw refuse('Choose an IMS item and a meeting.');
  await linkMeeting(env, String(key), String(m));
  await setState(env, 'ims_read_at', Date.now() - READ_EVERY_MS);
  return { ok: true };
}

export async function attachment(env, viewer, key, id) {
  mustSee(viewer);
  const k = String(key || '').toUpperCase();
  if (!isArea(k) && !k.startsWith(`${MAIN}-`)) throw refuse('That isn\'t an IMS item.');
  const { attachmentOf } = await import('./jiraview.js');
  return attachmentOf(env, k, id);
}

export async function refresh(env, viewer) {
  mustSee(viewer);
  return run(env, { force: true });
}
