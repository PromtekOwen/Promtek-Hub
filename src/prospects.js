// Prospects: new potential customers, before there's a quote for them. The sales team keeps
// who they are, what they do, what they'd like from Promtek, who to talk to and where they are.
// When they're ready for a quote, one is made from here and goes through the usual new
// customer quote process. Once the customer has a project in Jira, their details go into
// the Customers tile: the site address, the primary contact, and what's known about them.
import { scopeFor } from './country.js';
import { record } from './audit.js';

const DISCIPLINES = ['software', 'hardware', 'engineering', 'condor'];
export const STATUSES = { new: 'New', talking: 'In conversation', quoted: 'Quote started', won: 'Now a customer', lost: 'Not going ahead' };
export const SOURCES = ['PSC', 'Referral', 'Website', 'Phone or email enquiry', 'Trade show or event', 'Existing contact', 'Our outreach', 'Other'];
export const SIZES = ['1 to 10 people', '11 to 50 people', '51 to 250 people', 'More than 250 people'];
export const TIMESCALES = ['As soon as possible', 'Within 3 months', '3 to 6 months', '6 to 12 months', 'Just looking'];

const FIELDS = {
  name: 120, business: 1000, sector: 120, website: 200, size: 40, sites: 200,
  interest: 3000, timescale: 60, budget: 200, competitors: 300,
  source: 60, source_detail: 200,
  contact_name: 120, contact_title: 100, contact_email: 160, contact_phone: 40,
  site_address: 400, billing_address: 400, notes: 3000, next_step: 300, next_date: 10,
};

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const clip = (v, n) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, n);
const canUse = (viewer) => Boolean(viewer?.isAdmin || viewer?.can?.quotes);
function mustUse(viewer) { if (!canUse(viewer)) throw refuse('Prospects are for the sales team and team leads.', 403); }
const parse = (v, d) => { try { return JSON.parse(v || '') ?? d; } catch { return d; } };
const who = (viewer) => viewer?.employee?.name || viewer?.email || 'The hub';

function out(p) {
  return { ...p, areas: parse(p.areas, []), statusName: STATUSES[p.status] || p.status };
}

// ---------- the list, and the quotes that were for new customers before ----------

// Quotes for new potential customers made before Prospects existed become prospects:
// open ones wait here (their estimates kept) until a quote is asked for again; accepted
// ones carry on as quotes, with their prospect alongside.
export async function adoptOldQuotes(env) {
  const { results } = await env.DB.prepare(`SELECT q.*, e.chart_sa, e.name AS created_name FROM quotes q LEFT JOIN employees e ON e.account_id = q.created_by
    WHERE (q.project_key = '' OR q.project_key IS NULL) AND q.prospect IS NOT NULL AND q.status IN ('open', 'ready', 'accepted')
      AND NOT EXISTS (SELECT 1 FROM prospects p WHERE p.quote_id = q.id OR p.held_quote_id = q.id) LIMIT 50`).all();
  for (const q of results) {
    const held = q.status !== 'accepted';
    const now = new Date().toISOString();
    const r = await env.DB.prepare(`INSERT INTO prospects (name, region, interest, areas, source, source_detail, status, quote_id, held_quote_id, psc_key, created_by, created_name, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'The hub')`).bind(q.prospect, Number(q.chart_sa) ? 'sa' : 'uk',
      [q.title, q.description].filter(Boolean).join('\n\n') || null, q.psc_key ? 'PSC' : null, q.psc_key || null, held ? 'talking' : 'quoted',
      held ? null : q.id, held ? q.id : null, q.psc_key || null, q.created_by || null, q.created_name || null, q.created_at || now, now).run();
    // Kept, out of the quote lists, for when a quote is asked for.
    if (held && r.meta?.last_row_id) await env.DB.prepare("UPDATE quotes SET status = 'prospect', updated_at = ? WHERE id = ?").bind(now, q.id).run();
  }
  return { adopted: results.length };
}

export async function list(env, viewer, { show = 'open' } = {}) {
  mustUse(viewer);
  await adoptOldQuotes(env).catch((err) => console.warn('Prospects from old quotes:', err.message));
  const where = show === 'all' ? '' : show === 'closed' ? "WHERE p.status IN ('won', 'lost')" : "WHERE p.status NOT IN ('won', 'lost')";
  let { results } = await env.DB.prepare(`SELECT p.*, e.name AS owner_name, q.title AS quote_title, q.status AS quote_status, q.quote_key FROM prospects p
    LEFT JOIN employees e ON e.account_id = p.created_by LEFT JOIN quotes q ON q.id = p.quote_id ${where} ORDER BY p.updated_at DESC LIMIT 300`).all();
  const country = await scopeFor(env, viewer, 'quotes');
  if (country.only) results = results.filter((p) => !p.region || p.region === country.only || p.created_by === viewer.accountId);
  return { prospects: results.map(out), statuses: STATUSES, bothCountries: !country.only, country: viewer.country || 'uk' };
}

async function rowOf(env, viewer, id) {
  const p = await env.DB.prepare(`SELECT p.*, e.name AS owner_name, q.title AS quote_title, q.status AS quote_status, q.quote_key FROM prospects p
    LEFT JOIN employees e ON e.account_id = p.created_by LEFT JOIN quotes q ON q.id = p.quote_id WHERE p.id = ?`).bind(Number(id)).first();
  if (!p) throw refuse('That prospect has gone.', 404);
  const country = await scopeFor(env, viewer, 'quotes');
  if (country.only && p.region && p.region !== country.only && p.created_by !== viewer.accountId) throw refuse(`That prospect is Promtek ${p.region === 'sa' ? 'Africa' : 'UK'}'s.`, 403);
  return p;
}

export async function get(env, viewer, id) {
  mustUse(viewer);
  const p = await rowOf(env, viewer, id);
  return { prospect: out(p), statuses: STATUSES, sources: SOURCES, sizes: SIZES, timescales: TIMESCALES, bothCountries: !(await scopeFor(env, viewer, 'quotes')).only };
}

// ---------- adding and changing ----------

function cleanInput(input, viewer) {
  const v = {};
  for (const [k, n] of Object.entries(FIELDS)) if (k in input) v[k] = clip(input[k], n) || null;
  if ('areas' in input) v.areas = JSON.stringify(DISCIPLINES.filter((d) => (input.areas || []).includes(d)));
  if ('status' in input && ['new', 'talking', 'lost'].includes(input.status)) v.status = input.status;
  if ('region' in input && ['uk', 'sa'].includes(input.region) && (viewer.isAdmin || viewer.allCountries || viewer.tileAdmin?.includes('quotes'))) v.region = input.region;
  if (v.contact_email) {
    v.contact_email = v.contact_email.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.contact_email)) throw refuse('That email doesn\'t look right.');
  }
  if (v.next_date && !/^\d{4}-\d{2}-\d{2}$/.test(v.next_date)) v.next_date = null;
  if (v.website && !/^https?:\/\//i.test(v.website)) v.website = `https://${v.website}`;
  return v;
}

export async function create(env, viewer, input) {
  mustUse(viewer);
  const v = cleanInput(input, viewer);
  if (!v.name) throw refuse('Give the company\'s name.');
  return { id: await insert(env, viewer, v) };
}

async function insert(env, viewer, v) {
  const now = new Date().toISOString();
  const row = { region: viewer.country || 'uk', areas: '[]', status: 'new', ...v };
  const cols = Object.keys(row);
  const r = await env.DB.prepare(`INSERT INTO prospects (${cols.join(', ')}, created_by, created_name, created_at, updated_at, updated_by) VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ?)`)
    .bind(...cols.map((c) => row[c]), viewer.accountId || null, who(viewer), now, now, who(viewer)).run();
  await record(env, viewer, { area: 'Quotes', action: 'Prospect added', subjectType: 'prospect', subjectId: String(r.meta.last_row_id), label: row.name }).catch(() => {});
  return r.meta.last_row_id;
}

export async function save(env, viewer, input) {
  mustUse(viewer);
  const p = await rowOf(env, viewer, input.id);
  if (p.status === 'won') throw refuse('They\'re a customer now: change their details in the Customers tile.');
  const v = cleanInput(input, viewer);
  if ('name' in v && !v.name) throw refuse('Give the company\'s name.');
  const cols = Object.keys(v);
  if (!cols.length) return { ok: true };
  await env.DB.prepare(`UPDATE prospects SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`)
    .bind(...cols.map((c) => v[c]), new Date().toISOString(), who(viewer), p.id).run();
  // The name of a quote still waiting for their project follows.
  if (v.name && p.quote_id) await env.DB.prepare("UPDATE quotes SET prospect = ?, customer = ? WHERE id = ? AND (project_key = '' OR project_key IS NULL)").bind(v.name, v.name, p.quote_id).run();
  if ('status' in v && v.status !== p.status) {
    await record(env, viewer, { area: 'Quotes', action: 'Prospect status changed', subjectType: 'prospect', subjectId: String(p.id), label: p.name,
      changes: [{ label: 'Status', before: STATUSES[p.status] || p.status, after: STATUSES[v.status] }] }).catch(() => {});
  }
  return { ok: true };
}

export async function remove(env, viewer, { id }) {
  mustUse(viewer);
  const p = await rowOf(env, viewer, id);
  if (p.quote_id) throw refuse('There\'s a quote for them. Mark them Not going ahead instead.');
  await env.DB.prepare('DELETE FROM prospects WHERE id = ?').bind(p.id).run();
  if (p.held_quote_id) await env.DB.prepare("UPDATE quotes SET status = 'lost', updated_at = ? WHERE id = ? AND status = 'prospect'").bind(new Date().toISOString(), p.held_quote_id).run();
  await record(env, viewer, { area: 'Quotes', action: 'Prospect removed', subjectType: 'prospect', subjectId: String(p.id), label: p.name }).catch(() => {});
  return { ok: true };
}

// ---------- from a PSC ----------

// A PSC board item from someone who isn't a customer yet: a prospect, with what they asked about.
export async function fromPsc(env, viewer, { name, pscKey, summary, description, reporter, email }) {
  const v = {
    name: clip(name, FIELDS.name), source: 'PSC', source_detail: clip(`${pscKey}: ${summary || ''}`, FIELDS.source_detail),
    interest: clip([summary, description].filter(Boolean).join('\n\n'), FIELDS.interest) || null,
    contact_name: clip(reporter, FIELDS.contact_name) || null,
    contact_email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? clip(email, FIELDS.contact_email).toLowerCase() : null,
    psc_key: pscKey, status: 'new',
  };
  if (!v.name) throw refuse('Give the new potential customer\'s name.');
  return insert(env, viewer, v);
}

// ---------- asking for a quote ----------

function quoteDescription(p) {
  const line = (label, v) => (v ? `${label}: ${v}` : null);
  return [
    p.interest,
    [line('Who they are', p.business), line('Sector', p.sector), line('Website', p.website)].filter(Boolean).join('\n'),
    [line('Contact', [p.contact_name, p.contact_title].filter(Boolean).join(', ')), line('Email', p.contact_email), line('Phone', p.contact_phone), line('Site', p.site_address)].filter(Boolean).join('\n'),
    [line('Timescale', p.timescale), line('Budget', p.budget)].filter(Boolean).join('\n'),
  ].filter(Boolean).join('\n\n');
}

// The quote for them, in the Quote list as a new customer's quote. A quote kept from before
// Prospects existed comes back with its estimates; otherwise a new one is started.
export async function startQuote(env, viewer, input) {
  mustUse(viewer);
  const p = await rowOf(env, viewer, input.id);
  if (p.quote_id) throw refuse('There\'s already a quote for them.', 409);
  if (['won', 'lost'].includes(p.status)) throw refuse('They\'re not an open prospect.');
  const Quotes = await import('./quotes.js');
  const now = new Date().toISOString();
  let quoteId;
  const title = clip(input.title, 200) || `Quote for ${p.name}`;
  if (p.held_quote_id && await env.DB.prepare("SELECT 1 FROM quotes WHERE id = ? AND status = 'prospect'").bind(p.held_quote_id).first()) {
    quoteId = p.held_quote_id;
    await env.DB.prepare("UPDATE quotes SET status = 'open', prospect = ?, customer = ?, title = ?, updated_at = ? WHERE id = ?").bind(p.name, p.name, title, now, quoteId).run();
  } else {
    const made = await Quotes.createFor(env, viewer, {
      projectKey: '', prospect: p.name, customer: p.name, title, description: quoteDescription(p),
      disciplines: input.disciplines?.length ? input.disciplines : parse(p.areas, []), team: input.team, pscKey: p.psc_key || null, holdJira: true,
    });
    quoteId = made.id;
  }
  await env.DB.prepare("UPDATE prospects SET quote_id = ?, status = 'quoted', updated_at = ?, updated_by = ? WHERE id = ?").bind(quoteId, now, who(viewer), p.id).run();
  await record(env, viewer, { area: 'Quotes', action: 'Quote started for a prospect', subjectType: 'prospect', subjectId: String(p.id), label: p.name,
    changes: [{ label: 'Quote', before: '', after: title }] }).catch(() => {});
  return { ok: true, quoteId };
}

// ---------- once they're a customer ----------

// Their project is in Jira and their quote is in it: the prospect's details go into the
// Customers tile (site address, billing address, primary contact), and the prospect is closed.
export async function becameCustomer(env, quoteId, projectKey) {
  const p = await env.DB.prepare('SELECT * FROM prospects WHERE quote_id = ?').bind(Number(quoteId)).first();
  if (!p) return null;
  const Customers = await import('./customers.js');
  await Customers.fromProspect(env, projectKey, p);
  await env.DB.prepare("UPDATE prospects SET status = 'won', project_key = ?, updated_at = ?, updated_by = 'The hub' WHERE id = ?").bind(projectKey, new Date().toISOString(), p.id).run();
  return p.id;
}

// What was known about them as a prospect, for their page in the Customers tile.
export async function aboutCustomer(env, projectKey) {
  const p = await env.DB.prepare("SELECT * FROM prospects WHERE project_key = ? AND status = 'won' ORDER BY id DESC LIMIT 1").bind(projectKey).first().catch(() => null);
  if (!p) return null;
  return { business: p.business, sector: p.sector, website: p.website, size: p.size, sites: p.sites, interest: p.interest, areas: parse(p.areas, []),
    source: p.source, sourceDetail: p.source_detail, notes: p.notes, since: p.created_at, by: p.created_name };
}
