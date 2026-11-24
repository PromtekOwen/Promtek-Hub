// Job documentation. Each category on a job has the documents it needs, chosen by a team lead
// from the hub's list (each kind of category has its usual set ticked to start with). The
// engineers on the job fill them in as they go, in small pieces, and the hub lays each one out
// as a Promtek document and puts it on the category in Jira, from where it's filed in the job's
// Drive folder. Time logged against a document goes to the category in Tempo, as any other
// time on it does (so it counts towards the job's hours, and its ELO), and earns more XP.
// A category can't be moved to Done from the hub while its documents are outstanding.
import { LIBRARY, HEADER_FIELDS, customTemplate, cleanTemplate, fieldsOf, DISCIPLINE_NAMES, FIELD_KINDS } from './docs-library.js';
import { getState, setState, londonDate, raiseAlert, recalcIssues } from './sync.js';
import { jira, jiraFetch, getIssue, searchJql } from './jira.js';
import { record } from './audit.js';
import { jpegSize } from './coshh.js';
import { canTile, leadsOfTeam } from './permissions.js';
import { scopeFor } from './country.js';

const MAX_PHOTO_BYTES = 900 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MULTIPLIER = 1.5;
const DISCIPLINES = Object.keys(DISCIPLINE_NAMES);
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const clip = (v, n) => String(v ?? '').slice(0, n);
const nameOf = (viewer) => viewer?.employee?.name || viewer?.name || viewer?.email || 'Someone';
const initialsOf = (name) => String(name || '').split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 3);
const marks = (n) => Array(n).fill('?').join(',');
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (b64) => { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

// ---------- who can do what ----------

const canSee = (viewer) => canTile(viewer, 'jobs');
function mustSee(viewer) { if (!canSee(viewer)) throw refuse('Jobs isn\'t open to you.', 403); }
// The kinds of document, which are usual on each kind of category, and new ones: the Jobs settings cog.
export const canLibrary = (viewer) => Boolean(viewer?.isAdmin || viewer?.can?.jobDocs);
// Which documents a category needs: team leads, Management and admins.
export const canNeeds = (viewer) => Boolean(viewer?.isAdmin || viewer?.isLead || viewer?.groups?.includes('management') || viewer?.groups?.includes('lead'));

// ---------- the list of documents ----------

// The built-in documents with any changes made to them, then those made up in the hub.
export async function library(env, { all = false } = {}) {
  const { results } = await env.DB.prepare('SELECT * FROM doc_types').all().catch(() => ({ results: [] }));
  const saved = new Map(results.map((r) => [r.id, r]));
  const out = LIBRARY.map((t) => {
    const s = saved.get(t.id);
    return {
      id: t.id, name: s?.name || t.name, group: s?.grp || t.group, audience: s?.audience || t.audience,
      disciplines: s?.disciplines ? json(s.disciplines, t.disciplines) : t.disciplines,
      multiplier: s?.multiplier ?? DEFAULT_MULTIPLIER, active: s ? Boolean(s.active) && !s.deleted : true, deleted: Boolean(s?.deleted), custom: false,
      template: { title: t.title, intro: t.intro, header: t.header || [], sections: t.sections, landscape: Boolean(t.landscape), spreadsheet: Boolean(t.spreadsheet) },
    };
  });
  for (const s of results.filter((r) => r.custom)) {
    const sections = json(s.sections, []);
    const built = json(s.template, null);
    const template = built?.sections?.length ? built : { ...customTemplate({ name: s.name, intro: s.intro, sections }), landscape: false, spreadsheet: false };
    out.push({ id: s.id, name: s.name, group: s.grp || 'Other', audience: s.audience || 'customer', disciplines: json(s.disciplines, []),
      multiplier: s.multiplier ?? DEFAULT_MULTIPLIER, active: Boolean(s.active) && !s.deleted, deleted: Boolean(s.deleted), custom: true, sectionNames: template.sections.map((x) => x.title), template });
  }
  // Deleted ones are only kept for documents already written with them.
  return all ? out : out.filter((t) => t.active);
}

// The list as admins and Management see it, with how long each kind takes, for quoting.
export async function libraryView(env, viewer) {
  mustSee(viewer);
  const types = await library(env, { all: true });
  const { results: time } = await env.DB.prepare(
    `SELECT doc_type, SUM(seconds) AS seconds, COUNT(DISTINCT doc_id) AS docs FROM doc_worklogs GROUP BY doc_type`
  ).all().catch(() => ({ results: [] }));
  const { results: done } = await env.DB.prepare("SELECT doc_type, COUNT(*) AS n FROM doc_items WHERE version > 0 GROUP BY doc_type").all().catch(() => ({ results: [] }));
  const { results: onJobs } = await env.DB.prepare('SELECT doc_type, COUNT(*) AS n FROM doc_needs GROUP BY doc_type').all().catch(() => ({ results: [] }));
  const jobs = new Map(onJobs.map((r) => [r.doc_type, r.n]));
  const t = new Map(time.map((r) => [r.doc_type, r]));
  const d = new Map(done.map((r) => [r.doc_type, r.n]));
  return {
    deleted: types.filter((x) => x.deleted).map((x) => ({ id: x.id, name: x.name, custom: x.custom })),
    types: types.filter((x) => !x.deleted).map((x) => ({ id: x.id, name: x.name, group: x.group, audience: x.audience, disciplines: x.disciplines, multiplier: x.multiplier, active: x.active, custom: x.custom,
      sections: x.custom ? x.sectionNames : x.template.sections.map((s) => s.title), finished: d.get(x.id) || 0, onJobs: jobs.get(x.id) || 0,
      avgSeconds: t.get(x.id)?.docs ? Math.round(t.get(x.id).seconds / t.get(x.id).docs) : null })),
    disciplines: DISCIPLINE_NAMES, canEdit: canLibrary(viewer), builder: BUILDER, from: await getState(env, 'docs_from'),
  };
}

const noLibrary = () => refuse('Only admins, team leads, Management and developers can change the kinds of job document.', 403);

async function upsertType(env, viewer, t, now) {
  await env.DB.prepare(`INSERT INTO doc_types (id, name, grp, audience, disciplines, multiplier, active, deleted, custom, intro, sections, template, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, grp = excluded.grp, audience = excluded.audience, disciplines = excluded.disciplines,
      multiplier = excluded.multiplier, active = excluded.active, deleted = excluded.deleted, template = COALESCE(excluded.template, doc_types.template),
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(t.id, t.name, t.group, t.audience, JSON.stringify(t.disciplines), t.multiplier, t.active ? 1 : 0, t.deleted ? 1 : 0, t.custom ? 1 : 0,
      t.custom && t.template ? JSON.stringify(t.template) : null, now, nameOf(viewer)).run();
}

// One kind of document, everything about it, for the builder.
export async function typeDef(env, viewer, id) {
  if (!canLibrary(viewer)) throw noLibrary();
  const t = (await library(env, { all: true })).find((x) => x.id === String(id));
  if (!t) throw refuse('That kind of document has gone.', 404);
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM doc_items WHERE doc_type = ?').bind(t.id).first();
  return { id: t.id, name: t.name, group: t.group, audience: t.audience, disciplines: t.disciplines, multiplier: t.multiplier, active: t.active, deleted: t.deleted, custom: t.custom, used: n, template: t.template };
}

// A kind of document: its name, who it's for, where it's usual and its XP rate; for one made
// up in the hub, its sections and fields as well. A built-in one's fields stay as they are
// (copy it to change them).
export async function saveType(env, viewer, input) {
  if (!canLibrary(viewer)) throw noLibrary();
  const types = await library(env, { all: true });
  let id = String(input.id || '');
  const existing = types.find((t) => t.id === id);
  const name = clip(input.name, 80).trim();
  if (!name) throw refuse('Give the document a name.');
  if (types.some((t) => t.id !== id && !t.deleted && t.name.toLowerCase() === name.toLowerCase())) throw refuse(`There's already a document called ${name}.`);
  if (!existing) {
    id = `c-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'doc'}`;
    if (types.some((t) => t.id === id)) id = `${id}-${Date.now().toString(36)}`;
  }
  const custom = existing ? existing.custom : true;
  const template = custom && input.template ? cleanTemplate(input.template, name) : null;
  if (custom && !existing && !template) throw refuse('Add at least one section with a field in it.');
  await upsertType(env, viewer, {
    id, name, custom, template,
    group: clip(input.group || existing?.group || 'Other', 40).trim() || 'Other',
    audience: input.audience === 'internal' ? 'internal' : input.audience === 'customer' ? 'customer' : existing?.audience || 'customer',
    disciplines: DISCIPLINES.filter((d) => (input.disciplines ?? existing?.disciplines ?? []).includes(d)),
    multiplier: Math.min(3, Math.max(1, Number(input.multiplier ?? existing?.multiplier) || DEFAULT_MULTIPLIER)),
    active: input.active === undefined ? existing?.active ?? true : Boolean(input.active),
    deleted: Boolean(existing?.deleted),
  }, new Date().toISOString());
  await record(env, viewer, { area: 'Jobs', action: existing ? 'Changed a kind of job document' : 'Added a kind of job document', subjectType: 'doc-type', subjectId: id, label: name }).catch(() => {});
  return { ok: true, id };
}

// The table in the Jobs settings: which are in use, and usual on each kind of category.
export async function saveUsual(env, viewer, { types }) {
  if (!canLibrary(viewer)) throw noLibrary();
  const all = await library(env, { all: true });
  const now = new Date().toISOString();
  const changes = [];
  for (const row of Array.isArray(types) ? types : []) {
    const t = all.find((x) => x.id === String(row.id));
    if (!t || t.deleted) continue;
    const next = { ...t, template: null, disciplines: DISCIPLINES.filter((d) => (row.disciplines || []).includes(d)), active: Boolean(row.active),
      multiplier: Math.min(3, Math.max(1, Number(row.multiplier) || t.multiplier)) };
    if (JSON.stringify([next.disciplines, next.active, next.multiplier]) === JSON.stringify([t.disciplines, t.active, t.multiplier])) continue;
    await upsertType(env, viewer, next, now);
    changes.push({ label: t.name, before: `${t.active ? 'In use' : 'Not in use'}, usual on ${t.disciplines.map((d) => DISCIPLINE_NAMES[d]).join(', ') || 'none'}, ${t.multiplier}x XP`,
      after: `${next.active ? 'In use' : 'Not in use'}, usual on ${next.disciplines.map((d) => DISCIPLINE_NAMES[d]).join(', ') || 'none'}, ${next.multiplier}x XP` });
  }
  if (changes.length) await record(env, viewer, { area: 'Jobs', action: 'Changed which job documents are usual', subjectType: 'setting', subjectId: 'doc-types', label: 'Job documents', changes }).catch(() => {});
  return { ok: true, changed: changes.length };
}

// Deleted: off the list everywhere, and no longer needed on any job, so it holds nothing back.
// One made up in the hub and never started goes altogether. Any other (the hub's own, or one
// already written on a job) is kept out of sight, so documents written with it still open and
// lay out, and it can be brought back.
export async function removeType(env, viewer, { id }) {
  if (!canLibrary(viewer)) throw noLibrary();
  const t = (await library(env, { all: true })).find((x) => x.id === String(id));
  if (!t) return { ok: true };
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM doc_items WHERE doc_type = ?').bind(t.id).first();
  const { needed } = await env.DB.prepare('SELECT COUNT(*) AS needed FROM doc_needs WHERE doc_type = ?').bind(t.id).first();
  if (t.custom && !n) {
    await env.DB.batch([env.DB.prepare('DELETE FROM doc_types WHERE id = ?').bind(t.id), env.DB.prepare('DELETE FROM doc_needs WHERE doc_type = ?').bind(t.id)]);
  } else {
    await upsertType(env, viewer, { ...t, template: null, active: false, deleted: true }, new Date().toISOString());
    await env.DB.prepare('DELETE FROM doc_needs WHERE doc_type = ?').bind(t.id).run();
  }
  await record(env, viewer, { area: 'Jobs', action: 'Deleted a kind of job document', subjectType: 'doc-type', subjectId: t.id, label: t.name,
    changes: needed ? [{ label: 'Jobs it was needed on', before: String(needed), after: '0' }] : [] }).catch(() => {});
  return { ok: true, gone: t.custom && !n, written: n, needed };
}

export async function restoreType(env, viewer, { id }) {
  if (!canLibrary(viewer)) throw noLibrary();
  const t = (await library(env, { all: true })).find((x) => x.id === String(id));
  if (!t?.deleted) return { ok: true };
  await upsertType(env, viewer, { ...t, template: null, active: true, deleted: false }, new Date().toISOString());
  await record(env, viewer, { area: 'Jobs', action: 'Brought back a kind of job document', subjectType: 'doc-type', subjectId: t.id, label: t.name }).catch(() => {});
  return { ok: true };
}

// What a document laid out in the builder will look like, before anyone fills it in.
export async function previewType(env, viewer, { name, template }) {
  if (!canLibrary(viewer)) throw noLibrary();
  const t = cleanTemplate(template, clip(name, 80) || 'New document');
  const { buildDocPdf } = await import('./docs-pdf.js');
  const bytes = await buildDocPdf({ type: { id: 'preview', name: name || t.title, template: t }, header: {}, data: {}, photos: [], files: [], draft: false, blank: true,
    version: 1, versions: [], category: { key: 'ABC-2', epicKey: 'ABC-1', summary: '', order: 'The order', customer: 'The customer' }, engineers: [], finished: [], date: londonDate() });
  return { bytes, filename: `${clip(name, 80) || 'New document'} (template).pdf` };
}

export const BUILDER = { kinds: FIELD_KINDS, header: HEADER_FIELDS, disciplines: DISCIPLINE_NAMES };

// ---------- the categories, from the Jobs tile ----------

// Every category the Jobs tile reads is noted here, so documents can be chased once it's
// finished and gone from the list. Categories made from the day this started have their
// usual documents ticked; older ones only have what a lead ticks.
export async function noteCategories(env, cats) {
  if (!cats?.length) return;
  let from = await getState(env, 'docs_from').catch(() => null);
  if (!from) { from = londonDate(); await setState(env, 'docs_from', from).catch(() => {}); }
  const ids = cats.map((c) => String(c.issue_id));
  const known = new Map();
  for (const part of chunk(ids, 80)) {
    const { results } = await env.DB.prepare(`SELECT * FROM doc_categories WHERE category_id IN (${marks(part.length)})`).bind(...part).all();
    for (const r of results) known.set(r.category_id, r);
  }
  const types = await library(env);
  const now = new Date().toISOString();
  const stmts = [];
  for (const c of cats) {
    const id = String(c.issue_id);
    const created = String(c.created || '').slice(0, 10) || null;
    const had = known.get(id);
    const row = [c.issue_key, c.parent_id || c.epic_id || null, c.epic_key || null, c.summary || '', c.order_summary || '', c.project_name || '', c.discipline || null,
      c.team || null, c.status || null, c.done ? 1 : 0, c.assignee || null, JSON.stringify(c.staff || [])];
    // Only what's changed is written, as this runs every hour over every open job.
    const same = had && JSON.stringify([had.category_key, had.epic_id, had.epic_key, had.summary, had.order_summary, had.customer, had.discipline, had.team, had.status, had.done, had.assignee, had.staff])
      === JSON.stringify(row) && (had.created || !created);
    if (!same) stmts.push(env.DB.prepare(`INSERT INTO doc_categories (category_id, category_key, epic_id, epic_key, summary, order_summary, customer, discipline, team, status, done, assignee, staff, created, set_up, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(category_id) DO UPDATE SET category_key = excluded.category_key, epic_id = excluded.epic_id, epic_key = excluded.epic_key, summary = excluded.summary,
        order_summary = excluded.order_summary, customer = excluded.customer, discipline = excluded.discipline, team = excluded.team, status = excluded.status,
        done = excluded.done, assignee = excluded.assignee, staff = excluded.staff, created = COALESCE(excluded.created, doc_categories.created), seen_at = excluded.seen_at`)
      .bind(id, ...row, created, now));
    if (!had?.set_up && created && created >= from) {
      for (const t of types.filter((x) => x.disciplines.includes(c.discipline))) {
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO doc_needs (category_id, doc_type, set_by, set_at) VALUES (?, ?, ?, ?)').bind(id, t.id, 'Usual for the category', now));
      }
      stmts.push(env.DB.prepare('UPDATE doc_categories SET set_up = 1 WHERE category_id = ?').bind(id));
    }
  }
  for (const part of chunk(stmts, 80)) await env.DB.batch(part);
}

// Each category's documents in a line: how many it needs and how many are finished.
export async function summaryFor(env, categoryIds) {
  const map = new Map();
  const ids = [...new Set(categoryIds.map(String))];
  for (const part of chunk(ids, 80)) {
    const { results } = await env.DB.prepare(
      `SELECT n.category_id, n.doc_type, i.status, i.version FROM doc_needs n LEFT JOIN doc_items i ON i.category_id = n.category_id AND i.doc_type = n.doc_type
        WHERE n.category_id IN (${marks(part.length)})`
    ).bind(...part).all().catch(() => ({ results: [] }));
    for (const r of results) {
      const s = map.get(r.category_id) || { needed: 0, done: 0, started: 0 };
      s.needed++;
      if (r.version > 0) s.done++; else if (r.status) s.started++;
      map.set(r.category_id, s);
    }
  }
  return map;
}

async function categoryRow(env, viewer, categoryId) {
  const c = await env.DB.prepare('SELECT * FROM doc_categories WHERE category_id = ? OR category_key = ?').bind(String(categoryId), String(categoryId).toUpperCase()).first();
  if (!c) throw refuse('That category isn\'t one the hub has read yet. Open it in Jobs first.', 404);
  if (viewer) {
    const country = await scopeFor(env, viewer, 'jobs');
    if (!country.sees({ project: c.epic_key || c.category_key, keys: [c.epic_key, c.category_key] })) throw refuse('That job belongs to the other country.', 403);
  }
  return c;
}

// ---------- one category's documents ----------

export async function forCategory(env, viewer, categoryId) {
  mustSee(viewer);
  const c = await categoryRow(env, viewer, categoryId);
  const types = await library(env, { all: true });
  const byId = new Map(types.map((t) => [t.id, t]));
  const { results: needs } = await env.DB.prepare('SELECT * FROM doc_needs WHERE category_id = ?').bind(c.category_id).all();
  const { results: items } = await env.DB.prepare('SELECT id, doc_type, status, version, updated_at, updated_by, finished_at, finished_by, file_name, error FROM doc_items WHERE category_id = ?').bind(c.category_id).all();
  const { results: time } = await env.DB.prepare('SELECT doc_id, SUM(seconds) AS seconds FROM doc_worklogs WHERE category_id = ? GROUP BY doc_id').bind(c.category_id).all();
  const secs = new Map(time.map((r) => [r.doc_id, r.seconds]));
  const itemBy = new Map(items.map((i) => [i.doc_type, i]));
  const need = new Set(needs.map((n) => n.doc_type));
  const docs = [...need, ...items.map((i) => i.doc_type).filter((t) => !need.has(t))].map((id) => {
    const t = byId.get(id);
    const i = itemBy.get(id);
    return { type: id, name: t?.name || id, group: t?.group || 'Other', audience: t?.audience || 'customer', needed: need.has(id), multiplier: t?.multiplier ?? DEFAULT_MULTIPLIER,
      item: i ? { id: i.id, status: i.status, version: i.version, updatedAt: i.updated_at, updatedBy: i.updated_by, finishedAt: i.finished_at, finishedBy: i.finished_by, file: i.file_name, error: i.error, seconds: secs.get(i.id) || 0 } : null };
  });
  return {
    category: { id: c.category_id, key: c.category_key, summary: c.summary, epicKey: c.epic_key, order: c.order_summary, customer: c.customer, discipline: c.discipline,
      disciplineName: DISCIPLINE_NAMES[c.discipline] || null, done: Boolean(c.done), setUp: Boolean(c.set_up) },
    docs, library: types.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, group: t.group, audience: t.audience, usual: t.disciplines.includes(c.discipline) })),
    canNeeds: canNeeds(viewer),
  };
}

export async function setNeeds(env, viewer, { categoryId, types }) {
  mustSee(viewer);
  if (!canNeeds(viewer)) throw refuse('Team leads choose which documents a job needs.', 403);
  const c = await categoryRow(env, viewer, categoryId);
  const known = new Set((await library(env, { all: true })).map((t) => t.id));
  const want = [...new Set((types || []).map(String))].filter((t) => known.has(t));
  const { results: before } = await env.DB.prepare('SELECT doc_type FROM doc_needs WHERE category_id = ?').bind(c.category_id).all();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM doc_needs WHERE category_id = ?').bind(c.category_id),
    ...want.map((t) => env.DB.prepare('INSERT INTO doc_needs (category_id, doc_type, set_by, set_at) VALUES (?, ?, ?, ?)').bind(c.category_id, t, nameOf(viewer), now)),
    env.DB.prepare('UPDATE doc_categories SET set_up = 1 WHERE category_id = ?').bind(c.category_id),
  ]);
  const names = new Map((await library(env, { all: true })).map((t) => [t.id, t.name]));
  const say = (list) => list.map((t) => names.get(t) || t).join(', ') || 'None';
  await record(env, viewer, { area: 'Jobs', action: 'Chose the documents a job needs', subjectType: 'jira', subjectId: c.category_key, label: `${c.category_key} ${c.summary}`.trim(),
    changes: [{ label: 'Documents', before: say(before.map((b) => b.doc_type)), after: say(want) }] }).catch(() => {});
  return forCategory(env, viewer, c.category_id);
}

// ---------- one document ----------

async function docRow(env, id) {
  const d = await env.DB.prepare('SELECT * FROM doc_items WHERE id = ?').bind(Number(id)).first();
  if (!d) throw refuse('That document has gone.', 404);
  return d;
}

// The people on a category: its assignee, Promtek Staff Involved, and anyone who has logged time on it.
async function engineersOf(env, c) {
  const ids = new Set([c.assignee, ...json(c.staff, [])].filter(Boolean));
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT l.account_id FROM xp_ledger l LEFT JOIN jobs j ON j.issue_id = l.issue_id WHERE l.issue_id = ? OR j.parent_id = ?`
  ).bind(c.category_id, c.category_id).all().catch(() => ({ results: [] }));
  for (const r of results) ids.add(r.account_id);
  if (!ids.size) return [];
  const { results: emps } = await env.DB.prepare(`SELECT account_id, name FROM employees WHERE account_id IN (${marks(ids.size)})`).bind(...ids).all();
  return emps.map((e) => ({ id: e.account_id, name: e.name }));
}

// What a new document starts with: the customer's site address, if the hub has one.
async function startHeader(env, c, t) {
  const header = {};
  if ((t.template.header || []).includes('site')) {
    const project = String(c.epic_key || c.category_key).split('-')[0];
    const site = await env.DB.prepare('SELECT address FROM customer_sites WHERE project_key = ? AND hidden = 0 ORDER BY id LIMIT 1').bind(project).first().catch(() => null);
    if (site?.address) header.site = site.address;
  }
  return header;
}

function startData(t) {
  const data = {};
  for (const f of fieldsOf(t.template)) {
    if (f.start) data[f.id] = f.start;
    if (f.type === 'tests' && f.rows) data[f.id] = f.rows.map((action) => ({ action }));
    if (f.type === 'table' && f.rows) data[f.id] = f.rows.map((r) => ({ ...r }));
  }
  return data;
}

export async function open(env, viewer, { categoryId, type, id }) {
  mustSee(viewer);
  let d = id ? await docRow(env, id) : null;
  const c = await categoryRow(env, viewer, d ? d.category_id : categoryId);
  const types = await library(env, { all: true });
  const t = types.find((x) => x.id === (d ? d.doc_type : type));
  if (!t) throw refuse('That isn\'t a document in the list.');
  if (!d) {
    d = await env.DB.prepare('SELECT * FROM doc_items WHERE category_id = ? AND doc_type = ?').bind(c.category_id, t.id).first();
    if (!d) {
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT OR IGNORE INTO doc_items (category_id, doc_type, header, data, status, version, versions, started_by, started_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, 'draft', 0, '[]', ?, ?, ?, ?)`)
        .bind(c.category_id, t.id, JSON.stringify(await startHeader(env, c, t)), JSON.stringify(startData(t)), nameOf(viewer), now, now, nameOf(viewer)).run();
      d = await env.DB.prepare('SELECT * FROM doc_items WHERE category_id = ? AND doc_type = ?').bind(c.category_id, t.id).first();
    }
  }
  return docView(env, viewer, d, c, t);
}

async function docView(env, viewer, d, c, t) {
  const { results: photos } = await env.DB.prepare('SELECT id, field, width, height, caption FROM doc_photos WHERE doc_id = ? ORDER BY id').bind(d.id).all();
  const { results: files } = await env.DB.prepare('SELECT id, field, name, size, created_at, created_by FROM doc_files WHERE doc_id = ? ORDER BY id').bind(d.id).all();
  const { results: time } = await env.DB.prepare('SELECT SUM(seconds) AS seconds FROM doc_worklogs WHERE doc_id = ?').bind(d.id).all();
  return {
    doc: { id: d.id, type: t.id, name: t.name, audience: t.audience, status: d.status, version: d.version, rev: d.rev || 0, startedBy: d.started_by,
      canDelete: !d.version && (d.started_by === nameOf(viewer) || canNeeds(viewer)), versions: json(d.versions, []), header: json(d.header, {}), data: json(d.data, {}),
      updatedAt: d.updated_at, updatedBy: d.updated_by, finishedAt: d.finished_at, finishedBy: d.finished_by, file: d.file_name, error: d.error, seconds: time[0]?.seconds || 0, multiplier: t.multiplier },
    template: t.template, headerFields: Object.fromEntries((t.template.header || []).map((h) => [h, HEADER_FIELDS[h]])),
    category: { id: c.category_id, key: c.category_key, summary: c.summary, epicKey: c.epic_key, order: c.order_summary, customer: c.customer, done: Boolean(c.done) },
    photos, files, engineers: await engineersOf(env, c), finished: await finishedOnOrder(env, c), drive: await driveState(env, d),
  };
}

// Whether the issued version is in the job's Drive folder yet.
async function driveState(env, d) {
  const ids = json(d.attachments, []);
  if (!ids.length) return null;
  const F = await import('./drive-filing.js');
  const map = await F.filedFor(env, ids).catch(() => new Map());
  const rows = ids.map((id) => map.get(String(id))).filter(Boolean);
  if (!rows.length) return null;
  return rows.map((r) => ({ name: r.filename, status: r.status, link: r.drive_id ? `https://drive.google.com/file/d/${r.drive_id}/view` : null, error: r.error }));
}

// The documents finished on the same order, for a handover certificate.
async function finishedOnOrder(env, c) {
  if (!c.epic_key) return [];
  const names = new Map((await library(env, { all: true })).map((t) => [t.id, t.name]));
  const { results } = await env.DB.prepare(
    `SELECT i.doc_type, i.version, i.finished_at, c.category_key FROM doc_items i JOIN doc_categories c ON c.category_id = i.category_id
      WHERE c.epic_key = ? AND i.version > 0 ORDER BY i.finished_at`
  ).bind(c.epic_key).all();
  return results.map((r) => ({ name: names.get(r.doc_type) || r.doc_type, version: r.version, date: String(r.finished_at || '').slice(0, 10), category: r.category_key }));
}

// Sizes kept sensible, so nothing typed or pasted can swamp the hub.
function cleanValue(v, depth = 0) {
  if (v == null) return null;
  // A drawn signature is a small picture; anything else typed is kept to a sensible length.
  if (typeof v === 'string') return /^data:image\/jpeg;base64,/.test(v) ? v.slice(0, 150000) : v.slice(0, 20000);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth > 4) return null;
  if (Array.isArray(v)) return v.slice(0, 5000).map((x) => cleanValue(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 60).map(([k, x]) => [clip(k, 60), cleanValue(x, depth + 1)]));
  return null;
}

// Everyone on the job works on the same document at once. Each change is sent as the one
// answer (or the one list) that changed, applied to the document as it stands, and numbered,
// so everyone else's screen can pick up what's changed since it last looked.
const SAFE_KEY = /^[A-Za-z0-9_]{1,60}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  if (!keys.length || keys.length > 7 || keys.some((k) => !SAFE_KEY.test(k) || BAD_KEYS.has(k))) return false;
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(o) && /^\d+$/.test(last) && Number(last) > 5000) return false;
  o[last] = value;
  return true;
}

export async function save(env, viewer, { id, session = null, patches = null, header, data }) {
  mustSee(viewer);
  const d0 = await docRow(env, id);
  await categoryRow(env, viewer, d0.category_id);
  // The whole document at once, as the hub sent it before (kept for any screen still open on the old page).
  const list = Array.isArray(patches) ? patches.slice(0, 500)
    : [...Object.entries(header || {}).map(([k, v]) => ({ path: `h:${k}`, value: v })), ...Object.entries(data || {}).map(([k, v]) => ({ path: k, value: v }))];
  if (!list.length) return { ok: true, rev: d0.rev || 0 };
  for (let attempt = 0; attempt < 5; attempt++) {
    const d = attempt ? await docRow(env, id) : d0;
    const h = json(d.header, {});
    const body = json(d.data, {});
    const applied = [];
    for (const p of list) {
      const value = cleanValue(p?.value);
      const path = String(p?.path || '');
      if (path.startsWith('h:')) {
        const k = path.slice(2);
        if (!Object.hasOwn(HEADER_FIELDS, k)) continue;
        h[k] = typeof value === 'string' ? value : value == null ? '' : String(value);
      } else if (!setPath(body, path, value)) continue;
      applied.push({ path, value });
    }
    if (!applied.length) return { ok: true, rev: d.rev || 0 };
    const text = JSON.stringify(body);
    if (text.length > 1_500_000) throw refuse('That document has grown too big to keep. Split the longest list into a document of its own.');
    const now = new Date().toISOString();
    const rev = (d.rev || 0) + 1;
    const res = await env.DB.prepare('UPDATE doc_items SET header = ?, data = ?, rev = ?, updated_at = ?, updated_by = ? WHERE id = ? AND rev = ?')
      .bind(JSON.stringify(h), text, rev, now, nameOf(viewer), d.id, d.rev || 0).run();
    if (!res.meta?.changes) continue;
    await env.DB.batch(applied.map((p) => env.DB.prepare('INSERT INTO doc_edits (doc_id, rev, session, path, value, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(d.id, rev, clip(session, 40) || null, p.path, JSON.stringify(p.value), now)));
    if (rev % 25 === 0) await env.DB.prepare('DELETE FROM doc_edits WHERE doc_id = ? AND rev <= ?').bind(d.id, rev - 300).run();
    return { ok: true, rev, updatedAt: now };
  }
  throw refuse('Lots of people are changing this at once. Try again in a moment.', 409);
}

// What's changed since this screen last looked, and who else has the document open.
export async function changes(env, viewer, { id, since, session, field }) {
  mustSee(viewer);
  const d = await docRow(env, id);
  await categoryRow(env, viewer, d.category_id);
  const now = new Date();
  if (viewer.accountId) {
    await env.DB.prepare(`INSERT INTO doc_presence (doc_id, account_id, name, session, field, seen_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id, account_id) DO UPDATE SET name = excluded.name, session = excluded.session, field = excluded.field, seen_at = excluded.seen_at`)
      .bind(d.id, viewer.accountId, nameOf(viewer), clip(session, 40) || null, clip(field, 200) || null, now.toISOString()).run();
  }
  const { results: people } = await env.DB.prepare('SELECT account_id, name, field FROM doc_presence WHERE doc_id = ? AND seen_at >= ? AND account_id != ?')
    .bind(d.id, new Date(now - 30_000).toISOString(), viewer.accountId || '').all();
  const out = { rev: d.rev || 0, status: d.status, version: d.version, updatedBy: d.updated_by, people: people.map((p) => ({ name: p.name, field: p.field })) };
  const from = Number(since) || 0;
  if (out.rev > from) {
    const { results } = await env.DB.prepare('SELECT rev, session, path, value FROM doc_edits WHERE doc_id = ? AND rev > ? ORDER BY id').bind(d.id, from).all();
    const revs = new Set(results.map((r) => r.rev));
    // Too far behind (or the changes have been tidied away): the whole document instead.
    if (revs.size < out.rev - from) { out.full = { header: json(d.header, {}), data: json(d.data, {}) }; }
    else out.edits = results.map((r) => ({ session: r.session, path: r.path, value: json(r.value, null) }));
  }
  const { results: photos } = await env.DB.prepare('SELECT id, field, width, height, caption FROM doc_photos WHERE doc_id = ? ORDER BY id').bind(d.id).all();
  const { results: files } = await env.DB.prepare('SELECT id, field, name, size, created_at, created_by FROM doc_files WHERE doc_id = ? ORDER BY id').bind(d.id).all();
  return { ...out, photos, files };
}

// A document that's never been issued, deleted: by whoever started it, or a team lead.
export async function removeDoc(env, viewer, { id }) {
  mustSee(viewer);
  const d = await docRow(env, id);
  const c = await categoryRow(env, viewer, d.category_id);
  if (d.version) throw refuse('It has been issued, so it stays. Change it and issue the next version instead.');
  if (d.started_by !== nameOf(viewer) && !canNeeds(viewer)) throw refuse('Only whoever started it, or a team lead, can delete it.', 403);
  const t = (await library(env, { all: true })).find((x) => x.id === d.doc_type);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM doc_photos WHERE doc_id = ?').bind(d.id),
    env.DB.prepare('DELETE FROM doc_files WHERE doc_id = ?').bind(d.id),
    env.DB.prepare('DELETE FROM doc_edits WHERE doc_id = ?').bind(d.id),
    env.DB.prepare('DELETE FROM doc_presence WHERE doc_id = ?').bind(d.id),
    env.DB.prepare('DELETE FROM doc_items WHERE id = ?').bind(d.id),
  ]);
  await record(env, viewer, { area: 'Jobs', action: 'Deleted a draft document', subjectType: 'jira', subjectId: c.category_key, label: `${c.category_key}: ${t?.name || d.doc_type}` }).catch(() => {});
  return { ok: true, categoryId: c.category_id };
}

// ---------- pictures and files ----------

export async function addPhoto(env, viewer, { id, field, caption }, request) {
  mustSee(viewer);
  const d = await docRow(env, id);
  await categoryRow(env, viewer, d.category_id);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw refuse('That picture was empty.');
  if (bytes.length > MAX_PHOTO_BYTES) throw refuse('That picture is too big.');
  const size = jpegSize(bytes);
  if (!size) throw refuse('Pictures need to be JPEG.');
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM doc_photos WHERE doc_id = ?').bind(d.id).first();
  if (n >= 150) throw refuse('That document has as many pictures as it can hold.');
  const res = await env.DB.prepare('INSERT INTO doc_photos (doc_id, field, data, width, height, caption, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(d.id, clip(field, 120), toBase64(bytes), size.width, size.height, clip(caption, 300) || null, new Date().toISOString(), nameOf(viewer)).run();
  return { id: res.meta.last_row_id, field, width: size.width, height: size.height, caption: caption || null };
}

export async function photo(env, viewer, photoId) {
  mustSee(viewer);
  const p = await env.DB.prepare('SELECT doc_id, data FROM doc_photos WHERE id = ?').bind(Number(photoId)).first();
  if (!p) throw refuse('That picture has gone.', 404);
  const d = await docRow(env, p.doc_id);
  await categoryRow(env, viewer, d.category_id);
  return fromBase64(p.data);
}

export async function photoChange(env, viewer, { photoId, caption, remove }) {
  mustSee(viewer);
  const p = await env.DB.prepare('SELECT doc_id FROM doc_photos WHERE id = ?').bind(Number(photoId)).first();
  if (!p) return { ok: true };
  const d = await docRow(env, p.doc_id);
  await categoryRow(env, viewer, d.category_id);
  if (remove) await env.DB.prepare('DELETE FROM doc_photos WHERE id = ?').bind(Number(photoId)).run();
  else await env.DB.prepare('UPDATE doc_photos SET caption = ? WHERE id = ?').bind(clip(caption, 300) || null, Number(photoId)).run();
  return { ok: true };
}

async function attach(env, issueKey, filename, bytes, type) {
  const body = new FormData();
  body.append('file', new Blob([bytes], { type }), filename);
  const res = await jiraFetch(env, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`, {
    method: 'POST', headers: { 'X-Atlassian-Token': 'no-check', Accept: 'application/json' }, body,
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const out = await res.json().catch(() => []);
  return Array.isArray(out) ? out[0] || null : null;
}

// A file for the document (a backup, a drawing, the customer's spec) goes straight onto the
// category in Jira, from where it's filed in the job's Drive folder; the document lists it.
export async function addFile(env, viewer, { id, field, name }, request) {
  mustSee(viewer);
  const d = await docRow(env, id);
  const c = await categoryRow(env, viewer, d.category_id);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw refuse('That file was empty.');
  if (bytes.length > MAX_FILE_BYTES) throw refuse('Files can be up to 25 MB. Put bigger ones in the job\'s Drive folder.');
  const t = (await library(env, { all: true })).find((x) => x.id === d.doc_type);
  const clean = clip(String(name || 'File').replace(/[\\/:*?"<>|]+/g, ' ').trim(), 150) || 'File';
  const filename = `${String(t?.name || 'Document').replace(/\//g, '')} - ${clean}`;
  const a = await attach(env, c.category_key, filename, bytes, request.headers.get('content-type') || 'application/octet-stream');
  const res = await env.DB.prepare('INSERT INTO doc_files (doc_id, field, name, size, attachment_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(d.id, clip(field, 120), clean, bytes.length, a?.id ? String(a.id) : null, new Date().toISOString(), nameOf(viewer)).run();
  if (a?.id) await toDrive(env, c, [a], { now: false });
  return { id: res.meta.last_row_id, field, name: clean, size: bytes.length };
}

export async function removeFile(env, viewer, { fileId }) {
  mustSee(viewer);
  const f = await env.DB.prepare('SELECT * FROM doc_files WHERE id = ?').bind(Number(fileId)).first();
  if (!f) return { ok: true };
  const d = await docRow(env, f.doc_id);
  await categoryRow(env, viewer, d.category_id);
  if (f.attachment_id) await jira(env, `/rest/api/3/attachment/${encodeURIComponent(f.attachment_id)}`, { method: 'DELETE' }).catch(() => {});
  await env.DB.prepare('DELETE FROM doc_files WHERE id = ?').bind(f.id).run();
  return { ok: true };
}

// ---------- laying it out, and finishing ----------

async function render(env, d, c, t, { draft = false, version, versions } = {}) {
  const { results: photoRows } = await env.DB.prepare('SELECT id, field, data, width, height, caption FROM doc_photos WHERE doc_id = ? ORDER BY id').bind(d.id).all();
  const { results: files } = await env.DB.prepare('SELECT field, name, size FROM doc_files WHERE doc_id = ? ORDER BY id').bind(d.id).all();
  const { buildDocPdf } = await import('./docs-pdf.js');
  const input = {
    type: t, header: json(d.header, {}), data: json(d.data, {}), photos: photoRows, files, draft,
    version: version ?? d.version, versions: versions ?? json(d.versions, []),
    category: { key: c.category_key, summary: c.summary, epicKey: c.epic_key, order: c.order_summary, customer: c.customer },
    engineers: await engineersOf(env, c), finished: await finishedOnOrder(env, c), date: londonDate(),
  };
  const pdf = await buildDocPdf(input);
  let xlsx = null;
  if (t.template.spreadsheet && !draft) xlsx = await (await import('./docs-xlsx.js')).buildDocXlsx(input);
  return { pdf, xlsx };
}

// Put in the job's Drive folder by the hub, when it's filing them: straight away for a document
// that's just been issued, within a few minutes for anything else.
async function toDrive(env, c, attachments, { now = true } = {}) {
  try {
    const F = await import('./drive-filing.js');
    if (!(await F.isOn(env))) return;
    const list = attachments.filter((a) => a?.id);
    await F.queue(env, list.map((a) => ({ id: a.id, issueKey: c.category_key, epic: c.epic_key, folder: F.DISCIPLINE_FOLDERS[c.discipline] || null,
      filename: a.filename, size: a.size, mime: a.mimeType, created: new Date().toISOString(), source: 'hub' })));
    if (now) await F.fileNow(env, list.map((a) => a.id));
  } catch (err) { console.warn('Not filed in Drive yet:', err.message); }
}

const fileBase = (c, t, version) => `${c.epic_key || c.category_key} ${t.name}${version ? ` v${version}` : ''}`.replace(/\//g, '').replace(/[\\:*?"<>|]+/g, ' ').trim();

export async function preview(env, viewer, id) {
  mustSee(viewer);
  const d = await docRow(env, id);
  const c = await categoryRow(env, viewer, d.category_id);
  const t = (await library(env, { all: true })).find((x) => x.id === d.doc_type);
  const { pdf } = await render(env, d, c, t, { draft: true });
  return { bytes: pdf, filename: `${fileBase(c, t, null)} (draft).pdf` };
}

export async function finish(env, viewer, { id, description }) {
  mustSee(viewer);
  const d = await docRow(env, id);
  const c = await categoryRow(env, viewer, d.category_id);
  const t = (await library(env, { all: true })).find((x) => x.id === d.doc_type);
  if (!t) throw refuse('That document isn\'t in the list any more.');
  const version = (d.version || 0) + 1;
  const versions = [...json(d.versions, []), { version, initials: initialsOf(nameOf(viewer)), name: nameOf(viewer), date: londonDate(),
    description: clip(description, 200).trim() || (version === 1 ? 'First issue' : `Issue ${version}`) }];
  const { pdf, xlsx } = await render(env, d, c, t, { version, versions });
  const base = fileBase(c, t, version);
  const now = new Date().toISOString();
  const attached = [];
  try {
    attached.push(await attach(env, c.category_key, `${base}.pdf`, pdf, 'application/pdf'));
    if (xlsx) attached.push(await attach(env, c.category_key, `${base}.xlsx`, xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  } catch (err) {
    await env.DB.prepare('UPDATE doc_items SET error = ? WHERE id = ?').bind(clip(err.message, 300), d.id).run();
    throw refuse(`It couldn't be put on ${c.category_key} in Jira (${err.message.slice(0, 120)}). Nothing was lost; try again.`, 502);
  }
  await env.DB.prepare(`UPDATE doc_items SET status = 'done', version = ?, versions = ?, finished_at = ?, finished_by = ?, file_name = ?, attachments = ?, error = NULL, updated_at = ?, updated_by = ? WHERE id = ?`)
    .bind(version, JSON.stringify(versions), now, nameOf(viewer), `${base}.pdf`, JSON.stringify(attached.filter(Boolean).map((a) => String(a.id))), now, nameOf(viewer), d.id).run();
  await toDrive(env, c, attached);
  await record(env, viewer, { area: 'Jobs', action: 'Finished a document', subjectType: 'jira', subjectId: c.category_key, label: `${c.category_key}: ${t.name} v${version}` }).catch(() => {});
  return { ok: true, version, file: `${base}.pdf`, spreadsheet: xlsx ? `${base}.xlsx` : null };
}

// Opened again to change it: the next finish issues the next version.
export async function reopen(env, viewer, { id }) {
  mustSee(viewer);
  const d = await docRow(env, id);
  await categoryRow(env, viewer, d.category_id);
  await env.DB.prepare("UPDATE doc_items SET status = 'draft', updated_at = ?, updated_by = ? WHERE id = ?").bind(new Date().toISOString(), nameOf(viewer), d.id).run();
  return { ok: true };
}

// ---------- time on a document ----------

// Logged to the category in Tempo, as any time on it is, so it counts towards the job's hours
// (and its estimate and ELO); the hub notes which document it was for, and it earns more XP.
export async function logTime(env, viewer, { id, seconds, date, startTime, description }) {
  mustSee(viewer);
  const d = await docRow(env, id);
  const c = await categoryRow(env, viewer, d.category_id);
  const t = (await library(env, { all: true })).find((x) => x.id === d.doc_type);
  const { createWorklog } = await import('./logging.js');
  const note = clip(description, 300).trim();
  const r = await createWorklog(env, viewer, { issueId: c.category_id, issueKey: c.category_key, seconds, date, startTime,
    description: `Documentation: ${t?.name || 'document'}${note ? `. ${note}` : ''}` });
  const multiplier = t?.multiplier ?? DEFAULT_MULTIPLIER;
  await env.DB.prepare('INSERT OR REPLACE INTO doc_worklogs (worklog_id, doc_id, doc_type, category_id, account_id, seconds, multiplier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(String(r.worklogId), d.id, d.doc_type, c.category_id, viewer.accountId, r.seconds, multiplier, new Date().toISOString()).run();
  await recalcIssues(env, [c.category_id]).catch(() => {});
  return { ...r, multiplier };
}

// The XP rate for time logged against documents, by worklog.
export async function multipliersFor(env, worklogIds) {
  const map = new Map();
  for (const part of chunk([...new Set(worklogIds.map(String))], 80)) {
    const { results } = await env.DB.prepare(`SELECT worklog_id, multiplier FROM doc_worklogs WHERE worklog_id IN (${marks(part.length)})`).bind(...part).all()
      .catch(() => ({ results: [] }));
    for (const r of results) map.set(r.worklog_id, r.multiplier || 1);
  }
  return map;
}

// ---------- what's outstanding ----------

async function outstandingFor(env, categoryIds) {
  const out = new Map();
  const names = new Map((await library(env, { all: true })).map((t) => [t.id, t.name]));
  for (const part of chunk([...new Set(categoryIds.map(String))], 80)) {
    const { results } = await env.DB.prepare(
      `SELECT n.category_id, n.doc_type, i.id AS doc_id, i.status FROM doc_needs n LEFT JOIN doc_items i ON i.category_id = n.category_id AND i.doc_type = n.doc_type
        WHERE n.category_id IN (${marks(part.length)}) AND COALESCE(i.version, 0) = 0`
    ).bind(...part).all();
    for (const r of results) {
      if (!out.has(r.category_id)) out.set(r.category_id, []);
      out.get(r.category_id).push({ type: r.doc_type, name: names.get(r.doc_type) || r.doc_type, docId: r.doc_id || null, started: Boolean(r.doc_id) });
    }
  }
  return out;
}

function byOrder(cats, outstanding) {
  const orders = new Map();
  for (const c of cats) {
    const docs = outstanding.get(c.category_id);
    if (!docs?.length) continue;
    const k = c.epic_key || c.category_key;
    if (!orders.has(k)) orders.set(k, { key: c.epic_key, summary: c.order_summary, customer: c.customer, categories: [] });
    orders.get(k).categories.push({ id: c.category_id, key: c.category_key, summary: c.summary, done: Boolean(c.done), status: c.status, docs });
  }
  return [...orders.values()];
}

// Someone's own outstanding documents: on the categories they're assigned to, involved in or have logged time on.
export async function mine(env, viewer) {
  if (!viewer?.accountId || !canSee(viewer)) return { orders: [], count: 0 };
  const { results: cats } = await env.DB.prepare(
    `SELECT DISTINCT c.* FROM doc_categories c JOIN doc_needs n ON n.category_id = c.category_id
      WHERE c.assignee = ? OR c.staff LIKE ? OR c.category_id IN (
        SELECT l.issue_id FROM xp_ledger l WHERE l.account_id = ?
        UNION SELECT j.parent_id FROM xp_ledger l JOIN jobs j ON j.issue_id = l.issue_id WHERE l.account_id = ? AND j.parent_id IS NOT NULL)`
  ).bind(viewer.accountId, `%"${viewer.accountId}"%`, viewer.accountId, viewer.accountId).all().catch(() => ({ results: [] }));
  const country = await scopeFor(env, viewer, 'jobs');
  const seen = cats.filter((c) => country.sees({ project: c.epic_key || c.category_key, keys: [c.epic_key, c.category_key] }));
  const orders = byOrder(seen, await outstandingFor(env, seen.map((c) => c.category_id)));
  return { orders, count: orders.reduce((n, o) => n + o.categories.reduce((m, c) => m + c.docs.length, 0), 0) };
}

// Monday morning: each team lead hears which documents are outstanding in their team, by job.
export async function weeklyLeads(env) {
  const today = londonDate();
  if (new Date(`${today}T12:00:00Z`).getUTCDay() !== 1) return { skipped: 'Only on Mondays' };
  if ((await getState(env, 'docs_weekly')) === today) return { skipped: 'Sent already' };
  await setState(env, 'docs_weekly', today);
  const { results: cats } = await env.DB.prepare('SELECT DISTINCT c.* FROM doc_categories c JOIN doc_needs n ON n.category_id = c.category_id').all();
  const outstanding = await outstandingFor(env, cats.map((c) => c.category_id));
  const teams = new Map();
  for (const c of cats.filter((x) => outstanding.get(x.category_id)?.length)) {
    const k = c.team || '';
    if (!teams.has(k)) teams.set(k, []);
    teams.get(k).push(c);
  }
  const perLead = new Map();
  for (const [team, list] of teams) {
    for (const lead of await leadsOfTeam(env, team || null)) {
      const e = String(lead.email).toLowerCase();
      if (!perLead.has(e)) perLead.set(e, []);
      perLead.get(e).push(...list);
    }
  }
  let sent = 0;
  for (const [email, list] of perLead) {
    const orders = byOrder([...new Map(list.map((c) => [c.category_id, c])).values()], outstanding);
    const count = orders.reduce((n, o) => n + o.categories.reduce((m, c) => m + c.docs.length, 0), 0);
    const body = orders.map((o) => `${o.key || ''}${o.summary ? `: ${o.summary}` : ''}${o.customer ? ` (${o.customer})` : ''}\n${o.categories.map((c) =>
      `  ${c.key} ${c.summary}${c.done ? ' (finished)' : ''}: ${c.docs.map((x) => x.name).join(', ')}`).join('\n')}`).join('\n\n');
    await raiseAlert(env, { kind: 'docs-weekly', dedupe: `docs-weekly:${today}:${email}`, recipient: email, link: '#/jobs',
      subject: `${count} job document${count === 1 ? '' : 's'} outstanding in your team`,
      body: `These documents are still to be finished, by job:\n\n${body}\n\nOpen Jobs in the hub to see them.` });
    sent++;
  }
  return { sent };
}

// ---------- holding a category back until its documents are done ----------

// Moving a category to Done, or the last open sub-task of one, waits for its documents.
export async function mustAllowDone(env, issueKeyOrId) {
  const issue = await getIssue(env, issueKeyOrId, ['issuetype', 'parent']);
  if (!issue) return;
  const isSub = Boolean(issue.fields?.issuetype?.subtask);
  const categoryId = isSub ? String(issue.fields?.parent?.id || '') : String(issue.id);
  if (!categoryId) return;
  const c = await env.DB.prepare('SELECT * FROM doc_categories WHERE category_id = ?').bind(categoryId).first().catch(() => null);
  if (!c) return;
  const docs = (await outstandingFor(env, [categoryId])).get(categoryId) || [];
  if (!docs.length) return;
  if (isSub) {
    const open = await searchJql(env, `parent = ${c.category_key} AND statusCategory != Done AND key != ${issue.key}`, ['status'], { limit: 1 });
    if (open.length) return;
  }
  throw refuse(`${c.category_key}'s documents aren't finished yet: ${docs.map((x) => x.name).join(', ')}. Finish them in Jobs first.`, 409);
}

// ---------- filing in Google Drive ----------

export async function driveView(env, viewer) {
  if (!canLibrary(viewer)) throw refuse('Only admins and Management can see this.', 403);
  return { ...(await (await import('./drive-filing.js')).status(env)), canSwitch: Boolean(viewer.isAdmin) };
}

export async function driveSet(env, viewer, { on }) {
  if (!viewer?.isAdmin) throw refuse('Only admins can switch Drive filing on or off.', 403);
  const r = await (await import('./drive-filing.js')).setOn(env, Boolean(on));
  await record(env, viewer, { area: 'Jobs', action: on ? 'Started filing job attachments in Drive' : 'Stopped filing job attachments in Drive', subjectType: 'setting', subjectId: 'drive_filing', label: 'Drive filing' }).catch(() => {});
  return { ...r, canSwitch: true };
}

export async function driveRetry(env, viewer, { id }) {
  if (!canLibrary(viewer)) throw refuse('Only admins and Management can do this.', 403);
  return { ...(await (await import('./drive-filing.js')).retry(env, { id })), canSwitch: Boolean(viewer.isAdmin) };
}

export async function driveCheck(env, viewer) {
  if (!canLibrary(viewer)) throw refuse('Only admins and Management can do this.', 403);
  return (await import('./drive-filing.js')).check(env);
}
