// A Jira item shown in the hub rather than in Jira: its description, comments,
// attachments, who raised it and what it's linked to. Only for the PSC project and
// customer projects, to anyone who can see the PSC tile. Comments can be added from
// here: internal ones are kept to the Promtek Members group (and never reach the
// customer); customer-visible ones on a customer copy reach the customer through the
// app that keeps the copy and the PSC ticket in step.
import { jira, searchJql, customerProjects, BLOCKED_PROJECTS } from './jira.js';
import { mustSee, organizations, rowFor } from './psc.js';
import { record } from './audit.js';
import * as Contacts from './psccontacts.js';

const ORG_FIELD = 'customfield_12900';
const PSC = 'PSC';
const KEY = /^([A-Z][A-Z0-9_]*)-(\d+)$/;
export const internalGroup = (env) => env.PSC_INTERNAL_GROUP || 'Promtek Members';
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------- which items ----------

export async function viewableProjects(env) {
  let projects = [];
  try { projects = await customerProjects(env); } catch { /* PSC alone */ }
  return [PSC, ...projects.map((p) => p.key)].filter((k, i, a) => a.indexOf(k) === i && !BLOCKED_PROJECTS.includes(k));
}

async function checkKey(env, viewer, key) {
  mustSee(viewer);
  const k = String(key || '').trim().toUpperCase();
  const m = KEY.exec(k);
  if (!m) throw refuse('That isn\'t a Jira key.');
  if (!(await viewableProjects(env)).includes(m[1])) throw refuse('Only PSC and customer project items open in the hub.', 403);
  return { key: k, project: m[1] };
}

// ---------- Jira's document format, as safe HTML ----------

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^(https?:|mailto:)/i.test(String(u || '')) ? String(u) : null);

function marks(text, list = []) {
  let out = escHtml(text);
  for (const m of list) {
    if (m.type === 'strong') out = `<strong>${out}</strong>`;
    else if (m.type === 'em') out = `<em>${out}</em>`;
    else if (m.type === 'code') out = `<code>${out}</code>`;
    else if (m.type === 'strike') out = `<s>${out}</s>`;
    else if (m.type === 'underline') out = `<u>${out}</u>`;
    else if (m.type === 'link') { const href = safeUrl(m.attrs?.href); if (href) out = `<a href="${escHtml(href)}" target="_blank" rel="noopener">${out}</a>`; }
  }
  return out;
}

export function adfHtml(node, ctx = {}) {
  if (!node) return '';
  if (typeof node === 'string') return escHtml(node).replace(/\n/g, '<br>');
  const kids = () => (node.content || []).map((c) => adfHtml(c, ctx)).join('');
  switch (node.type) {
    case 'doc': return kids();
    case 'paragraph': return `<p>${kids() || '&nbsp;'}</p>`;
    case 'text': return marks(node.text, node.marks);
    case 'hardBreak': return '<br>';
    case 'heading': { const l = Math.min(6, Math.max(3, Number(node.attrs?.level || 3) + 2)); return `<h${l}>${kids()}</h${l}>`; }
    case 'bulletList': return `<ul>${kids()}</ul>`;
    case 'orderedList': return `<ol>${kids()}</ol>`;
    case 'listItem': return `<li>${kids()}</li>`;
    case 'blockquote': return `<blockquote>${kids()}</blockquote>`;
    case 'codeBlock': return `<pre><code>${(node.content || []).map((c) => escHtml(c.text || '')).join('')}</code></pre>`;
    case 'rule': return '<hr>';
    case 'panel': return `<div class="jv-panel">${kids()}</div>`;
    case 'mention': return `<span class="jv-mention">${escHtml(node.attrs?.text || '@someone')}</span>`;
    case 'emoji': return escHtml(node.attrs?.text || node.attrs?.shortName || '');
    case 'date': return escHtml(node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toLocaleDateString('en-GB') : '');
    case 'status': return `<span class="jv-status">${escHtml(node.attrs?.text || '')}</span>`;
    case 'inlineCard': case 'blockCard': { const href = safeUrl(node.attrs?.url); return href ? `<a href="${escHtml(href)}" target="_blank" rel="noopener">${escHtml(href)}</a>` : ''; }
    case 'mediaSingle': case 'mediaGroup': return `<div class="jv-media">${kids()}</div>`;
    case 'media': {
      // Pictures and files in the text are attachments; they're listed with the rest.
      const name = node.attrs?.alt || ctx.mediaName?.(node.attrs?.id) || 'an attachment';
      return `<span class="jv-media-ref">📎 ${escHtml(name)}</span>`;
    }
    case 'table': return `<div class="table-wrap"><table>${kids()}</table></div>`;
    case 'tableRow': return `<tr>${kids()}</tr>`;
    case 'tableHeader': return `<th>${kids()}</th>`;
    case 'tableCell': return `<td>${kids()}</td>`;
    case 'expand': case 'nestedExpand': return `<details><summary>${escHtml(node.attrs?.title || 'More')}</summary>${kids()}</details>`;
    default: return kids();
  }
}

// Plain words typed in the hub, as Jira's document format, under the name of whoever wrote them.
export function adfFrom(text, author) {
  const paras = String(text).replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  const para = (p) => {
    const lines = p.split('\n');
    const content = [];
    lines.forEach((l, i) => { if (i) content.push({ type: 'hardBreak' }); if (l) content.push({ type: 'text', text: l }); });
    return { type: 'paragraph', content };
  };
  const body = paras.map(para);
  if (author) body.unshift({ type: 'paragraph', content: [{ type: 'text', text: `${author}:`, marks: [{ type: 'strong' }] }] });
  return { type: 'doc', version: 1, content: body };
}

// ---------- reading one ----------

const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'reporter', 'creator', 'assignee', 'created', 'updated', 'description',
  'comment', 'attachment', 'issuelinks', 'project', 'parent', ORG_FIELD];

const person = (u) => (u ? { name: u.displayName || 'Someone', email: u.emailAddress || null, id: u.accountId || null, team: u.accountType === 'atlassian', customer: u.accountType === 'customer' } : null);

export async function view(env, viewer, rawKey) {
  const { key, project } = await checkKey(env, viewer, rawKey);
  const issue = await jira(env, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`);
  if (!issue) throw refuse('That item has gone from Jira.', 404);
  const f = issue.fields || {};
  const attachments = (f.attachment || []).map((a) => ({ id: String(a.id), name: a.filename, size: a.size, mime: a.mimeType, at: a.created, by: a.author?.displayName || '' }));
  const ctx = { mediaName: () => null };
  const reporter = person(f.reporter);
  // A customer's email address isn't always on the item itself; the service desk has it.
  if (project === PSC && reporter && !reporter.email) {
    const req = await jira(env, `/rest/servicedeskapi/request/${encodeURIComponent(key)}`).catch(() => null);
    if (req?.reporter?.emailAddress) reporter.email = req.reporter.emailAddress;
  }
  const comments = (f.comment?.comments || []).map((c) => ({
    id: String(c.id), by: c.author?.displayName || 'Someone', team: c.author?.accountType === 'atlassian', app: c.author?.accountType === 'app', at: c.created,
    html: adfHtml(c.body, ctx),
    // In the service desk: internal or seen by the customer. Elsewhere: kept to a group or open to all.
    internal: c.jsdPublic === false || Boolean(c.visibility),
    restricted: c.visibility ? c.visibility.value || c.visibility.identifier || 'a restricted group' : null,
  }));
  const links = (f.issuelinks || []).map((l) => {
    const other = l.outwardIssue || l.inwardIssue;
    return other ? { how: l.outwardIssue ? l.type?.outward : l.type?.inward, key: other.key, summary: other.fields?.summary || '', status: other.fields?.status?.name || '' } : null;
  }).filter(Boolean);
  const orgList = (Array.isArray(f[ORG_FIELD]) ? f[ORG_FIELD] : f[ORG_FIELD] ? [f[ORG_FIELD]] : []).filter((o) => o && typeof o === 'object');
  const orgs = orgList.map((o) => o.name ?? o.value).filter(Boolean).map(String);
  const projects = await customerProjects(env).catch(() => []);
  const keys = new Set(projects.map((p) => p.key));
  // The copy in the customer's project, or the PSC ticket this copy came from.
  const copy = project === PSC ? links.find((l) => keys.has(l.key.split('-')[0])) || null : null;
  const original = project !== PSC ? links.find((l) => l.key.startsWith(`${PSC}-`)) || null : null;
  const out = {
    key, project, url: `${env.JIRA_BASE_URL}/browse/${key}`,
    summary: f.summary || '', status: f.status?.name || '', statusCat: f.status?.statusCategory?.key || null, type: f.issuetype?.name || '',
    priority: f.priority?.name || null, created: f.created, updated: f.updated, reporter, assignee: person(f.assignee),
    projectName: f.project?.name || project, orgs, descriptionHtml: adfHtml(f.description, ctx), comments, attachments, links, copy, original,
    // Customers only hear from a customer project copy, which the sync carries to their ticket.
    canComment: { internal: true, customer: project !== PSC },
    internalGroup: internalGroup(env),
  };
  // A customer project item's customer is the project.
  if (project !== PSC) out.customer = f.project?.name || project;
  out.raisedByStaff = await isStaff(env, reporter).catch(() => false);
  // Which Organizations the customer who raised it is in, in Jira, and whether that
  // includes this ticket's.
  if (reporter?.id && !out.raisedByStaff) {
    const all = await organizations(env).catch(() => []);
    const ids = await Contacts.orgsOf(env, reporter.id);
    out.reporterOrgs = ids.map((id) => all.find((o) => String(o.id) === id)?.name).filter(Boolean);
    if (project === PSC && orgs.length) {
      out.reporterInOrg = orgList.some((o) => ids.includes(String(o.id)));
      const link = await env.DB.prepare(`SELECT status, org_name FROM psc_contact_links WHERE account_id = ? AND status = 'new' LIMIT 1`).bind(reporter.id).first().catch(() => null);
      out.contactPending = Boolean(link);
    }
  }
  if (project === PSC && !orgs.length) out.suggestions = await suggestOrgs(env, issue, reporter).catch(() => []);
  return out;
}

// ---------- which customer, when no Organization is set ----------

const STOP = new Set(['ltd', 'limited', 'plc', 'llp', 'inc', 'group', 'the', 'and', 'uk', 'co', 'com', 'org', 'net', 'gov', 'ac', 'www', 'mail', 'email', 'site', 'services']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
const FREE_MAIL = /(^|\.)(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|aol|btinternet|sky|virginmedia|protonmail)\./i;

export async function isStaff(env, reporter) {
  if (!reporter) return false;
  if (Contacts.ourDomain(env, Contacts.domainOf(reporter.email))) return true;
  if (!reporter.id) return false;
  return Boolean(await env.DB.prepare('SELECT 1 FROM employees WHERE account_id = ?').bind(String(reporter.id)).first().catch(() => null));
}

export async function suggestOrgs(env, issue, reporter) {
  const orgs = await organizations(env).catch(() => []);
  const found = new Map();
  const add = (org, why, score) => {
    if (!org) return;
    const was = found.get(org.id);
    if (!was || was.score < score) found.set(org.id, { id: org.id, name: org.name, why, score });
  };
  // Someone at Promtek raising a ticket could be raising it for any customer, so who they
  // are and their email say nothing about which; only the ticket's own words count.
  const staff = await isStaff(env, reporter);
  // The Organizations they're in, in Jira.
  if (reporter?.id && !staff) {
    for (const id of await Contacts.orgsOf(env, reporter.id)) add(orgs.find((o) => o.id === id), `${reporter.name} is in it in Jira`, 300);
  }
  // Others from their email domain.
  const dom = Contacts.domainOf(reporter?.email);
  if (dom && !staff && !FREE_MAIL.test(dom)) {
    for (const d of await Contacts.domainOrgs(env, dom)) add(orgs.find((o) => o.id === d.id), `${d.n} other${d.n === 1 ? '' : 's'} from ${dom} ${d.n === 1 ? 'is' : 'are'} in it`, 150 + d.n);
  }
  // Their earlier tickets: the Organization those were under.
  if (reporter?.id && !staff) {
    const past = await searchJql(env, `project = ${PSC} AND reporter = "${reporter.id}" AND cf[12900] is not EMPTY AND key != ${issue.key} ORDER BY created DESC`, [ORG_FIELD], { limit: 30 }).catch(() => []);
    const counts = new Map();
    for (const p of past) for (const o of p.fields?.[ORG_FIELD] || []) counts.set(String(o.id), (counts.get(String(o.id)) || 0) + 1);
    for (const [id, n] of counts) add(orgs.find((o) => o.id === id), `${n} earlier ticket${n === 1 ? '' : 's'} from ${reporter.name}`, 100 + n);
  }
  // Their email address: a company domain that shares a word with an Organization's name.
  const domain = (reporter?.email || '').split('@')[1] || '';
  if (domain && !staff && !FREE_MAIL.test(domain)) {
    const dw = words(domain.replace(/\.[a-z.]+$/i, ''));
    for (const o of orgs) {
      const ow = words(o.name);
      const hit = ow.filter((w) => dw.some((d) => d === w || (w.length >= 4 && d.includes(w)) || (d.length >= 4 && w.includes(d))));
      if (hit.length) add(o, `Email from ${domain}`, 50 + hit.length * 10);
    }
  }
  // Words in the summary and description that name a customer.
  const text = `${issue.fields?.summary || ''} ${JSON.stringify(issue.fields?.description || '')}`.toLowerCase();
  for (const o of orgs) {
    const ow = words(o.name).filter((w) => w.length > 3);
    if (ow.length && ow.every((w) => text.includes(w))) add(o, 'Named in the ticket', 40);
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 5).map(({ id, name, why }) => ({ id, name, why }));
}

// ---------- attachments ----------

export async function attachment(env, viewer, rawKey, id) {
  const { key } = await checkKey(env, viewer, rawKey);
  const issue = await jira(env, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=attachment`);
  const a = (issue?.fields?.attachment || []).find((x) => String(x.id) === String(id));
  if (!a) throw refuse('That attachment isn\'t on this item.', 404);
  const auth = `Basic ${btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`)}`;
  const res = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/attachment/content/${encodeURIComponent(a.id)}`, { headers: { Authorization: auth }, redirect: 'follow' });
  if (!res.ok) throw refuse(`Jira wouldn't hand over the file (${res.status}).`, 502);
  const safeName = String(a.filename || 'attachment').replace(/["\\\r\n]/g, '_');
  const inline = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/i.test(a.mimeType || '');
  return new Response(res.body, { headers: {
    'content-type': a.mimeType || 'application/octet-stream',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
    'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=300',
    'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  } });
}

// ---------- adding a comment ----------

export async function comment(env, viewer, { key: rawKey, text, visibility }) {
  const { key, project } = await checkKey(env, viewer, rawKey);
  const words = String(text || '').trim();
  if (words.length < 2) throw refuse('Write the comment first.');
  if (words.length > 8000) throw refuse('That comment is too long for Jira. Split it in two.');
  const internal = visibility !== 'customer';
  if (!internal && project === PSC) throw refuse('Customers hear from the copy in their project. This one has no copy yet, so it can only take an internal comment.');
  const name = viewer.employee?.name || viewer.email;
  const body = { body: adfFrom(words, name) };
  if (internal) {
    // In the service desk, an internal note; anywhere else, kept to the Promtek Members group so it never syncs to the customer.
    if (project === PSC) body.properties = [{ key: 'sd.public.comment', value: { internal: true } }];
    else body.visibility = { type: 'group', value: internalGroup(env) };
  }
  const saved = await jira(env, `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', body: JSON.stringify(body) });
  await record(env, viewer, { area: 'PSC', action: internal ? 'added an internal comment' : 'added a comment the customer sees', subjectType: 'jira', subjectId: key, label: key,
    changes: [{ label: 'Comment', before: '', after: words.slice(0, 200) }] }).catch(() => {});
  try { (await import('./psc.js')).changed(env); } catch { /* the next read picks it up */ }
  return { ok: true, id: String(saved?.id || ''), internal };
}

export { rowFor };
