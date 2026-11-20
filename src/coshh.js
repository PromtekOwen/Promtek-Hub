// COSHH assessments: the form filled in from the hub (on the tablet, with a photo of the
// product), kept as a PDF laid out like the paper form and filed on the COSHH page in
// Confluence. Every assessment is listed, marked in house or not and where it's kept; one
// still in house is due its review a year after it was last assessed or reviewed, and
// management hear about it. Assessments already on the Confluence page can be brought in.
import { canTile } from './permissions.js';
import { record } from './audit.js';
import { londonDate } from './sync.js';

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const clip = (v, n = 500) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, n);
const json = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const FIRST_NO = 1001;
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 700 * 1024;
const DUE_SOON_DAYS = 14;

// What the form asks, in the template's words.
export const LOCATIONS = ['Office', 'Workshop', 'Upstairs', 'Kitchen', 'Office Male Toilet', 'Office Female Toilet', 'Workshop Washroom & Toilet'];
export const WHERE_USED = [['manufacturing', 'Manufacturing'], ['offices', 'Offices'], ['canteens', 'Canteens / Kitchens / Washrooms'], ['outside', 'Outside only'], ['client', 'Client sites']];
export const HAZARDS = [
  ['explosive', 'Explosive'], ['flammable', 'Flammable'], ['oxidising', 'Oxidising'], ['gas', 'Gas under pressure'], ['corrosive', 'Corrosive'],
  ['toxic', 'Acute toxicity'], ['harmful', 'Harmful / irritant'], ['health', 'Serious health hazard'], ['environment', 'Hazardous to the environment'],
];
export const PPE = [['gloves', 'Gloves'], ['eyes', 'Safety glasses / goggles'], ['face', 'Face shield'], ['mask', 'Dust mask / respirator'], ['apron', 'Apron / overalls'], ['boots', 'Safety footwear']];
export const DISPOSAL = [['general', 'General waste (incl. residues)'], ['container', 'General waste (empty container / discharged aerosol)'], ['paper', 'Paper and cardboard'], ['hazardous', 'Hazardous (see QHSE dept.)']];
export const RISKS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
export const DEFAULT_PRECAUTIONS = 'Read label before use. Keep out of reach of children. If medical advice is needed, have product container or label at hand.';

export function mustSee(viewer) {
  if (!canTile(viewer, 'coshh')) throw refuse('COSHH isn\'t open to you.', 403);
}
export const canManage = (viewer) => Boolean(viewer?.isAdmin || viewer?.can?.coshhManage);
const nameOf = (viewer) => viewer.employee?.name || viewer.email;

export function addYear(day) {
  if (!isDay(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const out = new Date(Date.UTC(y + 1, m - 1, d));
  if (out.getUTCMonth() !== m - 1) out.setUTCDate(0);   // 29 February
  return out.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

const pick = (list, allowed) => [...new Set((Array.isArray(list) ? list : []).map(String))].filter((x) => allowed.some(([k]) => k === x));
const yesNo = (v) => (v === 'yes' || v === 'no' ? v : '');

// The form as kept: only what it asks, tidied.
export function cleanForm(input = {}) {
  const fa = input.firstAid || {};
  return {
    msds: clip(input.msds, 200),
    otherNames: clip(input.otherNames, 500),
    appearance: clip(input.appearance, 300),
    containers: clip(input.containers, 500),
    usedFor: clip(input.usedFor, 1000),
    where: pick(input.where, WHERE_USED),
    risk: RISKS.some(([k]) => k === input.risk) ? input.risk : '',
    hazards: pick(input.hazards, HAZARDS),
    ppe: pick(input.ppe, PPE),
    ppeNote: clip(input.ppeNote, 500),
    firstAid: { eye: clip(fa.eye, 500), skin: clip(fa.skin, 500), inhalation: clip(fa.inhalation, 500), ingestion: clip(fa.ingestion, 500) },
    precautions: clip(input.precautions ?? DEFAULT_PRECAUTIONS, 2000),
    disposal: pick(input.disposal, DISPOSAL),
    infoGiven: yesNo(input.infoGiven),
    training: yesNo(input.training),
    surveillance: yesNo(input.surveillance),
  };
}

// What's still needed before it can be completed.
export function missing(product, f) {
  const out = [];
  if (!clip(product)) out.push('the product name');
  if (!f.usedFor) out.push('what it\'s used for');
  if (!f.where.length) out.push('where it\'s used');
  if (!f.risk) out.push('the risk rating');
  if (!f.infoGiven || !f.training || !f.surveillance) out.push('the three questions at the end');
  return out;
}

const cleanLocations = (list) => [...new Set((Array.isArray(list) ? list : []).map((x) => clip(x, 60)).filter(Boolean))].slice(0, 12);

// ---------- reading ----------

const LIST_COLS = `i.id, i.coshh_no, i.rev, i.product, i.status, i.source, i.in_house, i.locations, i.assessed_by, i.assessed_on, i.last_review_on, i.next_review_on,
  i.pdf_name, i.file_name, i.confluence_id, i.confluence_note, i.created_by_id, i.created_by, i.updated_at, i.in_house_by, i.in_house_at, i.pending, i.in_date, i.out_date,
  (SELECT MIN(p.id) FROM coshh_photos p WHERE p.item_id = i.id) AS photo_id`;

function shape(r, today) {
  const due = r.status !== 'draft' && r.next_review_on ? daysBetween(today, r.next_review_on) : null;
  return {
    id: r.id, no: r.coshh_no, rev: r.rev, product: r.product, status: r.status, source: r.source, inHouse: Boolean(r.in_house),
    locations: json(r.locations, []), assessedBy: r.assessed_by, assessedOn: r.assessed_on, lastReviewOn: r.last_review_on, nextReviewOn: r.next_review_on,
    reviewDue: r.in_house && due != null ? (due < 0 ? 'overdue' : due <= DUE_SOON_DAYS ? 'soon' : null) : null, dueInDays: due,
    hasFile: Boolean(r.pdf_name || r.file_name), fileName: r.pdf_name || r.file_name || null, filed: Boolean(r.confluence_id), fileNote: r.confluence_note,
    photoId: r.photo_id || null, createdById: r.created_by_id, createdBy: r.created_by, updatedAt: r.updated_at, inHouseBy: r.in_house_by, inHouseAt: r.in_house_at,
    waiting: r.pending || null, inDate: r.in_date || null, outDate: r.out_date || null,
  };
}

export async function list(env, viewer) {
  mustSee(viewer);
  const today = londonDate();
  // Once: the same COSHH number on more than one item, from the page, comes down to one.
  if (!(await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'coshh_deduped'").first().catch(() => null))) {
    await dedupe(env).catch(() => {});
    await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('coshh_deduped', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(new Date().toISOString()).run();
  }
  const { results } = await env.DB.prepare(`SELECT ${LIST_COLS} FROM coshh_items i WHERE i.status != 'draft' OR i.created_by_id = ? ORDER BY i.product COLLATE NOCASE`).bind(viewer.accountId || '').all();
  const items = results.map((r) => shape(r, today));
  const used = [...new Set(items.flatMap((i) => i.locations))].filter((l) => !LOCATIONS.includes(l)).sort();
  return { items, locations: [...LOCATIONS, ...used], manage: canManage(viewer), today, release: await releaseState(env),
    options: { where: WHERE_USED, hazards: HAZARDS, ppe: PPE, disposal: DISPOSAL, risks: RISKS, precautions: DEFAULT_PRECAUTIONS } };
}

async function row(env, id) {
  const r = await env.DB.prepare('SELECT * FROM coshh_items WHERE id = ?').bind(Number(id)).first();
  if (!r) throw refuse('That assessment isn\'t in the list any more.', 404);
  return r;
}

export async function get(env, viewer, id) {
  mustSee(viewer);
  const r = await row(env, id);
  if (r.status === 'draft' && r.created_by_id !== viewer.accountId && !canManage(viewer)) throw refuse('That draft is someone else\'s.', 403);
  const { results: photos } = await env.DB.prepare('SELECT id, width, height FROM coshh_photos WHERE item_id = ? ORDER BY id').bind(r.id).all();
  const today = londonDate();
  return { item: { ...shape({ ...r, photo_id: photos[0]?.id }, today), data: json(r.data, {}) }, photos, manage: canManage(viewer) };
}

// ---------- writing the form ----------

const mayEdit = (viewer, r) => r.status !== 'draft' || r.created_by_id === viewer.accountId || canManage(viewer);

// Saved as a draft as it's filled in, so a photo has somewhere to go and nothing is lost.
export async function save(env, viewer, { id, product, data }) {
  mustSee(viewer);
  const now = new Date().toISOString();
  const form = cleanForm(data);
  if (id) {
    const r = await row(env, id);
    if (r.status !== 'draft') return { id: r.id, status: r.status };   // a revision is kept in the form until it's completed
    if (!mayEdit(viewer, r)) throw refuse('That draft is someone else\'s.', 403);
    await env.DB.prepare('UPDATE coshh_items SET product = ?, data = ?, updated_at = ? WHERE id = ?').bind(clip(product, 200), JSON.stringify({ ...json(r.data, {}), ...form }), now, r.id).run();
    return { id: r.id, status: 'draft' };
  }
  const res = await env.DB.prepare(`INSERT INTO coshh_items (product, status, source, data, in_house, locations, created_by_id, created_by, created_at, updated_at)
    VALUES (?, 'draft', 'hub', ?, 1, '[]', ?, ?, ?, ?)`).bind(clip(product, 200), JSON.stringify(form), viewer.accountId || null, nameOf(viewer), now, now).run();
  return { id: res.meta.last_row_id, status: 'draft' };
}

// The size of a JPEG, from its header.
export function jpegSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) + b[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: (b[i + 5] << 8) + b[i + 6], width: (b[i + 7] << 8) + b[i + 8] };
    i += 2 + len;
  }
  return null;
}
const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

export async function addPhoto(env, viewer, id, request) {
  mustSee(viewer);
  const r = await row(env, id);
  if (!mayEdit(viewer, r)) throw refuse('That draft is someone else\'s.', 403);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw refuse('That picture was empty.');
  if (bytes.length > MAX_PHOTO_BYTES) throw refuse('That picture is too big. Take it again a little further away.');
  const size = jpegSize(bytes);
  if (!size) throw refuse('Pictures need to be JPEG.');
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM coshh_photos WHERE item_id = ?').bind(r.id).first();
  if (n >= MAX_PHOTOS) throw refuse(`Up to ${MAX_PHOTOS} pictures. Remove one first.`);
  const res = await env.DB.prepare('INSERT INTO coshh_photos (item_id, data, width, height, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(r.id, toBase64(bytes), size.width, size.height, new Date().toISOString()).run();
  return { id: res.meta.last_row_id, width: size.width, height: size.height };
}

export async function removePhoto(env, viewer, { photoId }) {
  mustSee(viewer);
  const p = await env.DB.prepare('SELECT item_id FROM coshh_photos WHERE id = ?').bind(Number(photoId)).first();
  if (!p) return { ok: true };
  const r = await row(env, p.item_id);
  if (!mayEdit(viewer, r)) throw refuse('That draft is someone else\'s.', 403);
  await env.DB.prepare('DELETE FROM coshh_photos WHERE id = ?').bind(Number(photoId)).run();
  return { ok: true };
}

export async function photo(env, viewer, photoId) {
  mustSee(viewer);
  const p = await env.DB.prepare('SELECT data FROM coshh_photos WHERE id = ?').bind(Number(photoId)).first();
  if (!p) throw refuse('That picture has gone.', 404);
  return Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0));
}

async function photosFor(env, itemId) {
  const { results } = await env.DB.prepare('SELECT data, width, height FROM coshh_photos WHERE item_id = ? ORDER BY id').bind(itemId).all();
  return results.map((p) => ({ base64: p.data, width: p.width, height: p.height }));
}

// The file's name on the page. It stays the same from one review to the next, so each upload is a new
// version of the same file, not another file: "COSHH 1001 - Product.pdf", or for one brought in from the
// page, the name it already had there.
const cleanName = (product) => String(product).replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
export const hubName = (no, product) => `COSHH ${no} - ${cleanName(product)}.pdf`;
const targetName = (r, data) => data.keepName || hubName(r.coshh_no, r.product);
export const keepNameOf = (fileName) => (fileName ? `${String(fileName).replace(/\.[a-z0-9]+$/i, '')}.pdf` : null);

async function buildPdf(env, r, data) {
  const { buildCoshhPdf } = await import('./coshh-pdf.js');
  return buildCoshhPdf({ no: r.coshh_no, product: r.product, inHouse: Boolean(r.in_house), assessedBy: r.assessed_by, assessedOn: r.assessed_on, data }, await photosFor(env, r.id));
}

// What's changed since the last "COSHH review complete", for its release notes.
// How the assessment was just before, so a change made by mistake can be cancelled.
const UNDO_FIELDS = ['product', 'data', 'status', 'source', 'assessed_by', 'assessed_by_id', 'assessed_on', 'last_review_on', 'next_review_on', 'review_told', 'pending', 'release_n',
  'in_house', 'in_house_by', 'in_house_at', 'in_date', 'out_date'];
async function logChange(env, r, kind, viewer, before = null) {
  const args = [r.id, r.coshh_no || null, r.product || '', kind, viewer ? nameOf(viewer) : null, new Date().toISOString()];
  const snap = before ? JSON.stringify(Object.fromEntries(UNDO_FIELDS.map((f) => [f, before[f] ?? null]))) : null;
  try {
    await env.DB.prepare('INSERT INTO coshh_changes (item_id, coshh_no, product, kind, by_name, at, before_state) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(...args, snap).run();
  } catch {
    await env.DB.prepare('INSERT INTO coshh_changes (item_id, coshh_no, product, kind, by_name, at) VALUES (?, ?, ?, ?, ?, ?)').bind(...args).run();
  }
}

// A review today: added to the Next Reviews columns, or in place of one already made today.
function withReview(reviews, viewer, note) {
  const today = londonDate();
  const entry = { name: nameOf(viewer), date: today, note: clip(note, 300) };
  const list = [...(reviews || [])];
  if (list.at(-1)?.date === today) list[list.length - 1] = entry; else list.push(entry);
  return list;
}

// Completing a new assessment: numbered, dated today, made into a PDF and filed in Confluence straight
// away, and in house from today.
export async function submit(env, viewer, { id, product, data }) {
  mustSee(viewer);
  const form = cleanForm(data);
  const gaps = missing(product, form);
  if (gaps.length) throw refuse(`Fill in ${gaps.join(', ')} first.`);
  let r = id ? await row(env, id) : null;
  if (!r) r = await row(env, (await save(env, viewer, { product, data })).id);
  if (!mayEdit(viewer, r)) throw refuse('That draft is someone else\'s.', 403);
  if (r.status !== 'draft') throw refuse('That one is already completed. Use Review found changes to change it.');
  const today = londonDate();
  const old = json(r.data, {});
  const no = r.coshh_no || Math.max(FIRST_NO - 1, Number((await env.DB.prepare('SELECT MAX(coshh_no) AS n FROM coshh_items').first())?.n) || 0) + 1;
  const kept = { ...form, reviews: [], pastFiles: old.pastFiles || [] };
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE coshh_items SET coshh_no = ?, rev = 1, product = ?, status = 'done', data = ?, assessed_by = ?, assessed_by_id = ?, assessed_on = ?,
      last_review_on = NULL, next_review_on = ?, review_told = NULL, in_house = 1, in_house_by = ?, in_house_at = ?, in_date = ?, out_date = NULL, pending = NULL, updated_at = ? WHERE id = ?`)
    .bind(no, clip(product, 200), JSON.stringify(kept), nameOf(viewer), viewer.accountId || null, today, addYear(today), nameOf(viewer), now, today, now, r.id).run();
  r = await row(env, r.id);
  const filed = await file(env, r, kept);
  await logChange(env, r, 'added', viewer);
  await syncHouse(env).catch(() => {});
  await record(env, viewer, { area: 'COSHH', action: 'completed a COSHH assessment', subjectType: 'coshh', subjectId: String(r.id), label: `COSHH ${no}: ${r.product}`.slice(0, 120) }).catch(() => {});
  return { ok: true, id: r.id, no, ...filed };
}

// Renames a file on the page, keeping its versions, so its next upload carries on as the same file.
async function renameAttachment(env, attachmentId, title) {
  const got = await confluence(env, `/wiki/rest/api/content/${encodeURIComponent(attachmentId)}?expand=version`);
  if (!got.ok) throw new Error(`Confluence ${got.status}`);
  const a = await got.json();
  if (a.title === title) return;
  const res = await confluence(env, `/wiki/rest/api/content/${pageId(env)}/child/attachment/${encodeURIComponent(attachmentId)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: String(attachmentId), type: 'attachment', title, version: { number: (a.version?.number || 1) + 1, minorEdit: true }, container: { id: pageId(env), type: 'page' } }),
  });
  if (!res.ok) throw new Error(`Confluence ${res.status}`);
}

// The PDF onto the Confluence page, as a new version of its file, noted on the item.
async function file(env, r, data) {
  const name = targetName(r, data);
  let attachmentId = null;
  let note = null;
  try {
    const bytes = await buildPdf(env, r, data);
    // Its PDF on the page under another name (an older "Rev" name, or before the product was renamed) is renamed first.
    const was = r.pdf_name || r.file_name;
    if (r.confluence_id && was && was !== name && /\.pdf$/i.test(was)) await renameAttachment(env, r.confluence_id, name).catch(() => {});
    const last = data.reviews?.at(-1);
    attachmentId = await toConfluence(env, name, bytes, `COSHH ${r.coshh_no}${last ? `, reviewed ${last.date}` : ''}`);
  } catch (err) { note = `Not filed in Confluence: ${String(err.message).slice(0, 200)}`; }
  // Any file of its before this one is remembered, so bringing files in from the page never takes it for another.
  if (attachmentId && r.confluence_id && String(r.confluence_id) !== String(attachmentId)) {
    const kept = json((await env.DB.prepare('SELECT data FROM coshh_items WHERE id = ?').bind(r.id).first())?.data, {});
    kept.pastFiles = [...new Set([...(kept.pastFiles || []), String(r.confluence_id)])];
    await env.DB.prepare('UPDATE coshh_items SET data = ? WHERE id = ?').bind(JSON.stringify(kept), r.id).run();
  }
  await env.DB.prepare('UPDATE coshh_items SET pdf_name = ?, confluence_id = COALESCE(?, confluence_id), confluence_note = ? WHERE id = ?').bind(name, attachmentId, note, r.id).run();
  if (note) {
    const { raiseAlert } = await import('./sync.js');
    await raiseAlert(env, { kind: 'coshh-filing', dedupe: `coshh-filing:${r.id}:${londonDate()}`, subject: `COSHH ${r.coshh_no} wasn't filed in Confluence`,
      body: `COSHH ${r.coshh_no} (${r.product}) is saved in the hub, but:\n\n${note}\n\nIt can be downloaded from the COSHH tile and added to the page by hand, or filed again from there.` }).catch(() => {});
  }
  return { filed: Boolean(attachmentId), fileNote: note, fileName: name };
}

// Filing again, after Confluence wasn't reached.
export async function refile(env, viewer, { id }) {
  mustSee(viewer);
  const r = await row(env, id);
  if (r.status !== 'done') throw refuse('Only a completed assessment is filed.');
  const out = await file(env, r, json(r.data, {}));
  if (out.filed) await env.DB.prepare('UPDATE coshh_items SET pending = NULL WHERE id = ?').bind(r.id).run();
  return out;
}

// A review that found nothing to change: its date goes in the next Next Reviews column. The PDF goes to
// Confluence with the rest at "COSHH review complete".
export async function review(env, viewer, { id, note }) {
  mustSee(viewer);
  const r = await row(env, id);
  if (r.status === 'imported') throw refuse('This one came from Confluence. Fill it in from its document first, so the hub can make its PDF.');
  if (r.status !== 'done') throw refuse('Complete the assessment first.');
  const today = londonDate();
  const data = json(r.data, {});
  data.reviews = withReview(data.reviews, viewer, note);
  await env.DB.prepare('UPDATE coshh_items SET data = ?, last_review_on = ?, next_review_on = ?, review_told = NULL, pending = CASE WHEN release_n IS NULL THEN COALESCE(pending, ?) ELSE ? END, release_n = NULL, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(data), today, addYear(today), 'review', 'review', new Date().toISOString(), r.id).run();
  await logChange(env, r, 'reviewed', viewer, r);
  await record(env, viewer, { area: 'COSHH', action: 'reviewed a COSHH assessment', subjectType: 'coshh', subjectId: String(r.id),
    label: `${r.coshh_no ? `COSHH ${r.coshh_no}: ` : ''}${r.product}`.slice(0, 120), changes: note ? [{ label: 'Note', before: '', after: clip(note, 300) }] : [] }).catch(() => {});
  return { ok: true, nextReviewOn: addYear(today), reviews: data.reviews.length, waiting: true };
}

// A review that found changes: the assessment's details changed and the review dated today. One brought
// in from Confluence is filled in from its document the first time, and kept by the hub from then on,
// under the same file name. Either way it goes to Confluence at "COSHH review complete".
export async function change(env, viewer, { id, product, data, note, changed = true, assessedBy, assessedOn }) {
  mustSee(viewer);
  const r = await row(env, id);
  if (!['done', 'imported'].includes(r.status)) throw refuse('Complete the assessment first.');
  const first = r.status === 'imported';
  if (first && !r.coshh_no) throw refuse('Give it its COSHH number first, under The form.');
  const form = cleanForm(data);
  const gaps = missing(product, form);
  if (gaps.length) throw refuse(`Fill in ${gaps.join(', ')} first.`);
  if (first && assessedOn && !isDay(assessedOn)) throw refuse('Give the assessment date from the document.');
  const today = londonDate();
  const old = json(r.data, {});
  const kept = { ...form, reviews: withReview(first ? [] : old.reviews, viewer, note), pastFiles: old.pastFiles || [], keepName: first ? keepNameOf(r.file_name) || hubName(r.coshh_no, product) : old.keepName };
  await env.DB.prepare(`UPDATE coshh_items SET product = ?, data = ?, status = 'done', source = 'hub', assessed_by = ?, assessed_by_id = ?, assessed_on = ?,
      last_review_on = ?, next_review_on = ?, review_told = NULL, pending = ?, release_n = NULL, updated_at = ? WHERE id = ?`)
    .bind(clip(product, 200), JSON.stringify(kept), first ? clip(assessedBy, 120) || nameOf(viewer) : r.assessed_by, first ? null : r.assessed_by_id,
      first ? assessedOn || r.assessed_on : r.assessed_on, today, addYear(today), changed ? 'changes' : 'review', new Date().toISOString(), r.id).run();
  await logChange(env, { ...r, product: clip(product, 200) }, changed ? 'changed' : 'reviewed', viewer, r);
  await record(env, viewer, { area: 'COSHH', action: changed ? 'reviewed a COSHH assessment and changed it' : 'reviewed a COSHH assessment', subjectType: 'coshh', subjectId: String(r.id),
    label: `COSHH ${r.coshh_no}: ${clip(product, 200)}`.slice(0, 120), changes: first ? [{ label: 'Kept by', before: 'Confluence', after: 'The hub' }] : [] }).catch(() => {});
  return { ok: true, id: r.id, nextReviewOn: addYear(today), waiting: true };
}

// ---------- in house, and where ----------

// In house or not: dated, and the dates table on the Confluence page changed straight away.
export async function setInHouse(env, viewer, { id, inHouse }) {
  mustSee(viewer);
  const r = await row(env, id);
  if (r.status === 'draft') throw refuse('Complete the assessment first.');
  const on = inHouse ? 1 : 0;
  if (on === r.in_house) return { ok: true, inHouse: Boolean(on) };
  const today = londonDate();
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE coshh_items SET in_house = ?, in_house_by = ?, in_house_at = ?, ${on ? 'in_date' : 'out_date'} = ?, updated_at = ? WHERE id = ?`)
    .bind(on, nameOf(viewer), now, today, now, r.id).run();
  await logChange(env, r, on ? 'in' : 'out', viewer, r);
  const page = await syncHouse(env).catch((err) => ({ error: err.message }));
  await record(env, viewer, { area: 'COSHH', action: on ? 'marked a COSHH product in house' : 'marked a COSHH product no longer in house', subjectType: 'coshh', subjectId: String(r.id), label: r.product }).catch(() => {});
  return { ok: true, inHouse: Boolean(on), page };
}

export async function setLocations(env, viewer, { id, locations }) {
  mustSee(viewer);
  const r = await row(env, id);
  const list = cleanLocations(locations);
  await env.DB.prepare('UPDATE coshh_items SET locations = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(list), new Date().toISOString(), r.id).run();
  return { ok: true, locations: list };
}

// One brought in from Confluence: its name, number and date as they should be.
export async function setDetails(env, viewer, { id, product, no, assessedOn }) {
  mustSee(viewer);
  const r = await row(env, id);
  if (r.source !== 'confluence') throw refuse('Revise a hub assessment to change it.');
  if (!clip(product)) throw refuse('Give the product name.');
  if (assessedOn && !isDay(assessedOn)) throw refuse('Give the assessment date.');
  const other = Number(no) ? await env.DB.prepare("SELECT product FROM coshh_items WHERE coshh_no = ? AND id != ? AND status != 'draft'").bind(Number(no), r.id).first() : null;
  if (other) throw refuse(`COSHH ${Number(no)} is already ${other.product}.`);
  const last = r.last_review_on && (!assessedOn || r.last_review_on > assessedOn) ? r.last_review_on : assessedOn || r.assessed_on;
  await env.DB.prepare('UPDATE coshh_items SET product = ?, coshh_no = ?, assessed_on = ?, next_review_on = ?, review_told = NULL, updated_at = ? WHERE id = ?')
    .bind(clip(product, 200), Number(no) || null, assessedOn || r.assessed_on, addYear(last), new Date().toISOString(), r.id).run();
  if ((Number(no) || null) !== r.coshh_no) await syncHouse(env).catch(() => {});
  return { ok: true };
}

export async function remove(env, viewer, { id }) {
  mustSee(viewer);
  const r = await row(env, id);
  if (r.status === 'draft' ? !mayEdit(viewer, r) : !canManage(viewer)) throw refuse(r.status === 'draft' ? 'That draft is someone else\'s.' : 'Only management can remove an assessment. Mark it no longer in house instead.', 403);
  await env.DB.prepare('DELETE FROM coshh_photos WHERE item_id = ?').bind(r.id).run();
  await env.DB.prepare('DELETE FROM coshh_items WHERE id = ?').bind(r.id).run();
  if (r.status !== 'draft') await record(env, viewer, { area: 'COSHH', action: 'removed a COSHH assessment from the hub', subjectType: 'coshh', subjectId: String(r.id), label: r.product }).catch(() => {});
  return { ok: true };
}

// The file: a hub assessment's PDF, made now, or the one on Confluence.
export async function download(env, viewer, id) {
  mustSee(viewer);
  const r = await row(env, id);
  if (r.status === 'draft' && !mayEdit(viewer, r)) throw refuse('That draft is someone else\'s.', 403);
  if (r.source === 'confluence') {
    const link = json(r.data, {}).download || `/download/attachments/${pageId(env)}/${encodeURIComponent(r.file_name || '')}`;
    const res = await confluence(env, `/wiki${link}`, { redirect: 'follow', headers: { Accept: '*/*' } });
    if (!res.ok) throw refuse(`Confluence didn't send the file (${res.status}).`, 502);
    return { bytes: new Uint8Array(await res.arrayBuffer()), name: r.file_name || `${r.product}.pdf`, type: res.headers.get('content-type') || 'application/octet-stream' };
  }
  const data = json(r.data, {});
  const preview = r.status === 'draft' ? { ...r, coshh_no: r.coshh_no || 'Draft', assessed_by: r.assessed_by || r.created_by } : r;
  return { bytes: await buildPdf(env, preview, data), name: r.status === 'draft' ? `COSHH Draft - ${cleanName(r.product || 'Not named')}.pdf` : targetName(r, data), type: 'application/pdf' };
}

// ---------- Confluence ----------

const pageId = (env) => String(env.COSHH_CONFLUENCE_PAGE || '666533895');
function confluence(env, path, init = {}) {
  return fetch(`${env.JIRA_BASE_URL}${path}`, { ...init, headers: { Authorization: `Basic ${btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`)}`, Accept: 'application/json', ...(init.headers || {}) } });
}

async function toConfluence(env, name, bytes, comment) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
  form.append('minorEdit', 'true');
  form.append('comment', comment);
  // PUT adds it, or a new version of the file of the same name.
  const res = await confluence(env, `/wiki/rest/api/content/${pageId(env)}/child/attachment`, { method: 'PUT', headers: { 'X-Atlassian-Token': 'nocheck' }, body: form });
  if (!res.ok) throw new Error(`Confluence ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data = await res.json().catch(() => ({}));
  return String(data.results?.[0]?.id || data.id || '') || null;
}

// The assessments already on the page: each file not from the hub becomes an item, not in house
// until someone says it is, dated from when it was put there.
export async function importFromConfluence(env, viewer) {
  mustSee(viewer);
  if (!canManage(viewer)) throw refuse('Only management can bring assessments in from Confluence.', 403);
  const { results: rows } = await env.DB.prepare('SELECT confluence_id, data FROM coshh_items').all();
  const known = new Set([...rows.flatMap((r) => [r.confluence_id, ...(json(r.data, {}).pastFiles || [])]), ...await skipped(env)].filter(Boolean).map(String));
  let start = 0;
  let added = 0;
  const now = new Date().toISOString();
  for (let page = 0; page < 10; page++) {
    const res = await confluence(env, `/wiki/rest/api/content/${pageId(env)}/child/attachment?limit=100&start=${start}&expand=version`);
    if (!res.ok) throw refuse(`Confluence didn't list the page's files (${res.status}). Check the hub's Jira account can see the COSHH page.`, 502);
    const data = await res.json();
    for (const a of data.results || []) {
      const id = String(a.id);
      const title = String(a.title || '');
      if (known.has(id) || !/\.(pdf|docx?|xlsx?)$/i.test(title)) continue;
      const no = Number(/\b(\d{4})\b/.exec(title)?.[1]) || null;
      const product = title.replace(/\.[a-z0-9]+$/i, '').replace(/^(coshh|c\.o\.s\.h\.h\.?)[\s_-]*/i, '').replace(/^\d{3,5}[\s_-]*/, '').replace(/[_]+/g, ' ').trim() || title;
      const when = String(a.version?.when || '').slice(0, 10);
      const day = isDay(when) ? when : londonDate();
      await env.DB.prepare(`INSERT OR IGNORE INTO coshh_items (coshh_no, rev, product, status, source, data, in_house, locations, assessed_on, next_review_on, file_name, confluence_id, created_by, created_at, updated_at)
        VALUES (?, 1, ?, 'imported', 'confluence', ?, 0, '[]', ?, ?, ?, ?, ?, ?, ?)`).bind(no, product.slice(0, 200), JSON.stringify({ download: a._links?.download || null }), day, addYear(day), title, id, 'Confluence', now, now).run();
      known.add(id);
      added++;
    }
    if (!data._links?.next || !(data.results || []).length) break;
    start += data.results.length;
  }
  const removed = await dedupe(env);
  if (added) await syncHouse(env).catch(() => {});
  await record(env, viewer, { area: 'COSHH', action: 'brought COSHH assessments in from Confluence', subjectType: 'coshh', subjectId: pageId(env), label: `${added} added${removed ? `, ${removed} duplicates removed` : ''}` }).catch(() => {});
  return { ok: true, added: added - removed, removed };
}

// ---------- duplicates ----------

// Files from the page the hub has let go of (a duplicate's), so bringing files in doesn't add them again.
async function skipped(env) {
  return json((await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'coshh_skipped_files'").first().catch(() => null))?.value, []);
}

// More than one item with the same COSHH number (the same product's document on the page more than
// once): the one reviewed most recently is kept, with the others' places and in-house state, and the
// others removed from the hub. Their files stay on the page.
export async function dedupe(env) {
  const { results } = await env.DB.prepare("SELECT * FROM coshh_items WHERE coshh_no IS NOT NULL AND status != 'draft' ORDER BY coshh_no").all();
  const groups = new Map();
  for (const r of results) groups.set(r.coshh_no, [...(groups.get(r.coshh_no) || []), r]);
  const latest = (r) => [r.last_review_on, r.assessed_on].filter(Boolean).sort().at(-1) || '';
  const drop = [];
  const skip = new Set(await skipped(env));
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => latest(b).localeCompare(latest(a)) || (a.source === 'hub' ? -1 : 0) - (b.source === 'hub' ? -1 : 0) || b.id - a.id);
    const [keep, ...rest] = list;
    const data = json(keep.data, {});
    data.pastFiles = [...new Set([...(data.pastFiles || []), ...rest.flatMap((x) => [x.confluence_id, ...(json(x.data, {}).pastFiles || [])]).filter(Boolean).map(String)])];
    const places = [...new Set([keep, ...rest].flatMap((x) => json(x.locations, [])))].slice(0, 12);
    const max = (k) => [keep, ...rest].map((x) => x[k]).filter(Boolean).sort().at(-1) || null;
    await env.DB.prepare('UPDATE coshh_items SET data = ?, locations = ?, in_house = ?, in_date = ?, out_date = ? WHERE id = ?')
      .bind(JSON.stringify(data), JSON.stringify(places), [keep, ...rest].some((x) => x.in_house) ? 1 : 0, max('in_date'), max('out_date'), keep.id).run();
    for (const x of rest) { drop.push(x.id); if (x.confluence_id) skip.add(String(x.confluence_id)); }
  }
  for (const id of drop) {
    await env.DB.prepare('DELETE FROM coshh_photos WHERE item_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM coshh_items WHERE id = ?').bind(id).run();
  }
  if (drop.length) await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('coshh_skipped_files', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify([...skip])).run();
  return drop.length;
}

// ---------- the Confluence page's tables ----------
// Each found by its headings, so moving things about on the page doesn't matter.

const plainOf = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const keyOf = (html) => plainOf(html).toLowerCase().replace(/[^a-z0-9]/g, '');
const cellsOf = (row) => [...row.matchAll(/<(td|th)\b[^>]*>[\s\S]*?<\/\1>/g)];
const innerOf = (cell) => cell.replace(/^<(td|th)\b[^>]*>/, '').replace(/<\/(td|th)>\s*$/, '');
const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const para = (text) => (text ? `<p>${escHtml(text)}</p>` : '<p />');
export const longDay = (day) => (isDay(day) ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');

export function findTable(body, heads) {
  for (const t of String(body).matchAll(/<table\b[\s\S]*?<\/table>/g)) {
    const rows = [...t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/g)];
    for (let i = 0; i < rows.length; i++) {
      const keys = cellsOf(rows[i][0]).map((c) => keyOf(c[0]));
      if (heads.every((h) => keys.includes(h))) return { start: t.index, end: t.index + t[0].length, html: t[0], rows, headAt: i, keys };
    }
  }
  return null;
}
const swapTable = (body, t, html) => body.slice(0, t.start) + html + body.slice(t.end);

// The document control table at the top: its Ref, Owner, Team and the issue it's at.
export function readTop(body) {
  const t = findTable(body, ['version', 'lastreviewed']);
  const row = t?.rows[t.headAt + 1];
  if (!row) return null;
  const cells = cellsOf(row[0]).map((c) => c[0]);
  const at = (k) => cells[t.keys.indexOf(k)];
  const current = Number(/(\d+)/.exec(plainOf(at('version') || ''))?.[1]);
  if (!Number.isFinite(current)) return null;
  return { current, ref: plainOf(at('ref') || ''), ownerHtml: at('owner') ? innerOf(at('owner')) : '', teamHtml: at('team') ? innerOf(at('team')) : '', versionText: plainOf(at('version')) };
}

// Version to the new issue and Last Reviewed to the day; the rest of the row is left alone.
export function setTop(body, n, day) {
  const t = findTable(body, ['version', 'lastreviewed']);
  const row = t?.rows[t.headAt + 1];
  if (!row) return { body, updated: false };
  const cells = cellsOf(row[0]);
  const version = cells[t.keys.indexOf('version')];
  const reviewed = cells[t.keys.indexOf('lastreviewed')];
  if (!version || !reviewed) return { body, updated: false };
  const text = plainOf(version[0]);
  const edits = [[version, para(/\d+/.test(text) ? text.replace(/\d+/, String(n)) : `Issue ${n}`)], [reviewed, para(longDay(day))]].sort((a, b) => b[0].index - a[0].index);
  let html = row[0];
  for (const [c, inner] of edits) {
    const open = /^<(td|th)\b[^>]*>/.exec(c[0])[0];
    html = html.slice(0, c.index) + `${open}${inner}</${c[1]}>` + html.slice(c.index + c[0].length);
  }
  const table = t.html.slice(0, row.index) + html + t.html.slice(row.index + row[0].length);
  return { body: swapTable(body, t, table), updated: true };
}

// A row at the top of the Version History table, under its headings, as the newest rows are.
export function addHistory(body, { ref, ownerHtml, teamHtml, day, notes }) {
  const t = findTable(body, ['ref', 'released']);
  if (!t) return { body, updated: false };
  const head = t.rows[t.headAt];
  const value = { ref: para(ref), owner: ownerHtml || '<p />', team: teamHtml || '<p />', released: para(longDay(day)), releasenotes: para(notes) };
  const row = `<tr>${t.keys.map((k) => `<td>${value[k] ?? '<p />'}</td>`).join('')}</tr>`;
  const at = head.index + head[0].length;
  return { body: swapTable(body, t, t.html.slice(0, at) + row + t.html.slice(at)), updated: true };
}

// The in house / out of house dates table: a row for each COSHH number, in order. The hub's dates go in
// where it has them; anything else already in a row is kept, and empty rows go.
export function setHouse(body, items) {
  const t = findTable(body, ['coshhid', 'mostrecentdateinhouse', 'mostrecentdateoutofhouse']);
  if (!t) return { body, updated: false };
  const idAt = t.keys.indexOf('coshhid');
  const inAt = t.keys.indexOf('mostrecentdateinhouse');
  const outAt = t.keys.indexOf('mostrecentdateoutofhouse');
  const rows = new Map();
  for (const r of t.rows.slice(t.headAt + 1)) {
    const cells = cellsOf(r[0]).map((c) => innerOf(c[0]));
    const no = Number(/(\d{3,6})/.exec(plainOf(cells[idAt] || ''))?.[1]);
    if (no) rows.set(no, cells);
  }
  for (const i of items) {
    const cells = rows.get(i.coshh_no) || t.keys.map(() => '<p />');
    cells[idAt] = para(`COSHH ${i.coshh_no}`);
    if (i.in_date) cells[inAt] = para(longDay(i.in_date));
    if (i.out_date) cells[outAt] = para(longDay(i.out_date));
    rows.set(i.coshh_no, cells);
  }
  const html = [...rows].sort((a, b) => a[0] - b[0]).map(([, cells]) => `<tr>${t.keys.map((_, k) => `<td>${cells[k] || '<p />'}</td>`).join('')}</tr>`).join('');
  const head = t.rows[t.headAt];
  const last = t.rows.at(-1);
  const table = t.html.slice(0, head.index + head[0].length) + html + t.html.slice(last.index + last[0].length);
  return { body: swapTable(body, t, table), updated: table !== t.html };
}

async function pageGet(env) {
  const res = await confluence(env, `/wiki/rest/api/content/${pageId(env)}?expand=body.storage,version`);
  if (!res.ok) throw new Error(`Confluence ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json();
}

// Reads the page, changes it, and saves it as a minor edit; tried twice if someone saved it in between.
async function editPage(env, change, message) {
  for (let i = 0; i < 2; i++) {
    const page = await pageGet(env);
    const before = page.body?.storage?.value || '';
    const after = change(before, page);
    if (after === before) return { changed: false };
    const res = await confluence(env, `/wiki/rest/api/content/${pageId(env)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pageId(env), type: 'page', title: page.title, body: { storage: { value: after, representation: 'storage' } }, version: { number: (page.version?.number || 1) + 1, minorEdit: true, message } }),
    });
    if (res.ok) return { changed: true };
    if (res.status !== 409 || i) throw new Error(`Confluence ${res.status}: ${(await res.text()).slice(0, 150)}`);
  }
  return { changed: false };
}

const houseItems = async (env) => (await env.DB.prepare("SELECT coshh_no, in_date, out_date FROM coshh_items WHERE coshh_no IS NOT NULL AND status != 'draft'").all()).results;

// The in/out of house dates onto the page, as they change. If Confluence can't be reached it's tried again each hour.
export async function syncHouse(env) {
  const items = await houseItems(env);
  let found = true;
  try {
    await editPage(env, (body) => { const r = setHouse(body, items); found = r.updated || Boolean(findTable(body, ['coshhid', 'mostrecentdateinhouse', 'mostrecentdateoutofhouse'])); return r.body; }, 'COSHH in house dates');
    await env.DB.prepare("DELETE FROM sync_state WHERE key = 'coshh_house_dirty'").run();
    return { ok: true, found };
  } catch (err) {
    await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('coshh_house_dirty', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(err.message).slice(0, 200)).run();
    throw err;
  }
}

// ---------- COSHH review complete ----------
// Reviews and changes collect in the hub. "COSHH review complete" files their PDFs, moves the page on an
// issue and adds a row to its Version History, with notes saying what changed.

const SEND_EACH_TIME = 12;
const pad2 = (n) => String(n).padStart(2, '0');
const nums = (list) => list.map((c) => c.coshh_no).filter(Boolean).sort((a, b) => a - b).map((n, i) => (i ? n : `COSHH ${n}`)).join(', ');
const named = (list) => list.map((c) => `COSHH ${c.coshh_no || '?'} (${c.product})`).join(', ');

// What changed, in a few lines, for the Release Notes.
export function notesFor(changes) {
  const last = new Map();
  const kinds = new Map();
  for (const c of changes) {
    const k = kinds.get(c.item_id) || new Set();
    k.add(c.kind);
    kinds.set(c.item_id, k);
    last.set(c.item_id, c);
  }
  const pick = (test) => [...kinds].filter(([, k]) => test(k)).map(([id]) => last.get(id));
  const house = new Map();
  for (const c of changes) if (c.kind === 'in' || c.kind === 'out') house.set(c.item_id, c);
  const parts = [];
  const added = pick((k) => k.has('added'));
  const changed = pick((k) => k.has('changed'));
  const reviewed = pick((k) => k.has('reviewed') && !k.has('changed'));
  const ins = [...house.values()].filter((c) => c.kind === 'in');
  const outs = [...house.values()].filter((c) => c.kind === 'out');
  if (reviewed.length) parts.push(`Reviewed with no changes: ${nums(reviewed)}.`);
  if (changed.length) parts.push(`Reviewed with changes: ${named(changed)}.`);
  if (added.length) parts.push(`Added: ${named(added)}.`);
  if (ins.length) parts.push(`Back in house: ${nums(ins)}.`);
  if (outs.length) parts.push(`No longer in house: ${nums(outs)}.`);
  return parts.join(' ') || 'Reviewed risk assessments';
}

export async function releaseState(env) {
  const { results: changes } = await env.DB.prepare('SELECT * FROM coshh_changes WHERE release_n IS NULL ORDER BY id').all();
  const { results: waiting } = await env.DB.prepare("SELECT id, coshh_no, product, pending FROM coshh_items WHERE pending IS NOT NULL AND release_n IS NULL AND status = 'done' ORDER BY coshh_no").all();
  const open = await env.DB.prepare("SELECT * FROM coshh_releases WHERE status != 'done' ORDER BY n DESC LIMIT 1").first();
  const last = await env.DB.prepare("SELECT n, ref, released_on, by_name FROM coshh_releases WHERE status = 'done' ORDER BY n DESC LIMIT 1").first();
  const left = open ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM coshh_items WHERE release_n = ? AND pending IS NOT NULL').bind(open.n).first()).n : 0;
  return {
    waiting: waiting.map((w) => ({ id: w.id, no: w.coshh_no, product: w.product, kind: w.pending === 'review' ? 'reviewed' : 'changed' })),
    changes: changes.length, since: changes[0]?.at || null, notes: notesFor(changes),
    list: changes.map((c) => ({ id: c.id, itemId: c.item_id, no: c.coshh_no, product: c.product, kind: c.kind, by: c.by_name, at: c.at,
      latest: !changes.some((x) => x.item_id === c.item_id && x.id > c.id) })),
    open: open ? { n: open.n, ref: open.ref, status: open.status, error: open.error, left, by: open.by_name } : null,
    last: last ? { n: last.n, ref: last.ref, on: last.released_on, by: last.by_name } : null,
  };
}

// Cancelling a change made by mistake, before the review is completed. The assessment goes back to
// how it was just before (a review, a change to the form, or in or out of house, with the dates table
// on the page put back too). A new product is already on the page, so it's only left out of the notes.
export async function undoChange(env, viewer, { id }) {
  mustSee(viewer);
  const c = await env.DB.prepare('SELECT * FROM coshh_changes WHERE id = ?').bind(Number(id)).first();
  if (!c) throw refuse('That change has gone already.', 404);
  if (c.release_n != null) throw refuse('That change has already gone to Confluence with a completed review.', 409);
  const later = await env.DB.prepare('SELECT kind FROM coshh_changes WHERE item_id = ? AND id > ? AND release_n IS NULL ORDER BY id DESC LIMIT 1').bind(c.item_id, c.id).first();
  if (later && c.kind !== 'added') throw refuse('A later change to the same assessment is waiting too. Cancel that one first.', 409);
  const r = await env.DB.prepare('SELECT * FROM coshh_items WHERE id = ?').bind(c.item_id).first();
  const label = `${c.coshh_no ? `COSHH ${c.coshh_no}: ` : ''}${c.product || ''}`.slice(0, 120);
  let page = null;
  if (r && c.kind !== 'added') {
    const before = c.before_state ? json(c.before_state, null) : null;
    const now = new Date().toISOString();
    if (before) {
      const fields = ['reviewed', 'changed'].includes(c.kind) ? UNDO_FIELDS.filter((f) => !['in_house', 'in_house_by', 'in_house_at', 'in_date', 'out_date'].includes(f))
        : ['in_house', 'in_house_by', 'in_house_at', 'in_date', 'out_date'];
      await env.DB.prepare(`UPDATE coshh_items SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...fields.map((f) => before[f]), now, r.id).run();
    } else if (['reviewed', 'changed'].includes(c.kind)) {
      // From before changes were kept: the review it added comes off, and the dates go back to the one before.
      const data = json(r.data, {});
      const reviews = [...(data.reviews || [])];
      if (reviews.length && reviews.at(-1).date === String(c.at).slice(0, 10)) reviews.pop();
      data.reviews = reviews;
      const lastOn = reviews.at(-1)?.date || r.assessed_on || null;
      const others = await env.DB.prepare("SELECT 1 FROM coshh_changes WHERE item_id = ? AND id != ? AND release_n IS NULL AND kind IN ('reviewed', 'changed')").bind(r.id, c.id).first();
      await env.DB.prepare('UPDATE coshh_items SET data = ?, last_review_on = ?, next_review_on = ?, pending = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(data), lastOn, lastOn ? addYear(lastOn) : r.next_review_on, others ? r.pending : null, now, r.id).run();
    } else {
      const on = c.kind === 'in' ? 0 : 1;
      const today = String(c.at).slice(0, 10);
      await env.DB.prepare(`UPDATE coshh_items SET in_house = ?, ${on ? 'out_date' : 'in_date'} = CASE WHEN ${on ? 'out_date' : 'in_date'} = ? THEN NULL ELSE ${on ? 'out_date' : 'in_date'} END, updated_at = ? WHERE id = ?`)
        .bind(on, today, now, r.id).run();
    }
    if (c.kind === 'in' || c.kind === 'out') page = await syncHouse(env).catch((err) => ({ error: err.message }));
  }
  await env.DB.prepare('DELETE FROM coshh_changes WHERE id = ?').bind(c.id).run();
  const what = { reviewed: 'review', changed: 'review with changes', added: 'new product', in: 'back in house', out: 'no longer in house' }[c.kind] || c.kind;
  await record(env, viewer, { area: 'COSHH', action: `cancelled a COSHH change (${what})`, subjectType: 'coshh', subjectId: String(c.item_id || ''), label }).catch(() => {});
  return { ok: true, kind: c.kind, page, partial: !c.before_state && c.kind === 'changed' };
}

// The button: everything waiting goes out as the next issue.
export async function release(env, viewer, { notes } = {}) {
  mustSee(viewer);
  const open = await env.DB.prepare("SELECT n FROM coshh_releases WHERE status != 'done' ORDER BY n DESC LIMIT 1").first();
  if (open) return sendRelease(env, open.n);
  const { results: changes } = await env.DB.prepare('SELECT * FROM coshh_changes WHERE release_n IS NULL ORDER BY id').all();
  const { n: pendingN } = await env.DB.prepare("SELECT COUNT(*) AS n FROM coshh_items WHERE pending IS NOT NULL AND status = 'done'").first();
  if (!changes.length && !pendingN) throw refuse('Nothing has changed since the last COSHH review was completed.');
  let page;
  try { page = await pageGet(env); } catch (err) { throw refuse(`The COSHH page in Confluence couldn't be read, so nothing was sent: ${err.message}`, 502); }
  const top = readTop(page.body?.storage?.value || '');
  if (!top) throw refuse('The COSHH page\'s table with Version and Last Reviewed couldn\'t be found, so nothing was sent.', 409);
  const lastN = (await env.DB.prepare('SELECT MAX(n) AS n FROM coshh_releases').first())?.n || 0;
  const n = Math.max(top.current, lastN) + 1;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO coshh_releases (n, ref, released_on, by_name, by_email, notes, status, at, touched_at) VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?)")
      .bind(n, `${top.ref || 'IMS1.09'}.${pad2(n)}`, londonDate(), nameOf(viewer), viewer.email || null, clip(notes, 1000) || notesFor(changes), now, now),
    env.DB.prepare('UPDATE coshh_changes SET release_n = ? WHERE release_n IS NULL').bind(n),
    env.DB.prepare("UPDATE coshh_items SET release_n = ? WHERE pending IS NOT NULL AND status = 'done'").bind(n),
  ]);
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('coshh_page_top', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify({ ownerHtml: top.ownerHtml, teamHtml: top.teamHtml })).run();
  await record(env, viewer, { area: 'COSHH', action: 'completed a COSHH review', subjectType: 'coshh', subjectId: `release-${n}`, label: `Issue ${n}`, note: clip(notes, 300) || null }).catch(() => {});
  return sendRelease(env, n, { limit: SEND_EACH_TIME - 1 });
}

export async function continueRelease(env, viewer, { n }) {
  mustSee(viewer);
  return sendRelease(env, Number(n));
}

// A few PDFs at a time; once they're all filed, the page.
export async function sendRelease(env, n, { limit = SEND_EACH_TIME } = {}) {
  const rel = await env.DB.prepare('SELECT * FROM coshh_releases WHERE n = ?').bind(n).first();
  if (!rel) throw refuse('That COSHH review isn\'t in the hub.', 404);
  if (rel.status === 'done') return { ok: true, n, ref: rel.ref, done: true, left: 0 };
  const now = () => new Date().toISOString();
  await env.DB.prepare("UPDATE coshh_releases SET status = 'sending', error = NULL, touched_at = ? WHERE n = ?").bind(now(), n).run();
  const { results: items } = await env.DB.prepare('SELECT * FROM coshh_items WHERE release_n = ? AND pending IS NOT NULL ORDER BY coshh_no LIMIT ?').bind(n, limit).all();
  let sent = 0;
  for (const r of items) {
    const out = await file(env, r, json(r.data, {}));
    if (!out.filed) {
      await env.DB.prepare("UPDATE coshh_releases SET status = 'failed', error = ?, touched_at = ? WHERE n = ?").bind(`COSHH ${r.coshh_no}: ${out.fileNote}`.slice(0, 300), now(), n).run();
      return { ok: false, n, ref: rel.ref, sent, error: `COSHH ${r.coshh_no}: ${out.fileNote}` };
    }
    await env.DB.prepare('UPDATE coshh_items SET pending = NULL WHERE id = ?').bind(r.id).run();
    sent++;
  }
  const { left } = await env.DB.prepare('SELECT COUNT(*) AS left FROM coshh_items WHERE release_n = ? AND pending IS NOT NULL').bind(n).first();
  if (left) return { ok: true, n, ref: rel.ref, sent, left };
  const top = json((await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'coshh_page_top'").first())?.value, {});
  const items2 = await houseItems(env);
  const found = { top: false, history: false };
  try {
    await editPage(env, (body) => {
      const a = setTop(body, n, rel.released_on);
      const b = addHistory(a.body, { ref: rel.ref, ownerHtml: top.ownerHtml, teamHtml: top.teamHtml, day: rel.released_on, notes: rel.notes });
      found.top = a.updated; found.history = b.updated;
      return setHouse(b.body, items2).body;
    }, `${rel.ref}: COSHH review complete (${rel.by_name})`);
  } catch (err) {
    await env.DB.prepare("UPDATE coshh_releases SET status = 'failed', error = ?, touched_at = ? WHERE n = ?").bind(`The page: ${String(err.message).slice(0, 250)}`, now(), n).run();
    return { ok: false, n, ref: rel.ref, sent, error: `The PDFs are filed, but the page couldn't be changed: ${err.message}` };
  }
  await env.DB.prepare("UPDATE coshh_releases SET status = 'done', error = NULL, done_at = ?, touched_at = ? WHERE n = ?").bind(now(), now(), n).run();
  await env.DB.prepare("DELETE FROM sync_state WHERE key = 'coshh_house_dirty'").run();
  if (!found.top || !found.history) {
    const { raiseAlert } = await import('./sync.js');
    await raiseAlert(env, { kind: 'coshh-page', dedupe: `coshh-page:${n}`, subject: `Finish ${rel.ref} on the COSHH page by hand`,
      body: `The COSHH review is complete and its PDFs are filed, but ${[!found.top && 'the table with Version and Last Reviewed', !found.history && 'the Version History table'].filter(Boolean).join(' and ')} couldn't be found on the page.\n\nSet Version to Issue ${n} and Last Reviewed to ${longDay(rel.released_on)}, and add ${rel.ref} to the Version History: ${rel.notes}` }).catch(() => {});
  }
  return { ok: true, n, ref: rel.ref, sent, left: 0, done: true, page: found };
}

// Each hour: a review complete that stopped part way carries on, and the dates table catches up.
export async function hourly(env) {
  const out = {};
  const stuck = await env.DB.prepare("SELECT n, touched_at FROM coshh_releases WHERE status != 'done' ORDER BY n DESC LIMIT 1").first();
  if (stuck && Date.now() - Date.parse(stuck.touched_at || 0) > 15 * 60_000) out.release = await sendRelease(env, stuck.n).catch((err) => ({ error: err.message }));
  else if (await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'coshh_house_dirty'").first()) out.house = await syncHouse(env).catch((err) => ({ error: err.message }));
  return out;
}

// ---------- reviews due ----------

export async function dueList(env) {
  const soon = new Date(Date.parse(`${londonDate()}T12:00:00Z`) + DUE_SOON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(`SELECT id, coshh_no, product, next_review_on, review_told FROM coshh_items
    WHERE in_house = 1 AND status IN ('done', 'imported') AND next_review_on IS NOT NULL AND next_review_on <= ? ORDER BY next_review_on`).bind(soon).all();
  return results;
}

// Once a day: management hear of each assessment for a product still in house as its review comes due.
export async function remindReviews(env) {
  const today = londonDate();
  if ((await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'coshh_reviews_day'").first().catch(() => null))?.value === today) return { idle: true };
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('coshh_reviews_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(today).run();
  const due = (await dueList(env)).filter((r) => r.review_told !== r.next_review_on);
  const unsent = await unsentFor(env);
  if (!due.length && !unsent) return { told: 0 };
  const { peopleWith } = await import('./permissions.js');
  const { toPerson } = await import('./notify.js');
  const managers = await peopleWith(env, 'coshhManage').catch(() => []);
  const origin = String(env.HUB_URL || (await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'hub_origin'").first().catch(() => null))?.value || '').replace(/\/$/, '');
  const lines = due.map((r) => `- ${r.coshh_no ? `COSHH ${r.coshh_no}: ` : ''}${r.product}, ${r.next_review_on < today ? 'overdue since' : 'due'} ${r.next_review_on}`);
  for (const m of managers) {
    if (due.length) {
      await toPerson(env, m.account_id, { tile: 'coshh', kind: 'coshh-review', dedupe: `coshh-review:${today}`,
        subject: due.length === 1 ? `COSHH review due: ${due[0].product}` : `${due.length} COSHH assessments due for review`,
        body: `These products are still in house and their COSHH assessment is due its yearly review:\n\n${lines.join('\n')}\n\nCheck each is still right and mark it reviewed (or record what the review found changed) on the COSHH tile:\n${origin}/#/coshh`,
        link: '#/coshh', ref: { key: 'coshh-review' } }).catch(() => {});
    }
    if (unsent) {
      await toPerson(env, m.account_id, { tile: 'coshh', kind: 'coshh-release', dedupe: `coshh-release:${unsent.since.slice(0, 10)}:${Math.floor(unsent.days / UNSENT_DAYS)}`,
        subject: `COSHH reviews waiting to go to Confluence (${unsent.days} days)`,
        body: `COSHH reviews and changes made in the hub since ${longDay(unsent.since.slice(0, 10))} haven't been sent to Confluence yet: ${unsent.notes}\n\nWhen the review is finished, press COSHH review complete on the COSHH tile:\n${origin}/#/coshh`,
        link: '#/coshh', ref: { key: 'coshh-release' } }).catch(() => {});
    }
  }
  for (const r of due) await env.DB.prepare('UPDATE coshh_items SET review_told = ? WHERE id = ?').bind(r.next_review_on, r.id).run();
  return { told: due.length, unsent: Boolean(unsent), managers: managers.length };
}

// Reviews waiting for "COSHH review complete" for a few days or more.
const UNSENT_DAYS = 3;
export async function unsentFor(env) {
  const s = await releaseState(env);
  if (!s.waiting.length || !s.since) return null;
  const days = Math.floor((Date.now() - Date.parse(s.since)) / 86_400_000);
  return days >= UNSENT_DAYS ? { since: s.since, days, notes: s.notes, waiting: s.waiting.length } : null;
}

// ---------- the safety data sheet, beside the form ----------

// Somewhere on the public web: http(s), a named host, nothing on this machine or a private network.
export function publicUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
  }
  if (host.startsWith('[') || host.includes(':')) return null;
  if (u.port && !['80', '443'].includes(u.port)) return null;
  return u;
}

const SHEET_MAX = 20 * 1024 * 1024;
const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// The sheet itself, fetched here so it can be shown inside the hub. A web page rather than the PDF
// comes back as the PDF links on it, to choose from.
export async function sheet(env, viewer, raw) {
  mustSee(viewer);
  const u = publicUrl(raw);
  if (!u) throw refuse('That isn\'t a web address the hub can open. Copy the sheet\'s full address, starting https://');
  let res;
  try {
    res = await fetch(u.toString(), { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PromtekHub/1.0; COSHH safety data sheet viewer)', Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.5' } });
  } catch { throw refuse('That site couldn\'t be reached. Open the sheet with the link instead.', 502); }
  if (!res.ok) throw refuse(`That site said no (${res.status}). Some suppliers only let a browser open their sheets: open it with the link instead.`, 502);
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  const size = Number(res.headers.get('content-length') || 0);
  if (size > SHEET_MAX) throw refuse('That file is too big to show here. Open it with the link instead.');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > SHEET_MAX) throw refuse('That file is too big to show here. Open it with the link instead.');
  const isPdf = type.includes('pdf') || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
  if (isPdf) return { kind: 'pdf', bytes, url: res.url || u.toString() };
  if (!type.includes('html')) throw refuse('That isn\'t a PDF or a web page. Open it with the link instead.');
  // A page about the product: the PDFs it links to, the likeliest first.
  const html = new TextDecoder().decode(bytes.slice(0, 2_000_000));
  const base = res.url || u.toString();
  const found = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    let href;
    try { href = new URL(decode(m[1]), base).toString(); } catch { continue; }
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    const pdfish = /\.pdf(\?|$)/i.test(href);
    const sds = /\b(m?sds|safety[\s-]*data|data[\s-]*sheet|sicherheitsdatenblatt)\b/i.test(`${href} ${text}`);
    if (!pdfish && !sds) continue;
    if (!publicUrl(href) || found.has(href)) continue;
    found.set(href, { url: href, text: text || href.split('/').pop(), score: (pdfish ? 1 : 0) + (sds ? 2 : 0) });
  }
  const links = [...found.values()].sort((a, b) => b.score - a.score).slice(0, 12).map(({ url, text }) => ({ url, text }));
  return { kind: 'page', url: base, links };
}
