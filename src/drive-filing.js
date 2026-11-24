// Files attachments on customer jobs in the job's folder in the shared drive, in place
// of the Jira automations and Zaps that did it before. Each attachment is filed once, by its
// Jira id, so nothing is missed or filed twice however many are added together.
//
// Where each goes, as the Zaps did it (with their mistakes put right):
//   on the order (an Epic): its folder, named by its key (FDL-668)
//   on a category, or a sub-task of one: the folder for the category's kind inside it
//   on an older order's item (a child of the Epic): the folder for the item's kind
// Anything else (an item flagged Customer Item, a sub-task of an older item, other kinds) isn't filed.
import { getState, setState, raiseAlert } from './sync.js';
import { jiraFetch, getIssue, customerProjects } from './jira.js';
import { budget, search, fieldIds, OutOfCalls, options, lower } from './wip.js';

const DRIVE_ID = '0ADzmBIqPMa-AUk9PVA';
const EXCLUDED_PROJECT_IDS = ['15300'];
const SCAN_EVERY_MS = 3 * 60_000;
const SCAN_CALLS = 4;
const FILES_PER_RUN = 2;
const MAX_TRIES = 10;
const FOLDER = 'application/vnd.google-apps.folder';
const GOOGLE = 'https://www.googleapis.com';

export const CATEGORY_FOLDERS = { 'category - hardware': 'Hardware', 'category - software': 'Software', 'category - condor': 'Condor Software', 'category - site visit': 'Commissioning' };
export const DISCIPLINE_FOLDERS = { hardware: 'Hardware', software: 'Software', condor: 'Condor Software', engineering: 'Commissioning' };
const ITEM_FOLDERS = {
  design: 'Assembly, Configuration & Testing', build: 'Assembly, Configuration & Testing', 'configuration & test': 'Assembly, Configuration & Testing',
  'purchase order': 'Purchase Order', 'kestrel development': 'Kestrel Software', 'storaweigh development': 'StoraWeigh Software',
  'condor development': 'Condor Software', dispatch: 'Hardware Delivery', 'weekday site visit': 'Commissioning',
  'new design': 'Hardware', 'new build': 'Hardware', 'new configuration & testing': 'Hardware', 'new dispatch': 'Hardware',
  'new software development': 'Software', 'new download phase': 'Software', 'new condor development': 'Condor Software', 'new order site visit': 'Commissioning',
};

const driveId = (env) => env.DOCS_DRIVE_ID || DRIVE_ID;
const isEpic = (type) => lower(type?.name) === 'epic' || String(type?.id) === '6' || type?.hierarchyLevel === 1;
const jiraTime = (s) => Date.parse(String(s || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
const marks = (n) => Array(n).fill('?').join(',');
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

export async function isOn(env) { return (await getState(env, 'drive_filing').catch(() => null)) === 'on'; }

// Where an issue's attachments go: the order's key (or the item to find it from) and the folder inside.
export function placeOf(issue) {
  const f = issue.fields || {};
  const type = lower(f.issuetype?.name);
  const parent = f.parent;
  const parentType = lower(parent?.fields?.issuetype?.name);
  if (isEpic(f.issuetype)) return { epic: issue.key, folder: null };
  if (CATEGORY_FOLDERS[type]) return parent?.key ? { epic: parent.key, folder: CATEGORY_FOLDERS[type] } : null;
  if (f.issuetype?.subtask) return CATEGORY_FOLDERS[parentType] ? { via: parent.key, folder: CATEGORY_FOLDERS[parentType] } : null;
  if (parent && isEpic(parent.fields?.issuetype) && ITEM_FOLDERS[type]) return { epic: parent.key, folder: ITEM_FOLDERS[type] };
  return null;
}

// Noted to be filed: each attachment once.
export async function queue(env, rows) {
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  const stmts = rows.map((r) => env.DB.prepare(`INSERT OR IGNORE INTO drive_files (attachment_id, issue_key, parent_key, epic_key, folder, filename, size, mime, created, source, status, tries, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?)`)
    .bind(String(r.id), r.issueKey, r.via || null, r.epic || null, r.folder || null, String(r.filename || 'File').slice(0, 250), Number(r.size) || 0,
      r.mime || 'application/octet-stream', r.created || now, r.source || 'jira', now));
  let added = 0;
  for (const part of chunk(stmts, 80)) for (const res of await env.DB.batch(part)) added += res.meta?.changes || 0;
  return added;
}

// Attachments added to customer jobs in the last few minutes.
async function scan(env) {
  const now = Date.now();
  const mark = Number((await getState(env, 'drive_scan_at')) || 0);
  if (now - mark < SCAN_EVERY_MS) return { idle: true };
  const from = await getState(env, 'drive_from');
  if (!from) return { idle: true };
  const b = budget(env, SCAN_CALLS);
  const since = Math.max(mark, Date.parse(from));
  const minutes = Math.min(7 * 24 * 60, Math.ceil((now - since) / 60000) + 3);
  const projects = (await customerProjects(env)).filter((p) => !EXCLUDED_PROJECT_IDS.includes(String(p.id)));
  if (!projects.length) return { idle: true };
  const ids = await fieldIds(env, b);
  const jql = `project in (${projects.map((p) => `"${p.key}"`).join(',')}) AND attachments IS NOT EMPTY AND updated >= -${minutes}m ORDER BY updated ASC`;
  const { issues, more } = await search(b, jql, ['attachment', 'issuetype', 'parent', 'project', 'updated', ids.customerItem].filter(Boolean), { pages: 2 });
  const fromMs = Date.parse(from);
  const rows = [];
  for (const issue of issues) {
    if (ids.customerItem && options(issue.fields?.[ids.customerItem]).some((o) => lower(o.value) === 'customer item')) continue;
    const place = placeOf(issue);
    if (!place) continue;
    for (const a of issue.fields?.attachment || []) {
      if (!(jiraTime(a.created) >= fromMs)) continue;
      rows.push({ id: a.id, issueKey: issue.key, ...place, filename: a.filename, size: a.size, mime: a.mimeType, created: new Date(jiraTime(a.created)).toISOString() });
    }
  }
  const added = await queue(env, rows);
  const last = issues.length ? jiraTime(issues[issues.length - 1].fields?.updated) : NaN;
  await setState(env, 'drive_scan_at', String(more && !Number.isNaN(last) ? last - 60_000 : now - 30_000));
  return { seen: rows.length, added, calls: b.used };
}

// ---------- Google Drive ----------

let tokenCache = null;
async function token(env) {
  if (tokenCache && tokenCache.until > Date.now()) return tokenCache.token;
  const { googleToken } = await import('./pow.js');
  tokenCache = { token: await googleToken(env), until: Date.now() + 45 * 60_000 };
  return tokenCache.token;
}

async function google(env, path, init = {}) {
  const res = await fetch(`${GOOGLE}${path}`, { ...init, headers: { Authorization: `Bearer ${await token(env)}`, ...(init.headers || {}) } });
  if (res.status === 401) tokenCache = null;
  if (!res.ok) throw Object.assign(new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 160)}`), { status: res.status });
  return res;
}

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function findFolder(env, name, parent) {
  const q = `name = ${quote(name)} and mimeType = '${FOLDER}' and trashed = false${parent ? ` and ${quote(parent)} in parents` : ''}`;
  const params = new URLSearchParams({ q, corpora: 'drive', driveId: driveId(env), includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', fields: 'files(id,name)', pageSize: '5' });
  const data = await (await google(env, `/drive/v3/files?${params}`)).json();
  return data.files?.[0]?.id || null;
}

// A folder's id, remembered once found. The order's own folder must already be there; the
// folders inside it are made when they're missing, as the Zaps did.
async function folderId(env, path, name, parent, { create = false } = {}) {
  const saved = await env.DB.prepare('SELECT folder_id FROM drive_folders WHERE path = ?').bind(path).first();
  if (saved?.folder_id) return saved.folder_id;
  let id = await findFolder(env, name, parent);
  if (!id && create) {
    const res = await google(env, '/drive/v3/files?supportsAllDrives=true&fields=id', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
    });
    id = (await res.json()).id;
  }
  if (id) await env.DB.prepare('INSERT OR REPLACE INTO drive_folders (path, folder_id, found_at) VALUES (?, ?, ?)').bind(path, id, new Date().toISOString()).run();
  return id;
}

// Straight from Jira into Drive, without holding a big file in memory where that can be avoided.
async function upload(env, parent, name, source, size, mime) {
  const start = await google(env, '/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime, ...(size ? { 'x-upload-content-length': String(size) } : {}) },
    body: JSON.stringify({ name, parents: [parent] }),
  });
  const session = start.headers.get('location');
  if (!session) throw new Error('Drive gave nowhere to upload to');
  let body;
  if (size && source.body && typeof FixedLengthStream !== 'undefined') {
    // eslint-disable-next-line no-undef
    const { readable, writable } = new FixedLengthStream(size);
    source.body.pipeTo(writable).catch(() => {});
    body = readable;
  } else body = await source.arrayBuffer();
  const res = await fetch(session, { method: 'PUT', headers: { 'content-type': mime }, body });
  if (!res.ok) throw Object.assign(new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 160)}`), { status: res.status });
  return (await res.json()).id;
}

async function epicOf(env, key) {
  const c = await env.DB.prepare('SELECT epic_key FROM doc_categories WHERE category_key = ?').bind(key).first().catch(() => null);
  if (c?.epic_key) return c.epic_key;
  const issue = await getIssue(env, key, ['parent']);
  return issue?.fields?.parent?.key || null;
}

class Later extends Error {}

async function fileOne(env, row) {
  const now = new Date().toISOString();
  try {
    const epic = row.epic_key || (row.parent_key ? await epicOf(env, row.parent_key) : null);
    if (!epic) throw new Later(`${row.parent_key || row.issue_key} isn't on an order`);
    if (!row.epic_key) await env.DB.prepare('UPDATE drive_files SET epic_key = ? WHERE attachment_id = ?').bind(epic, row.attachment_id).run();
    const root = await folderId(env, epic, epic, null);
    if (!root) throw new Later(`There's no folder named ${epic} in the shared drive yet`);
    const target = row.folder ? await folderId(env, `${epic}/${row.folder}`, row.folder, root, { create: true }) : root;
    const src = await jiraFetch(env, `/rest/api/3/attachment/content/${encodeURIComponent(row.attachment_id)}`, { headers: { Accept: '*/*' } });
    if (src.status === 404) {
      await env.DB.prepare("UPDATE drive_files SET status = 'gone', error = ?, filed_at = ? WHERE attachment_id = ?").bind('Removed from Jira before it was filed', now, row.attachment_id).run();
      return 'gone';
    }
    if (!src.ok) throw new Error(`Jira ${src.status} reading the file`);
    let id;
    try { id = await upload(env, target, row.filename, src, row.size, row.mime || 'application/octet-stream'); }
    catch (err) {
      // A remembered folder that has since gone is looked for again next time.
      if (err.status === 404) await env.DB.prepare('DELETE FROM drive_folders WHERE path IN (?, ?)').bind(epic, `${epic}/${row.folder}`).run();
      throw err;
    }
    await env.DB.prepare("UPDATE drive_files SET status = 'filed', drive_id = ?, error = NULL, filed_at = ? WHERE attachment_id = ?").bind(id, now, row.attachment_id).run();
    return 'filed';
  } catch (err) {
    const tries = (row.tries || 0) + 1;
    const failed = tries >= MAX_TRIES;
    const wait = Math.min(6 * 60, 5 * 2 ** Math.min(tries - 1, 7)) * 60_000;
    await env.DB.prepare('UPDATE drive_files SET tries = ?, error = ?, next_at = ?, status = ? WHERE attachment_id = ?')
      .bind(tries, String(err.message).slice(0, 300), new Date(Date.now() + wait).toISOString(), failed ? 'failed' : 'waiting', row.attachment_id).run();
    if (failed) {
      await raiseAlert(env, { kind: 'drive-filing', dedupe: `drive-filing:${row.attachment_id}`, link: '#/docs?library',
        subject: `${row.filename} couldn't be filed in Drive`,
        body: `${row.filename} on ${row.issue_key} couldn't be put in the job's Drive folder after ${tries} tries: ${err.message}\n\nIt's still on ${row.issue_key} in Jira. Retry it from Job documents in the hub once the cause is fixed.` }).catch(() => {});
    }
    if (err instanceof Later) return 'later';
    return 'error';
  }
}

export async function fileNow(env, attachmentIds) {
  const out = [];
  for (const id of attachmentIds) {
    const row = await env.DB.prepare("SELECT * FROM drive_files WHERE attachment_id = ? AND status = 'waiting'").bind(String(id)).first();
    if (row) out.push(await fileOne(env, row));
  }
  return out;
}

// Every run while it's switched on: look for new attachments every few minutes, and file a couple.
export async function run(env) {
  if (!(await isOn(env))) return { idle: true };
  const out = {};
  try { out.scan = await scan(env); } catch (err) { if (!(err instanceof OutOfCalls)) throw err; }
  const { results } = await env.DB.prepare("SELECT * FROM drive_files WHERE status = 'waiting' AND (next_at IS NULL OR next_at <= ?) ORDER BY created LIMIT ?")
    .bind(new Date().toISOString(), FILES_PER_RUN).all();
  out.files = [];
  for (const row of results) out.files.push(await fileOne(env, row));
  return out;
}

// ---------- for the hub ----------

export async function status(env) {
  const on = await isOn(env);
  const since = await getState(env, 'drive_from');
  const week = new Date(Date.now() - 7 * 86400_000).toISOString();
  const counts = await env.DB.prepare(`SELECT
      SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status = 'filed' AND filed_at >= ? THEN 1 ELSE 0 END) AS week,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM drive_files`).bind(week).first().catch(() => null);
  const { results: problems } = await env.DB.prepare(
    "SELECT attachment_id, issue_key, filename, status, tries, error FROM drive_files WHERE status = 'failed' OR (status = 'waiting' AND tries > 0) ORDER BY created DESC LIMIT 25"
  ).all().catch(() => ({ results: [] }));
  return { on, since, configured: Boolean(env.GOOGLE_SERVICE_ACCOUNT), waiting: counts?.waiting || 0, week: counts?.week || 0, failed: counts?.failed || 0, problems };
}

export async function setOn(env, on) {
  if (on) {
    if (!env.GOOGLE_SERVICE_ACCOUNT) throw Object.assign(new Error('The hub has no Google service account yet. See SETUP.md, Part 20b.'), { status: 400 });
    await check(env);
    const now = new Date().toISOString();
    await setState(env, 'drive_from', now);
    await setState(env, 'drive_scan_at', String(Date.now()));
  }
  await setState(env, 'drive_filing', on ? 'on' : 'off');
  return status(env);
}

// The hub can see the shared drive.
export async function check(env) {
  try { await google(env, `/drive/v3/drives/${encodeURIComponent(driveId(env))}?fields=id,name`); }
  catch (err) {
    throw Object.assign(new Error(err.status === 404 ? 'The hub\'s service account isn\'t a member of the shared drive the job folders are in yet. Add it as a Content manager.' : err.message), { status: 400 });
  }
  return { ok: true };
}

export async function retry(env, { id = null } = {}) {
  const sql = "UPDATE drive_files SET status = 'waiting', tries = 0, next_at = NULL WHERE status IN ('failed', 'waiting')";
  if (id) await env.DB.prepare(`${sql} AND attachment_id = ?`).bind(String(id)).run();
  else await env.DB.prepare(sql).run();
  return status(env);
}

// How each of these attachments stands, for showing beside a document.
export async function filedFor(env, attachmentIds) {
  const map = new Map();
  const ids = [...new Set(attachmentIds.map(String))];
  for (const part of chunk(ids, 80)) {
    const { results } = await env.DB.prepare(`SELECT attachment_id, status, drive_id, error, filename FROM drive_files WHERE attachment_id IN (${marks(part.length)})`)
      .bind(...part).all().catch(() => ({ results: [] }));
    for (const r of results) map.set(r.attachment_id, r);
  }
  return map;
}
