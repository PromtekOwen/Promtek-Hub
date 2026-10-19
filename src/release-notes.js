// Condor release notes, built from the MES tickets in a release.
//
// The team carries on as now in Jira: each ticket has a Module, "Include in
// release notes" (Yes or No), and a Release Note written in its own field, with
// any screenshots pasted into it. The hub reads those, groups them the way the
// document has always been laid out (module, then new features, improvements
// and bug fixes), and shows a live preview. Wording can be tidied and pictures
// left out in the hub without touching the ticket; whether a ticket is included
// is written back to Jira. Screenshots stay in Jira and are fetched through the
// hub only when someone looks at them.
//
// Triage decides what kind of note each ticket gets (a single sentence, a
// paragraph, or a paragraph with a photo), and whoever is assigned the ticket
// writes it here, adding pictures, which go to Jira.
import { jira, searchJql } from './jira.js';
import { londonDate, raiseAlert } from './sync.js';
import { moduleOf, MODULE_FIELD, INCLUDE_FIELD, NOTE_FIELD } from './mes.js';

const PROJECT = 'MES';
const READ_EVERY_MS = 10 * 60 * 1000;
const READY_STATUS = 'ready for release notes';
// The release notes page in Condor's help groups notes under these headings, in
// this order. Jira's Module field maps onto them; any other module gets its own
// heading after these, in alphabetical order.
export const HEADINGS = ['Stock', 'Reports', 'Formulas and recipes', 'MicroMan', 'Weighbridge', 'Site and system management', 'Work orders',
  'Scheduling', 'Time in motion and energy', 'LIMS and quality control', 'Purchase and sales orders', 'Importer and exporter'];
const FROM_MODULE = {
  stock: 'Stock', reports: 'Reports', formulas: 'Formulas and recipes', recipes: 'Formulas and recipes', microman: 'MicroMan',
  weighbridge: 'Weighbridge', security: 'Site and system management', general: 'Site and system management', 'work orders': 'Work orders',
  scheduling: 'Scheduling', 'time in motion & energy': 'Time in motion and energy', 'lims - quality control': 'LIMS and quality control',
  'purchase / sales orders': 'Purchase and sales orders', 'importer / exporter': 'Importer and exporter',
};
export const headingFor = (module) => {
  const n = String(module || '').trim();
  return FROM_MODULE[n.toLowerCase()] || HEADINGS.find((h) => h.toLowerCase() === n.toLowerCase()) || n || 'Site and system management';
};
export function headingRank(name) {
  const i = HEADINGS.findIndex((h) => h.toLowerCase() === String(name).toLowerCase());
  return i >= 0 ? [0, String(i).padStart(3, '0')] : [1, String(name).toLowerCase()];
}

// A version number like 2026.07, from the month the release is due.
export const versionNumberFrom = (date) => (/^\d{4}-\d{2}/.test(date || '') ? `${date.slice(0, 4)}.${date.slice(5, 7)}` : '');
// Jira names releases in capitals; the help pages write them as names.
export const displayName = (name) => (/^[A-Z0-9 -]+$/.test(String(name || '')) ? String(name).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : String(name || ''));

const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const yesNo = (v) => (v == null ? null : /^(yes|y|true|1)$/i.test(String(v).trim()) ? 'yes' : /^(no|n|false|0)$/i.test(String(v).trim()) ? 'no' : null);

// ---------- reading a note out of Jira ----------

function inlineText(nodes = []) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.text || '';
    else if (n.type === 'hardBreak') out += '\n';
    else if (n.type === 'mention') out += n.attrs?.text || '';
    else if (n.type === 'emoji') out += n.attrs?.text || '';
    else if (n.type === 'inlineCard') out += n.attrs?.url || '';
    else if (n.type === 'date') out += n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
    else if (n.content) out += inlineText(n.content);
  }
  return out;
}

// A Release Note field becomes a list of blocks: paragraphs of text and the
// pictures between them, in the order they were written.
export function blocksFromAdf(doc, attachments = []) {
  const blocks = [];
  const images = attachments.filter((a) => /^image\//i.test(a.mimeType || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename || ''));
  const used = new Set();
  const media = (attrs = {}) => {
    const alt = String(attrs.alt || '').trim();
    const byName = images.find((a) => !used.has(a.id) && (a.filename === alt || a.filename.replace(/\.[^.]+$/, '') === alt.replace(/\.[^.]+$/, '')));
    const att = byName || null;
    if (!att) { if (alt) blocks.push({ type: 'missing', filename: alt }); return; }
    used.add(att.id);
    blocks.push({ type: 'image', attachmentId: att.id, filename: att.filename });
  };
  const text = (t) => { const s = t.replace(/[ \t]+\n/g, '\n').trim(); if (s) blocks.push({ type: 'text', text: s }); };
  const walk = (nodes = []) => {
    for (const n of nodes) {
      if (['paragraph', 'heading', 'blockquote'].includes(n.type)) {
        // Pictures pasted inline still come out as pictures.
        const inlineMedia = (n.content || []).filter((c) => c.type === 'mediaInline');
        text(inlineText((n.content || []).filter((c) => c.type !== 'mediaInline')));
        inlineMedia.forEach((m) => media(m.attrs));
      } else if (n.type === 'bulletList' || n.type === 'orderedList') {
        // A list stays a list: one line per item, inside the paragraph it belongs to.
        const lines = (n.content || []).map((item) => (item.content || []).map((c) => inlineText(c.content || [])).join(' ').trim()).filter(Boolean);
        if (lines.length) {
          const last = blocks[blocks.length - 1];
          const list = lines.map((l) => `- ${l}`).join('\n');
          if (last?.type === 'text') last.text += `\n${list}`; else blocks.push({ type: 'text', text: list });
        }
      } else if (n.type === 'mediaSingle' || n.type === 'mediaGroup') {
        for (const m of n.content || []) if (m.type === 'media') media(m.attrs);
      } else if (n.type === 'media') {
        media(n.attrs);
      } else if (n.type === 'codeBlock') {
        text(inlineText(n.content || []));
      } else if (n.type === 'table') {
        for (const row of n.content || []) text((row.content || []).map((cell) => inlineText((cell.content || []).flatMap((p) => p.content || []))).filter(Boolean).join(' | '));
      } else if (n.type === 'panel' || n.type === 'expand' || n.type === 'nestedExpand' || n.type === 'listItem') {
        walk(n.content || []);
      } else if (n.content) {
        walk(n.content);
      }
    }
  };
  if (doc && typeof doc === 'object') walk(doc.content || []);
  else if (typeof doc === 'string') doc.split(/\n{2,}/).forEach(text);
  return blocks;
}

// ---------- releases ----------

// Open releases, soonest first, then the last few released ones, newest first.
export async function releases(env) {
  const list = (await jira(env, `/rest/api/3/project/${PROJECT}/versions`)) || [];
  const live = list.filter((v) => !v.archived);
  const open = live.filter((v) => !v.released).sort((a, b) => (a.releaseDate || '9999').localeCompare(b.releaseDate || '9999'));
  const done = live.filter((v) => v.released).sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '')).slice(0, 8);
  return [...open, ...done].map((v) => ({ id: String(v.id), name: v.name, releaseDate: v.releaseDate || null, released: Boolean(v.released) }));
}

export async function readRelease(env, version) {
  const fields = ['summary', 'issuetype', 'status', 'priority', 'updated', 'attachment', 'assignee', MODULE_FIELD, INCLUDE_FIELD, NOTE_FIELD];
  const issues = await searchJql(env, `project = ${PROJECT} AND fixVersion = ${Number(version.id)} AND issuetype not in subTaskIssueTypes() ORDER BY key ASC`, fields, { limit: 400 });
  const now = new Date().toISOString();
  const statements = [];
  for (const issue of issues) {
    const f = issue.fields || {};
    const attachments = (f.attachment || []).map((a) => ({ id: String(a.id), filename: a.filename, mimeType: a.mimeType, size: a.size }));
    const include = yesNo(f[INCLUDE_FIELD]?.value ?? (Array.isArray(f[INCLUDE_FIELD]) ? f[INCLUDE_FIELD][0]?.value : f[INCLUDE_FIELD]));
    const done = f.status?.statusCategory?.key === 'done' || String(f.status?.name || '').toLowerCase() === READY_STATUS;
    statements.push(env.DB.prepare(
      `INSERT INTO mes_note_items (issue_id, issue_key, version_id, summary, type, module, status, done, include, priority, assignee_id, assignee_name, blocks, attachments, jira_updated, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, version_id = excluded.version_id, summary = excluded.summary, type = excluded.type,
         module = excluded.module, status = excluded.status, done = excluded.done, include = excluded.include, priority = excluded.priority,
         assignee_id = excluded.assignee_id, assignee_name = excluded.assignee_name,
         blocks = excluded.blocks, attachments = excluded.attachments, jira_updated = excluded.jira_updated, read_at = excluded.read_at`
    ).bind(String(issue.id), issue.key, version.id, f.summary || '', f.issuetype?.name || null, moduleOf(issue), f.status?.name || null, done ? 1 : 0,
      include, Number(f.priority?.id) || null, f.assignee?.accountId || null, f.assignee?.displayName || null,
      JSON.stringify(blocksFromAdf(f[NOTE_FIELD], attachments)), JSON.stringify(attachments), f.updated || null, now));
  }
  // Anything moved to another release since the last read no longer belongs here.
  const ids = issues.map((i) => String(i.id));
  statements.push(env.DB.prepare(
    `DELETE FROM mes_note_items WHERE version_id = ?${ids.length ? ` AND issue_id NOT IN (${ids.map(() => '?').join(',')})` : ''}`
  ).bind(version.id, ...ids));
  statements.push(env.DB.prepare(
    `INSERT INTO mes_release_notes (version_id, version_name, release_date, read_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(version_id) DO UPDATE SET version_name = excluded.version_name, release_date = excluded.release_date, read_at = excluded.read_at`
  ).bind(version.id, version.name, version.releaseDate, now));
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return { read: issues.length };
}

// ---------- the kinds of note ----------
// Chosen in triage and changeable here. Jira's "Include in release notes" field
// holds Yes for any of them and No for "Not included".

export const KINDS = [
  { id: 'none', label: 'Not included' },
  { id: 'sentence', label: 'Single sentence' },
  { id: 'paragraph', label: 'Paragraph' },
  { id: 'photo', label: 'Paragraph with photo' },
];
const KIND_IDS = KINDS.map((k) => k.id);

// A choice made in the hub counts until Jira has it. After that Jira is the
// record for in or out, so a change made there shows through, while the kind of
// note the hub knows is kept.
// A ticket marked Yes in Jira with no kind chosen here is a paragraph, or a
// paragraph with a photo if its note already has pictures.
export function kindFrom(jiraInclude, row, hasPictures = false) {
  if (row && Number(row.jira_synced) === 0) return row.kind;
  if (jiraInclude === 'no') return 'none';
  if (jiraInclude === 'yes') return row && row.kind !== 'none' ? row.kind : hasPictures ? 'photo' : 'paragraph';
  return row?.kind || null;
}

export async function setKind(env, viewer, ticket, kind) {
  if (!KIND_IDS.includes(kind)) throw new Error('Choose how it appears in the release notes.');
  await env.DB.prepare(
    `INSERT INTO mes_note_kinds (issue_id, issue_key, kind, jira_synced, set_by, set_at) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, kind = excluded.kind, jira_synced = 0, jira_error = NULL,
       set_by = excluded.set_by, set_at = excluded.set_at`
  ).bind(String(ticket.issue_id), ticket.issue_key, kind, viewer.email, new Date().toISOString()).run();
  return syncKind(env, String(ticket.issue_id));
}

export async function syncKind(env, issueId) {
  const k = await env.DB.prepare('SELECT * FROM mes_note_kinds WHERE issue_id = ?').bind(issueId).first();
  if (!k || k.jira_synced) return true;
  const value = k.kind === 'none' ? 'No' : 'Yes';
  try {
    await jira(env, `/rest/api/3/issue/${encodeURIComponent(k.issue_key)}`, { method: 'PUT', body: JSON.stringify({ fields: { [INCLUDE_FIELD]: { value } } }) });
    const yn = value.toLowerCase();
    await env.DB.batch([
      env.DB.prepare('UPDATE mes_note_kinds SET jira_synced = 1, jira_error = NULL WHERE issue_id = ?').bind(issueId),
      env.DB.prepare('UPDATE mes_note_items SET include = ? WHERE issue_id = ?').bind(yn, issueId),
      env.DB.prepare('UPDATE mes_tickets SET release_notes = ? WHERE issue_id = ?').bind(yn, issueId),
    ]);
    return true;
  } catch (err) {
    await env.DB.prepare('UPDATE mes_note_kinds SET jira_error = ? WHERE issue_id = ?').bind(err.message.slice(0, 300), issueId).run();
    return false;
  }
}

// ---------- what the release notes say ----------

// "MicroMan" keeps its capitals in a sentence; "Stock" doesn't.
export const inSentence = (h) => (/^[A-Z][a-z]/.test(h) && !/[A-Z]/.test(h.slice(1)) ? h[0].toLowerCase() + h.slice(1) : h);
const listWords = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');

export function defaultIntro(name, doc) {
  if (!doc.length) return '';
  return `${displayName(name)} introduces improvements across ${listWords(doc.map((m) => inSentence(m.name)))}.`;
}

// The words of a note, for telling whether Jira has changed since the hub last matched it.
export const textOf = (blocks) => (blocks || []).filter((b) => b.type === 'text').map((b) => String(b.text).trim()).filter(Boolean).join('\n\n');

// What each kind of note needs before it is ready. A paragraph is a section of
// its own on the help page, so it needs a heading too.
export function missingFor(kind, blocks, title) {
  const shown = (blocks || []).filter((b) => !b.hidden);
  const text = shown.filter((b) => b.type === 'text' && String(b.text).trim());
  const out = [];
  if (kind !== 'sentence' && !String(title || '').trim()) out.push('a heading');
  if (!text.length) out.push(kind === 'sentence' ? 'a sentence' : 'a paragraph');
  if (kind === 'photo' && !shown.some((b) => b.type === 'image')) out.push('a picture');
  return out;
}

function merge(item, edit, kindRow) {
  const jiraBlocks = parse(item.blocks, []);
  const blocks = edit?.blocks ? parse(edit.blocks, jiraBlocks) : jiraBlocks;
  const kind = kindFrom(item.include, kindRow, blocks.some((b) => b.type === 'image'));
  const notePending = Boolean(edit && Number(edit.note_synced) === 0);
  const title = edit?.title || null;
  return {
    id: item.issue_id, key: item.issue_key, summary: item.summary, type: item.type, status: item.status, done: Boolean(item.done),
    kind, include: kind == null ? null : kind === 'none' ? 'no' : 'yes',
    kindWaiting: Boolean(kindRow && Number(kindRow.jira_synced) === 0), kindError: kindRow?.jira_error || null,
    assigneeId: item.assignee_id || null, assigneeName: item.assignee_name || null,
    module: item.module || null, heading: edit?.module || headingFor(item.module), moduleSet: Boolean(edit?.module || item.module),
    title, blocks, jiraBlocks, edited: Boolean(edit?.blocks || edit?.title || edit?.module),
    writtenBy: edit?.written_by || null, writtenAt: edit?.written_at || null, notePending, noteError: edit?.note_error || null,
    changedInJira: Boolean(edit?.blocks && !notePending && edit.based_on != null && edit.based_on !== textOf(jiraBlocks)),
    missing: kind && kind !== 'none' ? missingFor(kind, blocks, title) : [],
    attachments: parse(item.attachments, []).filter((a) => /^image\//i.test(a.mimeType || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename || '')),
    priority: item.priority,
  };
}

// What shows for a note: anything hidden is left out, a sentence is just its
// words, and a note with nothing written yet stands in with the ticket summary.
export function shownBlocks(item) {
  let blocks = (item.blocks || []).filter((b) => !b.hidden && b.type !== 'missing');
  if (item.kind === 'sentence') blocks = blocks.filter((b) => b.type === 'text').slice(0, 1);
  if (item.kind === 'paragraph') blocks = blocks.filter((b) => b.type === 'text');
  if (!blocks.some((b) => b.type === 'text')) blocks.unshift({ type: 'text', text: item.summary || item.key, fromSummary: true });
  return blocks;
}

// Laid out as the help page is: under each heading, the bigger changes as
// sections of their own, then the one-line ones as bullets.
export function documentFrom(items) {
  const groups = new Map();
  const keyNum = (k) => Number(String(k).split('-')[1]) || 0;
  for (const it of [...items].sort((a, b) => keyNum(a.key) - keyNum(b.key))) {
    if (!groups.has(it.heading)) groups.set(it.heading, { name: it.heading, features: [], bullets: [] });
    const g = groups.get(it.heading);
    const blocks = shownBlocks(it);
    if (it.kind === 'sentence') g.bullets.push({ id: it.id, key: it.key, text: blocks[0].text, fromSummary: Boolean(blocks[0].fromSummary) });
    else g.features.push({ id: it.id, key: it.key, title: it.title || it.summary || it.key, titleFromSummary: !it.title, blocks });
  }
  return [...groups.values()].sort((a, b) => { const [ra, ka] = headingRank(a.name), [rb, kb] = headingRank(b.name); return ra - rb || ka.localeCompare(kb); });
}

export async function view(env, viewer, { versionId = null, refresh = false } = {}) {
  let list = [], listError = null;
  try { list = await releases(env); } catch (err) { listError = err.message; }
  const saved = (await env.DB.prepare('SELECT * FROM mes_release_notes ORDER BY release_date DESC').all()).results;
  if (!list.length) list = saved.map((r) => ({ id: r.version_id, name: r.version_name, releaseDate: r.release_date, released: false }));
  const version = list.find((v) => v.id === String(versionId)) || list[0];
  if (!version) return { releases: [], error: listError || 'There are no releases in MES yet.' };

  let note = saved.find((r) => r.version_id === version.id);
  let readError = null;
  if (refresh || !note?.read_at || Date.now() - Date.parse(note.read_at) > READ_EVERY_MS) {
    try { await readRelease(env, version); } catch (err) { readError = err.message; }
    note = await env.DB.prepare('SELECT * FROM mes_release_notes WHERE version_id = ?').bind(version.id).first();
  }
  const { results: rows } = await env.DB.prepare(
    `SELECT i.*, e.blocks AS e_blocks, e.title AS e_title, e.module AS e_module, e.based_on, e.note_synced, e.note_error, e.written_by, e.written_at,
            e.issue_id AS e_id, k.kind AS k_kind, k.jira_synced AS k_synced, k.jira_error AS k_error, k.issue_id AS k_id
       FROM mes_note_items i LEFT JOIN mes_note_edits e ON e.issue_id = i.issue_id LEFT JOIN mes_note_kinds k ON k.issue_id = i.issue_id
      WHERE i.version_id = ?`
  ).bind(version.id).all();
  const items = rows.map((r) => merge(r,
    r.e_id ? { blocks: r.e_blocks, title: r.e_title, module: r.e_module, based_on: r.based_on, note_synced: r.note_synced, note_error: r.note_error,
      written_by: r.written_by, written_at: r.written_at } : null,
    r.k_id ? { kind: r.k_kind, jira_synced: r.k_synced, jira_error: r.k_error } : null))
    .sort((a, b) => (Number(a.key.split('-')[1]) || 0) - (Number(b.key.split('-')[1]) || 0));

  const inDoc = items.filter((i) => i.include === 'yes' && i.done);
  const doc = documentFrom(inDoc);
  const toWrite = items.filter((i) => i.kind && i.kind !== 'none' && i.missing.length);
  const me = viewer.accountId || null;
  const releaseDate = version.releaseDate || note?.release_date || null;
  return {
    releases: list,
    version: { ...version, releaseDate, displayName: displayName(version.name),
      number: note?.version_number || versionNumberFrom(releaseDate), numberSet: Boolean(note?.version_number) },
    readAt: note?.read_at || null, error: readError || listError,
    intro: note?.intro ?? null, introDefault: defaultIntro(version.name, doc),
    document: doc,
    items, me, kinds: KINDS,
    counts: {
      inDocument: inDoc.length,
      unfinished: items.filter((i) => i.include === 'yes' && !i.done).length,
      undecided: items.filter((i) => !i.kind).length,
      left: items.filter((i) => i.kind === 'none').length,
      pictures: inDoc.reduce((t, i) => t + shownBlocks(i).filter((b) => b.type === 'image').length, 0),
      toWrite: toWrite.length,
      mine: toWrite.filter((i) => me && i.assigneeId === me).length,
    },
    headings: HEADINGS,
  };
}

// ---------- changes made in the hub ----------

async function itemFor(env, issueId) {
  const item = await env.DB.prepare('SELECT * FROM mes_note_items WHERE issue_id = ?').bind(String(issueId)).first();
  if (!item) throw new Error('That ticket isn\'t in a release the hub has read.');
  return item;
}

function cleanBlocks(item, input) {
  const allowed = new Set(parse(item.attachments, []).map((a) => a.id));
  return (Array.isArray(input) ? input : []).slice(0, 60).map((b) => (b?.type === 'image' && allowed.has(String(b.attachmentId))
    ? { type: 'image', attachmentId: String(b.attachmentId), filename: clean(b.filename, 200), caption: clean(b.caption, 200), hidden: Boolean(b.hidden) }
    : b?.type === 'text' ? { type: 'text', text: clean(b.text, 2000), hidden: Boolean(b.hidden) } : null)).filter((b) => b && (b.type === 'image' || b.text));
}

async function saveEdit(env, issueId, fields) {
  const now = new Date().toISOString();
  const before = await env.DB.prepare('SELECT * FROM mes_note_edits WHERE issue_id = ?').bind(issueId).first();
  const row = { blocks: null, title: null, module: null, based_on: null, note_synced: 1, note_error: null, written_by: null, written_at: null, ...(before || {}), ...fields };
  await env.DB.prepare(
    `INSERT INTO mes_note_edits (issue_id, blocks, title, module, based_on, note_synced, note_error, written_by, written_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET blocks = excluded.blocks, title = excluded.title, module = excluded.module, based_on = excluded.based_on,
       note_synced = excluded.note_synced, note_error = excluded.note_error, written_by = excluded.written_by, written_at = excluded.written_at,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(issueId, row.blocks, row.title, row.module, row.based_on, row.note_synced, row.note_error, row.written_by, row.written_at, row.updated_by || null, now).run();
}

// Tidying the wording, pictures, heading or which part of the page a note is in,
// for the release notes only.
export async function saveItem(env, viewer, input) {
  const item = await itemFor(env, input.issueId);
  const fields = { updated_by: viewer.email };
  if (input.blocks !== undefined) {
    fields.blocks = input.blocks === null ? null : JSON.stringify(cleanBlocks(item, input.blocks));
    fields.based_on = input.blocks === null ? null : textOf(parse(item.blocks, []));
  }
  if (input.title !== undefined) fields.title = clean(input.title, 120) || null;
  if (input.module !== undefined) fields.module = clean(input.module, 80) || null;
  if (Object.keys(fields).length > 1) await saveEdit(env, item.issue_id, fields);
  const jiraSynced = input.kind !== undefined ? await setKind(env, viewer, item, input.kind) : true;
  return { ok: true, jiraSynced };
}

// The note written by the person who did the work: the words go into the Release
// Note field in Jira, and the pictures are attachments on the ticket.
export async function write(env, viewer, input) {
  const item = await itemFor(env, input.issueId);
  const kindRow = await env.DB.prepare('SELECT * FROM mes_note_kinds WHERE issue_id = ?').bind(item.issue_id).first();
  const kind = kindFrom(item.include, kindRow, parse(item.blocks, []).some((b) => b.type === 'image')) || 'paragraph';
  if (kind === 'none') throw new Error('This ticket isn\'t in the release notes.');
  const text = clean(input.text, kind === 'sentence' ? 300 : 3000);
  if (!text) throw new Error(kind === 'sentence' ? 'Write the sentence first.' : 'Write the paragraph first.');
  if (kind === 'sentence' && /\n/.test(text)) throw new Error('Keep it to a single sentence, on one line.');
  const title = kind === 'sentence' ? null : clean(input.title, 120);
  if (kind !== 'sentence' && !title) throw new Error('Give it a heading, such as "Multiple scales per station".');
  const allowed = new Map(parse(item.attachments, []).map((a) => [a.id, a]));
  const pictures = kind === 'photo'
    ? (input.images || []).map((x) => (typeof x === 'object' ? { id: String(x.id), caption: clean(x.caption, 200) } : { id: String(x), caption: '' }))
      .filter((x) => allowed.has(x.id)).slice(0, 12)
    : [];
  if (kind === 'photo' && !pictures.length) throw new Error('Add at least one picture.');
  const blocks = [
    ...text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((t) => ({ type: 'text', text: t })),
    ...pictures.map((x) => ({ type: 'image', attachmentId: x.id, filename: allowed.get(x.id).filename, caption: x.caption })),
  ];
  const now = new Date().toISOString();
  await saveEdit(env, item.issue_id, { blocks: JSON.stringify(blocks), title, based_on: textOf(blocks), note_synced: 0, note_error: null,
    written_by: viewer.employee?.name || viewer.email, written_at: now, updated_by: viewer.email });
  return { ok: true, jiraSynced: await syncNote(env, item.issue_id) };
}

const adfFrom = (blocks) => ({
  type: 'doc', version: 1,
  content: blocks.filter((b) => b.type === 'text').map((b) => ({
    type: 'paragraph',
    content: String(b.text).split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
  })),
});

export async function syncNote(env, issueId) {
  const e = await env.DB.prepare('SELECT e.*, i.issue_key FROM mes_note_edits e JOIN mes_note_items i ON i.issue_id = e.issue_id WHERE e.issue_id = ?').bind(issueId).first();
  if (!e || Number(e.note_synced)) return true;
  try {
    const blocks = parse(e.blocks, []);
    await jira(env, `/rest/api/3/issue/${encodeURIComponent(e.issue_key)}`, { method: 'PUT', body: JSON.stringify({ fields: { [NOTE_FIELD]: adfFrom(blocks) } }) });
    // Jira's Release Note now holds these words, until it is next read.
    await env.DB.batch([
      env.DB.prepare('UPDATE mes_note_edits SET note_synced = 1, note_error = NULL WHERE issue_id = ?').bind(issueId),
      env.DB.prepare('UPDATE mes_note_items SET blocks = ? WHERE issue_id = ?').bind(JSON.stringify(blocks.filter((b) => b.type === 'text')), issueId),
    ]);
    return true;
  } catch (err) {
    await env.DB.prepare('UPDATE mes_note_edits SET note_error = ? WHERE issue_id = ?').bind(err.message.slice(0, 300), issueId).run();
    return false;
  }
}

// A picture for a note, added to the ticket in Jira as an attachment.
const MAX_UPLOAD = 10 * 1024 * 1024;
export async function upload(env, viewer, issueId, request) {
  const item = await itemFor(env, issueId);
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(type)) throw new Error('Pictures need to be PNG, JPEG, GIF or WebP.');
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new Error('That picture was empty.');
  if (bytes.byteLength > MAX_UPLOAD) throw new Error('Pictures need to be under 10 MB.');
  const ext = type.split('/')[1].replace('jpeg', 'jpg');
  let name = clean(decodeURIComponent(request.headers.get('x-filename') || ''), 120).replace(/[^\w .()-]+/g, '_') || `release-note.${ext}`;
  if (!/\.[a-z0-9]{2,4}$/i.test(name)) name += `.${ext}`;
  const form = new FormData();
  form.append('file', new File([bytes], name, { type }));
  const res = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(item.issue_key)}/attachments`, {
    method: 'POST', body: form,
    headers: { Authorization: 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`), 'X-Atlassian-Token': 'no-check', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira didn't take the picture (${res.status}). Try again in a moment.`);
  const [att] = await res.json();
  const added = { id: String(att.id), filename: att.filename, mimeType: att.mimeType || type, size: att.size };
  const list = [...parse(item.attachments, []).filter((a) => a.id !== added.id), added];
  await env.DB.prepare('UPDATE mes_note_items SET attachments = ? WHERE issue_id = ?').bind(JSON.stringify(list), item.issue_id).run();
  return added;
}

export async function saveIntro(env, viewer, { versionId, intro, number }) {
  const v = String(versionId || '');
  if (!v) throw new Error('Which release?');
  const num = number === undefined ? undefined : clean(number, 20).replace(/^v/i, '') || null;
  if (num && !/^[0-9][0-9.]*$/.test(num)) throw new Error('A version number is digits and dots, like 2026.07.');
  await env.DB.prepare(
    `INSERT INTO mes_release_notes (version_id, intro, version_number, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(version_id) DO UPDATE SET intro = excluded.intro, version_number = ${num === undefined ? 'mes_release_notes.version_number' : 'excluded.version_number'},
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(v, intro == null ? null : clean(intro, 3000), num ?? null, viewer.email, new Date().toISOString()).run();
  return { ok: true };
}

// A screenshot from Jira, only ever one belonging to a ticket in a release the hub has read.
export async function image(env, { issueId, attachmentId }) {
  const item = await env.DB.prepare('SELECT attachments FROM mes_note_items WHERE issue_id = ?').bind(String(issueId)).first();
  const att = parse(item?.attachments, []).find((a) => a.id === String(attachmentId));
  if (!att) return new Response('Not found', { status: 404 });
  const res = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/attachment/content/${encodeURIComponent(att.id)}`, {
    headers: { Authorization: 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`) },
  });
  if (!res.ok) return new Response('Jira didn\'t send the picture', { status: 502 });
  return new Response(res.body, {
    headers: { 'content-type': att.mimeType || res.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'private, max-age=86400' },
  });
}

// Notes waiting to be written, for the home screen: the person's own, in open releases.
export async function waitingFor(env, accountId) {
  if (!accountId) return 0;
  const { results } = await env.DB.prepare(
    `SELECT i.*, e.blocks AS e_blocks, e.title AS e_title, k.kind AS k_kind, k.jira_synced AS k_synced, k.issue_id AS k_id FROM mes_note_items i
       JOIN mes_release_notes r ON r.version_id = i.version_id
       LEFT JOIN mes_note_edits e ON e.issue_id = i.issue_id LEFT JOIN mes_note_kinds k ON k.issue_id = i.issue_id
      WHERE i.assignee_id = ?`
  ).bind(accountId).all();
  return results.filter((r) => {
    const blocks = parse(r.e_blocks || r.blocks, []);
    const kind = kindFrom(r.include, r.k_id ? { kind: r.k_kind, jira_synced: r.k_synced } : null, blocks.some((b) => b.type === 'image'));
    return kind && kind !== 'none' && missingFor(kind, blocks, r.e_title).length;
  }).length;
}

// Choices and notes that Jira hasn't taken yet, tried again each hour.
export async function hourly(env) {
  const { results: kinds } = await env.DB.prepare('SELECT issue_id FROM mes_note_kinds WHERE jira_synced = 0 LIMIT 10').all();
  for (const r of kinds) await syncKind(env, r.issue_id);
  const { results: notes } = await env.DB.prepare('SELECT issue_id FROM mes_note_edits WHERE note_synced = 0 LIMIT 10').all();
  for (const r of notes) await syncNote(env, r.issue_id);
  const stuck = (await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM mes_note_kinds WHERE jira_synced = 0) + (SELECT COUNT(*) FROM mes_note_edits WHERE note_synced = 0) AS n'
  ).first()).n;
  if (stuck) {
    await raiseAlert(env, { kind: 'mes-notes-jira', dedupe: `mes-notes-jira:${londonDate()}`, subject: `${stuck} release note ${stuck === 1 ? 'change is' : 'changes are'} waiting to reach Jira`,
      body: 'Release note choices or wording saved in Condor Dev haven\'t reached Jira yet. They are safe in the hub and retried every hour.' });
  }
  return { tried: kinds.length + notes.length, stuck };
}
