// Work in progress: every order (an Epic with a Promtek Invoicing Entity) and every
// service contract, read straight from Jira, with progress, invoicing and payment
// worked out from the items under them. Nothing is written back to the order to
// do this, so the Progress, Non Admin Progress, % Invoiced, % Paid and Subtask
// Count fields, and the Jira rules and Zaps that kept them, are no longer needed.
//
// Changes are picked up every run from a short search of what was updated in the
// last few minutes; a full read every half hour catches anything removed. On the
// first run of each month the month just ended is kept as it stood, which gives
// the "last month" figures and the history.
//
// The hub can also take over the Jira rule that moved orders between Work in
// progress, Awaiting Payment, Documentation Check and Done. It only starts once
// switched on in the tile's settings.
import { jira, searchPage, customerProjects } from './jira.js';
import { raiseAlert, getState, setState, londonDate } from './sync.js';
import { canonStatus } from './contracts.js';
import { canTile } from './permissions.js';

export const F = {
  upfront: 'customfield_12003',
  quote: 'customfield_14259',
  entity: 'customfield_14321',
  share: 'customfield_14317',
  due: 'customfield_14158',
  invoiceDate: 'customfield_14103',
  division: 'customfield_14562',
  start: 'customfield_14268',
  end: 'customfield_14269',
};
const ENTITIES = { 'promtek ltd': 'uk', 'promtek africa': 'sa' };
export const REGIONS = { uk: { name: 'UK', currency: 'GBP', symbol: '£' }, sa: { name: 'South Africa', currency: 'ZAR', symbol: 'R' } };
const CATEGORY_TYPES = ['category - hardware', 'category - software', 'category - condor', 'category - site visit'];
const ADMIN_TYPES = ['invoice', 'documentation check phase'];
const CONTRACT_TYPE = 'Service Contract';
const DIVISIONS = ['ServiceTeam', 'ProjectsTeam'];

export const STATUS = {
  wip: 'Work in progress', fresh: 'New', ap: 'Awaiting Payment', doc: 'Documentation Check', done: 'Done',
  holdCustomer: 'On Hold [Customer]', holdPromtek: 'On Hold [Promtek]',
};
const ACTIVE = [STATUS.wip, STATUS.fresh].map((s) => s.toLowerCase());

const QUICK_CALLS = 4;                 // every run, of the 50 outside calls a scheduled run may make
const FULL_CALLS = 30;                 // on its own turn
const FULL_EVERY_MS = 30 * 60 * 1000;
const FIELD_IDS_EVERY_MS = 24 * 3600 * 1000;
const BATCH = 25;                      // orders whose items are read together
const KEEP_DONE_DAYS = 95;             // finished orders still read, so the last two months stay right
const MOVE_TRIES_BEFORE_ALERT = 3;
const MOVE_RETRY_MS = 5 * 60 * 1000;
const MOVE_RETRY_CAP_MS = 6 * 3600 * 1000;
const IN = 90;                         // values in one IN list, under D1's 100

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const marks = (n) => Array(n).fill('?').join(',');
const lower = (v) => String(v ?? '').trim().toLowerCase();
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const text = (v) => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ');
  if (typeof v === 'object') return String(v.value ?? v.name ?? v.displayName ?? '');
  return String(v);
};
const options = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((o) => (typeof o === 'object' ? { id: String(o.id ?? ''), value: String(o.value ?? o.name ?? '') } : { id: '', value: String(o) }));
const dateOf = (v) => {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : londonDate(ms);
};
const floorPct = (done, total) => (total ? Math.floor((done / total) * 100) / 100 : null);
const round4 = (v) => (v === null || v === undefined ? null : Math.round(v * 10000) / 10000);

// ---------- months ----------
export const monthOf = (date) => String(date || '').slice(0, 7);
export const thisMonth = () => monthOf(londonDate());
export function shiftMonth(month, by) {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

// ---------- calls to Jira, counted ----------
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
async function search(b, jql, fields, { pages = 50 } = {}) {
  const out = [];
  let token = null;
  let n = 0;
  do {
    const params = { fields: fields.join(','), maxResults: '100' };
    if (token) params.nextPageToken = token;
    const data = await searchPage(b.env, (path) => b.call(path), jql, params);
    out.push(...(data.issues || []));
    token = data.nextPageToken || null;
    n++;
  } while (token && n < pages);
  return { issues: out, more: Boolean(token) };
}

// The Customer Item and Documentation fields are found by name, once a day.
async function fieldIds(env, b) {
  let saved = null;
  try { saved = JSON.parse((await getState(env, 'wip_field_ids')) || 'null'); } catch { /* found again */ }
  if (saved && Date.now() - saved.at < FIELD_IDS_EVERY_MS) return saved;
  const fields = await b.call('/rest/api/3/field');
  const named = (name) => (fields || []).filter((f) => lower(f.name) === name);
  const pick = (list) => (list.find((f) => /multicheckboxes$/.test(f.schema?.custom || '')) || list[0])?.id || null;
  const ids = { at: Date.now(), customerItem: pick(named('customer item')), documentation: pick(named('documentation')) };
  await setState(env, 'wip_field_ids', JSON.stringify(ids));
  return ids;
}

const ORDER_FIELDS = (ids) => ['summary', 'status', 'issuetype', 'project', 'created', 'updated', 'statuscategorychangedate', 'labels',
  F.upfront, F.quote, F.entity, ids.customerItem, ids.documentation].filter(Boolean);
const ITEM_FIELDS = ['summary', 'status', 'issuetype', 'parent', 'created', 'updated', 'statuscategorychangedate', F.share, F.due, F.invoiceDate, F.division];
const CONTRACT_FIELDS = ['summary', 'status', 'issuetype', 'project', 'created', 'updated', 'statuscategorychangedate', F.start, F.end, F.upfront, F.entity];
const ALL_FIELDS = (ids) => [...new Set([...ORDER_FIELDS(ids), ...ITEM_FIELDS, ...CONTRACT_FIELDS])];

const isEpic = (i) => lower(i.fields?.issuetype?.name) === 'epic' || String(i.fields?.issuetype?.id) === '6';
const isContract = (i) => lower(i.fields?.issuetype?.name) === lower(CONTRACT_TYPE);
const statusCat = (i) => i.fields?.status?.statusCategory?.key || null;

async function regionMap(env) {
  try { return new Map((await customerProjects(env)).map((p) => [p.key.toUpperCase(), p])); } catch { return new Map(); }
}
function regionOf(entityText, project) {
  return ENTITIES[lower(entityText)] || project?.region || null;
}

// An upsert that only writes when something has changed. A full read every half hour would
// otherwise rewrite every order and item each time, and every row written counts.
const ifChanged = (table, cols, extra = '') => ` WHERE ${cols.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(' OR ')}${extra}`;
const ORDER_COLS = ['issue_key', 'project_key', 'region', 'entity', 'summary', 'org', 'status', 'status_cat', 'created', 'done_at', 'updated', 'upfront', 'quote_no', 'labels',
  'customer_item', 'has_doc', 'doc_yes'];
const CONTRACT_COLS = ['issue_key', 'project_key', 'region', 'summary', 'org', 'status', 'status_cat', 'start_date', 'end_date', 'ended_at', 'total'];
const ITEM_COLS = ['issue_key', 'order_id', 'parent_id', 'level', 'issuetype', 'subtask', 'status', 'status_cat', 'summary', 'share', 'inv_due', 'inv_date', 'division', 'created', 'paid_at'];

function orderStatement(env, i, ids, projects, now) {
  const f = i.fields || {};
  const project = projects.get(String(f.project?.key || i.key.split('-')[0]).toUpperCase());
  const entity = text(f[F.entity]);
  const doc = ids.documentation ? options(f[ids.documentation]).map((o) => o.value) : [];
  const custom = ids.customerItem ? options(f[ids.customerItem]).map((o) => lower(o.value)) : [];
  const cat = statusCat(i);
  return env.DB.prepare(
    `INSERT INTO wip_orders (issue_id, issue_key, project_key, region, entity, summary, org, status, status_cat, created, done_at, updated, upfront, quote_no, labels,
       customer_item, has_doc, doc_yes, seen_at, gone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, project_key = excluded.project_key, region = excluded.region, entity = excluded.entity,
       summary = excluded.summary, org = excluded.org, status = excluded.status, status_cat = excluded.status_cat, created = excluded.created,
       done_at = excluded.done_at, updated = excluded.updated, upfront = excluded.upfront, quote_no = excluded.quote_no, labels = excluded.labels,
       customer_item = excluded.customer_item, has_doc = excluded.has_doc, doc_yes = excluded.doc_yes, seen_at = excluded.seen_at, gone = 0
     ${ifChanged('wip_orders', ORDER_COLS, ' OR wip_orders.gone = 1')}`
  ).bind(String(i.id), i.key, f.project?.key || i.key.split('-')[0], regionOf(entity, project), entity || null, f.summary || '', f.project?.name || project?.name || '',
    f.status?.name || '', cat, dateOf(f.created), cat === 'done' ? dateOf(f.statuscategorychangedate || f.updated) : null, f.updated || null,
    num(f[F.upfront]), text(f[F.quote]) || null, JSON.stringify(f.labels || []),
    custom.includes('customer item') ? 1 : 0, doc.length ? 1 : 0, doc.length === 1 && lower(doc[0]) === 'yes' ? 1 : 0, now);
}

function contractStatement(env, i, projects, now) {
  const f = i.fields || {};
  const project = projects.get(String(f.project?.key || i.key.split('-')[0]).toUpperCase());
  const cat = statusCat(i);
  const expired = /expired/i.test(f.status?.name || '');
  return env.DB.prepare(
    `INSERT INTO wip_contracts (issue_id, issue_key, project_key, region, summary, org, status, status_cat, start_date, end_date, ended_at, total, seen_at, gone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, project_key = excluded.project_key, region = excluded.region, summary = excluded.summary,
       org = excluded.org, status = excluded.status, status_cat = excluded.status_cat, start_date = excluded.start_date, end_date = excluded.end_date,
       ended_at = excluded.ended_at, total = excluded.total, seen_at = excluded.seen_at, gone = 0
     ${ifChanged('wip_contracts', CONTRACT_COLS, ' OR wip_contracts.gone = 1')}`
  ).bind(String(i.id), i.key, f.project?.key || i.key.split('-')[0], regionOf(text(f[F.entity]), project), f.summary || '', f.project?.name || project?.name || '',
    f.status?.name || '', cat, dateOf(f[F.start]), dateOf(f[F.end]), expired || cat === 'done' ? dateOf(f.statuscategorychangedate || f.updated) : null,
    num(f[F.upfront]), now);
}

function itemStatement(env, i, orderId, level) {
  const f = i.fields || {};
  const div = options(f[F.division]).map((o) => `${o.id}:${o.value}`).join('|') || null;
  return env.DB.prepare(
    `INSERT INTO wip_items (issue_id, issue_key, order_id, parent_id, level, issuetype, subtask, status, status_cat, summary, share, inv_due, inv_date, division, created, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, order_id = excluded.order_id, parent_id = excluded.parent_id, level = excluded.level,
       issuetype = excluded.issuetype, subtask = excluded.subtask, status = excluded.status, status_cat = excluded.status_cat, summary = excluded.summary,
       share = excluded.share, inv_due = excluded.inv_due, inv_date = excluded.inv_date, division = excluded.division, created = excluded.created,
       paid_at = CASE WHEN excluded.paid_at IS NULL THEN NULL ELSE COALESCE(wip_items.paid_at, excluded.paid_at) END
     ${ifChanged('wip_items', ITEM_COLS.filter((c) => c !== 'paid_at'), ' OR (wip_items.paid_at IS NULL) IS NOT (excluded.paid_at IS NULL)')}`
  ).bind(String(i.id), i.key, String(orderId), f.parent?.id ? String(f.parent.id) : null, level, f.issuetype?.name || '', f.issuetype?.subtask ? 1 : 0,
    f.status?.name || '', statusCat(i), f.summary || '', num(f[F.share]), dateOf(f[F.due]), dateOf(f[F.invoiceDate]), div, f.created || null,
    statusCat(i) === 'done' ? dateOf(f.statuscategorychangedate || f.updated) : null);
}

async function runAll(env, stmts) {
  for (const part of chunk(stmts, 50)) if (part.length) await env.DB.batch(part);
}

// ---------- working out an order ----------

export function invoiceState(item) {
  const s = lower(item.status);
  const paid = (/\bpaid\b/.test(s) && !/\b(un|not )paid\b/.test(s)) || item.status_cat === 'done';
  const overdue = !paid && /overdue/.test(s);
  // "Ready to be Invoiced" is waiting for its invoice to be checked and sent, so it isn't invoiced yet.
  const ready = !paid && !overdue && /ready/.test(s);
  const invoiced = paid || overdue || (!ready && /invoiced/.test(s) && !/not invoiced/.test(s));
  return { paid, invoiced, overdue, ready, label: paid ? 'Paid' : overdue ? 'Overdue' : invoiced ? 'Invoiced' : 'Not Invoiced' };
}
export const isTokenInvoice = (item) => /token/i.test(item.summary || '');
const isInvoice = (item) => /\binvoice\b/i.test(item.issuetype || '');

function divisionFromJira(order, items) {
  const found = new Set();
  const add = (s) => {
    const t = lower(s);
    if (/12680|service/.test(t)) found.add('ServiceTeam');
    else if (/12681|project/.test(t)) found.add('ProjectsTeam');
  };
  for (const i of items) if (i.level === 1 && i.division) for (const part of i.division.split('|')) add(part);
  let labels = [];
  try { labels = JSON.parse(order.labels || '[]'); } catch { /* none */ }
  for (const l of labels) add(l);
  return found.size === 1 ? [...found][0] : found.has('ProjectsTeam') ? 'ProjectsTeam' : null;
}

export function computeOrder(order, items) {
  const level1 = items.filter((i) => i.level === 1);
  const level2 = items.filter((i) => i.level === 2);
  const done = (i) => i.status_cat === 'done';
  const legacy = !level1.some((i) => CATEGORY_TYPES.includes(lower(i.issuetype)));
  const subs = level2.filter((i) => i.subtask);
  const workItems = legacy ? level1.filter((i) => !ADMIN_TYPES.includes(lower(i.issuetype))) : subs;
  const invoices = level1.filter(isInvoice);
  const tokens = invoices.filter(isTokenInvoice);
  const money = invoices.filter((i) => !isTokenInvoice(i));
  const sum = (list, test) => list.filter(test).reduce((t, i) => t + (Number(i.share) || 0), 0);
  const tokenOnly = tokens.length > 0 && money.length === 0;
  const tokenPaid = tokens.length > 0 && tokens.every((i) => invoiceState(i).paid);
  const paid = round4(sum(money, (i) => invoiceState(i).paid));
  const r = {
    legacy: legacy ? 1 : 0,
    progress: floorPct(level1.filter(done).length, level1.length) ?? 0,
    non_admin: floorPct(workItems.filter(done).length, workItems.length),
    children: level1.length,
    open_work: legacy ? null : subs.filter((i) => !done(i)).length,
    invoiced: round4(sum(money, (i) => invoiceState(i).invoiced)),
    paid,
    token_qty: tokens.length ? round4(sum(tokens, () => true)) : null,
    token_only: tokenOnly ? 1 : 0,
    token_paid: tokenPaid ? 1 : 0,
    division_jira: divisionFromJira(order, items),
  };
  // What the old Jira rule looked at: open sub-tasks, whether it's fully paid (or its tokens are), and the Documentation box.
  const paidEnough = tokenOnly ? tokenPaid : (paid || 0) >= 0.9999;
  const doc = order.doc_yes ? 'yes' : order.has_doc ? 'other' : 'empty';
  r.paidEnough = paidEnough;
  r.move_sig = `${r.progress}|${r.open_work ?? '-'}|${paidEnough ? 1 : 0}|${doc}`;
  r.target = legacy ? null : moveFor(order.status, r.open_work, paidEnough, doc);
  return r;
}

// The five steps of the Jira rule "Auto Transitions from Tasks", unchanged.
export function moveFor(status, open, paidEnough, doc) {
  if (open !== 0) return null;
  const s = lower(status);
  if (s === lower(STATUS.wip) && !paidEnough && doc === 'empty') return STATUS.ap;
  if (s === lower(STATUS.wip) && paidEnough && doc === 'empty') return STATUS.doc;
  if (s === lower(STATUS.ap) && paidEnough && doc === 'empty') return STATUS.doc;
  if (s === lower(STATUS.ap) && paidEnough && doc === 'yes') return STATUS.done;
  if (s === lower(STATUS.doc) && paidEnough && doc === 'yes') return STATUS.done;
  return null;
}

async function itemsFor(env, orderIds) {
  const out = [];
  for (const part of chunk(orderIds, IN)) {
    const { results } = await env.DB.prepare(`SELECT * FROM wip_items WHERE order_id IN (${marks(part.length)})`).bind(...part).all();
    out.push(...results);
  }
  return out;
}

// Works out the orders and contracts given, and queues any status change the old rule would have made.
async function recompute(env, ids) {
  const list = [...new Set(ids.map(String))];
  if (!list.length) return 0;
  const orders = [];
  const contracts = [];
  for (const part of chunk(list, IN)) {
    orders.push(...(await env.DB.prepare(`SELECT * FROM wip_orders WHERE issue_id IN (${marks(part.length)})`).bind(...part).all()).results);
    contracts.push(...(await env.DB.prepare(`SELECT issue_id, steps, steps_invoiced, steps_paid FROM wip_contracts WHERE issue_id IN (${marks(part.length)})`).bind(...part).all()).results);
  }
  const items = await itemsFor(env, list);
  const byOrder = new Map();
  for (const i of items) { if (!byOrder.has(i.order_id)) byOrder.set(i.order_id, []); byOrder.get(i.order_id).push(i); }
  const movesOn = (await getState(env, 'wip_moves_on')) === '1';
  const now = new Date().toISOString();
  const stmts = [];
  const same = (o, r) => ['legacy', 'progress', 'non_admin', 'children', 'open_work', 'invoiced', 'paid', 'token_qty', 'token_only', 'token_paid', 'division_jira', 'move_sig']
    .every((k) => (o[k] ?? null) === (r[k] ?? null));
  for (const o of orders) {
    const r = computeOrder(o, byOrder.get(o.issue_id) || []);
    if (!same(o, r)) stmts.push(env.DB.prepare(
      `UPDATE wip_orders SET legacy = ?, progress = ?, non_admin = ?, children = ?, open_work = ?, invoiced = ?, paid = ?, token_qty = ?, token_only = ?,
         token_paid = ?, division_jira = ?, move_sig = ?, computed_at = ? WHERE issue_id = ?`
    ).bind(r.legacy, r.progress, r.non_admin, r.children, r.open_work, r.invoiced, r.paid, r.token_qty, r.token_only, r.token_paid, r.division_jira,
      r.move_sig, now, o.issue_id));
    // Like the rule, which ran when progress changed: an order is only moved when what it depends on
    // has changed since it was last looked at, so moving one back by hand is left alone.
    const changed = o.move_sig !== null && o.move_sig !== r.move_sig;
    if (movesOn && changed && r.target && !o.customer_item && o.entity) {
      stmts.push(env.DB.prepare(
        `INSERT INTO wip_moves (issue_key, issue_id, target, from_status, reason, status, tries, next_at, last_error, queued_at, done_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, NULL, ?, NULL)
         ON CONFLICT(issue_key) DO UPDATE SET issue_id = excluded.issue_id, target = excluded.target, from_status = excluded.from_status, reason = excluded.reason,
           status = 'pending', tries = 0, next_at = 0, last_error = NULL, queued_at = excluded.queued_at, done_at = NULL`
      ).bind(o.issue_key, o.issue_id, r.target, o.status, moveReason(r), now));
    }
  }
  // Invoices past their Invoice Due Date are moved to Overdue in Jira, in place of the Jira automation.
  if (await overdueOn(env)) {
    const today = londonDate();
    for (const i of items) {
      if (i.level !== 1 || !isInvoice(i) || !i.issue_key || !i.inv_date || i.inv_date >= today) continue;
      const st = invoiceState(i);
      if (!st.invoiced || st.paid || st.overdue) continue;
      // Waiting already (with its own retries) is left as it is; one done or skipped before is queued again.
      stmts.push(env.DB.prepare(
        `INSERT INTO wip_moves (issue_key, issue_id, target, from_status, reason, status, tries, next_at, last_error, queued_at, done_at)
         VALUES (?, ?, 'Overdue', ?, ?, 'pending', 0, 0, NULL, ?, NULL)
         ON CONFLICT(issue_key) DO UPDATE SET issue_id = excluded.issue_id, target = excluded.target, from_status = excluded.from_status, reason = excluded.reason,
           status = 'pending', tries = 0, next_at = 0, last_error = NULL, queued_at = excluded.queued_at, done_at = NULL
         WHERE wip_moves.status != 'pending'`
      ).bind(i.issue_key, i.issue_id, i.status, `Its Invoice Due Date, ${i.inv_date}, has passed without payment`, now));
    }
  }
  for (const c of contracts) {
    const inv = (byOrder.get(c.issue_id) || []).filter((i) => i.level === 1 && isInvoice(i));
    const steps = [inv.length, inv.filter((i) => invoiceState(i).invoiced).length, inv.filter((i) => invoiceState(i).paid).length];
    if (steps[0] === c.steps && steps[1] === c.steps_invoiced && steps[2] === c.steps_paid) continue;
    stmts.push(env.DB.prepare('UPDATE wip_contracts SET steps = ?, steps_invoiced = ?, steps_paid = ? WHERE issue_id = ?').bind(...steps, c.issue_id));
  }
  await runAll(env, stmts);
  return orders.length + contracts.length;
}
function moveReason(r) {
  return r.paidEnough ? 'All sub-tasks are done and it is fully paid' : 'All sub-tasks are done and it is not yet fully paid';
}

// ---------- reading Jira ----------

const ORDER_JQL = `issuetype = Epic AND cf[${F.entity.split('_')[1]}] is not EMPTY AND (statusCategory != Done OR updated >= -${KEEP_DONE_DAYS}d) ORDER BY key`;
const CONTRACT_JQL = `issuetype = "${CONTRACT_TYPE}" AND status not in ("Archived", "Contract Lost") ORDER BY key`;

// Places each changed issue: an order or contract itself, an item under one, or an item under one of those.
async function place(env, issues, ids, projects, now) {
  const orderish = issues.filter((i) => isEpic(i) || isContract(i));
  const stmts = [];
  for (const i of orderish) stmts.push(isContract(i) ? contractStatement(env, i, projects, now) : orderStatement(env, i, ids, projects, now));
  await runAll(env, stmts);
  const touched = new Set(orderish.map((i) => String(i.id)));
  const rest = issues.filter((i) => !isEpic(i) && !isContract(i) && i.fields?.parent?.id);
  if (!rest.length) return touched;
  const parents = [...new Set(rest.map((i) => String(i.fields.parent.id)))];
  const known = new Map();
  const items = new Map();
  for (const part of chunk(parents, IN)) {
    const q = marks(part.length);
    for (const r of (await env.DB.prepare(`SELECT issue_id FROM wip_orders WHERE issue_id IN (${q}) UNION SELECT issue_id FROM wip_contracts WHERE issue_id IN (${q})`).bind(...part, ...part).all()).results) known.set(r.issue_id, true);
    for (const r of (await env.DB.prepare(`SELECT issue_id, order_id FROM wip_items WHERE level = 1 AND issue_id IN (${q})`).bind(...part).all()).results) items.set(r.issue_id, r.order_id);
  }
  // An item that has moved to a parent the hub doesn't follow is let go.
  const own = rest.map((i) => String(i.id));
  const before = new Map();
  for (const part of chunk(own, IN)) {
    for (const r of (await env.DB.prepare(`SELECT issue_id, order_id FROM wip_items WHERE issue_id IN (${marks(part.length)})`).bind(...part).all()).results) before.set(r.issue_id, r.order_id);
  }
  const out = [];
  // Items straight under an order first, so anything new under them in the same search is placed too.
  const first = rest.filter((i) => known.has(String(i.fields.parent.id)));
  for (const i of first) { out.push(itemStatement(env, i, String(i.fields.parent.id), 1)); items.set(String(i.id), String(i.fields.parent.id)); }
  for (const i of rest) {
    const p = String(i.fields.parent.id);
    if (known.has(p)) touched.add(p);
    else if (items.has(p)) { out.push(itemStatement(env, i, items.get(p), 2)); touched.add(items.get(p)); }
    else if (before.has(String(i.id))) { out.push(env.DB.prepare('DELETE FROM wip_items WHERE issue_id = ? OR parent_id = ?').bind(String(i.id), String(i.id))); }
    if (before.has(String(i.id))) touched.add(before.get(String(i.id)));
  }
  await runAll(env, out);
  return touched;
}

// Every run: what changed in the last few minutes.
export async function quick(env) {
  if (!(await getState(env, 'wip_full_done'))) return { idle: true };
  const b = budget(env, QUICK_CALLS);
  const out = {};
  try {
    out.month = await closeMonth(env);
    const mark = Number((await getState(env, 'wip_quick_at')) || 0);
    const started = Date.now();
    const minutes = Math.ceil((started - mark) / 60000) + 2;
    if (minutes > 24 * 60) {
      await setState(env, 'wip_full_at', '0');
      await setState(env, 'wip_quick_at', String(started));
      return { idle: true };
    }
    const ids = await fieldIds(env, b);
    const { issues, more } = await search(b, `updated >= -${minutes}m ORDER BY updated ASC`, ALL_FIELDS(ids), { pages: 2 });
    const projects = await regionMap(env);
    const touched = await place(env, issues, ids, projects, new Date().toISOString());
    out.changed = await recompute(env, [...touched]);
    // A busy few minutes leaves the rest to the next run.
    const last = issues.length ? Date.parse(issues[issues.length - 1].fields?.updated || '') : NaN;
    await setState(env, 'wip_quick_at', String(more && !Number.isNaN(last) ? last - 60_000 : started - 30_000));
    if (b.left() >= 2) out.moved = await processMoves(env, b, 1);
    await setState(env, 'wip_error', '');
  } catch (err) {
    if (!(err instanceof OutOfCalls)) { await setState(env, 'wip_error', `${new Date().toISOString()} ${err.message}`); throw err; }
  }
  out.calls = b.used;
  return out;
}

// Its own turn: the month change, the whole list every half hour, and any waiting moves.
export async function full(env, { force = false } = {}) {
  const b = budget(env, FULL_CALLS);
  const out = {};
  try {
    out.month = await closeMonth(env);
    let state = null;
    try { state = JSON.parse((await getState(env, 'wip_full') || 'null')); } catch { /* start again */ }
    const due = force || Date.now() - Number((await getState(env, 'wip_full_at')) || 0) >= FULL_EVERY_MS;
    if (!state && !due) {
      const waiting = await env.DB.prepare("SELECT 1 AS n FROM wip_moves WHERE status = 'pending' AND next_at <= ? LIMIT 1").bind(Date.now()).first();
      if (!waiting || !(await anyMovesOn(env))) return out.month ? out : { idle: true };
      out.moved = await processMoves(env, b, 5);
      return out;
    }
    const ids = await fieldIds(env, b);
    const projects = await regionMap(env);
    if (!state) {
      const at = new Date().toISOString();
      const orders = await search(b, ORDER_JQL, ORDER_FIELDS(ids));
      const contracts = await search(b, CONTRACT_JQL, CONTRACT_FIELDS);
      await runAll(env, [...orders.issues.map((i) => orderStatement(env, i, ids, projects, at)), ...contracts.issues.map((i) => contractStatement(env, i, projects, at))]);
      // Anything that should have come back and didn't has been deleted, or isn't an order now.
      const since = londonDate(Date.now() - KEEP_DONE_DAYS * 86_400_000);
      const seenOrders = new Set(orders.issues.map((i) => String(i.id)));
      const seenContracts = new Set(contracts.issues.map((i) => String(i.id)));
      const lostOrders = (await env.DB.prepare('SELECT issue_id, status_cat, done_at FROM wip_orders WHERE gone = 0').all()).results
        .filter((o) => !seenOrders.has(o.issue_id) && (o.status_cat !== 'done' || (o.done_at || '') >= since)).map((o) => o.issue_id);
      const lostContracts = (await env.DB.prepare('SELECT issue_id FROM wip_contracts WHERE gone = 0').all()).results
        .filter((c) => !seenContracts.has(c.issue_id)).map((c) => c.issue_id);
      const goneStmts = [];
      for (const part of chunk(lostOrders, IN)) goneStmts.push(env.DB.prepare(`UPDATE wip_orders SET gone = 1 WHERE issue_id IN (${marks(part.length)})`).bind(...part));
      for (const part of chunk(lostContracts, IN)) goneStmts.push(env.DB.prepare(`UPDATE wip_contracts SET gone = 1 WHERE issue_id IN (${marks(part.length)})`).bind(...part));
      if (goneStmts.length) await runAll(env, goneStmts);
      const keep = londonDate(Date.now() - KEEP_DONE_DAYS * 86_400_000);
      const { results } = await env.DB.prepare(
        `SELECT issue_id FROM wip_orders WHERE gone = 0 AND (status_cat IS NOT 'done' OR done_at >= ?)
         UNION ALL SELECT issue_id FROM wip_contracts WHERE gone = 0`
      ).bind(keep).all();
      state = { ids: results.map((r) => r.issue_id), at: 0 };
      await setState(env, 'wip_full', JSON.stringify(state));
    }
    out.read = 0;
    while (state.at < state.ids.length) {
      const batch = state.ids.slice(state.at, state.at + BATCH);
      await readItems(env, b, batch);
      out.read += await recompute(env, batch);
      state.at += batch.length;
      await setState(env, 'wip_full', JSON.stringify(state));
    }
    await setState(env, 'wip_full', '');
    await setState(env, 'wip_full_at', String(Date.now()));
    if (!(await getState(env, 'wip_full_done'))) {
      await setState(env, 'wip_full_done', new Date().toISOString());
      await setState(env, 'wip_quick_at', String(Date.now()));
    }
    if (b.left() >= 2 && (await anyMovesOn(env))) out.moved = await processMoves(env, b, Math.floor(b.left() / 2));
    await setState(env, 'wip_error', '');
  } catch (err) {
    if (!(err instanceof OutOfCalls)) { await setState(env, 'wip_error', `${new Date().toISOString()} ${err.message}`); throw err; }
    out.partial = true;
  }
  out.calls = b.used;
  return out;
}

// Reads everything under these orders and contracts, and replaces what was kept.
async function readItems(env, b, orderIds) {
  const level1 = [];
  for (const part of chunk(orderIds, 50)) level1.push(...(await search(b, `parent in (${part.join(',')})`, ITEM_FIELDS)).issues);
  // Sub-tasks sit under the category items (and, on older orders, under ordinary tasks).
  const cats = level1.filter((i) => !ADMIN_TYPES.includes(lower(i.fields?.issuetype?.name)) && !isContract({ fields: { issuetype: i.fields?.issuetype } })
    && !/visit|token/i.test(i.fields?.issuetype?.name || ''));
  const level2 = [];
  for (const part of chunk(cats.map((i) => String(i.id)), 50)) level2.push(...(await search(b, `parent in (${part.join(',')})`, ITEM_FIELDS)).issues);
  const orderOf = new Map(level1.map((i) => [String(i.id), String(i.fields.parent.id)]));
  const stmts = [];
  // Only items that have gone are deleted; the rest are written only if they changed.
  const fresh = new Set([...level1, ...level2].map((i) => String(i.id)));
  const lost = [];
  for (const part of chunk(orderIds.map(String), IN)) {
    for (const r of (await env.DB.prepare(`SELECT issue_id FROM wip_items WHERE order_id IN (${marks(part.length)})`).bind(...part).all()).results) {
      if (!fresh.has(r.issue_id)) lost.push(r.issue_id);
    }
  }
  for (const part of chunk(lost, IN)) stmts.push(env.DB.prepare(`DELETE FROM wip_items WHERE issue_id IN (${marks(part.length)})`).bind(...part));
  for (const i of level1) stmts.push(itemStatement(env, i, String(i.fields.parent.id), 1));
  for (const i of level2) stmts.push(itemStatement(env, i, orderOf.get(String(i.fields.parent.id)), 2));
  await runAll(env, stmts);
}

// ---------- moving orders on in Jira ----------

// Whether invoices are moved to Overdue by the hub. On unless turned off under Invoicing's cog.
export const overdueOn = async (env) => (await getState(env, 'invoice_overdue_on')) !== '0';
async function anyMovesOn(env) {
  return (await getState(env, 'wip_moves_on')) === '1' || (await overdueOn(env));
}

async function processMoves(env, b, max) {
  const ordersOn = (await getState(env, 'wip_moves_on')) === '1';
  const invoicesOn = await overdueOn(env);
  if (!ordersOn && !invoicesOn) return 0;
  const { results } = await env.DB.prepare("SELECT * FROM wip_moves WHERE status = 'pending' AND next_at <= ? ORDER BY queued_at LIMIT ?").bind(Date.now(), max).all();
  let moved = 0;
  for (const m of results) {
    if (b.left() < 2) break;
    // An order moving on, or an invoice moving to Overdue.
    let order = await env.DB.prepare('SELECT * FROM wip_orders WHERE issue_key = ?').bind(m.issue_key).first();
    const item = order ? null : await env.DB.prepare('SELECT * FROM wip_items WHERE issue_key = ?').bind(m.issue_key).first();
    if (item) order = item;
    if ((item && !invoicesOn) || (!item && !ordersOn)) continue;
    // Someone moved it first, or it no longer qualifies (paid, say, or given a later due date): nothing to do.
    const stillDue = !item || (item.inv_date && item.inv_date < londonDate() && !invoiceState(item).paid);
    if (!order || lower(order.status) !== lower(m.from_status) || lower(order.status) === lower(m.target) || !stillDue) {
      await env.DB.prepare("UPDATE wip_moves SET status = 'skipped', done_at = ? WHERE issue_key = ?").bind(new Date().toISOString(), m.issue_key).run();
      continue;
    }
    try {
      const { transitions = [] } = await b.call(`/rest/api/3/issue/${encodeURIComponent(m.issue_key)}/transitions`);
      const t = transitions.find((x) => lower(x.to?.name || x.name) === lower(m.target));
      if (!t) throw new Error(`Jira has no way to move ${m.issue_key} from ${order.status} to ${m.target}.`);
      await b.call(`/rest/api/3/issue/${encodeURIComponent(m.issue_key)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: t.id } }) });
      const cat = t.to?.statusCategory?.key || (lower(m.target) === 'done' ? 'done' : 'indeterminate');
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE wip_moves SET status = 'done', done_at = ?, last_error = NULL WHERE issue_key = ?").bind(now, m.issue_key),
        item
          ? env.DB.prepare('UPDATE wip_items SET status = ?, status_cat = ? WHERE issue_key = ?').bind(t.to?.name || m.target, cat, m.issue_key)
          : env.DB.prepare('UPDATE wip_orders SET status = ?, status_cat = ?, done_at = ? WHERE issue_key = ?').bind(m.target, cat, cat === 'done' ? londonDate() : null, m.issue_key),
      ]);
      moved++;
    } catch (err) {
      if (err instanceof OutOfCalls) throw err;
      const tries = (m.tries || 0) + 1;
      const wait = Math.min(MOVE_RETRY_CAP_MS, MOVE_RETRY_MS * 3 ** (tries - 1));
      await env.DB.prepare('UPDATE wip_moves SET tries = ?, next_at = ?, last_error = ? WHERE issue_key = ?').bind(tries, Date.now() + wait, String(err.message).slice(0, 300), m.issue_key).run();
      if (tries === MOVE_TRIES_BEFORE_ALERT) {
        await raiseAlert(env, {
          kind: 'wip-move',
          dedupe: `wip-move:${m.issue_key}:${m.target}:${m.queued_at}`,
          subject: `${m.issue_key} couldn't be moved to ${m.target}`,
          body: `The hub has tried ${tries} times to move ${m.issue_key} from ${m.from_status} to ${m.target} in Jira (${m.reason.toLowerCase()}).\n\nJira said: ${err.message}\n\n`
            + 'It keeps trying, less often. Moving it by hand in Jira also clears this. The WIP tile shows it as waiting to move.',
        });
      }
    }
  }
  return moved;
}

// ---------- months ----------

function inMonth(order, month) {
  const start = `${month}-01`, next = `${shiftMonth(month, 1)}-01`;
  if ((order.created || '') >= next) return false;
  if (order.status_cat === 'done' && order.done_at && order.done_at < start) return false;
  return true;
}

// On the first run of a month, the month just ended is kept as it stood.
async function closeMonth(env) {
  const now = thisMonth();
  const last = await getState(env, 'wip_month');
  if (!last) { await setState(env, 'wip_month', now); return null; }
  if (last >= now || !(await getState(env, 'wip_full_done'))) return null;
  for (const region of Object.keys(REGIONS)) {
    const rows = await liveRows(env, region, last);
    const already = await env.DB.prepare("SELECT 1 AS n FROM wip_snapshots WHERE month = ? AND region = ? AND source = 'hub' LIMIT 1").bind(last, region).first();
    if (already) continue;
    const stmts = [env.DB.prepare('DELETE FROM wip_snapshots WHERE month = ? AND region = ?').bind(last, region)];
    for (const r of rows) {
      stmts.push(env.DB.prepare(
        `INSERT INTO wip_snapshots (month, issue_key, region, org, title, status, division, upfront, token, quote_no, accepted, done_at, progress, non_admin, invoiced, paid, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hub')`
      ).bind(last, r.key, region, r.org, r.title, r.status, r.division, r.value, r.tokens !== null ? 1 : 0, r.quoteNo, r.accepted, r.doneAt, r.progress, r.nonAdmin, r.invoiced, r.paid));
    }
    const totals = metrics(rows, last);
    const prev = await historyRow(env, region, shiftMonth(last, -1));
    stmts.push(env.DB.prepare(
      `INSERT INTO wip_history (month, region, data, source) VALUES (?, ?, ?, 'hub')
       ON CONFLICT(month, region) DO UPDATE SET data = excluded.data, source = excluded.source`
    ).bind(last, region, JSON.stringify(historyFrom(totals, prev))));
    await runAll(env, stmts);
  }
  await setState(env, 'wip_month', now);
  return last;
}

async function historyRow(env, region, month) {
  const row = await env.DB.prepare('SELECT data FROM wip_history WHERE month = ? AND region = ?').bind(month, region).first();
  try { return row ? JSON.parse(row.data) : null; } catch { return null; }
}

// ---------- rows as the tile shows them ----------

async function overridesAndSeeds(env, keys) {
  const over = new Map(), seed = new Map();
  for (const part of chunk(keys, IN)) {
    for (const r of (await env.DB.prepare(`SELECT * FROM wip_overrides WHERE issue_key IN (${marks(part.length)})`).bind(...part).all()).results) over.set(r.issue_key, r);
    for (const r of (await env.DB.prepare(`SELECT * FROM wip_seed WHERE issue_key IN (${marks(part.length)})`).bind(...part).all()).results) seed.set(r.issue_key, r);
  }
  return { over, seed };
}

function rowFor(o, over, seed, last, month) {
  const tokenText = /token/i.test(seed?.upfront_text || '');
  const isToken = Boolean(o.token_only) || (tokenText && o.invoiced === 0 && !o.paid);
  const value = isToken ? null : (over?.upfront ?? seed?.upfront ?? o.upfront ?? null);
  const division = over?.division || seed?.division || o.division_jira || (value === null ? 'ServiceTeam' : value < 10000 ? 'ServiceTeam' : 'ProjectsTeam');
  const accepted = seed?.accepted || o.created;
  const isNew = monthOf(accepted) === month;
  const lastProgress = last ? last.progress : isNew ? 0 : null;
  const lastNonAdmin = last ? last.non_admin : isNew ? 0 : null;
  const v = value || 0;
  return {
    id: o.issue_id, key: o.issue_key, project: o.project_key, org: o.org, title: o.summary, status: o.status, statusCat: o.status_cat,
    division, value, tokens: isToken ? (o.token_qty || num(String(seed?.upfront_text || '').match(/[\d.]+/)?.[0]) || null) : null,
    quoteNo: o.quote_no || seed?.quote_no || null, accepted, doneAt: o.done_at, isNew,
    progress: o.progress ?? 0, lastProgress, nonAdmin: o.non_admin, lastNonAdmin,
    wipValue: value === null ? null : v * (o.progress || 0), lastValue: value === null || lastProgress === null ? null : v * lastProgress,
    invoiced: isToken ? null : o.invoiced ?? 0, paid: isToken ? null : o.paid ?? 0,
    invoicedValue: value === null ? null : v * (o.invoiced || 0), paidValue: value === null ? null : v * (o.paid || 0),
    remaining: value === null ? null : v - v * (o.paid || 0),
    open: o.open_work, legacy: Boolean(o.legacy), docYes: Boolean(o.doc_yes), hasDoc: Boolean(o.has_doc),
    tokenPaid: Boolean(o.token_paid), overridden: Boolean(over && (over.division || over.upfront !== null)),
    valueSource: isToken ? 'tokens' : over?.upfront != null ? 'override' : seed?.upfront != null ? 'sheet' : o.upfront != null ? 'jira' : 'none',
    divisionSource: over?.division ? 'override' : seed?.division ? 'sheet' : o.division_jira ? 'jira' : 'guess',
  };
}

async function lastMonthRows(env, region, month) {
  const { results } = await env.DB.prepare('SELECT issue_key, progress, non_admin FROM wip_snapshots WHERE month = ? AND region = ?').bind(shiftMonth(month, -1), region).all();
  return new Map(results.map((r) => [r.issue_key, r]));
}

async function liveRows(env, region, month) {
  const keep = `${shiftMonth(month, -1)}-01`;
  const { results } = await env.DB.prepare(
    `SELECT * FROM wip_orders WHERE region = ? AND gone = 0 AND customer_item = 0 AND entity IS NOT NULL
       AND (status_cat IS NOT 'done' OR done_at >= ?)`
  ).bind(region, keep).all();
  const orders = results.filter((o) => inMonth(o, month));
  const { over, seed } = await overridesAndSeeds(env, orders.map((o) => o.issue_key));
  const last = await lastMonthRows(env, region, month);
  return orders.filter((o) => !over.get(o.issue_key)?.excluded)
    .map((o) => rowFor(o, over.get(o.issue_key), seed.get(o.issue_key), last.get(o.issue_key), month));
}

async function snapshotRows(env, region, month) {
  const { results } = await env.DB.prepare('SELECT * FROM wip_snapshots WHERE month = ? AND region = ? ORDER BY issue_key').bind(month, region).all();
  const last = await lastMonthRows(env, region, month);
  return results.map((s) => {
    const l = last.get(s.issue_key);
    const isNew = monthOf(s.accepted) === month;
    const lastProgress = l ? l.progress : isNew ? 0 : null;
    const v = s.upfront || 0;
    const value = s.token ? null : s.upfront;
    return {
      id: null, key: s.issue_key, project: s.issue_key.split('-')[0], org: s.org, title: s.title, status: s.status, statusCat: lower(s.status) === 'done' ? 'done' : null,
      division: s.division, value, tokens: s.token ? 1 : null, quoteNo: s.quote_no, accepted: s.accepted, doneAt: s.done_at, isNew,
      progress: s.progress ?? 0, lastProgress, nonAdmin: s.non_admin, lastNonAdmin: l ? l.non_admin : isNew ? 0 : null,
      wipValue: value === null ? null : v * (s.progress || 0), lastValue: value === null || lastProgress === null ? null : v * lastProgress,
      invoiced: s.token ? null : s.invoiced, paid: s.token ? null : s.paid,
      invoicedValue: value === null ? null : v * (s.invoiced || 0), paidValue: value === null ? null : v * (s.paid || 0),
      remaining: value === null ? null : v - v * (s.paid || 0), open: null, legacy: null, snapshot: true, source: s.source,
    };
  });
}

// ---------- totals ----------

export function metrics(rows, month) {
  const part = (list) => {
    const money = list.filter((r) => r.value !== null);
    const sum = (fn) => money.reduce((t, r) => t + (fn(r) || 0), 0);
    const avg = (xs) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null);
    const known = list.filter((r) => r.lastProgress !== null && r.lastProgress !== undefined);
    const knownWork = list.filter((r) => r.nonAdmin !== null && r.nonAdmin !== undefined && r.lastNonAdmin !== null && r.lastNonAdmin !== undefined);
    const active = money.filter((r) => ACTIVE.includes(lower(r.status)));
    const orderBook = sum((r) => r.value);
    const wipValue = sum((r) => r.wipValue);
    const lastValue = sum((r) => (r.lastValue === null ? r.wipValue : r.lastValue));
    const invoiced = sum((r) => r.invoicedValue);
    const paid = sum((r) => r.paidValue);
    const activeValue = active.reduce((t, r) => t + (r.wipValue || 0), 0);
    return {
      orders: list.length, orderBook, wipValue, lastValue, thisMonthValue: wipValue - lastValue,
      avgProgress: avg(list.map((r) => r.progress || 0)), avgChange: avg(known.map((r) => (r.progress || 0) - r.lastProgress)),
      avgWorkChange: avg(knownWork.map((r) => r.nonAdmin - r.lastNonAdmin)),
      workValue: sum((r) => (r.nonAdmin !== null && r.nonAdmin !== undefined && r.lastNonAdmin !== null && r.lastNonAdmin !== undefined ? r.value * (r.nonAdmin - r.lastNonAdmin) : 0)),
      invoiced, paid, awaiting: invoiced - paid, remaining: orderBook - paid,
      newCount: list.filter((r) => r.isNew).length, newValue: sum((r) => (r.isNew ? r.value : 0)),
      completed: list.filter((r) => lower(r.status) === 'done' && (!month || !r.doneAt || monthOf(r.doneAt) === month)).length,
      activeValue, unrealised: active.reduce((t, r) => t + (r.value || 0), 0) - activeValue,
      tokenOrders: list.filter((r) => r.tokens !== null).length,
    };
  };
  const counts = {};
  for (const r of rows) counts[r.status || 'No status'] = (counts[r.status || 'No status'] || 0) + 1;
  return {
    all: part(rows),
    service: part(rows.filter((r) => r.division === 'ServiceTeam')),
    projects: part(rows.filter((r) => r.division !== 'ServiceTeam')),
    counts,
  };
}

export function historyFrom(t, prev) {
  return {
    newProjects: t.projects.newCount, newService: t.service.newCount,
    completeProjects: t.projects.completed, completeService: t.service.completed,
    projectsProgress: t.projects.avgChange, serviceProgress: t.service.avgChange,
    projectsWork: t.projects.avgWorkChange, serviceWork: t.service.avgWorkChange,
    projectsValue: t.projects.thisMonthValue, serviceValue: t.service.thisMonthValue,
    projectsWorkValue: t.projects.workValue, serviceWorkValue: t.service.workValue,
    unrealisedProjects: t.projects.unrealised, unrealisedService: t.service.unrealised,
    startInvoiced: prev?.endInvoiced ?? null, startPaid: prev?.endPaid ?? null, startAwaiting: prev?.endAwaiting ?? null,
    endInvoiced: t.all.invoiced, endPaid: t.all.paid, endAwaiting: t.all.awaiting,
    orderBook: t.all.orderBook, wipValue: t.all.wipValue, orders: t.all.orders,
  };
}

// ---------- what people see ----------

export function canSee(viewer) {
  return canTile(viewer, 'wip');
}
// Changing values, settings and payment terms.
const canChange = (viewer) => Boolean(viewer?.isAdmin || (viewer?.can && 'wipEdit' in viewer.can ? viewer.can.wipEdit : viewer?.groups?.includes('management')));
const refuse = (message, status = 403) => { const err = new Error(message); err.status = status; return err; };
function mustSee(viewer) { if (!canSee(viewer)) throw refuse('The WIP isn\'t open to you.'); }
const regionArg = (r) => (r in REGIONS ? r : 'uk');

async function header(env) {
  const keys = ['wip_full_done', 'wip_full_at', 'wip_quick_at', 'wip_error', 'wip_moves_on', 'wip_moves_since'];
  const [fullDone, fullAt, quickAt, error, movesOn, movesSince] = await Promise.all(keys.map((k) => getState(env, k)));
  const at = Math.max(Number(fullAt || 0), Number(quickAt || 0));
  return { ready: Boolean(fullDone), syncedAt: at ? new Date(at).toISOString() : null, error: error || null, movesOn: movesOn === '1', movesSince: movesSince || null };
}

async function monthsAvailable(env, region) {
  const { results } = await env.DB.prepare('SELECT DISTINCT month FROM wip_snapshots WHERE region = ? ORDER BY month DESC').bind(region).all();
  const now = thisMonth();
  return [now, ...results.map((r) => r.month).filter((m) => m < now)];
}

export async function overview(env, viewer, { region, month } = {}) {
  mustSee(viewer);
  region = regionArg(region);
  const now = thisMonth();
  month = isMonth(month) && month <= now ? month : now;
  const head = await header(env);
  const live = month === now;
  const rows = live ? await liveRows(env, region, month) : await snapshotRows(env, region, month);
  const invoices = [];
  if (live && rows.length) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const i of (await itemsFor(env, [...byId.keys()])).filter((x) => x.level === 1 && isInvoice(x))) {
      const r = byId.get(i.order_id);
      const s = invoiceState(i);
      invoices.push({
        order: r.key, orderTitle: r.title, org: r.org, key: i.issue_key, terms: String(i.summary || '').replace(/^(\s*[\d.]+%\s*)+/, '').trim() || i.summary,
        share: i.share, value: r.value === null || isTokenInvoice(i) ? null : r.value * (Number(i.share) || 0), token: isTokenInvoice(i),
        status: i.status, state: s.label, date: i.inv_date || i.inv_due || null, invoiceDate: i.inv_date, due: i.inv_due, created: i.created,
      });
    }
    invoices.sort((a, b) => a.order.localeCompare(b.order) || String(a.created || '').localeCompare(String(b.created || '')));
  }
  const { results: moves } = await env.DB.prepare(
    `SELECT m.* FROM wip_moves m JOIN wip_orders o ON o.issue_key = m.issue_key WHERE o.region = ? AND (m.status = 'pending' OR (m.status = 'done' AND m.done_at >= ?))
     ORDER BY m.queued_at DESC LIMIT 100`
  ).bind(region, new Date(Date.now() - 7 * 86_400_000).toISOString()).all();
  return {
    ...head, region, regions: REGIONS, month, live, months: await monthsAvailable(env, region),
    rows: rows.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true })),
    totals: metrics(rows, month), invoices, moves,
    canEdit: canChange(viewer), isAdmin: Boolean(viewer.isAdmin),
  };
}

export async function order(env, viewer, key) {
  mustSee(viewer);
  const o = await env.DB.prepare('SELECT * FROM wip_orders WHERE issue_key = ?').bind(String(key || '').toUpperCase()).first();
  if (!o) throw refuse('That order isn\'t in the WIP.', 404);
  const items = await itemsFor(env, [o.issue_id]);
  const { over, seed } = await overridesAndSeeds(env, [o.issue_key]);
  const last = await lastMonthRows(env, o.region, thisMonth());
  const row = rowFor(o, over.get(o.issue_key), seed.get(o.issue_key), last.get(o.issue_key), thisMonth());
  const level1 = items.filter((i) => i.level === 1).sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const subs = items.filter((i) => i.level === 2);
  const parts = level1.filter((i) => !isInvoice(i)).map((i) => {
    const mine = subs.filter((s) => s.parent_id === i.issue_id);
    return { key: i.issue_key, type: i.issuetype, summary: i.summary, status: i.status, done: i.status_cat === 'done',
      subs: mine.length, subsDone: mine.filter((s) => s.status_cat === 'done').length,
      open: mine.filter((s) => s.status_cat !== 'done').map((s) => ({ key: s.issue_key, summary: s.summary, status: s.status })) };
  });
  const invoices = level1.filter(isInvoice).map((i) => ({
    key: i.issue_key, summary: i.summary, terms: String(i.summary || '').replace(/^(\s*[\d.]+%\s*)+/, '').trim() || i.summary, share: i.share,
    value: row.value === null || isTokenInvoice(i) ? null : row.value * (Number(i.share) || 0), token: isTokenInvoice(i),
    status: i.status, state: invoiceState(i).label, invoiceDate: i.inv_date, due: i.inv_due,
  }));
  const move = await env.DB.prepare('SELECT * FROM wip_moves WHERE issue_key = ?').bind(o.issue_key).first();
  const saStaff = await saTime(env, o.issue_id, items);
  return {
    row, region: o.region, entity: o.entity, parts, invoices, move, saTime: saStaff,
    override: over.get(o.issue_key) || null, seed: seed.get(o.issue_key) || null, jiraValue: o.upfront, jiraDivision: o.division_jira,
    canEdit: canChange(viewer),
  };
}

// Time logged on the order and everything under it by the people marked as Promtek SA staff.
async function saTime(env, orderId, items) {
  let staff = [];
  try { staff = JSON.parse((await getState(env, 'wip_sa_staff')) || '[]'); } catch { /* none */ }
  if (!staff.length) return null;
  const ids = [orderId, ...items.map((i) => i.issue_id)];
  let seconds = 0;
  for (const p of chunk(staff, 40)) {
    for (const q of chunk(ids, 50)) {
      const r = await env.DB.prepare(`SELECT SUM(seconds) AS s FROM xp_ledger WHERE account_id IN (${marks(p.length)}) AND issue_id IN (${marks(q.length)})`).bind(...p, ...q).first();
      seconds += Number(r?.s || 0);
    }
  }
  return { seconds };
}

// Active service contracts only: In Contract or Requires Renewal. The status
// comes from the Service Contracts tile where it has the contract, since the hub
// moves contracts along there; Jira's own status otherwise.
const ACTIVE_CONTRACT = ['in contract', 'requires renewal'];

async function contractsIn(env, region) {
  const { results } = await env.DB.prepare(
    `SELECT w.*, c.status AS tile_status, c.customer AS tile_customer, c.start_date AS tile_start, c.end_date AS tile_end
       FROM wip_contracts w LEFT JOIN contracts c ON c.issue_key = w.issue_key
      WHERE w.region = ? AND w.gone = 0 ORDER BY w.issue_key`
  ).bind(region).all();
  return results;
}
const isActiveContract = (c) => ACTIVE_CONTRACT.includes(lower(canonStatus(c.tile_status || c.status)));

export async function recurring(env, viewer, { region } = {}) {
  mustSee(viewer);
  region = regionArg(region);
  const active = (await contractsIn(env, region)).filter(isActiveContract);
  const { over, seed } = await overridesAndSeeds(env, active.map((c) => c.issue_key));
  const rows = [];
  for (const c of active) {
    const s = seed.get(c.issue_key), o = over.get(c.issue_key);
    if (o?.excluded) continue;
    const total = o?.upfront ?? s?.upfront ?? c.total ?? null;
    const pctInv = c.steps ? c.steps_invoiced / c.steps : 0;
    const pctPaid = c.steps ? c.steps_paid / c.steps : 0;
    const status = canonStatus(c.tile_status || c.status);
    const state = lower(status) === 'requires renewal' ? 'Requires Renewal' : 'Active';
    const division = o?.division || s?.division || (/condor/i.test(c.summary || '') ? 'Condor' : 'Service');
    rows.push({
      key: c.issue_key, org: c.tile_customer || c.org, title: c.summary, status, state, division,
      start: c.tile_start || c.start_date || s?.start_date || null, end: c.tile_end || c.end_date || s?.end_date || null, ended: c.ended_at,
      total, steps: c.steps || 0, stepsInvoiced: c.steps_invoiced || 0, stepsPaid: c.steps_paid || 0,
      invoiced: pctInv, paid: pctPaid, invoicedValue: total === null ? null : total * pctInv, paidValue: total === null ? null : total * pctPaid,
      valueSource: o?.upfront != null ? 'override' : s?.upfront != null ? 'sheet' : c.total != null ? 'jira' : 'none',
    });
  }
  const sum = (list, k) => list.reduce((t, r) => t + (r[k] || 0), 0);
  const of = (d) => rows.filter((r) => r.division === d);
  return {
    region, rows,
    totals: {
      count: rows.length, value: sum(rows, 'total'), invoiced: sum(rows, 'invoicedValue'), paid: sum(rows, 'paidValue'),
      service: { count: of('Service').length, value: sum(of('Service'), 'total') },
      condor: { count: of('Condor').length, value: sum(of('Condor'), 'total') },
    },
  };
}

export async function history(env, viewer, { region } = {}) {
  mustSee(viewer);
  region = regionArg(region);
  const { results } = await env.DB.prepare('SELECT month, data, source FROM wip_history WHERE region = ? ORDER BY month').bind(region).all();
  const rows = results.map((r) => { let d = {}; try { d = JSON.parse(r.data); } catch { /* empty */ } return { month: r.month, source: r.source, ...d }; });
  // This month so far, from the live figures.
  const now = thisMonth();
  if (!rows.some((r) => r.month === now)) {
    const live = await liveRows(env, region, now);
    const prev = rows.filter((r) => r.month < now).pop() || null;
    rows.push({ month: now, source: 'live', ...historyFrom(metrics(live, now), prev?.month === shiftMonth(now, -1) ? prev : null) });
  }
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], r = rows[i];
    if (p.month !== shiftMonth(r.month, -1)) continue;
    if (r.startInvoiced == null) r.startInvoiced = p.endInvoiced ?? null;
    if (r.startPaid == null) r.startPaid = p.endPaid ?? null;
    if (r.startAwaiting == null) r.startAwaiting = p.endAwaiting ?? null;
  }
  return { region, rows };
}

// ---------- the finance overview ----------

const DONE = ['done', 'archive'];
const isDone = (r) => DONE.includes(lower(r.status));
const AGE_BUCKETS = [[31, 'Under a month'], [92, '1 to 3 months'], [183, '3 to 6 months'], [366, '6 to 12 months'], [Infinity, 'Over a year']];
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const endOfMonth = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };

// What actually happened in each month, rather than running totals: value that came onto
// the books and went off them, what was invoiced and paid in that month, and the open book
// at the month end, worked out from one month's list against the month before.
function flows(month, rows, prevRows) {
  const prev = prevRows ? new Map(prevRows.map((r) => [r.key, r])) : null;
  const v = (r) => (r.value === null || r.value === undefined ? 0 : r.value);
  const open = rows.filter((r) => !isDone(r));
  const out = {
    month,
    openBook: open.reduce((t, r) => t + v(r), 0),
    openDone: open.reduce((t, r) => t + v(r) * (r.progress || 0), 0),
    added: rows.filter((r) => r.isNew).reduce((t, r) => t + v(r), 0),
    addedCount: rows.filter((r) => r.isNew).length,
    awaiting: rows.reduce((t, r) => t + v(r) * Math.max(0, (r.invoiced || 0) - (r.paid || 0)), 0),
    finished: null, finishedCount: null, invoicedIn: null, paidIn: null, workIn: null,
  };
  out.openToDo = out.openBook - out.openDone;
  if (!prev) return out;
  const finished = rows.filter((r) => isDone(r) && !(prev.get(r.key) && isDone(prev.get(r.key))));
  out.finished = finished.reduce((t, r) => t + v(r), 0);
  out.finishedCount = finished.length;
  let inv = 0, paid = 0, work = 0;
  for (const r of rows) {
    const p = prev.get(r.key);
    const before = p || (r.isNew ? { invoiced: 0, paid: 0, progress: 0 } : null);
    if (!before) continue;
    inv += v(r) * ((r.invoiced || 0) - (before.invoiced || 0));
    paid += v(r) * ((r.paid || 0) - (before.paid || 0));
    work += v(r) * ((r.progress || 0) - (before.progress || 0));
  }
  out.invoicedIn = inv; out.paidIn = paid; out.workIn = work;
  return out;
}

async function datedFlows(env, region, from) {
  const { results: orders } = await env.DB.prepare('SELECT issue_id, issue_key, upfront, token_only FROM wip_orders WHERE region = ? AND customer_item = 0').bind(region).all();
  const out = new Map();
  if (!orders.length) return out;
  const { over, seed } = await overridesAndSeeds(env, orders.map((o) => o.issue_key));
  const value = new Map(orders.map((o) => [o.issue_id, o.token_only ? 0 : (over.get(o.issue_key)?.upfront ?? seed.get(o.issue_key)?.upfront ?? o.upfront ?? 0)]));
  const start = `${from}-01`;
  for (const part of chunk(orders.map((o) => o.issue_id), IN)) {
    const { results } = await env.DB.prepare(
      `SELECT order_id, share, summary, issuetype, status, status_cat, inv_date, paid_at FROM wip_items
        WHERE level = 1 AND order_id IN (${marks(part.length)}) AND (inv_date >= ? OR paid_at >= ?)`
    ).bind(...part, start, start).all();
    for (const i of results) {
      if (!isInvoice(i) || isTokenInvoice(i)) continue;
      const amount = (value.get(i.order_id) || 0) * (Number(i.share) || 0);
      const st = invoiceState(i);
      if (st.invoiced && i.inv_date >= start) { const g = out.get(monthOf(i.inv_date)) || { invoiced: 0, paid: 0 }; g.invoiced += amount; out.set(monthOf(i.inv_date), g); }
      if (st.paid && i.paid_at >= start) { const g = out.get(monthOf(i.paid_at)) || { invoiced: 0, paid: 0 }; g.paid += amount; out.set(monthOf(i.paid_at), g); }
    }
  }
  return out;
}

export async function insights(env, viewer, { region } = {}) {
  mustSee(viewer);
  region = regionArg(region);
  const now = thisMonth();
  const today = londonDate();
  const { results: snaps } = await env.DB.prepare(
    `SELECT month, issue_key, org, title, status, division, upfront, token, accepted, done_at, progress, non_admin, invoiced, paid
       FROM wip_snapshots WHERE region = ? ORDER BY month`
  ).bind(region).all();
  const byMonth = new Map();
  for (const s of snaps) {
    if (s.month >= now) continue;
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push({ key: s.issue_key, org: s.org, status: s.status, division: s.division, value: s.token ? null : s.upfront,
      accepted: s.accepted, doneAt: s.done_at, isNew: monthOf(s.accepted) === s.month, progress: s.progress, nonAdmin: s.non_admin, invoiced: s.invoiced, paid: s.paid });
  }
  const live = await liveRows(env, region, now);
  byMonth.set(now, live);
  const { results: hist } = await env.DB.prepare('SELECT month, data FROM wip_history WHERE region = ? ORDER BY month').bind(region).all();
  const histMap = new Map(hist.map((h) => { try { return [h.month, JSON.parse(h.data)]; } catch { return [h.month, {}]; } }));
  const months = [...new Set([...byMonth.keys(), ...histMap.keys()])].sort();
  // From the month the hub started keeping months, invoicing and payment come from each
  // invoice's own dates: its invoice date, and the day it was marked paid.
  const firstHub = await env.DB.prepare("SELECT MIN(month) AS m FROM wip_snapshots WHERE region = ? AND source = 'hub'").bind(region).first();
  const datedFrom = firstHub?.m || now;
  const dated = await datedFlows(env, region, datedFrom);
  const series = months.map((m) => {
    const rows = byMonth.get(m);
    const prevRows = byMonth.get(shiftMonth(m, -1)) || null;
    const h = histMap.get(m) || (m === now ? historyFrom(metrics(live, now), histMap.get(shiftMonth(now, -1)) || null) : {});
    const f = rows ? flows(m, rows, prevRows) : { month: m };
    if (m >= datedFrom) { f.invoicedIn = dated.get(m)?.invoiced || 0; f.paidIn = dated.get(m)?.paid || 0; f.dated = true; }
    return {
      ...f, live: m === now,
      projectsProgress: h.projectsProgress ?? null, serviceProgress: h.serviceProgress ?? null,
      projectsWork: h.projectsWork ?? null, serviceWork: h.serviceWork ?? null,
      projectsValue: h.projectsValue ?? null, serviceValue: h.serviceValue ?? null,
      endInvoiced: h.endInvoiced ?? null, endPaid: h.endPaid ?? null,
      endAwaiting: f.awaiting ?? h.endAwaiting ?? null,
    };
  });

  // Where the open value sits now.
  const open = live.filter((r) => !isDone(r));
  const v = (r) => r.value || 0;
  const group = (list, keyOf) => {
    const m = new Map();
    for (const r of list) {
      const k = keyOf(r) || 'Not set';
      const g = m.get(k) || { name: k, orders: 0, value: 0, done: 0, invoiced: 0, paid: 0 };
      g.orders++; g.value += v(r); g.done += v(r) * (r.progress || 0); g.invoiced += v(r) * (r.invoiced || 0); g.paid += v(r) * (r.paid || 0);
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, toDo: g.value - g.done }));
  };
  const statuses = group(open, (r) => r.status).sort((a, b) => b.value - a.value);
  const allCustomers = group(open, (r) => r.org).sort((a, b) => b.value - a.value);
  const top = allCustomers.slice(0, 10);
  const rest = allCustomers.slice(10);
  if (rest.length) {
    top.push(rest.reduce((t, g) => ({ name: `${rest.length} other customers`, orders: t.orders + g.orders, value: t.value + g.value, done: t.done + g.done,
      invoiced: t.invoiced + g.invoiced, paid: t.paid + g.paid, toDo: t.toDo + g.toDo, other: true }), { orders: 0, value: 0, done: 0, invoiced: 0, paid: 0, toDo: 0 }));
  }
  const ageing = AGE_BUCKETS.map(([, label]) => ({ name: label, orders: 0, value: 0, toDo: 0 }));
  for (const r of open) {
    if (!r.accepted) continue;
    const days = daysBetween(r.accepted, today);
    const b = ageing[AGE_BUCKETS.findIndex(([max]) => days < max)];
    b.orders++; b.value += v(r); b.toDo += v(r) * (1 - (r.progress || 0));
  }
  for (const b of ageing) b.done = b.value - b.toDo;

  // How long orders took from acceptance to being done, from every month on record.
  const finished = new Map();
  for (const [m, rows] of byMonth) {
    for (const r of rows) {
      if (!isDone(r) || !r.accepted || finished.has(r.key)) continue;
      const end = r.doneAt || (m === now ? today : endOfMonth(m));
      const days = daysBetween(r.accepted, end);
      if (days >= 0) finished.set(r.key, { key: r.key, division: r.division, days, value: r.value, end });
    }
  }
  const { results: doneOrders } = await env.DB.prepare(
    "SELECT o.issue_key, o.created, o.done_at FROM wip_orders o WHERE o.region = ? AND o.status_cat = 'done' AND o.done_at IS NOT NULL AND o.customer_item = 0 AND o.gone = 0"
  ).bind(region).all();
  if (doneOrders.length) {
    const { seed } = await overridesAndSeeds(env, doneOrders.map((o) => o.issue_key));
    for (const o of doneOrders) {
      const accepted = seed.get(o.issue_key)?.accepted || o.created;
      const known = finished.get(o.issue_key);
      if (!accepted) continue;
      const days = daysBetween(accepted, o.done_at);
      if (days >= 0) finished.set(o.issue_key, { key: o.issue_key, division: known?.division || seed.get(o.issue_key)?.division || null, days, value: known?.value ?? null, end: o.done_at });
    }
  }
  const since = `${shiftMonth(now, -24)}-01`;
  const recent = [...finished.values()].filter((f) => f.end >= since);
  const completion = AGE_BUCKETS.map(([, label]) => ({ name: label, projects: 0, service: 0 }));
  for (const f of recent) {
    const b = completion[AGE_BUCKETS.findIndex(([max]) => f.days < max)];
    if (f.division === 'ServiceTeam') b.service++; else b.projects++;
  }
  const typical = {
    all: median(recent.map((f) => f.days)), projects: median(recent.filter((f) => f.division !== 'ServiceTeam').map((f) => f.days)),
    service: median(recent.filter((f) => f.division === 'ServiceTeam').map((f) => f.days)), count: recent.length,
  };

  // Invoices still to raise, by the month they're planned for.
  const ids = live.filter((r) => r.id).map((r) => r.id);
  const valueOf = new Map(live.map((r) => [r.id, r.value]));
  const plan = new Map();
  let late = 0, lateCount = 0, undated = 0, undatedCount = 0;
  for (const i of (await itemsFor(env, ids)).filter((x) => x.level === 1 && isInvoice(x) && !isTokenInvoice(x))) {
    if (invoiceState(i).invoiced) continue;
    const val = (valueOf.get(i.order_id) || 0) * (Number(i.share) || 0);
    if (!val) continue;
    const when = i.inv_due;
    if (!when) { undated += val; undatedCount++; continue; }
    if (when < today) { late += val; lateCount++; continue; }
    const m = monthOf(when);
    const g = plan.get(m) || { month: m, value: 0, count: 0 };
    g.value += val; g.count++; plan.set(m, g);
  }
  const ahead = Array.from({ length: 6 }, (_, i) => plan.get(shiftMonth(now, i)) || { month: shiftMonth(now, i), value: 0, count: 0 });
  const later = [...plan.values()].filter((g) => g.month > shiftMonth(now, 5)).reduce((t, g) => ({ value: t.value + g.value, count: t.count + g.count }), { value: 0, count: 0 });

  return {
    region, regions: REGIONS, month: now, months: series,
    statuses, customers: top, ageing, completion, typical,
    forecast: { late: { value: late, count: lateCount }, months: ahead, later, undated: { value: undated, count: undatedCount } },
  };
}

// ---------- settings and changes ----------

export async function settings(env, viewer) {
  mustSee(viewer);
  const head = await header(env);
  let staff = [];
  try { staff = JSON.parse((await getState(env, 'wip_sa_staff')) || '[]'); } catch { /* none */ }
  const { results: people } = await env.DB.prepare('SELECT account_id, name FROM employees WHERE active = 1 ORDER BY name').all();
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM wip_orders WHERE gone = 0) AS orders, (SELECT COUNT(*) FROM wip_contracts WHERE gone = 0) AS contracts,
            (SELECT COUNT(*) FROM wip_seed) AS seeds, (SELECT COUNT(*) FROM wip_snapshots) AS snapshots`
  ).first();
  const { results: failing } = await env.DB.prepare("SELECT * FROM wip_moves WHERE status = 'pending' AND tries > 0 ORDER BY queued_at DESC LIMIT 20").all();
  const fields = await getState(env, 'wip_field_ids');
  let ids = null;
  try { ids = JSON.parse(fields || 'null'); } catch { /* not yet */ }
  const rebuild = await (await import('./wip-history.js')).status(env);
  return { ...head, saStaff: staff, people, counts, failing, rebuild, fields: ids ? { customerItem: ids.customerItem, documentation: ids.documentation } : null,
    canEdit: canChange(viewer) };
}

function mustEdit(viewer) {
  if (!canChange(viewer)) throw refuse('Changing the WIP is for management, and anyone else Admin allows.');
}

export async function saveSettings(env, viewer, body) {
  mustEdit(viewer);
  const changes = [];
  if (body.moves !== undefined) {
    const on = Boolean(body.moves);
    const was = (await getState(env, 'wip_moves_on')) === '1';
    if (on !== was) {
      if (on && !(await getState(env, 'wip_full_done'))) throw refuse('The WIP needs to finish its first read of Jira before it can move orders.', 400);
      await setState(env, 'wip_moves_on', on ? '1' : '0');
      if (on) {
        // Starts from where every order is now, so nothing is moved just for being switched on.
        await env.DB.prepare("UPDATE wip_moves SET status = 'skipped', done_at = ? WHERE status = 'pending' AND target != 'Overdue'").bind(new Date().toISOString()).run();
        await setState(env, 'wip_moves_since', new Date().toISOString());
      }
      changes.push({ label: 'Moves orders in Jira', before: was ? 'On' : 'Off', after: on ? 'On' : 'Off' });
    }
  }
  if (Array.isArray(body.saStaff)) {
    const staff = [...new Set(body.saStaff.map(String).filter((x) => /^[\w:-]{3,80}$/.test(x)))].slice(0, 200);
    await setState(env, 'wip_sa_staff', JSON.stringify(staff));
    changes.push({ label: 'Promtek SA staff', before: '', after: `${staff.length} people` });
  }
  return { ok: true, changes };
}

export async function saveOverride(env, viewer, body) {
  mustEdit(viewer);
  const key = String(body.key || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/.test(key)) throw refuse('That isn\'t a Jira key.', 400);
  const division = body.division ? String(body.division) : null;
  if (division && ![...DIVISIONS, 'Service', 'Condor'].includes(division)) throw refuse('Pick Service or Projects.', 400);
  const upfront = body.upfront === '' || body.upfront === null || body.upfront === undefined ? null : Number(body.upfront);
  if (upfront !== null && (!Number.isFinite(upfront) || upfront < 0 || upfront > 1e10)) throw refuse('That value isn\'t a number.', 400);
  const excluded = body.excluded ? 1 : 0;
  const before = await env.DB.prepare('SELECT * FROM wip_overrides WHERE issue_key = ?').bind(key).first();
  if (!division && upfront === null && !excluded) {
    await env.DB.prepare('DELETE FROM wip_overrides WHERE issue_key = ?').bind(key).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO wip_overrides (issue_key, division, upfront, excluded, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_key) DO UPDATE SET division = excluded.division, upfront = excluded.upfront, excluded = excluded.excluded, note = excluded.note,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).bind(key, division, upfront, excluded, body.note ? String(body.note).slice(0, 300) : null, viewer.email || null, new Date().toISOString()).run();
  }
  return { ok: true, key, before, after: { division, upfront, excluded } };
}

// When a search finds nothing, what changed in Jira since the last read is read now.
export async function lookup(env, viewer) {
  mustSee(viewer);
  const last = Number((await getState(env, 'wip_lookup_at')) || 0);
  if (Date.now() - last < 30_000) return { ok: true, skipped: true };
  await setState(env, 'wip_lookup_at', String(Date.now()));
  const r = await quick(env);
  return { ok: true, changed: r?.changed ?? 0 };
}

export async function refresh(env, viewer) {
  mustEdit(viewer);
  await setState(env, 'wip_full_at', '0');
  return { ok: true };
}

// ---------- the old sheet, read in once ----------

const clean = (v, n = 300) => (v === null || v === undefined ? null : String(v).trim().slice(0, n) || null);
const cleanNum = (v) => { const n = num(v); return n === null || !Number.isFinite(n) || Math.abs(n) > 1e11 ? null : n; };
const cleanDate = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
const cleanKey = (v) => { const k = String(v || '').trim().toUpperCase(); return /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/.test(k) ? k : null; };
const cleanDivision = (v) => (/service/i.test(v || '') ? 'ServiceTeam' : /project/i.test(v || '') ? 'ProjectsTeam' : null);
const cleanPct = (v) => { const n = cleanNum(v); return n === null ? null : Math.max(-5, Math.min(5, n)); };

// Which workbook a row came from, by the latest month it has a tab for, so an older
// year's workbook read in later never replaces what a newer one gave.
const bookOf = (source) => String(source || '').split(':')[1] || '';

export async function importSheet(env, viewer, body) {
  mustEdit(viewer);
  const region = body.region in REGIONS ? body.region : null;
  if (!region) throw refuse('Say whether this is the UK or South Africa WIP.', 400);
  const now = thisMonth();
  const at = new Date().toISOString();
  const months = (Array.isArray(body.months) ? body.months : []).filter((m) => isMonth(m?.month) && m.month <= now).sort((a, b) => a.month.localeCompare(b.month));
  if (!months.length) throw refuse('No month tabs were found.', 400);
  const book = months[months.length - 1].month;
  const stmts = [];
  const result = { region, book, months: [], seeded: 0, contracts: 0, history: 0, skipped: [] };
  const seeds = new Map();
  for (const m of months) {
    const rows = (Array.isArray(m.rows) ? m.rows : []).slice(0, 2000).map((r) => ({ ...r, key: cleanKey(r.key) })).filter((r) => r.key);
    for (const r of rows) seeds.set(r.key, { ...r, month: m.month });
    if (m.month === now) continue;
    const kept = await env.DB.prepare('SELECT source FROM wip_snapshots WHERE month = ? AND region = ? LIMIT 1').bind(m.month, region).first();
    if (kept && (kept.source === 'hub' || bookOf(kept.source) > book)) { result.skipped.push(m.month); continue; }
    stmts.push(env.DB.prepare('DELETE FROM wip_snapshots WHERE month = ? AND region = ?').bind(m.month, region));
    for (const r of rows) {
      const token = /token/i.test(String(r.upfrontText || '')) ? 1 : 0;
      stmts.push(env.DB.prepare(
        `INSERT INTO wip_snapshots (month, issue_key, region, org, title, status, division, upfront, token, quote_no, accepted, done_at, progress, non_admin, invoiced, paid, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(month, issue_key) DO UPDATE SET region = excluded.region, org = excluded.org, title = excluded.title, status = excluded.status,
           division = excluded.division, upfront = excluded.upfront, token = excluded.token, quote_no = excluded.quote_no, accepted = excluded.accepted,
           done_at = excluded.done_at, progress = excluded.progress, non_admin = excluded.non_admin, invoiced = excluded.invoiced, paid = excluded.paid, source = excluded.source`
      ).bind(m.month, r.key, region, clean(r.org), clean(r.title), clean(r.status, 60), cleanDivision(r.division), token ? null : cleanNum(r.upfront), token,
        clean(r.quoteNo, 60), cleanDate(r.accepted), cleanDate(r.doneAt), cleanPct(r.progress) ?? 0, cleanPct(r.nonAdmin), cleanPct(r.invoiced), cleanPct(r.paid), `import:${book}`));
    }
    result.months.push({ month: m.month, orders: rows.length });
  }
  // Each order's value, division and dates come from the latest month it appears in, across every workbook read in.
  for (const r of seeds.values()) {
    stmts.push(env.DB.prepare(
      `INSERT INTO wip_seed (issue_key, kind, region, division, upfront, upfront_text, quote_no, accepted, title, org, updated_at, seed_month) VALUES (?, 'order', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_key) DO UPDATE SET kind = excluded.kind, region = excluded.region, division = excluded.division, upfront = excluded.upfront,
         upfront_text = excluded.upfront_text, quote_no = excluded.quote_no, accepted = excluded.accepted, title = excluded.title, org = excluded.org,
         updated_at = excluded.updated_at, seed_month = excluded.seed_month
       WHERE excluded.seed_month >= COALESCE(wip_seed.seed_month, '')`
    ).bind(r.key, region, cleanDivision(r.division), /token/i.test(String(r.upfrontText || '')) ? null : cleanNum(r.upfront), clean(r.upfrontText, 40),
      clean(r.quoteNo, 60), cleanDate(r.accepted), clean(r.title), clean(r.org), at, r.month));
    result.seeded++;
  }
  for (const c of (Array.isArray(body.recurring) ? body.recurring : []).slice(0, 500)) {
    const key = cleanKey(c.key);
    if (!key) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO wip_seed (issue_key, kind, region, division, upfront, start_date, end_date, title, org, updated_at, seed_month) VALUES (?, 'contract', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_key) DO UPDATE SET kind = excluded.kind, region = excluded.region, division = excluded.division, upfront = excluded.upfront,
         start_date = excluded.start_date, end_date = excluded.end_date, title = excluded.title, org = excluded.org, updated_at = excluded.updated_at, seed_month = excluded.seed_month
       WHERE excluded.seed_month >= COALESCE(wip_seed.seed_month, '')`
    ).bind(key, region, /project|condor/i.test(c.division || '') ? 'Condor' : 'Service', cleanNum(c.total), cleanDate(c.start), cleanDate(c.end), clean(c.title), clean(c.org), at, book));
    result.contracts++;
  }
  const allowed = ['newProjects', 'newService', 'completeProjects', 'completeService', 'projectsProgress', 'serviceProgress', 'projectsWork', 'serviceWork',
    'projectsValue', 'serviceValue', 'projectsWorkValue', 'serviceWorkValue', 'unrealisedProjects', 'unrealisedService', 'startInvoiced', 'startPaid',
    'endInvoiced', 'endPaid', 'startAwaiting', 'endAwaiting'];
  const listed = new Map();
  for (const h of (Array.isArray(body.history) ? body.history : []).slice(0, 240)) {
    if (!isMonth(h?.month) || h.month >= now) continue;
    const data = {};
    for (const k of allowed) { const v = cleanNum(h.data?.[k]); if (v !== null) data[k] = v; }
    if (Object.keys(data).length) listed.set(h.month, { ...(listed.get(h.month) || {}), ...data });
  }
  await runAll(env, stmts);
  // Each month's figures: what the workbook's own list (Overall Data or WIP Statistics) gives,
  // with anything it leaves out worked out from that month's tab.
  const tabMonths = new Set(result.months.map((m) => m.month));
  const all = [...new Set([...listed.keys(), ...tabMonths])].sort();
  for (const month of all) {
    const has = await env.DB.prepare('SELECT data, source FROM wip_history WHERE month = ? AND region = ?').bind(month, region).first();
    if (has?.source === 'hub') continue;
    let before = {};
    try { before = has ? JSON.parse(has.data) : {}; } catch { /* replaced */ }
    // A newer workbook's figures win; this one only fills what it left out.
    const newer = has && bookOf(has.source) > book;
    let fromTab = {};
    if (tabMonths.has(month)) {
      const rows = await snapshotRows(env, region, month);
      const prev = await historyRow(env, region, shiftMonth(month, -1));
      fromTab = historyFrom(metrics(rows, month), prev);
    }
    const mine = { ...fromTab };
    for (const [k, v] of Object.entries(listed.get(month) || {})) if (v !== null && v !== undefined) mine[k] = v;
    if (!Object.keys(mine).length) continue;
    const data = newer ? { ...mine, ...Object.fromEntries(Object.entries(before).filter(([, v]) => v !== null && v !== undefined)) } : { ...before, ...mine };
    await env.DB.prepare(
      `INSERT INTO wip_history (month, region, data, source) VALUES (?, ?, ?, ?)
       ON CONFLICT(month, region) DO UPDATE SET data = excluded.data, source = excluded.source`
    ).bind(month, region, JSON.stringify(data), newer ? has.source : `${listed.has(month) ? 'import' : 'sheet'}:${book}`).run();
    result.history++;
  }
  // Then each month's orders are rebuilt from Jira's own history, in the background.
  if (result.months.length) { await (await import('./wip-history.js')).queue(env); result.rebuilding = true; }
  return result;
}

// Shared with the rebuild of past months from Jira's own history (wip-history.js).
export { overridesAndSeeds, rowFor, contractsIn, isActiveContract, refuse, OutOfCalls, budget, search, CATEGORY_TYPES, ADMIN_TYPES, isInvoice, snapshotRows, historyRow, chunk, marks, lower, floorPct, round4, runAll, IN, mustSee, mustEdit, regionArg };

// ---------- Invoicing ----------
// Every invoice milestone on the live orders, by where it has got to, and when the
// money is expected: each customer's payment terms applied to the invoice date (or
// the planned date, before it's invoiced), added up by month.

export const TERM_TYPES = {
  'Days After': 'Days after',
  'Following Month': 'Days after the end of that month',
  'Days After End of Month': 'Days after the end of the month',
  'EOFM +7': 'End of the month, plus 7 days',
};
// From the old invoice board. Keyed by the customer's Jira project key, which starts each order key.
const DEFAULT_TERMS = {
  ABAGRI: [50, 'Days After'], ADM: [60, 'Days After'], AFTON: [60, 'Days After'], ALLEN: [40, 'Days After'], ANPARIO: [31, 'Following Month'],
  AONE: [75, 'Days After'], DOC: [70, 'Days After'], AUR: [99, 'Days After'], BAILEYS: [60, 'Days After'], BATA: [30, 'Days After'],
  CBCARLISLE: [70, 'Days After'], CBSTONE: [30, 'Days After'], CHARLESRWY: [70, 'Days After'], CRED: [60, 'Days After'], MCLCUBIS: [60, 'Days After'],
  DAWNFOODS: [70, 'Days After'], DENIS: [60, 'Days After'], AMN: [30, 'Days After'], PENMILL: [30, 'Days After'], ELSHAM: [30, 'Days After'],
  FB: [30, 'Following Month'], FIN: [60, 'Days After End of Month'], FIRSTWATER: [60, 'Days After'], FOLDHILL: [30, 'Following Month'],
  FORMPAVE: [60, 'Days After End of Month'], BURL: [60, 'Days After'], BURTONSED: [70, 'Days After'], FWF: [90, 'Days After'], FRANKE: [30, 'Days After'],
  FUCHS: [30, 'Days After'], FDL: [30, 'Days After'], GALL: [30, 'Days After'], GOLDLINE: [30, 'Following Month'], GOODWIN: [60, 'Days After End of Month'],
  HUMPHREY: [30, 'Following Month'], INFINEUM: [60, 'Days After'], INFORM: [30, 'Following Month'], AKZO: [65, 'Days After End of Month'],
  JCL: [30, 'Following Month'], CAM: [30, 'Following Month'], SOFINA: [7, 'EOFM +7'], TILE: [45, 'Days After'], LAXEY: [30, 'Following Month'],
  MAELOR: [30, 'Following Month'], MALIBAN: [30, 'Days After'], MASS: [30, 'Following Month'], MATWALK: [30, 'Days After'], MERVUE: [30, 'Days After'],
  MVS: [30, 'Following Month'], MVH: [30, 'Following Month'], NEWLAY: [30, 'Days After'], PALRAM: [30, 'Following Month'], PAT: [30, 'Following Month'],
  PROV: [30, 'Following Month'], RWSCOTT: [30, 'Following Month'], MCBRID: [60, 'Days After'], ROGER: [30, 'Days After'], RS: [60, 'Days After End of Month'],
  GOBAINMEX: [45, 'Days After'], SAINTGOBN: [30, 'Following Month'], SAR: [30, 'Days After'], SCOTMIN: [30, 'Following Month'], STWEED: [30, 'Days After'],
  SIMS: [30, 'Following Month'], SIMSB: [30, 'Following Month'], SIMST: [30, 'Following Month'], SOUTHERN: [30, 'Days After'], DUFFIELD: [30, 'Following Month'],
  WYNNL: [30, 'Days After'],
};
const TERMS_KEY = 'invoice_terms';

export async function paymentTerms(env) {
  let saved = null;
  try { saved = JSON.parse((await getState(env, TERMS_KEY)) || 'null'); } catch { saved = null; }
  if (saved && typeof saved === 'object') return saved;
  return Object.fromEntries(Object.entries(DEFAULT_TERMS).map(([k, [days, type]]) => [k, { days, type }]));
}

// ---------- updating invoices from the Invoicing tile ----------
// What finance do to an Invoice item, straight to Jira: give a New one its Target End,
// create its draft (Ready to be Invoiced, which starts the draft invoice automation),
// mark it sent (Invoiced, with its Invoice Due Date from the customer's terms), and
// change an Invoice Due Date.

const canUpdateInvoices = (viewer) => Boolean(viewer?.isAdmin || viewer?.can?.invoiceUpdate);
const canSetDates = (viewer) => canUpdateInvoices(viewer) || Boolean(viewer?.can?.invoiceDates);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));

async function moveItem(env, key, match, fields = null) {
  const { transitions = [] } = (await jira(env, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)) || {};
  const t = transitions.find((x) => match(lower(x.to?.name || x.name)));
  if (!t) throw refuse(`Jira has no way to move ${key} there from where it is now.`, 409);
  const send = (body) => jira(env, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: JSON.stringify(body) });
  let fieldsSet = false;
  if (fields) {
    // Set with the move where Jira allows it; otherwise moved, then set.
    try { await send({ transition: { id: t.id }, fields }); fieldsSet = true; } catch (err) { if (err.status !== 400) throw err; }
  }
  if (!fieldsSet) await send({ transition: { id: t.id } });
  return { name: t.to?.name || t.name, cat: t.to?.statusCategory?.key || 'indeterminate', fieldsSet };
}
const setFields = (env, key, fields) => jira(env, `/rest/api/3/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ fields }) });

export async function invoiceAction(env, viewer, { key, action, date } = {}) {
  if (!(action === 'targetEnd' ? canSetDates(viewer) : canUpdateInvoices(viewer))) throw refuse('Updating invoices isn\'t open to you.');
  const item = await env.DB.prepare("SELECT * FROM wip_items WHERE issue_key = ? AND level = 1").bind(String(key || '').toUpperCase()).first();
  if (!item || !isInvoice(item)) throw refuse('That isn\'t an invoice the hub knows.', 404);
  const order = await env.DB.prepare('SELECT issue_key, project_key FROM wip_orders WHERE issue_id = ?').bind(item.order_id).first()
    || await env.DB.prepare('SELECT issue_key, project_key FROM wip_contracts WHERE issue_id = ?').bind(item.order_id).first();
  const s = invoiceState(item);
  const today = londonDate();
  let label, after = {};

  if (action === 'targetEnd') {
    if (s.invoiced || s.paid) throw refuse('It\'s already invoiced, so Target End no longer matters.', 400);
    if (!isDay(date)) throw refuse('Choose the date the milestone should be finished.', 400);
    await setFields(env, item.issue_key, { [F.due]: date });
    after = { inv_due: date };
    label = `Target End set to ${date}`;
  } else if (action === 'draft') {
    if (s.invoiced || s.paid || s.ready) throw refuse('It\'s past New, so it already has its draft.', 400);
    const m = await moveItem(env, item.issue_key, (to) => /ready/.test(to));
    after = { status: m.name, status_cat: m.cat };
    label = `Moved to ${m.name} to create the draft invoice`;
  } else if (action === 'sent') {
    if (!s.ready) throw refuse('Create the draft first: only a Ready to be Invoiced item can be marked sent.', 400);
    const terms = (await paymentTerms(env))[String(order?.project_key || item.issue_key.split('-')[0]).toUpperCase()];
    const due = isDay(date) ? date : terms ? paymentDue(today, terms) : null;
    if (!due) throw refuse('This customer has no payment terms: enter the Invoice Due Date.', 400);
    const m = await moveItem(env, item.issue_key, (to) => to === 'invoiced', { [F.invoiceDate]: due });
    if (!m.fieldsSet) await setFields(env, item.issue_key, { [F.invoiceDate]: due });
    after = { status: m.name, status_cat: m.cat, inv_date: due };
    label = `Marked sent, Invoice Due Date ${due}`;
  } else if (action === 'dueDate') {
    if (!s.invoiced || s.paid) throw refuse('Only an invoiced, unpaid invoice has an Invoice Due Date to change.', 400);
    if (!isDay(date)) throw refuse('Choose the new Invoice Due Date.', 400);
    await setFields(env, item.issue_key, { [F.invoiceDate]: date });
    after = { inv_date: date };
    label = `Invoice Due Date changed to ${date}`;
    // A later date on an Overdue invoice puts it back to Invoiced, where Jira allows it.
    if (s.overdue && date >= today) {
      try {
        const m = await moveItem(env, item.issue_key, (to) => to === 'invoiced');
        after = { ...after, status: m.name, status_cat: m.cat };
        label += ', and back to Invoiced';
      } catch { /* left Overdue; the date is still changed */ }
    }
  } else if (action === 'paid') {
    if (!s.invoiced || s.paid) throw refuse('Only an invoiced, unpaid invoice can be marked paid.', 400);
    const on = isDay(date) ? date : today;
    if (on > today) throw refuse('The date it was paid can\'t be in the future.', 400);
    const m = await moveItem(env, item.issue_key, (to) => /\bpaid\b/.test(to) && !/\b(un|not )paid\b/.test(to));
    after = { status: m.name, status_cat: m.cat, paid_at: on };
    label = `Marked paid on ${on}`;
    // Nothing left to move to Overdue.
    await env.DB.prepare("UPDATE wip_moves SET status = 'skipped', done_at = ? WHERE issue_key = ? AND status = 'pending'").bind(new Date().toISOString(), item.issue_key).run();
  } else throw refuse('That isn\'t something the hub can do to an invoice.', 400);

  // What the hub holds follows straight away, without waiting for the next read.
  const cols = Object.keys(after);
  await env.DB.prepare(`UPDATE wip_items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE issue_id = ?`).bind(...cols.map((c) => after[c]), item.issue_id).run();
  await recompute(env, [item.order_id]);
  try { await (await import('./invoice-stats.js')).noteAction(env, item, action, after, today); } catch (err) { console.warn('Invoice history not noted:', err.message); }
  return { ok: true, key: item.issue_key, order: order?.issue_key || null, label, ...after };
}

// Invoices waiting to be moved to Overdue, and any Jira has refused.
async function overdueMoves(env) {
  const { results } = await env.DB.prepare(
    "SELECT issue_key, from_status, status, tries, last_error, queued_at, done_at FROM wip_moves WHERE target = 'Overdue' AND (status = 'pending' OR done_at >= ?) ORDER BY queued_at DESC LIMIT 50"
  ).bind(new Date(Date.now() - 7 * 86_400_000).toISOString()).all();
  return results;
}

export async function setOverdue(env, viewer, on) {
  mustEdit(viewer);
  await setState(env, 'invoice_overdue_on', on ? '1' : '0');
  // Turned off: anything waiting is let go.
  if (!on) await env.DB.prepare("UPDATE wip_moves SET status = 'skipped', done_at = ? WHERE status = 'pending' AND target = 'Overdue'").bind(new Date().toISOString()).run();
  return { ok: true, on: Boolean(on) };
}

export async function saveTerms(env, viewer, list) {
  mustEdit(viewer);
  const out = {};
  for (const t of Array.isArray(list) ? list : []) {
    const account = String(t.account || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(account)) continue;
    const days = Math.round(Number(t.days));
    if (!(days >= 0 && days <= 365) || !TERM_TYPES[t.type]) throw refuse(`Check the terms for ${account}: days from 0 to 365, and a type.`, 400);
    out[account] = { days, type: t.type };
  }
  await setState(env, TERMS_KEY, JSON.stringify(out));
  return { ok: true, terms: out };
}

const addDaysIso = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// When an invoice dated on this day is due to be paid, on these terms. With no terms, the day itself.
export function paymentDue(date, terms) {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const day = date.slice(0, 10);
  if (!terms) return day;
  if (terms.type === 'Days After') return addDaysIso(day, terms.days);
  if (terms.type === 'Following Month' || terms.type === 'Days After End of Month') return addDaysIso(endOfMonth(day.slice(0, 7)), terms.days);
  if (terms.type === 'EOFM +7') return addDaysIso(endOfMonth(day.slice(0, 7)), 7);
  return day;
}

export async function invoicing(env, viewer, { region } = {}) {
  if (!canTile(viewer, 'invoicing')) throw refuse('Invoicing isn\'t open to you.');
  region = regionArg(region);
  const today = londonDate();
  const month = thisMonth();
  const [head, rows, terms] = await Promise.all([header(env), liveRows(env, region, month), paymentTerms(env)]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const accountOf = (r) => String(r.project || r.key.split('-')[0]).toUpperCase();
  const invoices = [];
  for (const i of rows.length ? (await itemsFor(env, [...byId.keys()])).filter((x) => x.level === 1 && isInvoice(x)) : []) {
    const r = byId.get(i.order_id);
    const s = invoiceState(i);
    const token = isTokenInvoice(i);
    const account = accountOf(r);
    const t = terms[account] || null;
    // Target End is when the work for the milestone should be done and the invoice sent;
    // Invoice Due Date is when the customer should pay it, set once it's invoiced.
    const targetEnd = i.inv_due || null;
    const invoiceDue = i.inv_date || null;
    const stage = s.paid ? 'paid'
      : s.invoiced ? (s.overdue || (invoiceDue && invoiceDue < today) ? 'overdue' : 'invoiced')
      : s.ready ? 'ready'
      : targetEnd && targetEnd < today ? 'exceeded' : 'upcoming';
    // When the money should come: the Invoice Due Date once invoiced; before that, the
    // customer's terms from Target End, or from today if Target End has passed.
    const from = targetEnd && targetEnd > today ? targetEnd : today;
    const expected = s.paid ? null
      : s.invoiced ? invoiceDue || paymentDue(targetEnd || today, t)
      : paymentDue(from, t);
    invoices.push({
      order: r.key, org: r.org, account, key: i.issue_key, terms: String(i.summary || '').replace(/^(\s*[\d.]+%\s*)+/, '').trim() || i.summary,
      share: i.share, value: r.value === null || token ? null : r.value * (Number(i.share) || 0), token,
      status: i.status, state: s.label, stage, targetEnd, invoiceDue, paidAt: i.paid_at || null,
      expected, guessed: !s.paid && !(s.invoiced && invoiceDue), noDueDate: s.invoiced && !s.paid && !invoiceDue,
      hasTerms: Boolean(t), created: i.created,
    });
  }
  for (const i of invoices) i.kind = 'order';
  const contracts = await contractInvoices(env, region, today, terms);
  invoices.push(...contracts.invoices);
  invoices.sort((a, b) => a.order.localeCompare(b.order, 'en', { numeric: true }) || String(a.created || '').localeCompare(String(b.created || '')));

  // The money still to come, by the month it's due. Anything due before this month
  // and not yet paid is kept apart, rather than left out.
  const forecast = new Map();
  const earlier = { total: 0, count: 0, customers: new Map() };
  const addTo = (bucket, i) => {
    bucket.total += i.value; bucket.count++;
    const c = bucket.customers.get(i.account) || { account: i.account, org: i.org, total: 0, orders: new Map() };
    c.total += i.value; c.orders.set(i.order, (c.orders.get(i.order) || 0) + i.value);
    bucket.customers.set(i.account, c);
  };
  for (const i of invoices) {
    if (i.stage === 'paid' || !i.value || i.value <= 0 || !i.expected) continue;
    if (i.expected.slice(0, 7) < month) { addTo(earlier, i); continue; }
    const m = i.expected.slice(0, 7);
    if (!forecast.has(m)) forecast.set(m, { month: m, total: 0, count: 0, customers: new Map() });
    addTo(forecast.get(m), i);
  }
  const shapeBucket = (b) => ({ ...b, customers: [...b.customers.values()].sort((x, y) => x.account.localeCompare(y.account))
    .map((c) => ({ ...c, orders: [...c.orders].sort((x, y) => x[0].localeCompare(y[0], 'en', { numeric: true })).map(([key, amount]) => ({ key, amount })) })) });

  const orders = Object.fromEntries(rows.map((r) => [r.key, { key: r.key, title: r.title, org: r.org, account: accountOf(r), value: r.value,
    uninvoiced: r.value === null ? null : r.value * (1 - (r.invoiced || 0)), remaining: r.remaining, division: r.division, kind: 'order' }]));
  Object.assign(orders, contracts.orders);
  // Terms matter until an invoice has its own due date.
  const missing = [...new Set(invoices.filter((i) => !i.hasTerms && i.guessed).map((i) => i.account))].sort();
  return {
    ...head, region, regions: REGIONS, today, month, invoices, orders,
    forecast: [...forecast.values()].sort((a, b) => a.month.localeCompare(b.month)).map(shapeBucket), earlier: shapeBucket(earlier),
    terms, termTypes: TERM_TYPES, missingTerms: missing, canEdit: canChange(viewer), canUpdate: canUpdateInvoices(viewer), canSetDates: canSetDates(viewer), overdueOn: await overdueOn(env), overdueMoves: await overdueMoves(env),
  };
}

// ---------- service contract invoices ----------
// A contract's sub-invoices share its value equally, and are spread evenly over its
// year from the start date: 12 is one a month, 4 one a quarter, 1 all at the start.
// A Target End set on a sub-invoice in Jira is used instead of its place in the spread.

const addMonthsIso = (day, months) => {
  const [y, m, d] = day.split('-').map(Number);
  const whole = Math.floor(months);
  const first = new Date(Date.UTC(y, m - 1 + whole, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)));
  return out.toISOString().slice(0, 10);
};

export function contractSchedule(start, count) {
  if (!start || !/^\d{4}-\d{2}-\d{2}/.test(start) || !(count > 0)) return [];
  const every = 12 / count;
  return Array.from({ length: count }, (_, n) => addMonthsIso(start.slice(0, 10), Math.round(n * every)));
}

export const scheduleName = (count) => ({ 1: 'All upfront', 2: 'Twice a year', 3: 'Every 4 months', 4: 'Quarterly', 6: 'Every 2 months', 12: 'Monthly' }[count]
  || (count > 0 ? `${count} a year` : null));

async function contractInvoices(env, region, today, terms) {
  const list = await contractsIn(env, region);
  if (!list.length) return { invoices: [], orders: {} };
  const { over, seed } = await overridesAndSeeds(env, list.map((c) => c.issue_key));
  const items = await itemsFor(env, list.map((c) => c.issue_id));
  const byContract = new Map();
  for (const i of items) {
    if (i.level !== 1 || !isInvoice(i)) continue;
    if (!byContract.has(i.order_id)) byContract.set(i.order_id, []);
    byContract.get(i.order_id).push(i);
  }
  const invoices = [], orders = {};
  for (const c of list) {
    if (over.get(c.issue_key)?.excluded) continue;
    const subs = (byContract.get(c.issue_id) || [])
      .sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')) || a.issue_key.localeCompare(b.issue_key, 'en', { numeric: true }));
    if (!subs.length) continue;
    const active = isActiveContract(c);
    const s0 = seed.get(c.issue_key), o = over.get(c.issue_key);
    const total = o?.upfront ?? s0?.upfront ?? c.total ?? null;
    const start = c.tile_start || c.start_date || s0?.start_date || null;
    const plan = contractSchedule(start, subs.length);
    const account = String(c.project_key || c.issue_key.split('-')[0]).toUpperCase();
    const t = terms[account] || null;
    const each = total === null ? null : total / subs.length;
    let shown = 0;
    subs.forEach((i, n) => {
      const s = invoiceState(i);
      // An ended contract only keeps the invoices still waiting to be paid.
      if (!active && !(s.invoiced && !s.paid)) return;
      shown++;
      const targetEnd = i.inv_due || plan[n] || null;
      const invoiceDue = i.inv_date || null;
      const stage = s.paid ? 'paid'
        : s.invoiced ? (s.overdue || (invoiceDue && invoiceDue < today) ? 'overdue' : 'invoiced')
        : s.ready ? 'ready'
        : targetEnd && targetEnd < today ? 'exceeded' : 'upcoming';
      const from = targetEnd && targetEnd > today ? targetEnd : today;
      const expected = s.paid ? null : s.invoiced ? invoiceDue || paymentDue(targetEnd || today, t) : paymentDue(from, t);
      invoices.push({
        kind: 'contract', order: c.issue_key, org: c.tile_customer || c.org, account, key: i.issue_key,
        terms: String(i.summary || '').trim() || `Invoice ${n + 1} of ${subs.length}`, number: n + 1, of: subs.length,
        share: 1 / subs.length, value: each, token: false,
        status: i.status, state: s.label, stage, targetEnd, scheduled: !i.inv_due && Boolean(plan[n]), invoiceDue, paidAt: i.paid_at || null,
        expected, guessed: !s.paid && !(s.invoiced && invoiceDue), noDueDate: s.invoiced && !s.paid && !invoiceDue,
        hasTerms: Boolean(t), created: i.created,
      });
    });
    if (!shown) continue;
    orders[c.issue_key] = { key: c.issue_key, title: c.summary, org: c.tile_customer || c.org, account, value: total, kind: 'contract',
      uninvoiced: each === null ? null : each * subs.filter((i) => !invoiceState(i).invoiced).length,
      start, end: c.tile_end || c.end_date || s0?.end_date || null, steps: subs.length, schedule: scheduleName(subs.length), active };
  }
  return { invoices, orders };
}
