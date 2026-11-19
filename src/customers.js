// Customers: every live customer project in Jira, with what's open there (quotes, PSCs and
// jobs), whether it has an active service contract, when anything there last changed, and who to
// contact. Opening one shows the contact and site on each job and service contract. Management
// also see its statistics: money and time by month, open work, how long things take, who knows the
// customer best and what the Operations team last said to them.
import { jira, searchJql, CUSTOMER_CATEGORY_IDS, BLOCKED_PROJECTS, projectKeyOf } from './jira.js';
import { customerFilter } from './jobs.js';
import { getState, setState } from './sync.js';
import { canTile } from './permissions.js';
import { PSC_TYPES } from './psc.js';

const CONTACT_FIELD = 'customfield_14261';
const CONTACT_PHONE_FIELD = 'customfield_14260';
const CONTACT_EMAIL_FIELD = 'customfield_14239';
const ADDRESS_FIELD = 'customfield_11300';
const ITEM_FIELDS = ['summary', 'status', 'issuetype', 'project', 'created', 'updated', CONTACT_FIELD, CONTACT_PHONE_FIELD, CONTACT_EMAIL_FIELD, ADDRESS_FIELD];
const RUN_EVERY_MS = 30 * 60_000;
const STATS_FOR_MS = 6 * 3600_000;
const ACTIVE_CONTRACT = ['in contract', 'requires renewal'];

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const marks = (n) => Array(n).fill('?').join(',');
const lower = (v) => String(v || '').toLowerCase();
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export function mustSee(viewer) {
  if (!canTile(viewer, 'customers')) throw refuse('Customers isn\'t open to you.', 403);
}
export const canStats = (viewer) => Boolean(viewer?.isAdmin || (viewer?.can && 'customerStats' in viewer.can ? viewer.can.customerStats : viewer?.groups?.includes('management')));

// Atlassian documents come back as a tree; this pulls the plain text out.
export function plainText(node, sep = ', ') {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => plainText(n, sep)).filter(Boolean).join(sep);
  if (node.type === 'hardBreak') return sep;
  if (node.type === 'mention') return node.attrs?.text || '';
  if (node.text) return node.text;
  return plainText(node.content, node.type === 'doc' ? '\n' : sep === '\n' ? ' ' : sep);
}
function addressText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(addressText).filter(Boolean).join(', ');
  if (node.type === 'hardBreak') return ', ';
  if (node.text) return node.text;
  return addressText(node.content);
}
const cleanAddress = (value) => addressText(value).replace(/\s*,\s*/g, ', ').replace(/(, )+/g, ', ').trim().replace(/^,\s*|,\s*$/g, '');
const fieldText = (v) => (v && typeof v === 'object' ? v.value || v.displayName || v.name || plainText(v) : String(v || '')).trim();

// ---------- reading Jira ----------

// Every half hour: the live customer projects (with when anything in each last changed), and the
// contact and site on each order and service contract.
export async function run(env, { force = false } = {}) {
  if (!force && Date.now() - Number((await getState(env, 'customers_at')) || 0) < RUN_EVERY_MS) return { idle: true };
  await setState(env, 'customers_at', String(Date.now()));
  const now = new Date().toISOString();
  const projects = [];
  for (const [region, categoryId] of Object.entries(CUSTOMER_CATEGORY_IDS)) {
    let startAt = 0;
    for (let page = 0; page < 6; page++) {
      const data = await jira(env, `/rest/api/3/project/search?categoryId=${categoryId}&status=live&expand=insight&orderBy=name&maxResults=50&startAt=${startAt}`);
      for (const p of data.values || []) {
        if (BLOCKED_PROJECTS.includes(String(p.key).toUpperCase())) continue;
        projects.push({ key: p.key, id: String(p.id), name: p.name, region, last: p.insight?.lastIssueUpdateTime || null, count: p.insight?.totalIssueCount ?? null });
      }
      if (data.isLast || !data.values?.length) break;
      startAt += data.values.length;
    }
  }
  if (projects.length) {
    const stmts = projects.map((p) => env.DB.prepare(`INSERT INTO customers (project_key, project_id, name, region, last_update, issue_count, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, region = excluded.region, last_update = COALESCE(excluded.last_update, customers.last_update),
        issue_count = excluded.issue_count, synced_at = excluded.synced_at`).bind(p.key, p.id, p.name, p.region, p.last, p.count, now));
    for (const part of chunk(stmts, 50)) await env.DB.batch(part);
    await env.DB.prepare('DELETE FROM customers WHERE synced_at < ?').bind(now).run();
  }
  const issues = await searchJql(env, `${customerFilter} AND issuetype in (Epic, "Service Contract") AND (statusCategory != Done OR updated >= -365d) ORDER BY updated DESC`, ITEM_FIELDS, { limit: 1500 });
  const stmts = issues.map((i) => {
    const f = i.fields || {};
    const kind = lower(f.issuetype?.name) === 'service contract' ? 'contract' : 'order';
    return env.DB.prepare(`INSERT INTO customer_items (issue_id, issue_key, project_key, kind, summary, status, status_cat, contact, phone, email, address, created, updated, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, project_key = excluded.project_key, kind = excluded.kind, summary = excluded.summary, status = excluded.status,
        status_cat = excluded.status_cat, contact = excluded.contact, phone = excluded.phone, email = excluded.email, address = excluded.address, created = excluded.created,
        updated = excluded.updated, synced_at = excluded.synced_at`).bind(String(i.id), i.key, f.project?.key || i.key.split('-')[0], kind, f.summary || '', f.status?.name || null,
      f.status?.statusCategory?.key || null, fieldText(f[CONTACT_FIELD]) || null, fieldText(f[CONTACT_PHONE_FIELD]) || null, fieldText(f[CONTACT_EMAIL_FIELD]) || null,
      cleanAddress(f[ADDRESS_FIELD]) || null, f.created || null, f.updated || null, now);
  });
  for (const part of chunk(stmts, 50)) await env.DB.batch(part);
  if (issues.length) await env.DB.prepare('DELETE FROM customer_items WHERE synced_at < ?').bind(now).run();
  return { projects: projects.length, items: issues.length };
}

// ---------- the list ----------

const isActiveContract = (c) => ACTIVE_CONTRACT.includes(lower(c.status));
const contactOf = (items) => {
  const usable = items.filter((i) => i.phone || i.email);
  const pick = usable.find((i) => i.kind === 'contract' && i.status_cat !== 'done') || usable.find((i) => i.status_cat !== 'done') || usable[0];
  return pick ? { name: pick.contact || null, phone: pick.phone || null, email: pick.email || null, from: pick.issue_key } : null;
};
const maxIso = (...xs) => xs.filter(Boolean).map((x) => new Date(x).toISOString()).sort().at(-1) || null;

async function countsBy(env, sql, binds = []) {
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return new Map(results.map((r) => [r.project_key, r]));
}

export async function list(env, viewer) {
  mustSee(viewer);
  let { results: customers } = await env.DB.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE').all();
  if (!customers.length) {
    const { customerProjects } = await import('./jira.js');
    customers = (await customerProjects(env).catch(() => [])).map((p) => ({ project_key: p.key, name: p.name, region: p.region, last_update: null }));
  }
  const quotes = await countsBy(env, 'SELECT project_key, COUNT(*) AS n, MAX(updated_at) AS last FROM jira_quotes WHERE done = 0 GROUP BY project_key');
  const pscs = await countsBy(env, `SELECT project_key, SUM(CASE WHEN done = 0 THEN 1 ELSE 0 END) AS n, MAX(updated_at) AS last FROM psc_items WHERE issuetype IN (${marks(PSC_TYPES.length)}) GROUP BY project_key`, PSC_TYPES);
  const jobs = await countsBy(env, `SELECT project_key, SUM(CASE WHEN status_cat IS NOT 'done' THEN 1 ELSE 0 END) AS n, MAX(updated) AS last FROM wip_orders
    WHERE gone = 0 AND customer_item = 0 AND entity IS NOT NULL GROUP BY project_key`);
  const { results: contracts } = await env.DB.prepare('SELECT project_key, issue_key, status, tier, end_date FROM contracts').all();
  const { results: items } = await env.DB.prepare('SELECT * FROM customer_items ORDER BY updated DESC').all();
  const itemsBy = new Map();
  for (const i of items) itemsBy.set(i.project_key, [...(itemsBy.get(i.project_key) || []), i]);
  const rows = customers.map((c) => {
    const k = c.project_key;
    const active = contracts.filter((x) => x.project_key === k && isActiveContract(x));
    return {
      key: k, name: c.name, region: c.region,
      quotes: quotes.get(k)?.n || 0, pscs: pscs.get(k)?.n || 0, jobs: jobs.get(k)?.n || 0,
      contract: active.length ? { key: active[0].issue_key, status: active[0].status, tier: active[0].tier || null, end: active[0].end_date || null } : null,
      lastUpdate: maxIso(c.last_update, quotes.get(k)?.last, pscs.get(k)?.last, jobs.get(k)?.last, itemsBy.get(k)?.[0]?.updated),
      contact: contactOf(itemsBy.get(k) || []),
    };
  });
  return { customers: rows, syncedAt: Number((await getState(env, 'customers_at')) || 0) || null, canStats: canStats(viewer) };
}

// ---------- one customer ----------

async function customerRow(env, raw) {
  const key = projectKeyOf(String(raw || '').toUpperCase());
  const c = await env.DB.prepare('SELECT * FROM customers WHERE project_key = ?').bind(key).first();
  if (c) return c;
  const { customerProjects } = await import('./jira.js');
  const p = (await customerProjects(env).catch(() => [])).find((x) => x.key === key);
  if (!p) throw refuse('That customer isn\'t in the hub.', 404);
  return { project_key: p.key, name: p.name, region: p.region, last_update: null };
}

export async function detail(env, viewer, raw) {
  mustSee(viewer);
  const c = await customerRow(env, raw);
  const k = c.project_key;
  const { results: items } = await env.DB.prepare('SELECT * FROM customer_items WHERE project_key = ? ORDER BY kind, updated DESC').bind(k).all();
  const { results: quotes } = await env.DB.prepare('SELECT issue_key, summary, status, assignee_name, created_at, updated_at FROM jira_quotes WHERE project_key = ? AND done = 0 ORDER BY updated_at DESC').bind(k).all();
  const { results: pscs } = await env.DB.prepare(`SELECT issue_key, summary, issuetype, status, assignee_name, created_at, updated_at FROM psc_items WHERE project_key = ? AND done = 0
    AND issuetype IN (${marks(PSC_TYPES.length)}) ORDER BY updated_at DESC`).bind(k, ...PSC_TYPES).all();
  const { results: jobs } = await env.DB.prepare(`SELECT issue_key, summary, status, progress, updated, division_jira FROM wip_orders
    WHERE project_key = ? AND gone = 0 AND customer_item = 0 AND entity IS NOT NULL AND status_cat IS NOT 'done' ORDER BY updated DESC`).bind(k).all();
  const { results: contracts } = await env.DB.prepare('SELECT issue_key, summary, status, tier, start_date, renewal_date, end_date FROM contracts WHERE project_key = ? ORDER BY start_date DESC').bind(k).all();
  const byKey = new Map(items.map((i) => [i.issue_key, i]));
  const contactFor = (key) => { const i = byKey.get(key); return i && (i.contact || i.phone || i.email) ? { name: i.contact, phone: i.phone, email: i.email } : null; };
  const sites = [...new Set(items.filter((i) => i.address).map((i) => i.address))];
  return {
    key: k, name: c.name, region: c.region, lastUpdate: maxIso(c.last_update, quotes[0]?.updated_at, pscs[0]?.updated_at, jobs[0]?.updated, items[0]?.updated),
    contact: contactOf(items),
    sites,
    contracts: contracts.map((x) => ({ key: x.issue_key, summary: x.summary, status: x.status, tier: x.tier, start: x.start_date, renewal: x.renewal_date, end: x.end_date,
      active: isActiveContract(x), contact: contactFor(x.issue_key), site: byKey.get(x.issue_key)?.address || null })),
    jobs: jobs.map((j) => ({ key: j.issue_key, summary: j.summary, status: j.status, progress: j.progress, updated: j.updated, contact: contactFor(j.issue_key), site: byKey.get(j.issue_key)?.address || null })),
    // Orders the WIP doesn't follow (done in the last year, or not yet read) still give their contact.
    otherOrders: items.filter((i) => i.kind === 'order' && !jobs.some((j) => j.issue_key === i.issue_key) && (i.contact || i.phone || i.email))
      .slice(0, 10).map((i) => ({ key: i.issue_key, summary: i.summary, status: i.status, updated: i.updated, contact: contactFor(i.issue_key), site: i.address })),
    quotes: quotes.map((q) => ({ key: q.issue_key, summary: q.summary, status: q.status, assignee: q.assignee_name, updated: q.updated_at })),
    pscs: pscs.map((p) => ({ key: p.issue_key, summary: p.summary, type: p.issuetype, status: p.status, assignee: p.assignee_name, updated: p.updated_at })),
    canStats: canStats(viewer),
  };
}

// ---------- statistics, for management ----------

const monthOf = (iso) => (iso ? String(iso).slice(0, 7) : null);
const londonMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()).slice(0, 7);
function lastMonths(n, to = londonMonth()) {
  const out = [];
  let [y, m] = to.split('-').map(Number);
  for (let i = 0; i < n; i++) { out.unshift(`${y}-${String(m).padStart(2, '0')}`); m -= 1; if (!m) { m = 12; y -= 1; } }
  return out;
}
const days = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 86_400_000 : null);
const avg = (xs) => { const v = xs.filter((x) => x !== null && Number.isFinite(x)); return v.length ? v.reduce((t, x) => t + x, 0) / v.length : null; };
const median = (xs) => { const v = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };

async function idsIn(env, sql, binds) { return (await env.DB.prepare(sql).bind(...binds).all()).results; }

export async function stats(env, viewer, raw, { fresh = false } = {}) {
  mustSee(viewer);
  if (!canStats(viewer)) throw refuse('Customer statistics are for management.', 403);
  const c = await customerRow(env, raw);
  const k = c.project_key;
  const cacheKey = `customer_stats:${k}`;
  if (!fresh) {
    const kept = await getState(env, cacheKey);
    if (kept) { try { const s = JSON.parse(kept); if (Date.now() - s.at < STATS_FOR_MS) return s; } catch { /* worked out again */ } }
  }
  const months = lastMonths(24);
  const inRange = (m) => m && m >= months[0];
  const series = () => Object.fromEntries(months.map((m) => [m, 0]));

  // Money: orders placed, invoiced and paid, and service contracts, by month.
  const orders = await idsIn(env, `SELECT o.issue_id, o.issue_key, o.summary, o.status, o.status_cat, o.created, o.done_at, o.progress, o.invoiced, o.paid, o.division_jira, o.token_only,
      COALESCE(v.upfront, s.upfront, o.upfront) AS value, COALESCE(s.accepted, o.created) AS accepted
    FROM wip_orders o LEFT JOIN wip_overrides v ON v.issue_key = o.issue_key LEFT JOIN wip_seed s ON s.issue_key = o.issue_key
    WHERE o.project_key = ? AND o.gone = 0 AND o.customer_item = 0 AND COALESCE(v.excluded, 0) = 0`, [k]);
  const placed = series(), invoicedBy = series(), paidBy = series(), contractBy = series();
  for (const o of orders) if (inRange(monthOf(o.accepted)) && o.value) placed[monthOf(o.accepted)] += o.value;
  const valueOf = new Map(orders.map((o) => [o.issue_id, o.value || 0]));
  const invoiceItems = [];
  for (const part of chunk(orders.map((o) => o.issue_id), 80)) {
    if (!part.length) continue;
    invoiceItems.push(...await idsIn(env, `SELECT order_id, status, share, inv_date, inv_due FROM wip_items WHERE level = 1 AND issuetype LIKE '%nvoice%' AND order_id IN (${marks(part.length)})`, part));
  }
  let overdue = 0, awaiting = 0;
  for (const i of invoiceItems) {
    const v = (valueOf.get(i.order_id) || 0) * (Number(i.share) || 0);
    const st = lower(i.status);
    const sent = /invoiced|paid|overdue/.test(st) && !/not invoiced|ready/.test(st);
    if (sent && i.inv_date && inRange(monthOf(i.inv_date))) invoicedBy[monthOf(i.inv_date)] += v;
    if (/paid/.test(st) && i.inv_date && inRange(monthOf(i.inv_date))) paidBy[monthOf(i.inv_date)] += v;
    if (/overdue/.test(st)) overdue += v;
    if (sent && !/paid/.test(st)) awaiting += v;
  }
  const { results: contractRows } = await env.DB.prepare('SELECT w.issue_key, w.total, w.start_date, c.status, c.tier, c.f_available, c.f_used FROM wip_contracts w LEFT JOIN contracts c ON c.issue_key = w.issue_key WHERE w.project_key = ? AND w.gone = 0').bind(k).all();
  for (const x of contractRows) if (x.total && inRange(monthOf(x.start_date))) contractBy[monthOf(x.start_date)] += x.total;
  const valued = orders.filter((o) => o.value && !o.token_only);
  const money = {
    months, placed: months.map((m) => placed[m]), invoiced: months.map((m) => invoicedBy[m]), paid: months.map((m) => paidBy[m]), contracts: months.map((m) => contractBy[m]),
    lifetime: valued.reduce((t, o) => t + o.value, 0), orders: valued.length, average: valued.length ? valued.reduce((t, o) => t + o.value, 0) / valued.length : null,
    lastYear: valued.filter((o) => days(o.accepted, new Date().toISOString()) <= 365).reduce((t, o) => t + o.value, 0),
    openBook: valued.filter((o) => o.status_cat !== 'done').reduce((t, o) => t + o.value * (1 - (o.paid || 0)), 0), awaiting, overdue,
    contractValue: contractRows.filter((x) => ACTIVE_CONTRACT.includes(lower(x.status))).reduce((t, x) => t + (x.total || 0), 0),
  };

  // Time logged for them, by month and by person: on their orders and everything under them, PSCs and contracts.
  const ids = new Set(orders.map((o) => o.issue_id));
  for (const part of chunk([...ids], 80)) for (const r of await idsIn(env, `SELECT issue_id FROM wip_items WHERE order_id IN (${marks(part.length)})`, part)) ids.add(r.issue_id);
  for (const r of await idsIn(env, 'SELECT issue_id FROM psc_items WHERE project_key = ?', [k])) ids.add(r.issue_id);
  for (const r of await idsIn(env, 'SELECT issue_id FROM contracts WHERE project_key = ?', [k])) ids.add(r.issue_id);
  for (const r of await idsIn(env, 'SELECT ci.issue_id FROM contract_items ci JOIN contracts c ON c.issue_key = ci.contract_key WHERE c.project_key = ?', [k])) ids.add(r.issue_id);
  for (const r of await idsIn(env, 'SELECT issue_id FROM jira_quotes WHERE project_key = ?', [k])) ids.add(r.issue_id);
  const hoursBy = series();
  const personSeconds = new Map();
  for (const part of chunk([...ids], 80)) {
    const { results } = await env.DB.prepare(`SELECT account_id, substr(work_date, 1, 7) AS month, SUM(seconds) AS s FROM xp_ledger WHERE issue_id IN (${marks(part.length)}) GROUP BY account_id, month`).bind(...part).all();
    for (const r of results) {
      if (inRange(r.month)) hoursBy[r.month] += r.s / 3600;
      personSeconds.set(r.account_id, (personSeconds.get(r.account_id) || 0) + r.s);
    }
  }
  const { results: staff } = await env.DB.prepare('SELECT account_id, name, avatar, department FROM employees').all();
  const who = new Map(staff.map((e) => [e.account_id, e]));
  const nameOf = (id, fallback) => who.get(id)?.name || fallback || 'Someone not in the hub';

  // Jira: when they started, what's open, how long things took, and who has been assigned their work.
  const first = (await searchJql(env, `project = "${k}" ORDER BY created ASC`, ['created'], { limit: 1 }).catch(() => []))[0];
  const open = await searchJql(env, `project = "${k}" AND statusCategory != Done ORDER BY updated DESC`, ['issuetype', 'status', 'assignee', 'created', 'updated'], { limit: 500 }).catch(() => []);
  const done = await searchJql(env, `project = "${k}" AND statusCategory = Done AND resolved >= -730d`, ['issuetype', 'created', 'resolutiondate'], { limit: 1000 }).catch(() => []);
  const everyone = await searchJql(env, `project = "${k}" AND assignee is not EMPTY ORDER BY created DESC`, ['assignee', 'issuetype'], { limit: 1500 }).catch(() => []);

  const byType = new Map();
  for (const i of open) {
    const t = i.fields?.issuetype?.name || 'Other';
    const cat = i.fields?.status?.statusCategory?.key === 'new' ? 'todo' : 'doing';
    const row = byType.get(t) || { type: t, todo: 0, doing: 0, oldest: null, statuses: {} };
    row[cat] += 1;
    const st = i.fields?.status?.name || 'No status';
    row.statuses[st] = (row.statuses[st] || 0) + 1;
    if (!row.oldest || i.fields?.created < row.oldest) row.oldest = i.fields?.created;
    byType.set(t, row);
  }
  const openWork = [...byType.values()].sort((a, b) => (b.todo + b.doing) - (a.todo + a.doing));
  const orderProgress = orders.filter((o) => o.status_cat !== 'done').map((o) => ({ key: o.issue_key, summary: o.summary, status: o.status, progress: o.progress || 0, invoiced: o.invoiced || 0 }));

  const durations = new Map();
  for (const i of done) {
    const t = i.fields?.issuetype?.name || 'Other';
    const d = days(i.fields?.created, i.fields?.resolutiondate);
    if (d === null || d < 0) continue;
    durations.set(t, [...(durations.get(t) || []), d]);
  }
  const timings = [...durations].map(([type, list]) => ({ type, count: list.length, avgDays: avg(list), medianDays: median(list) })).sort((a, b) => b.count - a.count);

  const current = new Map();
  for (const i of open) {
    const a = i.fields?.assignee;
    if (!a?.accountId) continue;
    const row = current.get(a.accountId) || { id: a.accountId, name: nameOf(a.accountId, a.displayName), total: 0, types: {} };
    row.total += 1;
    const t = i.fields?.issuetype?.name || 'Other';
    row.types[t] = (row.types[t] || 0) + 1;
    current.set(a.accountId, row);
  }
  const allTime = new Map();
  for (const i of everyone) {
    const a = i.fields?.assignee;
    if (!a?.accountId) continue;
    const row = allTime.get(a.accountId) || { id: a.accountId, name: nameOf(a.accountId, a.displayName), tasks: 0, hours: 0 };
    row.tasks += 1;
    allTime.set(a.accountId, row);
  }
  for (const [id, s] of personSeconds) {
    const row = allTime.get(id) || { id, name: nameOf(id), tasks: 0, hours: 0 };
    row.hours = s / 3600;
    allTime.set(id, row);
  }
  const familiar = [...allTime.values()].sort((a, b) => b.tasks - a.tasks || b.hours - a.hours);

  // PSCs: how many each month, how quickly someone looked and how long they took.
  const { results: pscRows } = await env.DB.prepare(`SELECT issuetype, created_at, resolved_at, team_first_at, chargeable, done FROM psc_items WHERE project_key = ? AND issuetype IN (${marks(PSC_TYPES.length)})`).bind(k, ...PSC_TYPES).all();
  const pscBy = series();
  for (const p of pscRows) if (inRange(monthOf(p.created_at))) pscBy[monthOf(p.created_at)] += 1;
  const psc = {
    months, opened: months.map((m) => pscBy[m]), open: pscRows.filter((p) => !p.done).length,
    firstLookHours: avg(pscRows.map((p) => (p.team_first_at ? days(p.created_at, p.team_first_at) * 24 : null))),
    resolveDays: avg(pscRows.map((p) => (p.resolved_at ? days(p.created_at, p.resolved_at) : null))),
    chargeable: pscRows.filter((p) => /yes|chargeable/i.test(p.chargeable || '')).length, counted: pscRows.length,
  };
  const { results: quoteRows } = await env.DB.prepare('SELECT done, created_at FROM jira_quotes WHERE project_key = ?').bind(k).all();
  const quotes = { open: quoteRows.filter((q) => !q.done).length, lastYear: quoteRows.filter((q) => days(q.created_at, new Date().toISOString()) <= 365).length };

  // What the "Operations Team" Jira account (the mail handler, posting the customer's emails) last put on their items.
  const opsName = lower(env.OPS_ACCOUNT_NAME || 'Operations Team');
  const recent = await searchJql(env, `project = "${k}" AND updated >= -120d ORDER BY updated DESC`, ['summary', 'comment'], { limit: 40 }).catch(() => []);
  const comments = [];
  for (const i of recent) {
    for (const cm of i.fields?.comment?.comments || []) {
      if (lower(cm.author?.displayName).trim() !== opsName) continue;
      comments.push({ key: i.key, summary: i.fields?.summary || '', at: cm.created, text: plainText(cm.body, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) });
    }
  }
  comments.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const out = {
    at: Date.now(), key: k, name: c.name, firstCreated: first?.fields?.created || null, issueCount: c.issue_count ?? null,
    money, hours: { months, values: months.map((m) => Math.round(hoursBy[m] * 10) / 10), total: [...personSeconds.values()].reduce((t, s) => t + s, 0) / 3600 },
    openWork, orderProgress, timings, current: [...current.values()].sort((a, b) => b.total - a.total), familiar: familiar.slice(0, 15),
    psc, quotes, contracts: contractRows.map((x) => ({ key: x.issue_key, status: x.status, tier: x.tier, total: x.total, start: x.start_date, available: x.f_available, used: x.f_used })),
    comments: comments.slice(0, 15), sampled: { open: open.length, done: done.length, assigned: everyone.length },
  };
  await setState(env, cacheKey, JSON.stringify(out));
  return out;
}
