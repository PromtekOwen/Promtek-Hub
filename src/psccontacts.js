// Which customer people belong to which Organization. The service desk knows each
// Organization's members (that's how a customer's email gets its Organization filled in),
// and the hub keeps a copy, read a few Organizations each run. When a PSC ticket has an
// Organization and the customer who raised it isn't in it in Jira, the hub notes the link
// and tells admins, who can add them to it from the PSC settings, or put a wrong one right.
// People at Promtek are never linked: they raise tickets for any customer.
import { jira } from './jira.js';
import { getState, setState, raiseAlert } from './sync.js';
import { allowedDomains } from './auth.js';
import { record } from './audit.js';

const PSC = 'PSC';
const READ_EVERY_MS = 12 * 3600 * 1000;    // every Organization's members, twice a day
const ORGS_PER_RUN = 6;
const EMAILS_PER_RUN = 4;                  // service desk look-ups for a reporter's email
const HEADERS = { 'X-ExperimentalApi': 'opt-in' };
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const lower = (s) => String(s || '').trim().toLowerCase();
export const domainOf = (email) => lower(email).split('@')[1] || '';

function adminOnly(viewer) {
  if (!viewer?.isAdmin) throw refuse('Admin only.', 403);
}

export async function staffIds(env) {
  const { results } = await env.DB.prepare("SELECT account_id FROM employees WHERE account_id NOT LIKE 'pending%'").all().catch(() => ({ results: [] }));
  return new Set(results.map((r) => String(r.account_id)));
}

export function ourDomain(env, domain) {
  const ours = [...allowedDomains(env), 'promtek.com', 'promtek.co.za'];
  return Boolean(domain) && ours.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// ---------- reading the members ----------

async function readOrg(env, b, org) {
  const members = [];
  let start = 0;
  for (let page = 0; page < 10; page++) {
    const data = await b.call(`/rest/servicedeskapi/organization/${encodeURIComponent(org.id)}/user?start=${start}&limit=50`, { headers: HEADERS });
    members.push(...(data?.values || []));
    if (data?.isLastPage !== false || !data?.values?.length) break;
    start += data.values.length;
  }
  const at = new Date().toISOString();
  const stmts = [env.DB.prepare('DELETE FROM psc_org_members WHERE org_id = ?').bind(String(org.id))];
  for (const m of members) {
    if (!m.accountId) continue;
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO psc_org_members (org_id, account_id, email, name, read_at) VALUES (?, ?, ?, ?, ?)')
      .bind(String(org.id), String(m.accountId), m.emailAddress || null, m.displayName || null, at));
  }
  await env.DB.batch(stmts);
  return members.length;
}

// Carries on reading Organizations' members, a few each run; starts again twice a day.
export async function readMembers(env, b, orgs) {
  let job = JSON.parse((await getState(env, 'psc_members')) || 'null');
  if (!job || (job.done && Date.now() - Date.parse(job.finished) >= READ_EVERY_MS)) {
    job = { started: new Date().toISOString(), queue: orgs.map((o) => String(o.id)), read: job?.read || [], done: false };
  }
  if (job.done) return { idle: true };
  const byId = new Map(orgs.map((o) => [String(o.id), o]));
  let n = 0;
  while (job.queue.length && n < ORGS_PER_RUN && b.left() > 3) {
    const id = job.queue[0];
    if (byId.has(id)) await readOrg(env, b, byId.get(id));
    job.queue.shift();
    if (!job.read.includes(id)) job.read.push(id);
    n++;
  }
  if (!job.queue.length) { job.done = true; job.finished = new Date().toISOString(); }
  await setState(env, 'psc_members', JSON.stringify(job));
  return { read: n, left: job.queue.length };
}

// ---------- spotting customers who aren't in their Organization ----------

async function emailFor(env, b, accountId, key, budget) {
  const known = await env.DB.prepare('SELECT email FROM psc_org_members WHERE account_id = ? AND email IS NOT NULL LIMIT 1').bind(accountId).first();
  if (known?.email) return known.email;
  if (budget.left <= 0 || b.left() < 2) return null;
  budget.left--;
  const req = await b.call(`/rest/servicedeskapi/request/${encodeURIComponent(key)}`).catch(() => null);
  return req?.reporter?.emailAddress || null;
}

// PSC tickets raised since this was first run, by customers, with an Organization.
export async function check(env, b, items, orgs) {
  let since = await getState(env, 'psc_contacts_since');
  if (!since) { since = new Date().toISOString(); await setState(env, 'psc_contacts_since', since); }
  const job = JSON.parse((await getState(env, 'psc_members')) || 'null');
  const read = new Set(job?.read || []);
  const staff = await staffIds(env);
  const byName = new Map(orgs.map((o) => [lower(o.name), o]));
  const { results: known } = await env.DB.prepare('SELECT account_id, org_id FROM psc_contact_links').all();
  const linked = new Set(known.map((r) => `${r.account_id}|${r.org_id}`));
  const budget = { left: EMAILS_PER_RUN };
  let found = 0;
  for (const r of items) {
    if (r.project_key !== PSC || !r.org || !r.reporter_id || r.reporter_team || staff.has(String(r.reporter_id))) continue;
    if (String(r.created_at || '') < since) continue;
    const ticketOrgs = String(r.org).split(' | ').map((n) => byName.get(lower(n))).filter(Boolean);
    // Only once those Organizations' members have been read.
    if (!ticketOrgs.length || ticketOrgs.some((o) => !read.has(String(o.id)))) continue;
    const inOne = await env.DB.prepare(`SELECT 1 FROM psc_org_members WHERE account_id = ? AND org_id IN (${ticketOrgs.map(() => '?').join(', ')}) LIMIT 1`)
      .bind(String(r.reporter_id), ...ticketOrgs.map((o) => String(o.id))).first();
    if (inOne) continue;
    for (const org of ticketOrgs) {
      if (linked.has(`${r.reporter_id}|${org.id}`)) continue;
      if (b.left() < 2) return { found };
      const email = await emailFor(env, b, String(r.reporter_id), r.issue_key, budget);
      const domain = domainOf(email);
      if (domain && ourDomain(env, domain)) { linked.add(`${r.reporter_id}|${org.id}`); continue; }
      const { results: doms } = await env.DB.prepare(`SELECT email FROM psc_org_members WHERE org_id = ? AND email IS NOT NULL
        UNION SELECT email FROM psc_contact_links WHERE org_id = ? AND email IS NOT NULL AND status IN ('new', 'added')`).bind(String(org.id), String(org.id)).all();
      const newDomain = domain && !doms.some((d) => domainOf(d.email) === domain) ? 1 : 0;
      await env.DB.prepare(`INSERT OR IGNORE INTO psc_contact_links (account_id, email, name, org_id, org_name, issue_key, new_domain, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)`).bind(String(r.reporter_id), email, r.reporter_name || null, String(org.id), org.name, r.issue_key, newDomain, new Date().toISOString()).run();
      linked.add(`${r.reporter_id}|${org.id}`);
      found++;
      const who = `${r.reporter_name || 'A customer'}${email ? ` (${email})` : ''}`;
      await raiseAlert(env, { kind: 'psc-contact', dedupe: `psc-contact:${r.reporter_id}:${org.id}`,
        subject: `${r.reporter_name || 'A customer'} isn't in ${org.name} in Jira`,
        body: `${who} raised ${r.issue_key} (${r.summary}), which is under ${org.name}, but isn't a member of that Organization in Jira, so their next ticket won't get it filled in.${newDomain ? `\n\nNo one else from ${domain} is in ${org.name} yet.` : ''}\n\nOpen the PSC settings in the hub to add them to it, or to put it right if the ticket is under the wrong Organization.` }).catch(() => {});
    }
  }
  return { found };
}

export async function run(env, b, items, orgs) {
  const out = {};
  out.members = await readMembers(env, b, orgs);
  out.contacts = await check(env, b, items, orgs);
  return out;
}

// ---------- what a viewer of a ticket sees ----------

export async function orgsOf(env, accountId) {
  if (!accountId) return [];
  const { results } = await env.DB.prepare('SELECT org_id FROM psc_org_members WHERE account_id = ?').bind(String(accountId)).all().catch(() => ({ results: [] }));
  return results.map((r) => String(r.org_id));
}

export async function domainOrgs(env, domain) {
  if (!domain) return [];
  const { results } = await env.DB.prepare("SELECT org_id, COUNT(*) AS n FROM psc_org_members WHERE email LIKE ? GROUP BY org_id ORDER BY n DESC").bind(`%@${domain}`).all().catch(() => ({ results: [] }));
  return results.map((r) => ({ id: String(r.org_id), n: r.n }));
}

// ---------- for admins ----------

export async function list(env, viewer, { q = '' } = {}, orgs = []) {
  adminOnly(viewer);
  const names = new Map(orgs.map((o) => [String(o.id), o.name]));
  const { results: pending } = await env.DB.prepare("SELECT * FROM psc_contact_links WHERE status = 'new' ORDER BY created_at DESC LIMIT 100").all();
  const { results: recent } = await env.DB.prepare("SELECT * FROM psc_contact_links WHERE status != 'new' ORDER BY COALESCE(done_at, created_at) DESC LIMIT 20").all();
  let found = [];
  const term = lower(q);
  if (term.length >= 2) {
    const { results } = await env.DB.prepare(`SELECT account_id, email, name, org_id FROM psc_org_members
      WHERE lower(email) LIKE ? OR lower(name) LIKE ? ORDER BY name LIMIT 60`).bind(`%${term}%`, `%${term}%`).all();
    const people = new Map();
    for (const r of results) {
      const p = people.get(r.account_id) || { accountId: r.account_id, email: r.email, name: r.name, orgs: [] };
      p.orgs.push({ id: String(r.org_id), name: names.get(String(r.org_id)) || r.org_id });
      people.set(r.account_id, p);
    }
    found = [...people.values()];
  }
  const job = JSON.parse((await getState(env, 'psc_members')) || 'null');
  return { pending, recent, found, members: job ? { done: job.done, read: job.read?.length || 0, left: job.queue?.length || 0, at: job.finished || job.started } : null };
}

async function orgById(orgs, id) {
  const org = orgs.find((o) => String(o.id) === String(id));
  if (!org) throw refuse('Choose an Organization from the list.');
  return org;
}

async function addInJira(env, org, accountId) {
  await jira(env, `/rest/servicedeskapi/organization/${encodeURIComponent(org.id)}/user`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ accountIds: [accountId] }) });
}
async function removeInJira(env, org, accountId) {
  await jira(env, `/rest/servicedeskapi/organization/${encodeURIComponent(org.id)}/user`, { method: 'DELETE', headers: HEADERS, body: JSON.stringify({ accountIds: [accountId] }) });
}

async function person(env, accountId) {
  return (await env.DB.prepare('SELECT email, name FROM psc_org_members WHERE account_id = ? LIMIT 1').bind(accountId).first())
    || (await env.DB.prepare('SELECT email, name FROM psc_contact_links WHERE account_id = ? LIMIT 1').bind(accountId).first()) || {};
}

async function note(env, accountId, org, status, viewer, extra = {}) {
  const p = await person(env, accountId);
  await env.DB.prepare(`INSERT INTO psc_contact_links (account_id, email, name, org_id, org_name, issue_key, new_domain, status, created_at, done_by, done_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?) ON CONFLICT(account_id, org_id) DO UPDATE SET status = excluded.status, done_by = excluded.done_by, done_at = excluded.done_at`)
    .bind(accountId, p.email || null, p.name || null, String(org.id), org.name, extra.issueKey || null, status, new Date().toISOString(), viewer.employee?.name || viewer.email, new Date().toISOString()).run();
  return p;
}

export async function add(env, viewer, { accountId, orgId }, orgs) {
  adminOnly(viewer);
  const id = String(accountId || '');
  if (!id) throw refuse('Choose who to add.');
  const org = await orgById(orgs, orgId);
  await addInJira(env, org, id);
  const p = await note(env, id, org, 'added', viewer);
  await env.DB.prepare('INSERT OR REPLACE INTO psc_org_members (org_id, account_id, email, name, read_at) VALUES (?, ?, ?, ?, ?)')
    .bind(String(org.id), id, p.email || null, p.name || null, new Date().toISOString()).run();
  await record(env, viewer, { area: 'PSC', action: 'added a customer to an Organization', subjectType: 'customer', subjectId: id, label: p.name || p.email || id,
    changes: [{ label: 'Organization', before: '', after: org.name }] }).catch(() => {});
  return { ok: true };
}

export async function remove(env, viewer, { accountId, orgId }, orgs) {
  adminOnly(viewer);
  const id = String(accountId || '');
  const org = await orgById(orgs, orgId);
  const member = await env.DB.prepare('SELECT 1 FROM psc_org_members WHERE org_id = ? AND account_id = ?').bind(String(org.id), id).first();
  if (member) await removeInJira(env, org, id);
  await env.DB.prepare('DELETE FROM psc_org_members WHERE org_id = ? AND account_id = ?').bind(String(org.id), id).run();
  const p = await note(env, id, org, member ? 'removed' : 'wrong', viewer);
  await record(env, viewer, { area: 'PSC', action: member ? 'took a customer out of an Organization' : 'marked a customer link wrong', subjectType: 'customer', subjectId: id,
    label: p.name || p.email || id, changes: [{ label: 'Organization', before: org.name, after: '' }] }).catch(() => {});
  return { ok: true };
}

export async function move(env, viewer, { accountId, fromOrgId, toOrgId }, orgs) {
  adminOnly(viewer);
  if (String(fromOrgId) === String(toOrgId)) throw refuse('That\'s the Organization they\'re in already.');
  const to = await orgById(orgs, toOrgId);
  await remove(env, viewer, { accountId, orgId: fromOrgId }, orgs);
  await add(env, viewer, { accountId, orgId: to.id }, orgs);
  return { ok: true };
}
