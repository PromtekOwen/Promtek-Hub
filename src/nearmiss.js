// Near misses: anyone can report one, with who they are filled in for them. The people
// who review them (admins, unless changed under Admin) read every report, note what was
// done about it and close it, and hear about each new one as it comes in.
import { raiseAlert, sendAlerts, londonDate } from './sync.js';
import { record } from './audit.js';
import { peopleWith } from './permissions.js';

const MAX_PEOPLE = 20;
const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const canReview = (viewer) => Boolean(viewer?.isAdmin || viewer?.can?.nearMissReview);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));

function shape(r, { full = true } = {}) {
  return {
    id: r.id, reporter: r.reporter_name, reporterId: r.reporter_id, date: r.incident_date, location: r.location,
    involved: parse(r.involved, []), description: full ? r.description : String(r.description || '').slice(0, 200),
    actionNeeded: Boolean(r.action_needed), recommendations: r.recommendations, status: r.status,
    reviewNote: r.review_note, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, at: r.created_at,
  };
}

// What the form needs: everyone at Promtek to choose from.
export async function setup(env, viewer) {
  const { results } = await env.DB.prepare("SELECT account_id, name FROM employees WHERE active = 1 AND account_id NOT LIKE 'pending%' ORDER BY name").all();
  return { people: results.map((e) => ({ id: e.account_id, name: e.name })), me: { id: viewer.accountId, name: viewer.employee?.name || viewer.email },
    canReview: canReview(viewer), today: londonDate() };
}

export async function submit(env, viewer, input) {
  if (!viewer.accountId && !viewer.email) throw refuse('Sign in first.', 401);
  const date = String(input.date || '');
  if (!isDay(date)) throw refuse('Give the date it happened.');
  if (date > londonDate()) throw refuse('The date it happened can\'t be in the future.');
  const location = clean(input.location, 300);
  if (location.length < 2) throw refuse('Say where it happened.');
  const { results: staff } = await env.DB.prepare('SELECT account_id, name FROM employees WHERE active = 1').all();
  const involved = [];
  for (const p of (Array.isArray(input.involved) ? input.involved : []).slice(0, MAX_PEOPLE)) {
    if (p?.outside) {
      const name = clean(p.name, 120);
      if (!name) throw refuse('Give the name of the person from outside Promtek.');
      involved.push({ outside: true, name });
    } else {
      const e = staff.find((s) => s.account_id === p?.id);
      if (e && !involved.some((x) => x.id === e.account_id)) involved.push({ id: e.account_id, name: e.name });
    }
  }
  if (!involved.length) throw refuse('Say who was involved.');
  const description = clean(input.description, 5000);
  if (description.length < 10) throw refuse('Describe what happened.');
  if (typeof input.actionNeeded !== 'boolean') throw refuse('Say whether further action is needed.');
  const recommendations = clean(input.recommendations, 3000) || null;
  const now = new Date().toISOString();
  const name = viewer.employee?.name || viewer.email;
  const res = await env.DB.prepare(
    `INSERT INTO near_misses (reporter_id, reporter_name, reporter_email, incident_date, location, involved, description, action_needed, recommendations, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).bind(viewer.accountId || null, name, viewer.email || null, date, location, JSON.stringify(involved), description, input.actionNeeded ? 1 : 0, recommendations, now).run();
  const id = res.meta.last_row_id;
  // The reviewers hear straight away.
  const who = involved.map((p) => (p.outside ? `${p.name} (outside Promtek)` : p.name)).join(', ');
  for (const r of await peopleWith(env, 'nearMissReview').catch(() => [])) {
    if (!r.email) continue;
    await raiseAlert(env, { kind: 'near-miss', dedupe: `near-miss:${id}:${r.email}`, recipient: r.email,
      subject: `Near miss reported${input.actionNeeded ? ', further action needed' : ''}: ${location}`,
      body: `${name} reported a near miss on ${date} at ${location}.\n\nInvolved: ${who}\n\n${description}\n\nFurther action needed: ${input.actionNeeded ? 'Yes' : 'No'}${recommendations ? `\nRecommendations: ${recommendations}` : ''}\n\nOpen Near misses in the hub to read and close it.` });
  }
  await sendAlerts(env).catch(() => {});
  await record(env, viewer, { area: 'Near misses', action: 'reported', subjectType: 'near-miss', subjectId: id, label: `${date}, ${location}` });
  return { ok: true, id };
}

export async function mine(env, viewer) {
  const { results } = await env.DB.prepare('SELECT * FROM near_misses WHERE reporter_id = ? OR (reporter_id IS NULL AND reporter_email = ?) ORDER BY id DESC LIMIT 100')
    .bind(viewer.accountId || '', viewer.email || '').all();
  return { reports: results.map((r) => shape(r)) };
}

export async function all(env, viewer, { status = 'open' } = {}) {
  if (!canReview(viewer)) throw refuse('Reading every near miss isn\'t open to you.', 403);
  const where = status === 'closed' ? "WHERE status = 'closed'" : status === 'all' ? '' : "WHERE status != 'closed'";
  const { results } = await env.DB.prepare(`SELECT * FROM near_misses ${where} ORDER BY incident_date DESC, id DESC LIMIT 500`).all();
  const { results: counts } = await env.DB.prepare("SELECT status, action_needed, COUNT(*) AS n FROM near_misses GROUP BY status, action_needed").all();
  const sum = (fn) => counts.filter(fn).reduce((t, c) => t + c.n, 0);
  return { reports: results.map((r) => shape(r)), counts: { open: sum((c) => c.status !== 'closed'), openAction: sum((c) => c.status !== 'closed' && c.action_needed), closed: sum((c) => c.status === 'closed'), all: sum(() => true) } };
}

export async function get(env, viewer, id) {
  const r = await env.DB.prepare('SELECT * FROM near_misses WHERE id = ?').bind(Number(id)).first();
  if (!r) throw refuse('That report has gone.', 404);
  const own = (viewer.accountId && r.reporter_id === viewer.accountId) || (!r.reporter_id && r.reporter_email === viewer.email);
  if (!own && !canReview(viewer)) throw refuse('That report isn\'t yours.', 403);
  return { report: shape(r), canReview: canReview(viewer) };
}

// What was done about it, and closing it (or opening it again).
export async function review(env, viewer, { id, status, note }) {
  if (!canReview(viewer)) throw refuse('Reviewing near misses isn\'t open to you.', 403);
  const r = await env.DB.prepare('SELECT * FROM near_misses WHERE id = ?').bind(Number(id)).first();
  if (!r) throw refuse('That report has gone.', 404);
  const next = status === 'closed' ? 'closed' : 'open';
  const text = clean(note, 3000) || null;
  if (next === 'closed' && r.action_needed && !text) throw refuse('Say what was done about it before closing it.');
  await env.DB.prepare('UPDATE near_misses SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
    .bind(next, text, viewer.employee?.name || viewer.email, new Date().toISOString(), r.id).run();
  await record(env, viewer, { area: 'Near misses', action: next === 'closed' ? 'closed' : 'reopened', subjectType: 'near-miss', subjectId: r.id, label: `${r.incident_date}, ${r.location}`,
    changes: [{ label: 'Action taken', before: r.review_note || '', after: text || '' }] });
  return { ok: true };
}

export async function csv(env, viewer) {
  if (!canReview(viewer)) throw refuse('Reading every near miss isn\'t open to you.', 403);
  const { results } = await env.DB.prepare('SELECT * FROM near_misses ORDER BY incident_date DESC, id DESC').all();
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['Reported', 'Reported by', 'Date', 'Location', 'Involved', 'Description', 'Further action needed', 'Recommendations', 'Status', 'Action taken', 'Reviewed by'].join(',')];
  for (const r of results.map((x) => shape(x))) {
    lines.push([r.at.slice(0, 10), r.reporter, r.date, r.location, r.involved.map((p) => (p.outside ? `${p.name} (outside Promtek)` : p.name)).join('; '), r.description,
      r.actionNeeded ? 'Yes' : 'No', r.recommendations, r.status === 'closed' ? 'Closed' : 'Open', r.reviewNote, r.reviewedBy].map(cell).join(','));
  }
  return { body: lines.join('\n'), filename: `Near misses ${londonDate()}.csv` };
}
