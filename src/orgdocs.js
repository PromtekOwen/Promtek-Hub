// The company chart as a controlled document, IMS2.02. Changes collect as
// pending; an admin reviews them and issues the next version, which becomes
// the copy in Confluence. Major changes are what a new version is for: who is
// here, who they report to, and what their job is.
import { Pdf, widthOf } from './pdf.js';
import { LOGO } from './logo.js';
import { raiseAlert } from './sync.js';
import { same } from './audit.js';

export const PREFIX = 'IMS2.02';
const FIRST_VERSION = 8;
const PAGE_ID = '529793080';
const FILE_BASE = 'IMS2.02 Company Organisation Chart';
const ANCHOR_START = 'promtek-hub-org-start';
const ANCHOR_END = 'promtek-hub-org-end';

const MAJOR = { name: 'Name', job_title: 'Job title', department: 'Department', manager_id: 'Reports to' };
const MINOR = { pronouns: 'Pronouns', extension: 'Extension', avatar: 'Photo', org_order: 'Chart order', icons: 'Chart icons', email: 'Email' };

const reference = (n) => `${PREFIX}-${n}`;
const longDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

async function snapshot(env) {
  const { results } = await env.DB.prepare(
    'SELECT account_id, name, job_title, department, manager_id FROM employees WHERE active = 1 ORDER BY org_order, name'
  ).all();
  return results;
}

// Today's chart is version 8, so that's where the record starts.
export async function ensureStarted(env) {
  const any = await env.DB.prepare('SELECT n FROM org_versions LIMIT 1').first();
  if (any) return;
  await env.DB.prepare(
    `INSERT INTO org_versions (n, reference, issued_at, issued_by_name, summary, snapshot, confluence_status) VALUES (?, ?, ?, ?, ?, ?, 'none')`
  ).bind(FIRST_VERSION, reference(FIRST_VERSION), new Date().toISOString(), 'Issued before the hub',
    'The chart as it stood when the hub started keeping versions.', JSON.stringify(await snapshot(env))).run();
}

async function nameOf(env, accountId) {
  if (!accountId) return '';
  return (await env.DB.prepare('SELECT name FROM employees WHERE account_id = ?').bind(accountId).first())?.name || '';
}

// Called with an employee as they were and as they are after a change.
export async function track(env, viewer, before, after) {
  await ensureStarted(env);
  const now = new Date().toISOString();
  const rows = [];
  const who = after?.name || before?.name || '';
  const id = after?.account_id || before?.account_id;
  const wasOn = Boolean(before && Number(before.active));
  const isOn = Boolean(after && Number(after.active));
  if (!wasOn && isOn) rows.push(['major', 'joined', before ? 'Back on the chart' : 'Joined', '', `${after.job_title || 'No job title'}${after.manager_id ? `, reports to ${await nameOf(env, after.manager_id)}` : ''}`]);
  else if (wasOn && !isOn) rows.push(['major', 'left', 'Left', before.job_title || '', '']);
  else if (wasOn && isOn) {
    for (const [field, label] of Object.entries(MAJOR)) {
      if (same(before[field], after[field])) continue;
      const show = field === 'manager_id' ? async (v) => (await nameOf(env, v)) || 'Nobody' : async (v) => v || '';
      rows.push(['major', field, label, await show(before[field]), await show(after[field])]);
    }
    for (const [field, label] of Object.entries(MINOR)) {
      if (same(before[field], after[field])) continue;
      rows.push(['minor', field, label, field === 'avatar' ? '' : String(before[field] ?? ''), field === 'avatar' ? 'Changed' : String(after[field] ?? '')]);
    }
  }
  for (const [kind, field, label, b, a] of rows) {
    await env.DB.prepare(
      'INSERT INTO org_changes (at, actor_email, account_id, person_name, kind, field, label, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(now, viewer?.email || null, id, who, kind, field, label, b, a).run();
  }
  return rows.length;
}

export async function current(env) {
  await ensureStarted(env);
  return env.DB.prepare('SELECT n, reference, issued_at, issued_by_name, confluence_status FROM org_versions ORDER BY n DESC LIMIT 1').first();
}

export async function status(env) {
  const latest = await current(env);
  const { results: pending } = await env.DB.prepare('SELECT * FROM org_changes WHERE version_n IS NULL ORDER BY id').all();
  const { results: history } = await env.DB.prepare(
    'SELECT n, reference, issued_at, issued_by_name, summary, major, minor, confluence_status, confluence_error, published_at FROM org_versions ORDER BY n DESC'
  ).all();
  return {
    latest, next: reference(latest.n + 1), pending,
    major: pending.filter((p) => p.kind === 'major').length, minor: pending.filter((p) => p.kind === 'minor').length, history,
  };
}

function summarise(changes) {
  const byPerson = new Map();
  for (const c of changes) {
    if (!byPerson.has(c.person_name)) byPerson.set(c.person_name, []);
    const phrase = {
      joined: () => c.label.toLowerCase(), left: () => 'left',
      name: () => `now called ${c.after}`, job_title: () => `job title now ${c.after || 'blank'}`,
      department: () => `moved to ${c.after || 'no department'}`, manager_id: () => `now reports to ${c.after}`,
    }[c.field];
    byPerson.get(c.person_name).push(phrase ? phrase() : `${c.label.toLowerCase()} changed`);
  }
  return [...byPerson].map(([name, parts]) => `${name}: ${parts.join(', ')}`).join('. ');
}

// The approver is whoever issues it, which the version records by name.
export async function issue(env, viewer, { excluded = [], image, width, height }) {
  if (!viewer.isAdmin) throw new Error('Only admins can issue a new version of the chart.');
  const s = await status(env);
  const skip = new Set(excluded.map(Number));
  const counted = s.pending.filter((p) => p.kind === 'major' && !skip.has(p.id));
  if (!counted.length) throw new Error('Only minor changes are waiting. They go out with the next version.');
  if (!image || !/^[A-Za-z0-9+/=]+$/.test(image) || image.length > 1_900_000) throw new Error('The chart image did not come through. Try again.');
  const n = s.latest.n + 1;
  const now = new Date().toISOString();
  const summary = summarise(counted);
  const stmts = [
    env.DB.prepare(
      `INSERT INTO org_versions (n, reference, issued_at, issued_by, issued_by_name, summary, major, minor, snapshot, image, image_width, image_height, confluence_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(n, reference(n), now, viewer.email, viewer.employee?.name || viewer.email, summary, counted.length,
      s.pending.length - counted.length, JSON.stringify(await snapshot(env)), image, Number(width) || null, Number(height) || null),
    env.DB.prepare('UPDATE org_changes SET version_n = ? WHERE version_n IS NULL').bind(n),
  ];
  for (const id of skip) stmts.push(env.DB.prepare('UPDATE org_changes SET excluded = 1, kind = ? WHERE id = ?').bind('minor', id));
  await env.DB.batch(stmts);
  const published = await publish(env, n);
  return { ok: true, reference: reference(n), published };
}

// ---------- The controlled copy ----------

const BLUE = [0.055, 0.384, 0.576], BLUE_BRIGHT = [0, 0.553, 0.776], WHITE = [1, 1, 1], MUTED = [0.404, 0.49, 0.557];

export async function buildPdf(version) {
  const page = { width: 841.89, height: 595.28 };          // A4 landscape
  const doc = new Pdf({ size: page, margin: 30, title: `${version.reference} Company Organisation Chart` });
  doc.addJpeg('Logo', LOGO);
  doc.addJpeg('Chart', { base64: version.image, width: version.image_width, height: version.image_height });
  const band = 70;
  doc.rect(0, page.height - band, page.width, band, { fill: BLUE });
  doc.rect(0, page.height - band - 3, page.width, 3, { fill: BLUE_BRIGHT });
  const logoH = 30, logoW = (LOGO.width / LOGO.height) * logoH;
  doc.image('Logo', 30, page.height - 50, logoW, logoH);
  doc.text('Company Organisation Chart', 30 + logoW + 12, page.height - 32, { size: 15, bold: true, colour: WHITE });
  doc.text(`Issued ${longDate(version.issued_at)}. Approved by ${version.issued_by_name}.`, 30 + logoW + 12, page.height - 46, { size: 9.5, colour: [0.79, 0.89, 0.95] });
  const ref = version.reference;
  const refW = widthOf(ref, 11, true) + 22;
  doc.roundRect(page.width - 30 - refW, page.height - 44, refW, 21, 10.5, { fill: WHITE });
  doc.text(ref, page.width - 30 - refW + 11, page.height - 37, { size: 11, bold: true, colour: BLUE });
  // The chart scales to fit the page below the banner, keeping its shape.
  const boxW = page.width - 60, boxH = page.height - band - 3 - 50;
  const scale = Math.min(boxW / version.image_width, boxH / version.image_height);
  const w = version.image_width * scale, h = version.image_height * scale;
  doc.image('Chart', 30 + (boxW - w) / 2, 30 + (boxH - h) / 2 + 6, w, h);
  doc.text(`${ref}. Printed copies are uncontrolled; the current version is in Confluence.`, 30, 16, { size: 8, colour: MUTED });
  return doc.toBytes();
}

function confluenceAuth(env) {
  return 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
}

async function confluence(env, path, init = {}) {
  const res = await fetch(`${env.JIRA_BASE_URL}/wiki${path}`, {
    ...init, headers: { Authorization: confluenceAuth(env), Accept: 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Confluence ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const anchor = (name) => `<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">${name}</ac:parameter></ac:structured-macro>`;

export function pageBlock(version, history) {
  const rows = history.map((h) => `<tr><td>${esc(h.reference)}</td><td>${esc(longDate(h.issued_at))}</td><td>${esc(h.issued_by_name)}</td><td>${esc(h.summary)}</td></tr>`).join('');
  return `${anchor(ANCHOR_START)}
<p><ac:image ac:width="1400"><ri:attachment ri:filename="${FILE_BASE}.jpg" /></ac:image></p>
<p><ac:link><ri:attachment ri:filename="${FILE_BASE}.pdf" /><ac:plain-text-link-body><![CDATA[Controlled copy, ${version.reference} (PDF)]]></ac:plain-text-link-body></ac:link></p>
<p><strong>Changes in this version:</strong> ${esc(version.summary)}</p>
<h3>Version history</h3>
<table><tbody><tr><th>Reference</th><th>Issued</th><th>Approved by</th><th>Changes</th></tr>${rows}</tbody></table>
<p><em>${esc(version.reference)} approved by ${esc(version.issued_by_name)} on ${esc(longDate(version.issued_at))}.</em></p>
${anchor(ANCHOR_END)}`;
}

const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const cellsOf = (row) => [...row.matchAll(/<(td|th)\b[^>]*>[\s\S]*?<\/\1>/g)];

// The page's own document control table, found by its column headings. Only
// Version and Last Reviewed change; Owner, Team and the rest are left alone.
export function findControlTable(body) {
  for (const table of body.matchAll(/<table\b[\s\S]*?<\/table>/g)) {
    const rows = [...table[0].matchAll(/<tr\b[\s\S]*?<\/tr>/g)];
    for (let i = 0; i < rows.length - 1; i++) {
      const heads = cellsOf(rows[i][0]).map((c) => textOf(c[0]));
      const version = heads.indexOf('version');
      const reviewed = heads.indexOf('last reviewed');
      if (version < 0 || reviewed < 0) continue;
      return { start: table.index, end: table.index + table[0].length, html: table[0], row: rows[i + 1], version, reviewed };
    }
  }
  return null;
}

export function updateControlTable(body, version) {
  const found = findControlTable(body);
  if (!found) return { body, updated: false, tableEnd: null };
  const issued = new Date(version.issued_at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const cells = cellsOf(found.row[0]);
  if (cells.length <= Math.max(found.version, found.reviewed)) return { body, updated: false, tableEnd: found.end };
  const replaceInner = (cell, inner) => cell[0].replace(/^(<(td|th)\b[^>]*>)[\s\S]*(<\/\2>)$/, `$1${inner}$3`);
  let row = found.row[0];
  // Replace from the right so earlier positions stay valid.
  const edits = [[found.version, `<p>Issue ${version.n}</p>`], [found.reviewed, `<p><time datetime="${issued}" /></p>`]].sort((a, b) => b[0] - a[0]);
  for (const [i, inner] of edits) {
    const c = cells[i];
    row = row.slice(0, c.index) + replaceInner(c, inner) + row.slice(c.index + c[0].length);
  }
  const table = found.html.slice(0, found.row.index) + row + found.html.slice(found.row.index + found.row[0].length);
  return { body: body.slice(0, found.start) + table + body.slice(found.end), updated: true, tableEnd: found.start + table.length };
}

// Replaces only the hub's part of the page, so anything else on it is kept. The
// first time, it goes straight after the document control table.
export function mergeBody(existing, block, afterIndex = null) {
  const macro = (name) => new RegExp(`<ac:structured-macro[^>]*ac:name="anchor"[^>]*>(?:(?!</ac:structured-macro>)[\\s\\S])*?${name}(?:(?!</ac:structured-macro>)[\\s\\S])*?</ac:structured-macro>`);
  const start = existing.match(macro(ANCHOR_START));
  const end = existing.match(macro(ANCHOR_END));
  if (start && end && end.index > start.index) {
    return existing.slice(0, start.index) + block + existing.slice(end.index + end[0].length);
  }
  if (afterIndex != null) return `${existing.slice(0, afterIndex)}\n${block}\n${existing.slice(afterIndex)}`;
  return `${block}\n${existing}`;
}

async function upload(env, filename, bytes, type, comment) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  form.append('comment', comment);
  form.append('minorEdit', 'true');
  // PUT adds the file, or a new version of it if it's already there.
  return confluence(env, `/rest/api/content/${PAGE_ID}/child/attachment`, { method: 'PUT', body: form, headers: { 'X-Atlassian-Token': 'nocheck' } });
}

export async function publish(env, n) {
  const version = await env.DB.prepare('SELECT * FROM org_versions WHERE n = ?').bind(n).first();
  if (!version || !version.image) return false;
  try {
    const pdf = await buildPdf(version);
    const jpg = Uint8Array.from(atob(version.image), (c) => c.charCodeAt(0));
    await upload(env, `${FILE_BASE}.pdf`, pdf, 'application/pdf', version.reference);
    await upload(env, `${FILE_BASE}.jpg`, jpg, 'image/jpeg', version.reference);
    const page = await confluence(env, `/api/v2/pages/${PAGE_ID}?body-format=storage`);
    const { results: history } = await env.DB.prepare('SELECT reference, issued_at, issued_by_name, summary FROM org_versions ORDER BY n DESC').all();
    const control = updateControlTable(page.body?.storage?.value || '', version);
    const body = mergeBody(control.body, pageBlock(version, history), control.tableEnd);
    await confluence(env, `/api/v2/pages/${PAGE_ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: PAGE_ID, status: 'current', title: page.title, body: { representation: 'storage', value: body },
        version: { number: page.version.number + 1, message: `${version.reference} issued by ${version.issued_by_name}` } }),
    });
    await env.DB.prepare("UPDATE org_versions SET confluence_status = 'published', confluence_error = NULL, published_at = ? WHERE n = ?")
      .bind(new Date().toISOString(), n).run();
    if (!control.updated) {
      await raiseAlert(env, { kind: 'org-table', dedupe: `org-table:${n}`, subject: `Update the IMS2.02 table in Confluence by hand for Issue ${n}`,
        body: `The chart for ${version.reference} is on the Confluence page, but the document control table couldn't be found by its Version and Last Reviewed headings, so it wasn't changed.\n\nSet Version to "Issue ${n}" and Last Reviewed to ${longDate(version.issued_at)}.` });
    }
    return true;
  } catch (err) {
    await env.DB.prepare("UPDATE org_versions SET confluence_status = 'failed', confluence_error = ? WHERE n = ?").bind(err.message.slice(0, 300), n).run();
    await raiseAlert(env, { kind: 'org-confluence', dedupe: `org-confluence:${n}`, subject: `${version.reference} hasn't reached Confluence yet`,
      body: `${version.reference} is issued in the hub, but Confluence couldn't be updated: ${err.message.slice(0, 200)}\nThe hub tries again every hour.` });
    return false;
  }
}

// Only the newest version is worth retrying; an older one would overwrite it.
// Major changes left waiting a few days get a reminder, once a week at most.
export async function hourly(env) {
  const latest = await env.DB.prepare('SELECT n, reference, confluence_status FROM org_versions ORDER BY n DESC LIMIT 1').first();
  if (!latest) return { idle: true };
  const oldest = await env.DB.prepare("SELECT MIN(at) AS at, COUNT(*) AS n FROM org_changes WHERE version_n IS NULL AND kind = 'major'").first();
  if (oldest?.n && Date.now() - Date.parse(oldest.at) > 3 * 86_400_000) {
    const week = new Date().toISOString().slice(0, 10);
    await raiseAlert(env, { kind: 'org-pending', dedupe: `org-pending:${latest.n}:${Math.floor(Date.now() / (7 * 86_400_000))}`,
      subject: `The company chart has ${oldest.n} major ${oldest.n === 1 ? 'change' : 'changes'} waiting for ${PREFIX}-${latest.n + 1}`,
      body: `Major changes to the company chart have been waiting since ${longDate(oldest.at)}. Confluence still shows ${latest.reference}.\n\nOpen the company chart in the hub, review the changes under the cog, and issue the next version when they're right. (${week})` });
  }
  if (latest.confluence_status !== 'failed') return {};
  return { published: await publish(env, latest.n) };
}
