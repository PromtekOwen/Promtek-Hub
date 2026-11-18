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
  i.pdf_name, i.file_name, i.confluence_id, i.confluence_note, i.created_by_id, i.created_by, i.updated_at, i.in_house_by, i.in_house_at,
  (SELECT MIN(p.id) FROM coshh_photos p WHERE p.item_id = i.id) AS photo_id`;

function shape(r, today) {
  const due = r.status !== 'draft' && r.next_review_on ? daysBetween(today, r.next_review_on) : null;
  return {
    id: r.id, no: r.coshh_no, rev: r.rev, product: r.product, status: r.status, source: r.source, inHouse: Boolean(r.in_house),
    locations: json(r.locations, []), assessedBy: r.assessed_by, assessedOn: r.assessed_on, lastReviewOn: r.last_review_on, nextReviewOn: r.next_review_on,
    reviewDue: r.in_house && due != null ? (due < 0 ? 'overdue' : due <= DUE_SOON_DAYS ? 'soon' : null) : null, dueInDays: due,
    hasFile: Boolean(r.pdf_name || r.file_name), fileName: r.pdf_name || r.file_name || null, filed: Boolean(r.confluence_id), fileNote: r.confluence_note,
    photoId: r.photo_id || null, createdById: r.created_by_id, createdBy: r.created_by, updatedAt: r.updated_at, inHouseBy: r.in_house_by, inHouseAt: r.in_house_at,
  };
}

export async function list(env, viewer) {
  mustSee(viewer);
  const today = londonDate();
  const { results } = await env.DB.prepare(`SELECT ${LIST_COLS} FROM coshh_items i WHERE i.status != 'draft' OR i.created_by_id = ? ORDER BY i.product COLLATE NOCASE`).bind(viewer.accountId || '').all();
  const items = results.map((r) => shape(r, today));
  const used = [...new Set(items.flatMap((i) => i.locations))].filter((l) => !LOCATIONS.includes(l)).sort();
  return { items, locations: [...LOCATIONS, ...used], manage: canManage(viewer), today,
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

const pdfName = (no, rev, product) => `COSHH ${no} Rev ${rev} - ${String(product).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80)}.pdf`;

async function buildPdf(env, r, data) {
  const { buildCoshhPdf } = await import('./coshh-pdf.js');
  return buildCoshhPdf({ no: r.coshh_no, rev: r.rev, product: r.product, inHouse: Boolean(r.in_house), assessedBy: r.assessed_by, assessedOn: r.assessed_on, data }, await photosFor(env, r.id));
}

// Completing it: numbered (a new one takes the next number), dated today, made into a PDF and
// filed in Confluence. Completing a revision of one already done keeps its number and goes up a Rev.
export async function submit(env, viewer, { id, product, data }) {
  mustSee(viewer);
  const form = cleanForm(data);
  const gaps = missing(product, form);
  if (gaps.length) throw refuse(`Fill in ${gaps.join(', ')} first.`);
  let r = id ? await row(env, id) : null;
  if (!r) r = await row(env, (await save(env, viewer, { product, data })).id);
  if (!mayEdit(viewer, r)) throw refuse('That draft is someone else\'s.', 403);
  if (r.source === 'confluence') throw refuse('That one came from Confluence. Start a new assessment for it instead.');
  const revising = r.status === 'done';
  const today = londonDate();
  const old = json(r.data, {});
  const no = r.coshh_no || Math.max(FIRST_NO - 1, Number((await env.DB.prepare('SELECT MAX(coshh_no) AS n FROM coshh_items').first())?.n) || 0) + 1;
  const rev = revising ? (r.rev || 1) + 1 : 1;
  const kept = { ...form, reviews: revising ? [] : old.reviews || [], pastFiles: [...(old.pastFiles || []), ...(revising && r.confluence_id ? [r.confluence_id] : [])] };
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE coshh_items SET coshh_no = ?, rev = ?, product = ?, status = 'done', data = ?, assessed_by = ?, assessed_by_id = ?, assessed_on = ?,
      last_review_on = NULL, next_review_on = ?, review_told = NULL, updated_at = ? WHERE id = ?`)
    .bind(no, rev, clip(product, 200), JSON.stringify(kept), nameOf(viewer), viewer.accountId || null, today, addYear(today), now, r.id).run();
  r = await row(env, r.id);
  const filed = await file(env, r, kept);
  await record(env, viewer, { area: 'COSHH', action: revising ? 'revised a COSHH assessment' : 'completed a COSHH assessment', subjectType: 'coshh', subjectId: String(r.id),
    label: `COSHH ${no} Rev ${rev}: ${r.product}`.slice(0, 120) }).catch(() => {});
  return { ok: true, id: r.id, no, rev, ...filed };
}

// The PDF onto the Confluence page (replacing one of the same name), noted on the item.
async function file(env, r, data) {
  const name = pdfName(r.coshh_no, r.rev, r.product);
  let attachmentId = null;
  let note = null;
  try {
    const bytes = await buildPdf(env, r, data);
    attachmentId = await toConfluence(env, name, bytes, `COSHH ${r.coshh_no} Rev ${r.rev}${data.reviews?.length ? `, reviewed ${data.reviews.at(-1).date}` : ''}`);
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
    await raiseAlert(env, { kind: 'coshh-filing', dedupe: `coshh-filing:${r.id}:${r.rev}:${londonDate()}`, subject: `COSHH ${r.coshh_no} wasn't filed in Confluence`,
      body: `COSHH ${r.coshh_no} Rev ${r.rev} (${r.product}) is saved in the hub, but:\n\n${note}\n\nIt can be downloaded from the COSHH tile and added to the page by hand, or filed again from there.` }).catch(() => {});
  }
  return { filed: Boolean(attachmentId), fileNote: note, fileName: name };
}

// Filing again, after Confluence wasn't reached.
export async function refile(env, viewer, { id }) {
  mustSee(viewer);
  const r = await row(env, id);
  if (r.status !== 'done') throw refuse('Only a completed assessment is filed.');
  return file(env, r, json(r.data, {}));
}

// A yearly review: who and when, into the Next Reviews table, and the PDF filed again.
export async function review(env, viewer, { id, note }) {
  mustSee(viewer);
  const r = await row(env, id);
  if (!['done', 'imported'].includes(r.status)) throw refuse('Complete the assessment first.');
  const today = londonDate();
  const data = json(r.data, {});
  data.reviews = [...(data.reviews || []), { name: nameOf(viewer), date: today, note: clip(note, 300) }];
  await env.DB.prepare('UPDATE coshh_items SET data = ?, last_review_on = ?, next_review_on = ?, review_told = NULL, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(data), today, addYear(today), new Date().toISOString(), r.id).run();
  const out = r.status === 'done' ? await file(env, { ...r }, data) : {};
  await record(env, viewer, { area: 'COSHH', action: 'reviewed a COSHH assessment', subjectType: 'coshh', subjectId: String(r.id),
    label: `${r.coshh_no ? `COSHH ${r.coshh_no}: ` : ''}${r.product}`.slice(0, 120), changes: note ? [{ label: 'Note', before: '', after: clip(note, 300) }] : [] }).catch(() => {});
  return { ok: true, nextReviewOn: addYear(today), reviews: data.reviews.length, ...out };
}

// ---------- in house, and where ----------

export async function setInHouse(env, viewer, { id, inHouse }) {
  mustSee(viewer);
  const r = await row(env, id);
  if (r.status === 'draft') throw refuse('Complete the assessment first.');
  const on = inHouse ? 1 : 0;
  await env.DB.prepare('UPDATE coshh_items SET in_house = ?, in_house_by = ?, in_house_at = ?, updated_at = ? WHERE id = ?')
    .bind(on, nameOf(viewer), new Date().toISOString(), new Date().toISOString(), r.id).run();
  await record(env, viewer, { area: 'COSHH', action: on ? 'marked a COSHH product in house' : 'marked a COSHH product no longer in house', subjectType: 'coshh', subjectId: String(r.id), label: r.product }).catch(() => {});
  return { ok: true, inHouse: Boolean(on) };
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
  const last = r.last_review_on && (!assessedOn || r.last_review_on > assessedOn) ? r.last_review_on : assessedOn || r.assessed_on;
  await env.DB.prepare('UPDATE coshh_items SET product = ?, coshh_no = ?, assessed_on = ?, next_review_on = ?, review_told = NULL, updated_at = ? WHERE id = ?')
    .bind(clip(product, 200), Number(no) || null, assessedOn || r.assessed_on, addYear(last), new Date().toISOString(), r.id).run();
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
  return { bytes: await buildPdf(env, preview, data), name: r.pdf_name || pdfName(preview.coshh_no, r.rev, r.product || 'Draft'), type: 'application/pdf' };
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
  const known = new Set(rows.flatMap((r) => [r.confluence_id, ...(json(r.data, {}).pastFiles || [])]).filter(Boolean).map(String));
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
  await record(env, viewer, { area: 'COSHH', action: 'brought COSHH assessments in from Confluence', subjectType: 'coshh', subjectId: pageId(env), label: `${added} added` }).catch(() => {});
  return { ok: true, added };
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
  if (!due.length) return { told: 0 };
  const { peopleWith } = await import('./permissions.js');
  const { toPerson } = await import('./notify.js');
  const managers = await peopleWith(env, 'coshhManage').catch(() => []);
  const origin = String(env.HUB_URL || (await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'hub_origin'").first().catch(() => null))?.value || '').replace(/\/$/, '');
  const lines = due.map((r) => `- ${r.coshh_no ? `COSHH ${r.coshh_no}: ` : ''}${r.product}, ${r.next_review_on < today ? 'overdue since' : 'due'} ${r.next_review_on}`);
  for (const m of managers) {
    await toPerson(env, m.account_id, { tile: 'coshh', kind: 'coshh-review', dedupe: `coshh-review:${today}`,
      subject: due.length === 1 ? `COSHH review due: ${due[0].product}` : `${due.length} COSHH assessments due for review`,
      body: `These products are still in house and their COSHH assessment is due its yearly review:\n\n${lines.join('\n')}\n\nCheck each is still right and mark it reviewed (or revise it) on the COSHH tile:\n${origin}/#/coshh`,
      link: '#/coshh', ref: { key: 'coshh-review' } }).catch(() => {});
  }
  for (const r of due) await env.DB.prepare('UPDATE coshh_items SET review_told = ? WHERE id = ?').bind(r.next_review_on, r.id).run();
  return { told: due.length, managers: managers.length };
}
