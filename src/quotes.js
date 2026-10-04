// The quote builder. Each quote records what was known when it was priced,
// counts, conditions, novelty and estimates, so that once the job is done the
// hub can learn how those things relate to the hours and difficulty it took.
import { jira, searchJql } from './jira.js';
import { DISCIPLINES, disciplineOf, customerFilter } from './jobs.js';
import { raiseAlert, sendAlerts, getState, setState, londonDate } from './sync.js';
import { quoteElo } from './progression.js';
import { forMe } from './permissions.js';

export const DISCIPLINE_ORDER = ['software', 'hardware', 'engineering', 'condor'];
const QUOTE_NUMBER_FIELD = 'customfield_14259';
const MODEL_MIN_JOBS = 15;
const NOVELTY = { exact: 0, similar: 0.5, never: 1 };
const SPEC = { clear: 0, partly: 0.5, vague: 1 };

export const DEFAULT_CONFIG = {
  common: ['New customer', 'New site'],
  software: {
    counts: [['integrations', 'Systems to integrate with'], ['screens', 'Screens or workflows'], ['recipes', 'Recipes or products'], ['reports', 'Reports'], ['lines', 'Sites or lines']],
    chips: ['Customer IT involved', 'Legacy system to migrate from', 'Data migration', 'Reused design'],
  },
  hardware: {
    counts: [['panels', 'Panels'], ['io', 'I/O points'], ['weighpoints', 'Weigh points or load cells'], ['boughtout', 'Bought-out items']],
    chips: ['ATEX', 'Custom enclosure', 'Drawings supplied by the customer', 'Legacy or obsolete kit', 'Reused design'],
  },
  engineering: {
    jobTypes: ['Maintenance', 'Build', 'Commissioning', 'Repair', 'Calibration', 'Training'],
    counts: [['days', 'Days on site'], ['devices', 'Devices'], ['weighpoints', 'Weigh points'], ['attendees', 'People to train']],
    chips: ['ATEX', 'Working at height', 'Permits needed', 'Out of hours', 'Customer staff available', 'Fault not yet known', 'Long travel'],
  },
  condor: {
    counts: [['stations', 'Weigh points or stations'], ['modules', 'Standard modules switched on'], ['custom', 'Custom features beyond standard'], ['integrations', 'Integrations']],
    chips: ['New install', 'Upgrade', 'Customer IT involved', 'Legacy or obsolete kit'],
  },
};

const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const hoursText = (h) => `${Math.round((h || 0) * 10) / 10}h`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Blank lines start new paragraphs; single line breaks stay as line breaks.
const adf = (text) => ({
  type: 'doc', version: 1,
  content: String(text).replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => ({
    type: 'paragraph',
    content: p.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
  })),
});
const MAX_DESCRIPTION = 20000;
const cleanDescription = (v) => String(v || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_DESCRIPTION);

// Jira's description is what sales wrote, with the hub's estimates underneath
// once the quote is ready to send, so neither ever overwrites the other.
async function jiraDescription(env, q) {
  const parts = [];
  if (q.description) parts.push(q.description);
  if (q.status === 'ready') {
    const { results } = await env.DB.prepare(
      'SELECT s.*, e.name AS estimator FROM quote_sections s LEFT JOIN employees e ON e.account_id = s.estimator_id WHERE quote_id = ?'
    ).bind(q.id).all();
    const lines = results.sort((a, b) => DISCIPLINE_ORDER.indexOf(a.discipline) - DISCIPLINE_ORDER.indexOf(b.discipline))
      .map((s) => `${DISCIPLINE_LABELS[s.discipline]}: ${s.quoted_hours != null ? hoursText(s.quoted_hours) : 'hours not set'}`
        + `${s.job_elo ? `, job ELO ${Math.round(s.job_elo)}` : ''}${s.estimator ? `, estimated by ${s.estimator}` : ''}.`);
    parts.push(`Estimates from the Promtek Hub quote builder\n${lines.join('\n')}`);
  }
  return parts.length ? adf(parts.join('\n\n')) : null;
}

async function syncDescription(env, q) {
  if (!q.quote_key) return null;
  try {
    const description = await jiraDescription(env, q);
    await jira(env, `/rest/api/3/issue/${encodeURIComponent(q.quote_key)}`, { method: 'PUT', body: JSON.stringify({ fields: { description } }) });
    await env.DB.prepare('UPDATE quotes SET description_synced = 1 WHERE id = ?').bind(q.id).run();
    return true;
  } catch {
    await env.DB.prepare('UPDATE quotes SET description_synced = 0 WHERE id = ?').bind(q.id).run();
    return false;
  }
}

export async function config(env) {
  return parse(await getState(env, 'quote_config'), DEFAULT_CONFIG);
}

export async function saveConfig(env, input) {
  const clean = { common: (input.common || []).map(String).filter(Boolean).slice(0, 20) };
  for (const d of DISCIPLINE_ORDER) {
    const c = input[d] || {};
    clean[d] = {
      counts: (c.counts || []).filter((x) => Array.isArray(x) && x[0] && x[1]).map(([k, l]) => [String(k).slice(0, 40), String(l).slice(0, 80)]).slice(0, 12),
      chips: (c.chips || []).map(String).filter(Boolean).slice(0, 20),
    };
    if (d === 'engineering') clean[d].jobTypes = (c.jobTypes || []).map(String).filter(Boolean).slice(0, 15);
  }
  await setState(env, 'quote_config', JSON.stringify(clean));
  return clean;
}

// ---------- Who can do what ----------

const canCreate = (viewer) => Boolean(viewer.can?.quotes);

async function canView(env, viewer, quoteId) {
  if (canCreate(viewer)) return true;
  if (!viewer.accountId) return false;
  const r = await env.DB.prepare('SELECT 1 FROM quote_requests WHERE quote_id = ? AND account_id = ? LIMIT 1').bind(quoteId, viewer.accountId).first();
  return Boolean(r);
}

// ---------- Jira ----------

async function createInJira(env, quote, viewer) {
  const lists = await searchJql(env, `project = "${quote.project_key}" AND issuetype = "Quote List" ORDER BY created ASC`, ['summary'], { limit: 1 });
  const fields = { project: { key: quote.project_key }, issuetype: { name: 'Quote' }, summary: quote.title };
  const description = await jiraDescription(env, quote);
  if (description) fields.description = description;
  if (viewer?.accountId) fields.assignee = { id: viewer.accountId };
  if (lists[0]) fields.parent = { key: lists[0].key };
  let created;
  try {
    created = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
  } catch (err) {
    if (!fields.parent && !fields.assignee) throw err;
    // Some projects refuse a parent or assignee on create; the quote matters more.
    delete fields.parent; delete fields.assignee;
    created = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
  }
  return created.key;
}

export async function retryJira(env, id) {
  const q = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(Number(id)).first();
  if (!q || q.quote_key) return q;
  try {
    const key = await createInJira(env, q, { accountId: q.created_by });
    await env.DB.prepare('UPDATE quotes SET quote_key = ?, jira_error = NULL, updated_at = ? WHERE id = ?').bind(key, new Date().toISOString(), q.id).run();
  } catch (err) {
    await env.DB.prepare('UPDATE quotes SET jira_error = ? WHERE id = ?').bind(err.message.slice(0, 300), q.id).run();
  }
  return env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(q.id).first();
}

// ---------- Quotes ----------

export async function create(env, viewer, input) {
  if (!canCreate(viewer)) throw new Error('Only the sales team and team leads can start a quote.');
  const title = String(input.title || '').trim().slice(0, 200);
  if (!title) throw new Error('Give the quote a title.');
  if (!/^[A-Z][A-Z0-9_]+$/.test(input.projectKey || '')) throw new Error('Choose the customer.');
  const disciplines = DISCIPLINE_ORDER.filter((d) => (input.disciplines || []).includes(d));
  if (!disciplines.length) throw new Error('Choose at least one category.');
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO quotes (project_key, customer, title, description, status, created_by, created_email, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).bind(input.projectKey, String(input.customer || '').slice(0, 120), title, cleanDescription(input.description) || null, viewer.accountId, viewer.email, now, now).run();
  const id = res.meta.last_row_id;
  await env.DB.batch(disciplines.map((d) => env.DB.prepare(
    'INSERT INTO quote_sections (quote_id, discipline, counts, chips, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, d, '{}', '[]', now)));
  // The hub keeps the quote even if Jira can't take it yet.
  const q = await retryJira(env, id);
  return { id, quoteKey: q.quote_key, jiraError: q.jira_error };
}

export async function list(env, viewer, { scope = 'open' } = {}) {
  let rows;
  if (canCreate(viewer)) {
    const where = scope === 'mine' ? 'WHERE q.created_by = ?' : scope === 'open' ? "WHERE q.status IN ('open', 'ready')" : '';
    const stmt = env.DB.prepare(`SELECT q.*, e.name AS created_name FROM quotes q LEFT JOIN employees e ON e.account_id = q.created_by ${where} ORDER BY q.id DESC LIMIT 200`);
    rows = (scope === 'mine' ? await stmt.bind(viewer.accountId).all() : await stmt.all()).results;
  } else {
    rows = (await env.DB.prepare(
      `SELECT DISTINCT q.*, e.name AS created_name FROM quotes q JOIN quote_requests r ON r.quote_id = q.id
         LEFT JOIN employees e ON e.account_id = q.created_by WHERE r.account_id = ? ORDER BY q.id DESC LIMIT 100`
    ).bind(viewer.accountId).all()).results;
  }
  const requests = viewer.accountId ? (await env.DB.prepare(
    `SELECT r.*, q.title, q.quote_key, q.customer, e.name AS requested_name FROM quote_requests r JOIN quotes q ON q.id = r.quote_id
       LEFT JOIN employees e ON e.account_id = r.requested_by WHERE r.account_id = ? AND r.status = 'pending' ORDER BY r.id`
  ).bind(viewer.accountId).all()).results : [];
  return { quotes: rows, requests, canCreate: canCreate(viewer) };
}

export async function get(env, viewer, id) {
  const q = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(Number(id)).first();
  if (!q) throw new Error('That quote has gone.');
  if (!(await canView(env, viewer, q.id))) throw new Error('This quote hasn\'t been shared with you.');
  const { results: sections } = await env.DB.prepare('SELECT s.*, e.name AS estimator FROM quote_sections s LEFT JOIN employees e ON e.account_id = s.estimator_id WHERE quote_id = ?').bind(q.id).all();
  const { results: requests } = await env.DB.prepare(
    'SELECT r.*, e.name AS name FROM quote_requests r LEFT JOIN employees e ON e.account_id = r.account_id WHERE quote_id = ? ORDER BY id'
  ).bind(q.id).all();
  const out = sections.sort((a, b) => DISCIPLINE_ORDER.indexOf(a.discipline) - DISCIPLINE_ORDER.indexOf(b.discipline))
    .map((s) => ({ ...s, counts: parse(s.counts, {}), chips: parse(s.chips, []) }));
  const withHelp = [];
  for (const s of out) withHelp.push({ ...s, help: await suggest(env, s) });
  return {
    quote: q, sections: withHelp, config: await config(env),
    requests: requests.map((r) => ({ ...r, answer: parse(r.answer, null) })),
    canEdit: canCreate(viewer), jiraUrl: q.quote_key ? `${env.JIRA_BASE_URL}/browse/${q.quote_key}` : null,
  };
}

const num = (v, lo, hi) => {
  if (v === '' || v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) && x >= lo && x <= hi ? x : null;
};

function cleanSection(input, cfg, discipline) {
  const c = cfg[discipline] || { counts: [], chips: [] };
  const counts = {};
  for (const [k] of c.counts) { const v = num(input.counts?.[k], 0, 100000); if (v != null) counts[k] = v; }
  const allowed = new Set([...(cfg.common || []), ...c.chips]);
  return {
    job_type: discipline === 'engineering' && (c.jobTypes || []).includes(input.job_type) ? input.job_type : null,
    counts: JSON.stringify(counts),
    chips: JSON.stringify((input.chips || []).filter((x) => allowed.has(x))),
    novelty: input.novelty in NOVELTY ? input.novelty : null,
    spec: input.spec in SPEC ? input.spec : null,
    best_hours: num(input.best_hours, 0, 100000), likely_hours: num(input.likely_hours, 0, 100000), worst_hours: num(input.worst_hours, 0, 100000),
    tech: num(input.tech, 1, 5), risk: num(input.risk, 1, 5), dep: num(input.dep, 1, 5),
    reference_id: input.reference_id ? String(input.reference_id).slice(0, 40) : null,
    reference_compare: ['harder', 'same', 'easier'].includes(input.reference_compare) ? input.reference_compare : null,
    quoted_hours: num(input.quoted_hours, 0, 100000),
  };
}

async function writeSection(env, quoteId, discipline, data, estimatorId) {
  const elo = quoteElo(data);
  await env.DB.prepare(
    `UPDATE quote_sections SET job_type = ?, counts = ?, chips = ?, novelty = ?, spec = ?, best_hours = ?, likely_hours = ?, worst_hours = ?,
       tech = ?, risk = ?, dep = ?, reference_id = ?, reference_compare = ?, quoted_hours = ?, job_elo = ?,
       estimator_id = COALESCE(?, estimator_id), updated_at = ? WHERE quote_id = ? AND discipline = ?`
  ).bind(data.job_type, data.counts, data.chips, data.novelty, data.spec, data.best_hours, data.likely_hours, data.worst_hours,
    data.tech, data.risk, data.dep, data.reference_id, data.reference_compare, data.quoted_hours, elo,
    estimatorId, new Date().toISOString(), quoteId, discipline).run();
}

export async function saveSection(env, viewer, input) {
  if (!canCreate(viewer)) throw new Error('Only the sales team and team leads can change a quote.');
  const q = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(Number(input.quoteId)).first();
  if (!q) throw new Error('That quote has gone.');
  if (q.epic_key) throw new Error('This quote has become an order, so it can no longer change.');
  const data = cleanSection(input.data || {}, await config(env), input.discipline);
  // Whoever gives the hours is the estimator, so their bias can be learned.
  const estimator = data.likely_hours != null ? (input.estimatorId || viewer.accountId) : null;
  await writeSection(env, q.id, input.discipline, data, estimator);
  await env.DB.prepare('UPDATE quotes SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), q.id).run();
  const s = await env.DB.prepare('SELECT * FROM quote_sections WHERE quote_id = ? AND discipline = ?').bind(q.id, input.discipline).first();
  return { help: await suggest(env, { ...s, counts: parse(s.counts, {}), chips: parse(s.chips, []) }) };
}

export async function setStatus(env, viewer, input) {
  if (!canCreate(viewer)) throw new Error('Only the sales team and team leads can change a quote.');
  if (!['open', 'ready', 'lost'].includes(input.status)) throw new Error('Unknown status.');
  const q = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(Number(input.id)).first();
  if (!q) throw new Error('That quote has gone.');
  await env.DB.prepare('UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?').bind(input.status, new Date().toISOString(), q.id).run();
  // Ready adds the estimates under the description; going back takes them off again.
  const changesJira = input.status === 'ready' || q.status === 'ready';
  const jiraUpdated = changesJira ? await syncDescription(env, { ...q, status: input.status }) : null;
  return { ok: true, jiraUpdated };
}

export async function saveDescription(env, viewer, input) {
  if (!canCreate(viewer)) throw new Error('Only the sales team and team leads can change a quote.');
  const q = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(Number(input.id)).first();
  if (!q) throw new Error('That quote has gone.');
  if (q.epic_key) throw new Error('This quote has become an order, so it can no longer change.');
  const description = cleanDescription(input.description) || null;
  await env.DB.prepare('UPDATE quotes SET description = ?, updated_at = ? WHERE id = ?').bind(description, new Date().toISOString(), q.id).run();
  return { ok: true, jiraUpdated: await syncDescription(env, { ...q, description }) };
}

export const DISCIPLINE_LABELS = { software: 'Software', hardware: 'Hardware', engineering: 'Site visit', condor: 'Condor' };

// ---------- Asking an engineer ----------

export async function ask(env, viewer, input) {
  if (!canCreate(viewer)) throw new Error('Only the sales team and team leads can ask for an estimate.');
  const q = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(Number(input.quoteId)).first();
  if (!q) throw new Error('That quote has gone.');
  const who = await env.DB.prepare('SELECT account_id, name, email FROM employees WHERE account_id = ? AND active = 1').bind(input.accountId).first();
  if (!who) throw new Error('Choose who to ask.');
  if (!DISCIPLINE_ORDER.includes(input.discipline)) throw new Error('Which category?');
  const note = String(input.note || '').trim().slice(0, 1000) || null;
  const res = await env.DB.prepare(
    'INSERT INTO quote_requests (quote_id, discipline, account_id, requested_by, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(q.id, input.discipline, who.account_id, viewer.accountId, note, new Date().toISOString()).run();
  const asker = viewer.employee?.name || viewer.email;
  await raiseAlert(env, {
    kind: 'quote-request', dedupe: `quote-request:${res.meta.last_row_id}`, recipient: who.email,
    subject: `${asker} would like your estimate for ${q.customer || 'a quote'}`,
    body: `${asker} is quoting ${q.title}${q.quote_key ? ` (${q.quote_key})` : ''} for ${q.customer || 'a customer'} and would like your view on the ${DISCIPLINE_LABELS[input.discipline]} side.\n\n`
      + (note ? `${note}\n\n` : '') + 'Open Quotes in the hub to answer. It takes a couple of minutes.',
  });
  await sendAlerts(env).catch(() => {});
  return { ok: true };
}

export async function answer(env, viewer, input) {
  const r = await env.DB.prepare('SELECT * FROM quote_requests WHERE id = ?').bind(Number(input.requestId)).first();
  if (!r || r.account_id !== viewer.accountId) throw new Error('That request isn\'t yours to answer.');
  if (r.status !== 'pending') throw new Error('That has already been answered.');
  const q = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(r.quote_id).first();
  const data = cleanSection(input.data || {}, await config(env), r.discipline);
  if (data.likely_hours == null) throw new Error('Give at least your likely hours.');
  const comment = String(input.comment || '').trim().slice(0, 2000) || null;
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE quote_requests SET status = 'answered', answer = ?, comment = ?, answered_at = ? WHERE id = ?")
    .bind(JSON.stringify({ ...data, counts: parse(data.counts, {}), chips: parse(data.chips, []) }), comment, now, r.id).run();

  // An empty section takes the answer as it stands; otherwise sales chooses.
  const s = await env.DB.prepare('SELECT likely_hours FROM quote_sections WHERE quote_id = ? AND discipline = ?').bind(r.quote_id, r.discipline).first();
  let applied = false;
  if (s && s.likely_hours == null && !q.epic_key) { await writeSection(env, r.quote_id, r.discipline, data, viewer.accountId); applied = true; }

  let commented = false;
  if (q.quote_key) {
    const name = viewer.employee?.name || viewer.email;
    const text = `${name}'s estimate for ${DISCIPLINE_LABELS[r.discipline]}: best ${hoursText(data.best_hours)}, likely ${hoursText(data.likely_hours)}, worst ${hoursText(data.worst_hours)}.`
      + `${data.novelty ? ` Done before: ${{ exact: 'this exact thing', similar: 'something similar', never: 'never' }[data.novelty]}.` : ''}`
      + `${comment ? `\n\n${comment}` : ''}`;
    try {
      await jira(env, `/rest/api/3/issue/${encodeURIComponent(q.quote_key)}/comment`, { method: 'POST', body: JSON.stringify({ body: adf(text) }) });
      await env.DB.prepare('UPDATE quote_requests SET jira_commented = 1 WHERE id = ?').bind(r.id).run();
      commented = true;
    } catch { /* kept in the hub and shown on the quote */ }
  }
  return { ok: true, applied, commented };
}

export async function useAnswer(env, viewer, requestId) {
  if (!canCreate(viewer)) throw new Error('Only the sales team and team leads can change a quote.');
  const r = await env.DB.prepare('SELECT * FROM quote_requests WHERE id = ?').bind(Number(requestId)).first();
  if (!r?.answer) throw new Error('There is no answer to use.');
  const a = JSON.parse(r.answer);
  await writeSection(env, r.quote_id, r.discipline, { ...a, counts: JSON.stringify(a.counts || {}), chips: JSON.stringify(a.chips || []) }, r.account_id);
  return { ok: true };
}

// ---------- Reference jobs, suggestions and the learning model ----------

// Finished categories with whatever was known when they were quoted.
async function history(env, discipline) {
  const { results } = await env.DB.prepare(
    `SELECT c.issue_id, c.issue_key, c.epic_key, c.project_name, c.summary, c.done_date, c.estimate_seconds, c.actual_seconds,
            c.score_tech, c.score_risk, c.score_dep, m.job_elo_after AS learned_elo, m.job_elo AS rated_elo,
            s.quote_id, s.job_type, s.counts, s.chips, s.novelty, s.spec, s.likely_hours, s.estimator_id, s.tech, s.risk, s.dep,
            k.actual AS checked_counts
       FROM completed_jobs c
       LEFT JOIN elo_matches m ON m.category_id = c.issue_id AND m.status = 'rated'
       LEFT JOIN quotes q ON q.epic_key = c.epic_key
       LEFT JOIN quote_sections s ON s.quote_id = q.id AND s.discipline = c.discipline
       LEFT JOIN count_checks k ON k.category_id = c.issue_id AND k.status = 'done'
      WHERE c.kind = 'category' AND c.discipline = ? AND c.actual_seconds > 0
      ORDER BY c.done_date DESC LIMIT 500`
  ).bind(discipline).all();
  return results.map((r) => ({
    ...r,
    counts: parse(r.checked_counts, null) || parse(r.counts, null),
    chips: parse(r.chips, null),
    tech: r.tech ?? r.score_tech, risk: r.risk ?? r.score_risk, dep: r.dep ?? r.score_dep,
  }));
}

export function similarity(s, h) {
  let total = 0, weight = 0;
  const add = (score, w) => { total += score * w; weight += w; };
  if (s.chips?.length || (h.chips && h.chips.length)) {
    if (h.chips) {
      const a = new Set(s.chips || []), b = new Set(h.chips);
      const union = new Set([...a, ...b]);
      add(union.size ? [...a].filter((x) => b.has(x)).length / union.size : 1, 2);
    }
  }
  if (h.counts && s.counts && Object.keys({ ...s.counts, ...h.counts }).length) {
    const keys = Object.keys({ ...s.counts, ...h.counts });
    add(keys.reduce((a, k) => {
      const x = s.counts[k] || 0, y = h.counts[k] || 0;
      return a + (x === y ? 1 : Math.min(x, y) / Math.max(x, y));
    }, 0) / keys.length, 2);
  }
  if (s.job_type && h.job_type) add(s.job_type === h.job_type ? 1 : 0, 1);
  if (s.novelty && h.novelty) add(1 - Math.abs(NOVELTY[s.novelty] - NOVELTY[h.novelty]), 0.5);
  const scores = ['tech', 'risk', 'dep'].filter((k) => s[k] != null && h[k] != null);
  if (scores.length) add(scores.reduce((a, k) => a + 1 - Math.abs(s[k] - h[k]) / 4, 0) / scores.length, 1);
  const hours = s.likely_hours, est = h.estimate_seconds ? h.estimate_seconds / 3600 : h.actual_seconds / 3600;
  if (hours && est) add(1 - Math.min(1, Math.abs(Math.log(hours / est)) / Math.log(4)), 1);
  return weight ? total / weight : 0;
}

function features(row, cfg, discipline) {
  const c = cfg[discipline] || { counts: [], chips: [] };
  const counts = row.counts || {};
  const chips = new Set(row.chips || []);
  const f = [1];
  for (const [k] of c.counts) f.push(Math.log1p(counts[k] || 0));
  for (const chip of [...(cfg.common || []), ...c.chips]) f.push(chips.has(chip) ? 1 : 0);
  if (discipline === 'engineering') for (const t of c.jobTypes || []) f.push(row.job_type === t ? 1 : 0);
  f.push(row.novelty ? NOVELTY[row.novelty] : 0.5, row.spec ? SPEC[row.spec] : 0.5);
  return f;
}

// Ridge regression by the normal equations; small data, so plain arrays do.
export function ridge(X, y, lambda = 1) {
  const p = X[0].length;
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => X.reduce((a, r) => a + r[i] * r[j], 0) + (i === j && i > 0 ? lambda : 0)));
  const b = Array.from({ length: p }, (_, i) => X.reduce((a, r, n) => a + r[i] * y[n], 0));
  for (let col = 0; col < p; col++) {
    let pivot = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]]; [b[col], b[pivot]] = [b[pivot], b[col]];
    if (Math.abs(A[col][col]) < 1e-12) continue;
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k < p; k++) A[r][k] -= f * A[col][k];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => (Math.abs(A[i][i]) < 1e-12 ? 0 : v / A[i][i]));
}
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

export async function suggest(env, section) {
  const cfg = await config(env);
  const past = await history(env, section.discipline);
  const references = past
    .map((h) => ({ h, sim: similarity(section, h) }))
    .filter((x) => x.sim > 0.35)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 5)
    .map(({ h, sim }) => ({
      id: h.issue_id, key: h.issue_key, customer: h.project_name, summary: h.summary, doneDate: h.done_date, similarity: Math.round(sim * 100) / 100,
      estimateHours: h.estimate_seconds ? h.estimate_seconds / 3600 : null, actualHours: h.actual_seconds / 3600,
      learnedElo: h.learned_elo, quoted: Boolean(h.quote_id),
    }));

  const { best_hours: b, likely_hours: l, worst_hours: w } = section;
  const pert = l != null ? (b != null && w != null ? (b + 4 * l + w) / 6 : l) : null;
  const ratios = references.filter((r) => r.estimateHours).map((r) => r.actualHours / r.estimateHours);
  const refFactor = ratios.length >= 3 ? Math.min(3, Math.max(0.5, median(ratios))) : null;

  // How this estimator's likely hours have compared with what happened.
  let bias = null;
  if (section.estimator_id) {
    const theirs = past.filter((h) => h.estimator_id === section.estimator_id && h.likely_hours).map((h) => (h.actual_seconds / 3600) / h.likely_hours);
    if (theirs.length >= 3) bias = { ratio: median(theirs), jobs: theirs.length };
  }

  // The model only speaks once there's enough quoted, finished work behind it.
  const trained = past.filter((h) => h.quote_id && h.counts);
  let model = null;
  if (trained.length >= MODEL_MIN_JOBS) {
    const X = trained.map((h) => features(h, cfg, section.discipline));
    const beta = ridge(X, trained.map((h) => Math.log(h.actual_seconds / 3600)));
    const x = features(section, cfg, section.discipline);
    const eloRows = trained.filter((h) => h.learned_elo != null);
    let elo = null;
    if (eloRows.length >= MODEL_MIN_JOBS) {
      const XE = eloRows.map((h) => [...features(h, cfg, section.discipline), h.tech ?? 3, h.risk ?? 3, h.dep ?? 3]);
      const betaE = ridge(XE, eloRows.map((h) => h.learned_elo), 5);
      elo = dot([...x, section.tech ?? 3, section.risk ?? 3, section.dep ?? 3], betaE);
    }
    model = { hours: Math.exp(dot(x, beta)), elo, jobs: trained.length };
  }

  return {
    references,
    pert,
    refFactor,
    suggestedHours: pert != null ? pert * (refFactor ?? 1) : (model?.hours ?? null),
    bias,
    model,
    modelNeeds: Math.max(0, MODEL_MIN_JOBS - trained.length),
    jobElo: quoteElo(section),
  };
}

// ---------- When the quote becomes an order ----------

const quoteNumberOf = (issue) => {
  const v = issue.fields?.[QUOTE_NUMBER_FIELD];
  return String(typeof v === 'object' && v ? v.value ?? '' : v ?? '').trim().toUpperCase() || null;
};

async function alertAdmin(env, dedupe, subject, body) {
  await raiseAlert(env, { kind: 'quote-handoff', dedupe, subject, body });
}

// Puts each quoted category's difficulty and hours on the new order in Jira.
export async function handOff(env) {
  const { results: waiting } = await env.DB.prepare('SELECT * FROM quotes WHERE quote_key IS NOT NULL AND epic_key IS NULL').all();
  if (!waiting.length) return { linked: 0 };
  const byKey = new Map(waiting.map((q) => [q.quote_key.toUpperCase(), q]));
  const epics = await searchJql(env, `${customerFilter} AND issuetype = Epic AND cf[${QUOTE_NUMBER_FIELD.split('_')[1]}] is not EMPTY AND created >= -60d`,
    ['summary', 'created', QUOTE_NUMBER_FIELD], { limit: 300 });
  let linked = 0;
  for (const epic of epics) {
    const q = byKey.get(quoteNumberOf(epic));
    if (!q) continue;
    const cats = await searchJql(env, `parent = ${epic.key} AND issuetype not in subTaskIssueTypes()`, ['summary', 'issuetype']);
    const byDiscipline = new Map(cats.filter(disciplineOf).map((c) => [disciplineOf(c), c]));
    const { results: sections } = await env.DB.prepare('SELECT * FROM quote_sections WHERE quote_id = ?').bind(q.id).all();
    const missing = sections.filter((s) => !byDiscipline.has(s.discipline));
    const ageDays = (Date.now() - Date.parse(epic.fields?.created || Date.now())) / 86_400_000;
    // Categories can arrive after the order; give them a week before saying so.
    if (missing.length && ageDays < 7) continue;
    try {
      const epicFields = {};
      for (const s of sections) {
        const cat = byDiscipline.get(s.discipline);
        if (!cat) continue;
        const map = DISCIPLINES[s.discipline];
        const hours = s.quoted_hours ?? s.likely_hours;
        const fields = {};
        if (s.job_elo != null) fields[env.FIELD_ELO] = Math.round(s.job_elo);
        if (hours) fields.timetracking = { originalEstimate: `${Math.round(hours * 10) / 10}h` };
        if (Object.keys(fields).length) {
          await jira(env, `/rest/api/3/issue/${encodeURIComponent(cat.key)}`, { method: 'PUT', body: JSON.stringify({ fields }) });
        }
        if (hours) {
          await env.DB.prepare(
            `INSERT INTO quote_splits (category_id, category_key, quote_id, seconds, status, handed_off_at) VALUES (?, ?, ?, ?, 'pending', ?)
             ON CONFLICT(category_id) DO UPDATE SET seconds = excluded.seconds, status = 'pending', handed_off_at = excluded.handed_off_at`
          ).bind(String(cat.id), cat.key, q.id, Math.round(hours * 36) * 100, new Date().toISOString()).run();
        }
        if (s.tech != null) epicFields[map.tech] = s.tech;
        if (s.risk != null) epicFields[map.risk] = s.risk;
        if (s.dep != null) epicFields[map.dep] = s.dep;
        await env.DB.prepare('UPDATE quote_sections SET category_id = ? WHERE quote_id = ? AND discipline = ?').bind(String(cat.id), q.id, s.discipline).run();
      }
      if (Object.keys(epicFields).length) {
        await jira(env, `/rest/api/3/issue/${encodeURIComponent(epic.key)}`, { method: 'PUT', body: JSON.stringify({ fields: epicFields }) });
      }
      await env.DB.prepare("UPDATE quotes SET epic_key = ?, epic_id = ?, status = 'won', handed_off_at = ?, handoff_error = NULL, updated_at = ? WHERE id = ?")
        .bind(epic.key, String(epic.id), new Date().toISOString(), new Date().toISOString(), q.id).run();
      linked++;
      if (missing.length) {
        await alertAdmin(env, `quote-missing:${q.id}`, `${epic.key} has no category for part of quote ${q.quote_key}`,
          `${q.quote_key} was quoted with ${missing.map((s) => DISCIPLINE_LABELS[s.discipline]).join(', ')}, but ${epic.key} still has no matching category after a week. The rest has been filled in.`);
      }
    } catch (err) {
      // Nothing is marked as done, so the whole hand-off is tried again next hour.
      await env.DB.prepare('UPDATE quotes SET handoff_error = ? WHERE id = ?').bind(err.message.slice(0, 300), q.id).run();
      await alertAdmin(env, `quote-handoff:${q.id}:${londonDate()}`, `Jira couldn't take the quoted figures for ${epic.key}`,
        `The hub tried to put the figures from ${q.quote_key} onto ${epic.key} and Jira refused: ${err.message.slice(0, 200)}\nIt tries again every hour, and the figures are safe in the hub.`);
    }
  }
  return { linked };
}

// ---------- Sharing a category's hours across its subtasks ----------

// The weights agreed with the teams, until finished jobs show how the time
// really divides. A subtask type not listed counts as 1.
export const STAGE_WEIGHTS = {
  hardware: { 'New Design': 2, 'New Purchase Order': 1, 'New Build': 2, 'New Configuration & Testing': 2, 'New Dispatch': 1 },
  software: { 'New Software Development': 3, 'New Download Phase': 1 },
  engineering: { 'New Order Site Visit': 1 },
  condor: { 'New Condor Development': 3, 'New Download Phase': 1 },
};
const LEARNED_MIN_JOBS = 10;       // finished categories needed per subtask type before data takes over
const SPLIT_WAIT_DAYS = 7;         // subtasks can arrive after the order
const SPLIT_RECHECK_DAYS = 14;     // late subtasks get a share for this long
const SPLIT_WRITES_PER_RUN = 15;        // with one search per category, a turn stays well inside 50 calls

// From finished jobs: the typical share of a category's time each subtask type takes.
export async function learnedShares(env, discipline) {
  const { results } = await env.DB.prepare(
    `SELECT s.stage_type, s.stage_share FROM completed_jobs s JOIN completed_jobs c ON c.issue_id = s.parent_id
      WHERE s.kind = 'stage' AND s.discipline = ? AND s.stage_type IS NOT NULL AND s.stage_share > 0
        AND c.kind = 'category' AND c.confidence = 'good'`
  ).bind(discipline).all();
  const by = new Map();
  for (const r of results) { if (!by.has(r.stage_type)) by.set(r.stage_type, []); by.get(r.stage_type).push(r.stage_share); }
  return new Map([...by].map(([type, shares]) => [type, { share: median(shares), jobs: shares.length }]));
}

// Shares out whole minutes so the subtasks add up to the category exactly.
export function splitMinutes(totalMinutes, weights) {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map((w) => (totalMinutes * w) / sum);
  const out = raw.map(Math.floor);
  let left = totalMinutes - out.reduce((a, m) => a + m, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

export function planSplit(discipline, subtasks, seconds, learned) {
  const types = subtasks.map((t) => t.type);
  const useData = types.length > 0 && types.every((t) => (learned.get(t)?.jobs || 0) >= LEARNED_MIN_JOBS);
  const fixed = STAGE_WEIGHTS[discipline] || {};
  const weights = types.map((t) => (useData ? learned.get(t).share : fixed[t] ?? 1));
  const minutes = splitMinutes(Math.round(seconds / 60), weights);
  return { method: useData ? 'data' : 'weights', subtasks: subtasks.map((t, i) => ({ ...t, minutes: minutes[i] })) };
}

async function subtasksOf(env, categoryKey) {
  const issues = await searchJql(env, `parent = ${categoryKey} ORDER BY created ASC`, ['issuetype', 'timeoriginalestimate', 'summary']);
  return issues.map((i) => ({ id: String(i.id), key: i.key, type: i.fields?.issuetype?.name || '', current: i.fields?.timeoriginalestimate ?? null }));
}

// Pending splits are written a few at a time; categories already split are
// rechecked once a day for a fortnight in case more subtasks have arrived.
export async function splitStep(env, { maxWrites = SPLIT_WRITES_PER_RUN } = {}) {
  const now = Date.now();
  const recheckFrom = new Date(now - SPLIT_RECHECK_DAYS * 86_400_000).toISOString();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const { results: due } = await env.DB.prepare(
    `SELECT * FROM quote_splits WHERE status = 'pending'
        OR (status = 'done' AND handed_off_at >= ? AND (checked_at IS NULL OR checked_at < ?)) ORDER BY handed_off_at LIMIT 6`
  ).bind(recheckFrom, dayAgo).all();
  if (!due.length) return { idle: true };
  let writes = 0;
  for (const row of due) {
    if (writes >= maxWrites) break;
    const subs = await subtasksOf(env, row.category_key);
    const stamp = new Date().toISOString();
    if (!subs.length) {
      const waited = now - Date.parse(row.handed_off_at) > SPLIT_WAIT_DAYS * 86_400_000;
      await env.DB.prepare('UPDATE quote_splits SET checked_at = ?, status = ? WHERE category_id = ?')
        .bind(stamp, waited ? 'done' : row.status, row.category_id).run();
      continue;
    }
    const previous = JSON.parse(row.subtasks || '[]');
    if (row.status === 'done') {
      const sameSet = previous.length === subs.length && subs.every((s) => previous.some((p) => p.id === s.id));
      // Someone has set their own figures: leave them be.
      const untouched = subs.every((s) => { const p = previous.find((x) => x.id === s.id); return !p || s.current === p.minutes * 60; });
      if (sameSet || !untouched) {
        await env.DB.prepare('UPDATE quote_splits SET checked_at = ? WHERE category_id = ?').bind(stamp, row.category_id).run();
        continue;
      }
    }
    const cat = await env.DB.prepare('SELECT discipline FROM quote_sections WHERE category_id = ?').bind(row.category_id).first();
    const plan = planSplit(cat?.discipline, subs, row.seconds, await learnedShares(env, cat?.discipline));
    let failed = null;
    for (const s of plan.subtasks) {
      if (s.current === s.minutes * 60) continue;
      if (writes >= maxWrites) { failed = 'carry on'; break; }
      try {
        await jira(env, `/rest/api/3/issue/${encodeURIComponent(s.key)}`, { method: 'PUT', body: JSON.stringify({ fields: { timetracking: { originalEstimate: `${s.minutes}m` } } }) });
        writes++;
      } catch (err) { failed = err.message.slice(0, 300); break; }
    }
    const finished = !failed;
    await env.DB.prepare('UPDATE quote_splits SET status = ?, method = ?, subtasks = ?, checked_at = ?, error = ? WHERE category_id = ?')
      .bind(finished ? 'done' : 'pending', plan.method, JSON.stringify(plan.subtasks.map(({ current, ...s }) => s)), stamp,
        failed === 'carry on' ? null : failed, row.category_id).run();
  }
  return { writes };
}

// After a quoted category finishes, its team lead is asked whether the counts were right.
export async function queueCountChecks(env) {
  const { results } = await env.DB.prepare(
    `SELECT c.issue_id, c.issue_key, c.team, s.quote_id, s.discipline, s.counts FROM completed_jobs c
       JOIN quotes q ON q.epic_key = c.epic_key
       JOIN quote_sections s ON s.quote_id = q.id AND s.discipline = c.discipline
       LEFT JOIN count_checks k ON k.category_id = c.issue_id
      WHERE c.kind = 'category' AND k.category_id IS NULL`
  ).all();
  const now = new Date().toISOString();
  for (const r of results) {
    await env.DB.prepare(
      'INSERT INTO count_checks (category_id, category_key, quote_id, discipline, team, quoted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
    ).bind(r.issue_id, r.issue_key, r.quote_id, r.discipline, r.team, r.counts || '{}', now).run();
  }
  return { queued: results.length };
}

export async function pendingCountChecks(env, viewer) {
  if (!viewer.isLead) return [];
  const { results } = await env.DB.prepare(
    `SELECT k.*, q.title, q.customer, q.quote_key FROM count_checks k JOIN quotes q ON q.id = k.quote_id WHERE k.status = 'pending' ORDER BY k.created_at`
  ).all();
  const cfg = await config(env);
  return results
    .filter((k) => forMe(viewer, k.team))
    .filter((k) => Object.keys(parse(k.quoted, {})).length)
    .map((k) => ({ ...k, quoted: parse(k.quoted, {}), labels: Object.fromEntries((cfg[k.discipline]?.counts || [])) }));
}

export async function checkCounts(env, viewer, input) {
  if (!viewer.isLead) throw new Error('Only team leads can check counts.');
  const k = await env.DB.prepare('SELECT * FROM count_checks WHERE category_id = ?').bind(String(input.categoryId)).first();
  if (!k || k.status !== 'pending') throw new Error('That has already been checked.');
  const quoted = parse(k.quoted, {});
  let actual = quoted;
  if (input.counts) {
    actual = {};
    for (const key of Object.keys(quoted)) { const v = num(input.counts[key], 0, 100000); actual[key] = v ?? quoted[key]; }
  }
  const status = input.skip ? 'skipped' : 'done';
  await env.DB.prepare('UPDATE count_checks SET actual = ?, status = ?, checked_by = ?, checked_at = ? WHERE category_id = ?')
    .bind(status === 'done' ? JSON.stringify(actual) : null, status, viewer.email, new Date().toISOString(), k.category_id).run();
  return { ok: true };
}

export async function hourly(env) {
  const { results } = await env.DB.prepare('SELECT id FROM quotes WHERE quote_key IS NULL LIMIT 10').all();
  for (const q of results) await retryJira(env, q.id);
  const { results: unsynced } = await env.DB.prepare('SELECT * FROM quotes WHERE description_synced = 0 AND quote_key IS NOT NULL LIMIT 10').all();
  for (const q of unsynced) await syncDescription(env, q);
  const handed = await handOff(env);
  const checks = await queueCountChecks(env);
  return { ...handed, ...checks };
}

export async function people(env) {
  const { results } = await env.DB.prepare("SELECT account_id, name, team FROM employees WHERE active = 1 ORDER BY name").all();
  return results;
}
