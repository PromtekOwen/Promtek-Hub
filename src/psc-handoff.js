// A PSC that isn't support work after all: turned into a quote for the sales team, or
// copied to the MES project as a Bug for Condor Dev. Either way it leaves the PSC tile
// once the hand-off has gone through, and anything Jira refuses is kept and tried again.
//
// A quote: a PSC in a customer's project becomes a Quote under that project's Quote List
// (its issue type changed, or, where Jira won't change it, a new Quote linked to it). A PSC
// on the PSC board, with no Organization, becomes a quote for a customer chosen then, or
// for a new potential customer whose quote waits in the hub until they have a project.
//
// Condor: a Bug in MES with the PSC's summary and description, linked Sync To / Sync From.
import { jira } from './jira.js';
import { raiseAlert, getState, setState } from './sync.js';
import { mustSee, rowFor, context, describe, changed, adfText, organizations, setOrg } from './psc.js';

const MES_PROJECT = 'MES';
const MES_TYPE = 'Bug';
const LINK_KEY = 'psc_sync_link_type';
const MAX_TRIES = 10;
const ALERT_AFTER = 3;

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const withNote = (description, note) => ({
  type: 'doc', version: 1,
  content: [...(description?.type === 'doc' && Array.isArray(description.content) ? description.content : []), para(note)],
});

async function shownItem(env, key) {
  const ctx = await context(env);
  const row = ctx.items.find((r) => r.issue_key === key);
  if (!row) throw refuse('That item isn\'t in the list any more.', 404);
  return describe(row, ctx);
}

const saveHandoff = (env, h) => env.DB.prepare(
  `INSERT INTO psc_handoffs (issue_key, source_key, kind, status, target_key, quote_id, summary, customer, project_key, created_by, created_name, created_at, payload)
   VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(issue_key) DO UPDATE SET source_key = excluded.source_key, kind = excluded.kind, status = 'pending', target_key = NULL, quote_id = excluded.quote_id,
     summary = excluded.summary, customer = excluded.customer, project_key = excluded.project_key, created_by = excluded.created_by,
     created_name = excluded.created_name, created_at = excluded.created_at, payload = excluded.payload, error = NULL, attempts = 0, done_at = NULL`
).bind(h.issue_key, h.source_key, h.kind, h.quote_id ?? null, h.summary, h.customer, h.project_key, h.created_by, h.created_name, new Date().toISOString(), JSON.stringify(h.payload || {})).run();

async function existing(env, key) {
  const h = await env.DB.prepare('SELECT * FROM psc_handoffs WHERE issue_key = ?').bind(key).first();
  if (h?.status === 'done') throw refuse(h.kind === 'condor' ? `That PSC is already in Condor Dev as ${h.target_key}.` : `That PSC is already a quote${h.target_key ? `, ${h.target_key}` : ''}.`, 409);
  return h;
}

// ---------- Condor ----------

// The link type that reads "Sync To" one way and "Sync From" the other.
async function syncLinkType(env) {
  try { const saved = JSON.parse((await getState(env, LINK_KEY)) || 'null'); if (saved?.id) return saved; } catch { /* found again */ }
  const { issueLinkTypes = [] } = (await jira(env, '/rest/api/3/issueLinkType')) || {};
  const t = issueLinkTypes.find((x) => /sync to/i.test(`${x.inward} ${x.outward}`) && /sync from/i.test(`${x.inward} ${x.outward}`))
    || issueLinkTypes.find((x) => /sync/i.test(`${x.name} ${x.inward} ${x.outward}`));
  if (!t) throw new Error('Jira has no Sync To / Sync From link type.');
  const found = { id: String(t.id), name: t.name, outward: t.outward, inward: t.inward };
  await setState(env, LINK_KEY, JSON.stringify(found));
  return found;
}

// The PSC reads "Sync To" the MES ticket, and the MES ticket "Sync From" the PSC.
// Jira's link call puts the type's outward words on its inwardIssue.
export function linkBody(type, pscKey, mesKey) {
  const pscOutward = /sync to/i.test(type.outward || '');
  return { type: { id: type.id }, inwardIssue: { key: pscOutward ? pscKey : mesKey }, outwardIssue: { key: pscOutward ? mesKey : pscKey } };
}

async function doCondor(env, h) {
  let target = h.target_key;
  if (!target) {
    const issue = await jira(env, `/rest/api/3/issue/${encodeURIComponent(h.issue_key)}?fields=summary,description`);
    const note = `Raised as ${h.issue_key}${h.customer ? ` for ${h.customer}` : ''}, and sent to Condor Dev from the PSC tile by ${h.created_name || 'the service team'}.`;
    const fields = { project: { key: MES_PROJECT }, issuetype: { name: MES_TYPE }, summary: issue?.fields?.summary || h.summary || h.issue_key, description: withNote(issue?.fields?.description, note) };
    let created;
    try {
      created = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
    } catch (err) {
      if (err.status !== 400) throw err;
      // A description Jira won't take (an attachment it can't carry, say) is left to the link.
      created = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields: { ...fields, description: withNote(null, note) } }) });
    }
    target = created.key;
    await env.DB.prepare('UPDATE psc_handoffs SET target_key = ? WHERE issue_key = ?').bind(target, h.issue_key).run();
  }
  await jira(env, '/rest/api/3/issueLink', { method: 'POST', body: JSON.stringify(linkBody(await syncLinkType(env), h.issue_key, target)) });
  return target;
}

export async function toCondor(env, viewer, { key }) {
  mustSee(viewer);
  const row = await rowFor(env, key);
  const before = await existing(env, row.issue_key);
  const d = await shownItem(env, row.issue_key);
  const h = { issue_key: row.issue_key, source_key: d.sourceKey, kind: 'condor', summary: row.summary, customer: d.customer || null, project_key: row.project_key,
    created_by: viewer.accountId || viewer.email, created_name: viewer.employee?.name || viewer.email };
  if (!before || before.kind !== 'condor' || !before.target_key) await saveHandoff(env, h);
  return attempt(env, { ...(await env.DB.prepare('SELECT * FROM psc_handoffs WHERE issue_key = ?').bind(row.issue_key).first()) });
}

// ---------- quotes ----------

async function quoteTypeId(env, projectKey) {
  const data = await jira(env, `/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  const t = (data?.issueTypes || []).find((x) => String(x.name).toLowerCase() === 'quote');
  if (!t) throw new Error(`${projectKey} has no Quote issue type.`);
  return String(t.id);
}

async function quoteListKey(env, projectKey) {
  const r = await env.DB.prepare("SELECT issue_key FROM customer_lists WHERE project_key = ? AND kind = 'quotes'").bind(projectKey).first().catch(() => null);
  if (r?.issue_key) return r.issue_key;
  const data = await jira(env, `/rest/api/3/search/jql?jql=${encodeURIComponent(`project = "${projectKey}" AND issuetype = "Quote List" ORDER BY created ASC`)}&maxResults=1&fields=summary`);
  return data?.issues?.[0]?.key || null;
}

// The PSC in the customer's project becomes a Quote under its Quote List. Where Jira won't
// change the type (a different workflow, say), a new Quote is made there and linked to it.
async function convertInProject(env, h, quote) {
  const Quotes = await import('./quotes.js');
  const p = JSON.parse(h.payload || '{}');
  if (!p.made) {
    try {
      const id = await quoteTypeId(env, h.project_key);
      const list = await quoteListKey(env, h.project_key);
      const put = (fields) => jira(env, `/rest/api/3/issue/${encodeURIComponent(h.issue_key)}`, { method: 'PUT', body: JSON.stringify({ fields }) });
      try { await put({ issuetype: { id }, ...(list ? { parent: { key: list } } : {}) }); } catch (err) { if (!list || err.status !== 400) throw err; await put({ issuetype: { id } }); }
      p.made = h.issue_key; p.how = 'changed';
    } catch (err) {
      if (err.status && err.status >= 500) throw err;
      // Jira won't change it: a new Quote, linked back to the PSC.
      const q = await Quotes.retryJira(env, quote.id);
      if (!q?.quote_key) throw new Error(q?.jira_error || err.message);
      p.made = q.quote_key; p.how = 'new';
      await jira(env, '/rest/api/3/issueLink', { method: 'POST', body: JSON.stringify({ type: { name: 'Relates' }, inwardIssue: { key: q.quote_key }, outwardIssue: { key: h.issue_key } }) }).catch(() => {});
    }
    await env.DB.prepare('UPDATE psc_handoffs SET payload = ?, target_key = ? WHERE issue_key = ?').bind(JSON.stringify(p), p.made, h.issue_key).run();
  }
  await env.DB.prepare('UPDATE quotes SET quote_key = COALESCE(quote_key, ?), jira_error = NULL, updated_at = ? WHERE id = ?').bind(p.made, new Date().toISOString(), quote.id).run();
  if (p.how === 'changed') await Quotes.syncDescriptionFor(env, quote.id).catch(() => {});
  return p.made;
}

async function doQuote(env, h) {
  const quote = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(h.quote_id).first();
  if (!quote) throw new Error('The quote in the hub has gone.');
  const comment = (text) => jira(env, `/rest/api/3/issue/${encodeURIComponent(h.source_key || h.issue_key)}/comment`, { method: 'POST',
    body: JSON.stringify({ body: { type: 'doc', version: 1, content: [para(text)] }, properties: [{ key: 'sd.public.comment', value: { internal: true } }] }) }).catch(() => {});
  if (h.project_key && h.project_key !== 'PSC') return convertInProject(env, h, quote);
  // On the PSC board: a quote in the chosen customer's project, or one waiting in the hub for a new customer.
  if (quote.project_key) {
    const Quotes = await import('./quotes.js');
    const q = await Quotes.retryJira(env, quote.id);
    if (!q?.quote_key) throw new Error(q?.jira_error || 'Jira didn\'t take the quote.');
    await comment(`Turned into quote ${q.quote_key} from the PSC tile.`);
    return q.quote_key;
  }
  await comment(`Turned into a quote for ${quote.prospect || 'a new potential customer'} from the PSC tile. It waits in the hub's Quotes tile until they have a project in Jira.`);
  return null;
}

export async function toQuote(env, viewer, input) {
  mustSee(viewer);
  const row = await rowFor(env, input.key);
  await existing(env, row.issue_key);
  const d = await shownItem(env, row.issue_key);
  const onBoard = row.project_key === 'PSC';
  const prospect = String(input.prospect || '').trim().slice(0, 120);
  const projectKey = onBoard ? String(input.projectKey || '').trim().toUpperCase() : row.project_key;
  if (onBoard && !projectKey && !prospect) throw refuse('Choose the customer, or give the new potential customer\'s name.');
  if (projectKey && !/^[A-Z][A-Z0-9_]+$/.test(projectKey)) throw refuse('Choose the customer from the list.');
  let description = '';
  try { description = adfText((await jira(env, `/rest/api/3/issue/${encodeURIComponent(row.issue_key)}?fields=description`))?.fields?.description).trim(); } catch { /* the summary is enough */ }
  const Quotes = await import('./quotes.js');
  const made = await Quotes.createFor(env, viewer, {
    projectKey: projectKey || '', customer: projectKey ? (input.customer || d.customer || projectKey) : prospect, prospect: projectKey ? null : prospect,
    title: input.title || row.summary, description: [description, `From ${row.issue_key} in the PSC tile.`].filter(Boolean).join('\n\n'),
    disciplines: input.disciplines, team: input.team, pscKey: row.issue_key, holdJira: true,
  });
  await saveHandoff(env, { issue_key: row.issue_key, source_key: d.sourceKey, kind: 'quote', quote_id: made.id, summary: row.summary,
    customer: projectKey ? (input.customer || d.customer || projectKey) : prospect, project_key: row.project_key,
    created_by: viewer.accountId || viewer.email, created_name: viewer.employee?.name || viewer.email });
  const r = await attempt(env, await env.DB.prepare('SELECT * FROM psc_handoffs WHERE issue_key = ?').bind(row.issue_key).first());
  return { ...r, quoteId: made.id };
}

// ---------- trying, and trying again ----------

async function attempt(env, h) {
  try {
    const target = h.kind === 'condor' ? await doCondor(env, h) : await doQuote(env, h);
    await env.DB.prepare("UPDATE psc_handoffs SET status = 'done', target_key = COALESCE(?, target_key), done_at = ?, error = NULL WHERE issue_key = ?")
      .bind(target, new Date().toISOString(), h.issue_key).run();
    await changed(env);
    return { ok: true, saved: true, target };
  } catch (err) {
    const attempts = (h.attempts || 0) + 1;
    await env.DB.prepare('UPDATE psc_handoffs SET attempts = ?, error = ? WHERE issue_key = ?').bind(attempts, String(err.message).slice(0, 400), h.issue_key).run();
    if (attempts === ALERT_AFTER) {
      await raiseAlert(env, { kind: 'psc-handoff', dedupe: `psc-handoff:${h.issue_key}`, subject: `${h.issue_key} couldn't be ${h.kind === 'condor' ? 'sent to Condor Dev' : 'turned into a quote'}`,
        body: `${h.created_name || 'Someone'} asked for ${h.issue_key} (${h.summary || ''}) to be ${h.kind === 'condor' ? 'copied to MES as a Bug' : 'turned into a quote'}, and Jira refused:\n\n${err.message}\n\nThe hub keeps trying.` });
    }
    await changed(env);
    return { ok: true, saved: false, message: `Jira didn't take it just now (${String(err.message).slice(0, 160)}). The hub keeps it and tries again.` };
  }
}

export async function retry(env, b) {
  const { results } = await env.DB.prepare("SELECT * FROM psc_handoffs WHERE status = 'pending' AND attempts < ? ORDER BY created_at LIMIT 5").bind(MAX_TRIES).all().catch(() => ({ results: [] }));
  for (const h of results) {
    if (b && b.left() < 6) break;
    await attempt(env, h);
  }
}

// ---------- PSCs with time logged and no Organization ----------

export async function setFlagOrg(env, viewer, { id, orgId }) {
  mustSee(viewer);
  const f = await env.DB.prepare("SELECT * FROM contract_flags WHERE id = ? AND kind = 'psc-org'").bind(Number(id)).first();
  if (!f?.ref_key) throw refuse('That alert has gone.', 404);
  const result = await setOrg(env, viewer, f.ref_key, orgId);
  const org = (await organizations(env)).find((o) => String(o.id) === String(orgId));
  await env.DB.prepare('UPDATE contract_issues SET org = ? WHERE issue_key = ?').bind(org.name, f.ref_key).run().catch(() => {});
  await env.DB.prepare('UPDATE contract_flags SET resolved_at = ?, resolved_by = ? WHERE id = ?')
    .bind(new Date().toISOString(), `${viewer.employee?.name || viewer.email}, Organization set to ${org.name}`, f.id).run();
  await setState(env, 'contracts_touched', String(Date.now())).catch(() => {});
  await changed(env);
  return { ...result, flag: f, org: org.name };
}

export async function resolveFlag(env, viewer, id) {
  mustSee(viewer);
  const f = await env.DB.prepare("SELECT * FROM contract_flags WHERE id = ? AND kind = 'psc-org'").bind(Number(id)).first();
  if (!f) throw refuse('That alert has gone.', 404);
  await env.DB.prepare('UPDATE contract_flags SET resolved_at = ?, resolved_by = ? WHERE id = ?').bind(new Date().toISOString(), viewer.employee?.name || viewer.email, f.id).run();
  await changed(env);
  return { ok: true, flag: f };
}

// ---------- the Condor Dev tile's PSC tab ----------

export async function condorList(env) {
  const { results } = await env.DB.prepare(
    `SELECT h.*, t.status AS mes_status, t.status_category AS mes_cat, t.done AS mes_done, e.name AS mes_assignee
       FROM psc_handoffs h LEFT JOIN mes_tickets t ON t.issue_key = h.target_key LEFT JOIN employees e ON e.account_id = t.assignee_id
      WHERE h.kind = 'condor' ORDER BY h.created_at DESC LIMIT 200`
  ).all();
  return {
    items: results.map((h) => ({
      psc: h.issue_key, original: h.source_key, mes: h.target_key, summary: h.summary, customer: h.customer, by: h.created_name, at: h.created_at,
      status: h.status === 'done' ? (h.mes_status || 'Sent') : 'Waiting to go to MES', done: Boolean(h.mes_done), waiting: h.status !== 'done', error: h.status === 'done' ? null : h.error,
      assignee: h.mes_assignee || null,
    })),
  };
}
