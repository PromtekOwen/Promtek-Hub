// Short forms sent from Admin, like a Christmas party sign-up or a quick survey. Each shows
// under Alerts on the home screen for the people it's for until they've answered it or it
// closes. Questions are multiple choice (one answer, or any number) or a typed answer.
// Admins see every answer, person by person, and what share each choice got.
import { londonDate } from './sync.js';
import { record } from './audit.js';
import { teamsOf, TEAMS } from './permissions.js';

const MAX_QUESTIONS = 30;
const MAX_OPTIONS = 20;
const MAX_TEXT = 2000;
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const readerOf = (viewer) => viewer.accountId || viewer.email;

function reaches(audience, viewer) {
  if (audience.everyone) return true;
  if ((audience.people || []).includes(viewer.accountId)) return true;
  return (audience.teams || []).some((t) => (viewer.teams || []).includes(t));
}

const isOpen = (f, now = new Date().toISOString()) => !f.closed_at && (!f.ends_at || f.ends_at > now);

// ---------- making one ----------

export function cleanQuestions(list) {
  const qs = (Array.isArray(list) ? list : []).slice(0, MAX_QUESTIONS).map((q, i) => {
    const label = clean(q.label, 300);
    const type = q.type === 'text' ? 'text' : 'choice';
    const options = type === 'choice' ? [...new Set((q.options || []).map((o) => clean(o, 120)).filter(Boolean))].slice(0, MAX_OPTIONS) : [];
    return { id: `q${i + 1}`, label, type, multi: type === 'choice' && Boolean(q.multi), long: type === 'text' && Boolean(q.long), required: Boolean(q.required), options };
  });
  if (!qs.length) throw refuse('Add at least one question.');
  qs.forEach((q, i) => {
    if (q.label.length < 2) throw refuse(`Question ${i + 1} needs its question written.`);
    if (q.type === 'choice' && q.options.length < 2) throw refuse(`Question ${i + 1} needs at least two answers to choose from.`);
  });
  return qs;
}

export async function create(env, viewer, input) {
  const title = clean(input.title, 120);
  if (title.length < 3) throw refuse('Give the form a title.');
  const intro = clean(input.intro, 1000) || null;
  const questions = cleanQuestions(input.questions);
  const everyone = Boolean(input.everyone);
  const teams = everyone ? [] : [...new Set(input.teams || [])].filter((t) => TEAMS.includes(t));
  const { results: staff } = await env.DB.prepare('SELECT account_id, name FROM employees WHERE active = 1').all();
  const people = everyone ? [] : [...new Set(input.people || [])].filter((id) => staff.some((s) => s.account_id === id));
  if (!everyone && !teams.length && !people.length) throw refuse('Choose who it\'s for.');
  let endsAt = null;
  if (input.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until)) throw refuse('The closing date isn\'t a date.');
    if (input.until < londonDate()) throw refuse('The closing date has already passed.');
    endsAt = new Date(Date.parse(`${input.until}T23:59:59Z`)).toISOString();
  }
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO hub_forms (title, intro, questions, audience, tone, ends_at, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(title, intro, JSON.stringify(questions), JSON.stringify({ everyone, teams, people }), input.tone === 'important' ? 'important' : 'info', endsAt,
    viewer.email, viewer.employee?.name || viewer.email, now).run();
  const id = res.meta.last_row_id;
  await record(env, viewer, { area: 'Home messages', action: 'form sent', subjectType: 'form', subjectId: id, label: title,
    changes: [{ label: 'Questions', before: '', after: String(questions.length) },
      { label: 'Who for', before: '', after: everyone ? 'Everyone' : [...teams.map((t) => `${t} team`), ...people.map((p) => staff.find((s) => s.account_id === p)?.name || p)].join(', ') }] });
  return { id };
}

export async function close(env, viewer, id) {
  const f = await env.DB.prepare('SELECT * FROM hub_forms WHERE id = ?').bind(Number(id)).first();
  if (!f) throw refuse('That form has gone.', 404);
  if (f.closed_at) return { ok: true };
  await env.DB.prepare('UPDATE hub_forms SET closed_at = ?, closed_by = ? WHERE id = ?').bind(new Date().toISOString(), viewer.email, f.id).run();
  await record(env, viewer, { area: 'Home messages', action: 'form closed', subjectType: 'form', subjectId: f.id, label: f.title });
  return { ok: true };
}

// ---------- on the home screen ----------

// Forms open to this person that they haven't answered, shaped as alerts.
export async function forFeed(env, viewer) {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT f.*, a.submitted_at FROM hub_forms f LEFT JOIN hub_form_answers a ON a.form_id = f.id AND a.account_id = ?
      WHERE f.closed_at IS NULL AND (f.ends_at IS NULL OR f.ends_at > ?) ORDER BY f.id DESC LIMIT 50`
  ).bind(readerOf(viewer), now).all();
  return results.filter((f) => !f.submitted_at && reaches(parse(f.audience, {}), viewer)).map((f) => ({
    id: null, formId: f.id, title: f.title, body: f.intro, tone: f.tone, from: f.created_by_name, at: f.created_at, form: true,
    questions: parse(f.questions, []).length, endsAt: f.ends_at,
  }));
}

export async function get(env, viewer, id) {
  const f = await env.DB.prepare('SELECT * FROM hub_forms WHERE id = ?').bind(Number(id)).first();
  if (!f || (!reaches(parse(f.audience, {}), viewer) && !viewer.isAdmin)) throw refuse('That form isn\'t for you.', 404);
  const mine = await env.DB.prepare('SELECT answers, submitted_at FROM hub_form_answers WHERE form_id = ? AND account_id = ?').bind(f.id, readerOf(viewer)).first();
  return { form: { id: f.id, title: f.title, intro: f.intro, questions: parse(f.questions, []), endsAt: f.ends_at, open: isOpen(f), from: f.created_by_name },
    answers: mine ? parse(mine.answers, {}) : null, submittedAt: mine?.submitted_at || null };
}

export async function answer(env, viewer, { id, answers }) {
  const f = await env.DB.prepare('SELECT * FROM hub_forms WHERE id = ?').bind(Number(id)).first();
  if (!f || !reaches(parse(f.audience, {}), viewer)) throw refuse('That form isn\'t for you.', 404);
  if (!isOpen(f)) throw refuse('That form has closed.');
  const given = answers && typeof answers === 'object' ? answers : {};
  const out = {};
  for (const q of parse(f.questions, [])) {
    const v = given[q.id];
    if (q.type === 'text') {
      const text = clean(v, MAX_TEXT);
      if (text) out[q.id] = text;
    } else {
      const picked = [...new Set((Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String))].filter((o) => q.options.includes(o));
      if (picked.length) out[q.id] = q.multi ? picked : picked.slice(0, 1);
    }
    if (q.required && !out[q.id]) throw refuse(`"${q.label}" needs an answer.`);
  }
  if (!Object.keys(out).length) throw refuse('Answer at least one question.');
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO hub_form_answers (form_id, account_id, name, answers, submitted_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(form_id, account_id) DO UPDATE SET name = excluded.name, answers = excluded.answers, submitted_at = excluded.submitted_at`
  ).bind(f.id, readerOf(viewer), viewer.employee?.name || viewer.email, JSON.stringify(out), now).run();
  return { ok: true };
}

// ---------- for admins ----------

export async function adminList(env, people) {
  const { results } = await env.DB.prepare(
    `SELECT f.*, (SELECT COUNT(*) FROM hub_form_answers a WHERE a.form_id = f.id) AS answered FROM hub_forms f ORDER BY f.id DESC LIMIT 100`
  ).all();
  const now = new Date().toISOString();
  return results.map((f) => {
    const audience = parse(f.audience, {});
    const reach = people.filter((p) => audience.everyone || (audience.people || []).includes(p.id) || (audience.teams || []).some((t) => p.teams.includes(t))).length;
    return { id: f.id, title: f.title, intro: f.intro, questions: parse(f.questions, []).length, answered: f.answered, reach, from: f.created_by_name, at: f.created_at,
      endsAt: f.ends_at, live: isOpen(f, now), closedAt: f.closed_at || (f.ends_at && f.ends_at <= now ? f.ends_at : null), tone: f.tone,
      audienceText: audience.everyone ? 'Everyone' : [...(audience.teams || []).map((t) => `${t} team`), ...(audience.people || []).map((id) => people.find((p) => p.id === id)?.name || 'someone who has left')].join(', ') };
  });
}

// Every answer, person by person, and for each multiple choice question the share each choice got.
export async function responses(env, id) {
  const f = await env.DB.prepare('SELECT * FROM hub_forms WHERE id = ?').bind(Number(id)).first();
  if (!f) throw refuse('That form has gone.', 404);
  const questions = parse(f.questions, []);
  const { results } = await env.DB.prepare('SELECT account_id, name, answers, submitted_at FROM hub_form_answers WHERE form_id = ? ORDER BY name').bind(f.id).all();
  const rows = results.map((r) => ({ who: r.name || r.account_id, at: r.submitted_at, answers: parse(r.answers, {}) }));
  const audience = parse(f.audience, {});
  const { results: staff } = await env.DB.prepare("SELECT account_id, name, teams, team FROM employees WHERE active = 1 AND account_id NOT LIKE 'pending:%' ORDER BY name").all();
  const answeredBy = new Set(results.map((r) => r.account_id));
  const waiting = staff.filter((s) => reaches(audience, { accountId: s.account_id, teams: teamsOf(s) }) && !answeredBy.has(s.account_id)).map((s) => s.name);
  const stats = questions.map((q) => {
    const said = rows.map((r) => r.answers[q.id]).filter((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
    if (q.type === 'text') return { id: q.id, label: q.label, type: q.type, answered: said.length };
    const counts = Object.fromEntries(q.options.map((o) => [o, 0]));
    for (const v of said) for (const o of v) if (o in counts) counts[o]++;
    // Out of the people who answered it, so a multiple-answer question can add up to more than 100%.
    return { id: q.id, label: q.label, type: q.type, multi: q.multi, answered: said.length,
      options: q.options.map((o) => ({ option: o, count: counts[o], share: said.length ? counts[o] / said.length : 0 })) };
  });
  return { form: { id: f.id, title: f.title, intro: f.intro, questions, live: isOpen(f), endsAt: f.ends_at, from: f.created_by_name, at: f.created_at },
    rows, stats, waiting };
}

export async function csv(env, id) {
  const { form, rows } = await responses(env, id);
  const cell = (v) => { const s = Array.isArray(v) ? v.join('; ') : String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['Name', 'Answered', ...form.questions.map((q) => q.label)].map(cell).join(',')];
  for (const r of rows) lines.push([r.who, r.at.slice(0, 16).replace('T', ' '), ...form.questions.map((q) => r.answers[q.id])].map(cell).join(','));
  return { body: lines.join('\n'), filename: `${form.title.replace(/[^\w -]+/g, '').trim() || 'Form'} answers.csv` };
}
