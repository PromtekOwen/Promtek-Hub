// Customers: every live customer project in Jira, with what's open there (quotes, PSCs and
// jobs), whether it has an active service contract, when anything there last changed, and who to
// contact. Opening one shows its sites and contacts (read from the jobs and contracts in Jira, and
// put right by hand), each job and contract, and the emails the mail handler has posted to them.
// Management also see its statistics: money and time by month, open work, how long things take and
// who knows the customer best.
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
// Kept statistics from an older version of this are worked out again.
const STATS_VERSION = 3;
// Customer projects that are templates for new customers, not customers.
const TEMPLATE_PROJECTS = ['UKST', 'SAST'];
// Newest start first, then the newest item.
const dayValue = (v) => { const t = Date.parse(String(v || '').slice(0, 10)); return Number.isNaN(t) ? -Infinity : t; };
const keyNumber = (k) => Number(String(k || '').split('-')[1]) || 0;
const newestStart = (list) => [...list].sort((a, b) => dayValue(b.start_date) - dayValue(a.start_date) || keyNumber(b.issue_key) - keyNumber(a.issue_key));
const isTemplate = (key) => TEMPLATE_PROJECTS.includes(String(key || '').toUpperCase());
// Issue types left out of Open work: nobody works them once they're made.
const IDLE_TYPES = /^documentation/i;
const ACTIVE_CONTRACT = ['in contract', 'requires renewal'];

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const marks = (n) => Array(n).fill('?').join(',');
const lower = (v) => String(v || '').toLowerCase();
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export function mustSee(viewer) {
  if (!canTile(viewer, 'customers')) throw refuse('Customers isn\'t open to you.', 403);
}
export const canManage = (viewer) => Boolean(viewer?.isAdmin || viewer?.can?.customerManage);
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
        if (BLOCKED_PROJECTS.includes(String(p.key).toUpperCase()) || isTemplate(p.key)) continue;
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
  await learnPeopleAndPlaces(env);
  return { projects: projects.length, items: issues.length };
}

// ---------- sites and contacts ----------
// Each address and each contact found on a customer's jobs and contracts is kept once. Anything put
// right by hand stays as it was put; anything removed by hand stays removed.

const siteKey = (address) => lower(address).replace(/[^a-z0-9]/g, '');
const digits = (v) => String(v || '').replace(/\D/g, '');
const contactKey = (c) => (c.email ? `e:${lower(c.email).trim()}` : c.name ? `n:${lower(c.name).replace(/\s+/g, ' ').trim()}` : c.phone ? `p:${digits(c.phone)}` : null);

export async function learnPeopleAndPlaces(env, onlyKey = null) {
  const now = new Date().toISOString();
  const { results: items } = await env.DB.prepare(`SELECT * FROM customer_items${onlyKey ? ' WHERE project_key = ?' : ''} ORDER BY updated ASC`).bind(...(onlyKey ? [onlyKey] : [])).all();
  const sites = new Map();
  const people = new Map();
  for (const i of items) {
    const open = i.status_cat !== 'done';
    if (i.address) {
      const k = `${i.project_key}|${siteKey(i.address)}`;
      sites.set(k, { project: i.project_key, key: siteKey(i.address), address: i.address, at: i.updated });
    }
    const key = contactKey(i);
    if (!key || !(i.phone || i.email || i.contact)) continue;
    const k = `${i.project_key}|${key}`;
    const was = people.get(k) || { project: i.project_key, key, items: [], contract: 0, open: 0 };
    // The latest item's details win, as items are read oldest first.
    Object.assign(was, { name: i.contact || was.name || null, phone: i.phone || was.phone || null, email: i.email || was.email || null, at: i.updated, siteKey: i.address ? siteKey(i.address) : was.siteKey });
    was.items.push(i.issue_key);
    if (open && i.kind === 'contract') was.contract = 1;
    if (open) was.open = 1;
    people.set(k, was);
  }
  const stmts = [];
  for (const x of sites.values()) {
    stmts.push(env.DB.prepare(`INSERT INTO customer_sites (project_key, match_key, address, source, seen_at, created_at, updated_at) VALUES (?, ?, ?, 'jira', ?, ?, ?)
      ON CONFLICT(project_key, match_key) DO UPDATE SET seen_at = excluded.seen_at`).bind(x.project, x.key, x.address, x.at, now, now));
  }
  for (const x of people.values()) {
    stmts.push(env.DB.prepare(`INSERT INTO customer_contacts (project_key, match_key, name, phone, email, source, seen_contract, seen_open, seen_at, items, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'jira', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key, match_key) DO UPDATE SET seen_contract = excluded.seen_contract, seen_open = excluded.seen_open, seen_at = excluded.seen_at, items = excluded.items,
        name = CASE WHEN customer_contacts.edited = 1 THEN customer_contacts.name ELSE excluded.name END,
        phone = CASE WHEN customer_contacts.edited = 1 THEN customer_contacts.phone ELSE excluded.phone END,
        email = CASE WHEN customer_contacts.edited = 1 THEN customer_contacts.email ELSE excluded.email END`)
      .bind(x.project, x.key, x.name, x.phone, x.email, x.contract, x.open, x.at, JSON.stringify([...new Set(x.items)].slice(-20)), now, now));
  }
  for (const part of chunk(stmts, 50)) await env.DB.batch(part);
  // A contact with no site yet takes the site of their latest job, while it's still there.
  for (const x of people.values()) {
    if (!x.siteKey) continue;
    await env.DB.prepare(`UPDATE customer_contacts SET site_id = (SELECT id FROM customer_sites WHERE project_key = ? AND match_key = ? AND hidden = 0)
      WHERE project_key = ? AND match_key = ? AND site_id IS NULL AND edited = 0`).bind(x.project, x.siteKey, x.project, x.key).run();
  }
  return { sites: sites.size, contacts: people.size };
}

// The primary contact: the one chosen, or else the one on their active service contract, or else on their latest open job.
function primaryOf(contacts) {
  const usable = contacts.filter((c) => !c.hidden && (c.phone || c.email));
  return usable.find((c) => c.is_primary)
    || [...usable].sort((a, b) => b.seen_contract - a.seen_contract || b.seen_open - a.seen_open || String(b.seen_at || '').localeCompare(String(a.seen_at || '')) || b.id - a.id)[0] || null;
}
const contactOut = (c, sites = []) => (c ? { id: c.id, name: c.name, phone: c.phone, email: c.email, jobTitle: c.job_title || null, siteId: c.site_id || null,
  site: sites.find((x) => x.id === c.site_id)?.address || null, primary: Boolean(c.is_primary), source: c.source, items: JSON.parse(c.items || '[]') } : null);

// ---------- the list ----------

const isActiveContract = (c) => ACTIVE_CONTRACT.includes(lower(c.status));
const maxIso = (...xs) => xs.filter(Boolean).map((x) => new Date(x).toISOString()).sort().at(-1) || null;

async function countsBy(env, sql, binds = []) {
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return new Map(results.map((r) => [r.project_key, r]));
}

export async function list(env, viewer) {
  mustSee(viewer);
  let { results: customers } = await env.DB.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE').all();
  customers = customers.filter((c) => !isTemplate(c.project_key));
  if (!customers.length) {
    const { customerProjects } = await import('./jira.js');
    customers = (await customerProjects(env).catch(() => [])).filter((p) => !isTemplate(p.key)).map((p) => ({ project_key: p.key, name: p.name, region: p.region, last_update: null }));
  }
  const quotes = await countsBy(env, 'SELECT project_key, COUNT(*) AS n, MAX(updated_at) AS last FROM jira_quotes WHERE done = 0 GROUP BY project_key');
  const pscs = await countsBy(env, `SELECT project_key, SUM(CASE WHEN done = 0 THEN 1 ELSE 0 END) AS n, MAX(updated_at) AS last FROM psc_items WHERE issuetype IN (${marks(PSC_TYPES.length)}) GROUP BY project_key`, PSC_TYPES);
  const jobs = await countsBy(env, `SELECT project_key, SUM(CASE WHEN status_cat IS NOT 'done' THEN 1 ELSE 0 END) AS n, MAX(updated) AS last FROM wip_orders
    WHERE gone = 0 AND customer_item = 0 AND entity IS NOT NULL GROUP BY project_key`);
  const { results: contracts } = await env.DB.prepare('SELECT project_key, issue_key, status, tier, end_date FROM contracts').all();
  const { results: lastItems } = await env.DB.prepare('SELECT project_key, MAX(updated) AS last FROM customer_items GROUP BY project_key').all();
  const lastItem = new Map(lastItems.map((r) => [r.project_key, r.last]));
  // Straight after this was added, the contacts are worked out from what's already been read.
  if (!(await env.DB.prepare('SELECT 1 FROM customer_contacts LIMIT 1').first()) && await env.DB.prepare('SELECT 1 FROM customer_items LIMIT 1').first()) await learnPeopleAndPlaces(env);
  const { results: people } = await env.DB.prepare('SELECT * FROM customer_contacts WHERE hidden = 0').all();
  const peopleBy = new Map();
  for (const c of people) peopleBy.set(c.project_key, [...(peopleBy.get(c.project_key) || []), c]);
  const rows = customers.map((c) => {
    const k = c.project_key;
    const active = contracts.filter((x) => x.project_key === k && isActiveContract(x));
    return {
      key: k, name: c.name, region: c.region,
      quotes: quotes.get(k)?.n || 0, pscs: pscs.get(k)?.n || 0, jobs: jobs.get(k)?.n || 0,
      contract: active.length ? { key: active[0].issue_key, status: active[0].status, tier: active[0].tier || null, end: active[0].end_date || null } : null,
      lastUpdate: maxIso(c.last_update, quotes.get(k)?.last, pscs.get(k)?.last, jobs.get(k)?.last, lastItem.get(k)),
      contact: contactOut(primaryOf(peopleBy.get(k) || [])),
    };
  });
  return { customers: rows, syncedAt: Number((await getState(env, 'customers_at')) || 0) || null, canStats: canStats(viewer) };
}

// ---------- one customer ----------

async function customerRow(env, raw) {
  const key = projectKeyOf(String(raw || '').toUpperCase());
  if (isTemplate(key)) throw refuse('That\'s a template project, not a customer.', 404);
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
  const { results: siteRows } = await env.DB.prepare('SELECT * FROM customer_sites WHERE project_key = ? ORDER BY hidden, id').bind(k).all();
  const { results: people } = await env.DB.prepare('SELECT * FROM customer_contacts WHERE project_key = ? ORDER BY name COLLATE NOCASE').bind(k).all();
  const sites = siteRows.filter((x) => !x.hidden).map((x) => ({ id: x.id, address: x.address, label: x.label || null, source: x.source, edited: Boolean(x.edited) }));
  const siteByKey = new Map(siteRows.map((x) => [x.match_key, x]));
  const personByKey = new Map(people.map((x) => [x.match_key, x]));
  const byKey = new Map(items.map((i) => [i.issue_key, i]));
  // Each job's contact and site as they've been put right here, if they have.
  const contactFor = (key) => {
    const i = byKey.get(key);
    if (!i || !(i.contact || i.phone || i.email)) return null;
    const p = personByKey.get(contactKey(i));
    if (p && !p.hidden) return { name: p.name, phone: p.phone, email: p.email, jobTitle: p.job_title || null };
    return { name: i.contact, phone: i.phone, email: i.email };
  };
  const siteFor = (key) => {
    const a = byKey.get(key)?.address;
    if (!a) return null;
    const x = siteByKey.get(siteKey(a));
    return x ? (x.hidden ? null : x.address) : a;
  };
  const visible = people.filter((x) => !x.hidden);
  const primary = primaryOf(visible);
  return {
    key: k, name: c.name, region: c.region, lastUpdate: maxIso(c.last_update, quotes[0]?.updated_at, pscs[0]?.updated_at, jobs[0]?.updated, items[0]?.updated),
    contact: contactOut(primary, sites), primaryChosen: Boolean(primary?.is_primary),
    sites,
    contacts: visible.map((x) => ({ ...contactOut(x, sites), isPrimary: primary?.id === x.id })),
    contracts: newestStart(contracts).map((x) => ({ key: x.issue_key, summary: x.summary, status: x.status, tier: x.tier, start: x.start_date, renewal: x.renewal_date, end: x.end_date,
      active: isActiveContract(x), contact: contactFor(x.issue_key), site: siteFor(x.issue_key) })),
    jobs: jobs.map((j) => ({ key: j.issue_key, summary: j.summary, status: j.status, progress: j.progress, updated: j.updated, contact: contactFor(j.issue_key), site: siteFor(j.issue_key) })),
    quotes: quotes.map((q) => ({ key: q.issue_key, summary: q.summary, status: q.status, assignee: q.assignee_name, updated: q.updated_at })),
    pscs: pscs.map((p) => ({ key: p.issue_key, summary: p.summary, type: p.issuetype, status: p.status, assignee: p.assignee_name, updated: p.updated_at })),
    canStats: canStats(viewer), canManage: canManage(viewer),
  };
}

// ---------- putting sites and contacts right ----------

const clip = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
async function mustManage(env, viewer, raw) {
  mustSee(viewer);
  if (!canManage(viewer)) throw refuse('Only admins can change a customer\'s sites and contacts.', 403);
  return customerRow(env, raw);
}
async function note(env, viewer, c, action, label) {
  const { record } = await import('./audit.js');
  await record(env, viewer, { area: 'Customers', action, subjectType: 'customer', subjectId: c.project_key, label: `${c.name}: ${label}`.slice(0, 120) }).catch(() => {});
}

export async function saveSite(env, viewer, { key, id, address, label }) {
  const c = await mustManage(env, viewer, key);
  const text = clip(address, 400);
  if (text.length < 5) throw refuse('Give the address.');
  const now = new Date().toISOString();
  const who = viewer.employee?.name || viewer.email;
  if (id) {
    const r = await env.DB.prepare('UPDATE customer_sites SET address = ?, label = ?, edited = 1, hidden = 0, updated_at = ?, updated_by = ? WHERE id = ? AND project_key = ?').bind(text, clip(label, 60) || null, now, who, Number(id), c.project_key).run();
    if (!r.meta.changes) throw refuse('That address has gone.', 404);
    await note(env, viewer, c, 'changed a site address', text);
    return { ok: true, id: Number(id) };
  }
  const r = await env.DB.prepare(`INSERT INTO customer_sites (project_key, match_key, address, label, source, edited, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 'hub', 1, ?, ?, ?)
    ON CONFLICT(project_key, match_key) DO UPDATE SET hidden = 0, address = excluded.address, label = excluded.label, edited = 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(c.project_key, siteKey(text), text, clip(label, 60) || null, now, now, who).run();
  await note(env, viewer, c, 'added a site address', text);
  return { ok: true, id: r.meta.last_row_id };
}

export async function removeSite(env, viewer, { key, id }) {
  const c = await mustManage(env, viewer, key);
  const site = await env.DB.prepare('SELECT * FROM customer_sites WHERE id = ? AND project_key = ?').bind(Number(id), c.project_key).first();
  if (!site) return { ok: true };
  // One from Jira is hidden, so the next read doesn't bring it back; one added here is deleted.
  if (site.source === 'jira') await env.DB.prepare('UPDATE customer_sites SET hidden = 1, updated_at = ?, updated_by = ? WHERE id = ?').bind(new Date().toISOString(), viewer.employee?.name || viewer.email, site.id).run();
  else await env.DB.prepare('DELETE FROM customer_sites WHERE id = ?').bind(site.id).run();
  await env.DB.prepare('UPDATE customer_contacts SET site_id = NULL WHERE site_id = ?').bind(site.id).run();
  await note(env, viewer, c, 'removed a site address', site.address);
  return { ok: true };
}

export async function saveContact(env, viewer, { key, id, name, phone, email, jobTitle, siteId }) {
  const c = await mustManage(env, viewer, key);
  const v = { name: clip(name, 120) || null, phone: clip(phone, 40) || null, email: clip(email, 160).toLowerCase() || null, job: clip(jobTitle, 100) || null };
  if (!v.name && !v.email && !v.phone) throw refuse('Give at least a name, phone or email.');
  if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) throw refuse('That email doesn\'t look right.');
  const site = siteId ? await env.DB.prepare('SELECT id FROM customer_sites WHERE id = ? AND project_key = ? AND hidden = 0').bind(Number(siteId), c.project_key).first() : null;
  const now = new Date().toISOString();
  const who = viewer.employee?.name || viewer.email;
  if (id) {
    const r = await env.DB.prepare('UPDATE customer_contacts SET name = ?, phone = ?, email = ?, job_title = ?, site_id = ?, edited = 1, updated_at = ?, updated_by = ? WHERE id = ? AND project_key = ? AND hidden = 0')
      .bind(v.name, v.phone, v.email, v.job, site?.id || null, now, who, Number(id), c.project_key).run();
    if (!r.meta.changes) throw refuse('That contact has gone.', 404);
    await note(env, viewer, c, 'changed a contact', v.name || v.email || v.phone);
    return { ok: true, id: Number(id) };
  }
  const match = contactKey({ contact: v.name, phone: v.phone, email: v.email });
  const was = await env.DB.prepare('SELECT id, hidden FROM customer_contacts WHERE project_key = ? AND match_key = ?').bind(c.project_key, match).first();
  if (was && !was.hidden) throw refuse('They\'re already in the contacts. Change them there.');
  if (was) {
    await env.DB.prepare('UPDATE customer_contacts SET name = ?, phone = ?, email = ?, job_title = ?, site_id = ?, hidden = 0, edited = 1, updated_at = ?, updated_by = ? WHERE id = ?')
      .bind(v.name, v.phone, v.email, v.job, site?.id || null, now, who, was.id).run();
    await note(env, viewer, c, 'added a contact', v.name || v.email || v.phone);
    return { ok: true, id: was.id };
  }
  const r = await env.DB.prepare(`INSERT INTO customer_contacts (project_key, match_key, name, phone, email, job_title, site_id, source, edited, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'hub', 1, ?, ?, ?)`).bind(c.project_key, match, v.name, v.phone, v.email, v.job, site?.id || null, now, now, who).run();
  await note(env, viewer, c, 'added a contact', v.name || v.email || v.phone);
  return { ok: true, id: r.meta.last_row_id };
}

export async function removeContact(env, viewer, { key, id }) {
  const c = await mustManage(env, viewer, key);
  const p = await env.DB.prepare('SELECT * FROM customer_contacts WHERE id = ? AND project_key = ?').bind(Number(id), c.project_key).first();
  if (!p) return { ok: true };
  if (p.source === 'jira') await env.DB.prepare('UPDATE customer_contacts SET hidden = 1, is_primary = 0, updated_at = ?, updated_by = ? WHERE id = ?').bind(new Date().toISOString(), viewer.employee?.name || viewer.email, p.id).run();
  else await env.DB.prepare('DELETE FROM customer_contacts WHERE id = ?').bind(p.id).run();
  await note(env, viewer, c, 'removed a contact', p.name || p.email || p.phone || '');
  return { ok: true };
}

// The primary contact chosen, or (with no id) back to the hub choosing.
export async function setPrimary(env, viewer, { key, id }) {
  const c = await mustManage(env, viewer, key);
  await env.DB.prepare('UPDATE customer_contacts SET is_primary = 0 WHERE project_key = ?').bind(c.project_key).run();
  if (id) {
    const r = await env.DB.prepare('UPDATE customer_contacts SET is_primary = 1 WHERE id = ? AND project_key = ? AND hidden = 0').bind(Number(id), c.project_key).run();
    if (!r.meta.changes) throw refuse('That contact has gone.', 404);
  }
  await note(env, viewer, c, id ? 'chose the primary contact' : 'let the hub choose the primary contact', String(id || ''));
  return { ok: true };
}

// ---------- the emails the mail handler posted ----------
// The "Operations Team" account puts each customer email on its Jira item as a comment. Shown as who
// sent it and what they said: without the headers, signature, disclaimer, earlier messages quoted
// below it, or the formatting marks emails bring with them.

// The comment as lines, keeping its paragraphs and line breaks.
function linesOf(node) {
  const out = [''];
  const walk = (n) => {
    if (!n) return;
    if (typeof n === 'string') { out[out.length - 1] += n; return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'hardBreak') { out.push(''); return; }
    if (n.type === 'mention') { out[out.length - 1] += n.attrs?.text || ''; return; }
    if (n.type === 'inlineCard' || n.type === 'blockCard') { out[out.length - 1] += n.attrs?.url || ''; return; }
    if (n.text) { out[out.length - 1] += n.text; return; }
    const block = ['paragraph', 'heading', 'listItem', 'tableRow', 'blockquote', 'codeBlock', 'panel', 'rule'].includes(n.type);
    if (block && out[out.length - 1] !== '') out.push('');
    walk(n.content);
    if (block) out.push('');
  };
  walk(typeof node === 'string' ? node.split(/\r?\n/).map((t) => ({ type: 'paragraph', content: [{ text: t }] })) : node);
  return out;
}

const SIGN_OFF = /^(kind(est)? regards|best regards|warm regards|many thanks|regards|best wishes|thanks( and| &) regards|thanks|thank you|cheers|yours sincerely|yours faithfully|sent from my|get outlook for)\b[\s,.!]*$/i;
const STOP = [
  /^--\s*$/, /^_{5,}/, /^-{5,}/, /^={5,}/, /^>/,
  /^on .{6,80}wrote:?$/i, /^(from|sent|to|cc|date|subject):\s/i,
  /^-+\s*original message\s*-+/i, /^begin forwarded message/i,
  /(confidential|disclaimer|intended (solely|only) for|if you (have )?received this (e-?mail|message) in error|this (e-?mail|message) (and any attachments )?(is|are|may be))/i,
  /^sent from my /i, /^get outlook for/i, /^registered (in|office)/i, /^company (registration|number)/i, /^vat (reg|no|number)/i,
];
// Formatting marks: Jira wiki markup, markdown, stray HTML, image and link placeholders.
function tidyLine(t) {
  return String(t)
    .replace(/\{(color|panel|quote|noformat|code)(:[^}]*)?\}/gi, '')
    .replace(/!\S+\.(png|jpe?g|gif|bmp)(\|[^!]*)?!/gi, '')
    .replace(/\[(image|cid):[^\]]*\]/gi, '').replace(/\[cid:[^\]]*\]/gi, '')
    .replace(/<mailto:[^>]+>/gi, '').replace(/<https?:[^>]+>/gi, '')
    .replace(/\[([^\]|]+)\|(mailto:|https?:)[^\]]+\]/gi, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&rsquo;/gi, '\'').replace(/&quot;/gi, '"')
    .replace(/(^|\s)[*_]{1,3}(?=\S)|(?<=\S)[*_]{1,3}(?=\s|$)/g, '$1')
    .replace(/^#{1,6}\s+/, '').replace(/^h[1-6]\.\s+/i, '').replace(/^\s*[|]+\s*|\s*[|]+\s*$/g, '').replace(/\s*\|\s*/g, ' · ')
    .replace(/[​-‍﻿­]/g, '')
    .replace(/\s+/g, ' ').trim();
}
const nameFromHeader = (v) => {
  const t = String(v).replace(/<[^>]*>/g, '').replace(/\[[^\]]*\]/g, '').replace(/["']/g, '').replace(/mailto:\S+/gi, '').trim();
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(String(v))?.[0] || null;
  const name = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '').replace(/[()<>]/g, '').trim();
  return { name: name || null, email };
};

export function emailOf(body) {
  const lines = linesOf(body).map((l) => l.replace(/ /g, ' '));
  let from = null;
  let start = 0;
  // The headers at the top, as the mail handler writes them.
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const t = tidyLine(lines[i]);
    if (!t) { if (from) { start = i + 1; } continue; }
    const m = /^(?:(?:from|sender)\s*:|(?:e-?mail|message) (?:received )?from\b)\s*(.+?):?$/i.exec(String(lines[i]).replace(/\s+/g, ' ').trim());
    if (m && !from) { from = nameFromHeader(m[1]); start = i + 1; continue; }
    if (/^(to|cc|bcc|sent|date|subject|reply-to|received)\s*:/i.test(t)) { start = i + 1; continue; }
    if (from) break;
  }
  const body2 = [];
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    const t = tidyLine(raw);
    if (STOP.some((re) => re.test(t))) break;
    if (SIGN_OFF.test(t)) break;
    body2.push(t);
  }
  const text = body2.join('\n').replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n').replace(/^(hi|hello|dear|good (morning|afternoon))\b[^\n]{0,40},?\n+/i, (g) => `${g.trim()} `);
  return { from: from?.name || from?.email || null, email: from?.email || null, text: text.slice(0, 1200) };
}

export async function comms(env, viewer, raw, { fresh = false } = {}) {
  mustSee(viewer);
  const c = await customerRow(env, raw);
  const k = c.project_key;
  const cacheKey = `customer_comms:${k}`;
  if (!fresh) {
    const kept = await getState(env, cacheKey);
    if (kept) { try { const s = JSON.parse(kept); if (Date.now() - s.at < 30 * 60_000) return s; } catch { /* read again */ } }
  }
  const opsName = lower(env.OPS_ACCOUNT_NAME || 'Operations Team');
  const recent = await searchJql(env, `project = "${k}" AND updated >= -120d ORDER BY updated DESC`, ['summary', 'comment'], { limit: 40 }).catch(() => []);
  const list = [];
  for (const i of recent) {
    for (const cm of i.fields?.comment?.comments || []) {
      if (lower(cm.author?.displayName).trim() !== opsName) continue;
      const e = emailOf(cm.body);
      if (!e.text) continue;
      list.push({ key: i.key, summary: i.fields?.summary || '', at: cm.created, from: e.from, email: e.email, text: e.text });
    }
  }
  list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const out = { at: Date.now(), key: k, comments: list.slice(0, 20) };
  await setState(env, cacheKey, JSON.stringify(out));
  return out;
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
    if (kept) { try { const s = JSON.parse(kept); if (s.v === STATS_VERSION && Date.now() - s.at < STATS_FOR_MS) return s; } catch { /* worked out again */ } }
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
  // Every service contract: those the Service contracts tile keeps (archived ones too), with their value from the WIP.
  const { results: tileContracts } = await env.DB.prepare(`SELECT c.issue_key, c.status, c.tier, c.start_date, c.f_available, c.f_used, c.f_overdraft, w.total
    FROM contracts c LEFT JOIN wip_contracts w ON w.issue_key = c.issue_key WHERE c.project_key = ?`).bind(k).all();
  const { results: wipOnly } = await env.DB.prepare(`SELECT w.issue_key, w.status, NULL AS tier, w.start_date, NULL AS f_available, NULL AS f_used, NULL AS f_overdraft, w.total
    FROM wip_contracts w WHERE w.project_key = ? AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.issue_key = w.issue_key)`).bind(k).all();
  const contractRows = [...tileContracts, ...wipOnly];
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
  const { results: staff } = await env.DB.prepare('SELECT account_id, name FROM employees WHERE active = 1').all();
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
    if (IDLE_TYPES.test(t)) continue;
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
    if (!a?.accountId || !who.has(a.accountId)) continue;
    const row = current.get(a.accountId) || { id: a.accountId, name: nameOf(a.accountId, a.displayName), total: 0, types: {} };
    row.total += 1;
    const t = i.fields?.issuetype?.name || 'Other';
    row.types[t] = (row.types[t] || 0) + 1;
    current.set(a.accountId, row);
  }
  const allTime = new Map();
  for (const i of everyone) {
    const a = i.fields?.assignee;
    if (!a?.accountId || !who.has(a.accountId)) continue;
    const row = allTime.get(a.accountId) || { id: a.accountId, name: nameOf(a.accountId, a.displayName), tasks: 0, hours: 0 };
    row.tasks += 1;
    allTime.set(a.accountId, row);
  }
  for (const [id, s] of personSeconds) {
    if (!who.has(id)) continue;
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

  const out = {
    v: STATS_VERSION, at: Date.now(), key: k, name: c.name, firstCreated: first?.fields?.created || null, issueCount: c.issue_count ?? null,
    money, hours: { months, values: months.map((m) => Math.round(hoursBy[m] * 10) / 10), total: [...personSeconds.values()].reduce((t, s) => t + s, 0) / 3600 },
    openWork, orderProgress, timings, current: [...current.values()].sort((a, b) => b.total - a.total), familiar: familiar.slice(0, 15),
    psc, quotes, contracts: newestStart(contractRows).map((x) => ({ key: x.issue_key, status: x.status, tier: x.tier, total: x.total, start: x.start_date, available: x.f_available, used: x.f_used, overdraft: x.f_overdraft })),
    sampled: { open: open.length, done: done.length, assigned: everyone.length },
  };
  await setState(env, cacheKey, JSON.stringify(out));
  return out;
}
