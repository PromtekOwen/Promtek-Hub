// Training and policies. The training matrix (who has done which course, when, and when it's
// due again), tool box talks (an Internal Training item in Compliance & Training, with a
// reminder each day counting down to it) and policies to acknowledge. Everyone sees their
// own; management set them up and see who has and hasn't acknowledged each.
import { jira } from './jira.js';
import { canTile } from './permissions.js';
import { record } from './audit.js';
import { londonDate } from './sync.js';

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const DAY = 86_400_000;
const clip = (v, n = 500) => String(v ?? '').trim().slice(0, n);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const json = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
export const DUE_SOON_DAYS = 30;

export function mustSee(viewer) {
  if (!canTile(viewer, 'training') && !canTile(viewer, 'ims')) throw refuse('Training and policies aren\'t open to you.', 403);
}
export const canManage = (viewer) => Boolean(viewer.isAdmin || viewer.can?.trainingManage);
function mustManage(viewer) {
  mustSee(viewer);
  if (!canManage(viewer)) throw refuse('Only management can do that.', 403);
}

// ---------- people and who something is for ----------

async function people(env) {
  const { results } = await env.DB.prepare("SELECT account_id, name, email, teams, job_title, department FROM employees WHERE active = 1 AND account_id NOT LIKE 'pending%' ORDER BY name").all();
  return results.map((e) => ({ id: e.account_id, name: e.name, email: e.email, teams: json(e.teams || '[]', []), job: e.job_title || '' }));
}

export const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();

// Who an audience covers: everyone, teams, matrix divisions and named people.
async function audienceIds(env, audience, everyone = null) {
  const list = everyone || await people(env);
  const a = audience || {};
  if (a.everyone) return new Set(list.map((p) => p.id));
  const out = new Set((a.people || []).map(String));
  for (const p of list) if ((a.teams || []).some((t) => p.teams.includes(t))) out.add(p.id);
  if ((a.divisions || []).length) {
    const ids = a.divisions.map(Number).filter(Boolean).slice(0, 20);
    const { results } = await env.DB.prepare(`SELECT person_key FROM training_members WHERE division_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    results.forEach((r) => out.add(r.person_key));
  }
  const known = new Set(list.map((p) => p.id));
  return new Set([...out].filter((id) => known.has(id)));
}

function cleanAudience(a = {}) {
  return {
    everyone: Boolean(a.everyone),
    teams: (Array.isArray(a.teams) ? a.teams : []).map((t) => clip(t, 40)).filter(Boolean).slice(0, 20),
    divisions: (Array.isArray(a.divisions) ? a.divisions : []).map(Number).filter(Boolean).slice(0, 20),
    people: (Array.isArray(a.people) ? a.people : []).map(String).filter((x) => /^[\w:-]{3,128}$/.test(x)).slice(0, 200),
  };
}
const audienceEmpty = (a) => !a.everyone && !a.teams.length && !a.divisions.length && !a.people.length;

// ---------- the training matrix ----------

// When a course is due again: from when it was done and how often it's needed, unless
// an expiry date was given (a passport or certificate, say).
export function cellStatus(rec, course, today = londonDate()) {
  if (!rec) return { status: 'blank' };
  if (rec.state === 'na') return { status: 'na' };
  if (rec.state === 'optional') return { status: 'optional' };
  if (rec.state === 'required') return { status: 'missing' };
  let due = rec.expires_on || null;
  if (!due && rec.completed_on && course?.months) {
    const d = new Date(`${rec.completed_on}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + course.months);
    due = d.toISOString().slice(0, 10);
  }
  if (!due) return { status: 'ok', due: null };
  if (due < today) return { status: 'expired', due };
  const soon = new Date(Date.parse(`${today}T12:00:00Z`) + DUE_SOON_DAYS * DAY).toISOString().slice(0, 10);
  return { status: due <= soon ? 'soon' : 'ok', due };
}

// Names from the old spreadsheet are matched to people in the hub as soon as one fits.
async function linkNames(env, list) {
  const { results } = await env.DB.prepare("SELECT DISTINCT person_key, name FROM training_members WHERE person_key LIKE 'n:%'").all();
  const byName = new Map(list.map((p) => [normName(p.name), p.id]));
  for (const r of results) {
    const id = byName.get(normName(r.name));
    if (id) await relink(env, r.person_key, id);
  }
}

async function relink(env, from, to) {
  await env.DB.batch([
    env.DB.prepare('UPDATE OR IGNORE training_members SET person_key = ? WHERE person_key = ?').bind(to, from),
    env.DB.prepare('DELETE FROM training_members WHERE person_key = ?').bind(from),
    env.DB.prepare('UPDATE OR IGNORE training_records SET person_key = ? WHERE person_key = ?').bind(to, from),
    env.DB.prepare('DELETE FROM training_records WHERE person_key = ?').bind(from),
  ]);
}

export async function matrix(env, viewer, { division = null } = {}) {
  mustSee(viewer);
  const manage = canManage(viewer);
  const list = await people(env);
  await linkNames(env, list).catch(() => {});
  const [{ results: divisions }, { results: courses }, { results: links }, { results: members }] = await Promise.all([
    env.DB.prepare('SELECT * FROM training_divisions ORDER BY position, name').all(),
    env.DB.prepare('SELECT * FROM training_courses WHERE active = 1 ORDER BY position, name').all(),
    env.DB.prepare('SELECT * FROM training_division_courses ORDER BY position').all(),
    env.DB.prepare('SELECT * FROM training_members ORDER BY position, name').all(),
  ]);
  // Management start on the first division: every course at once is too wide to read.
  const div = divisions.find((d) => d.id === Number(division)) || (manage && division == null && divisions.length ? divisions[0] : null);
  const mine = viewer.accountId;
  // Everyone sees their own training; management see everyone's.
  const shownMembers = members.filter((m) => (div ? m.division_id === div.id : true) && (manage || m.person_key === mine));
  const personKeys = [...new Set(shownMembers.map((m) => m.person_key))];
  const courseIds = div ? links.filter((l) => l.division_id === div.id).map((l) => l.course_id)
    : [...new Set(links.filter((l) => shownMembers.some((m) => m.division_id === l.division_id)).map((l) => l.course_id))];
  const shownCourses = courseIds.map((id) => courses.find((c) => c.id === id)).filter(Boolean);
  if (!div) shownCourses.sort((a, b) => a.position - b.position);
  const records = new Map();
  for (let i = 0; i < personKeys.length; i += 90) {
    const part = personKeys.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT * FROM training_records WHERE person_key IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const r of results) records.set(`${r.person_key}|${r.course_id}`, r);
  }
  const today = londonDate();
  const byId = new Map(list.map((p) => [p.id, p]));
  const rows = personKeys.map((key) => {
    const m = shownMembers.find((x) => x.person_key === key);
    const cells = {};
    const counts = { expired: 0, soon: 0, missing: 0 };
    for (const c of shownCourses) {
      const rec = records.get(`${key}|${c.id}`);
      const st = cellStatus(rec, c, today);
      if (counts[st.status] != null) counts[st.status]++;
      cells[c.id] = { ...st, completed: rec?.completed_on || null, expires: rec?.expires_on || null, note: rec?.note || null, evidence: rec?.evidence || null, state: rec?.state || null };
    }
    const theirDivisions = members.filter((x) => x.person_key === key).map((x) => x.division_id);
    // The courses that apply to them: those of their divisions.
    const theirCourses = shownCourses.filter((c) => links.some((l) => l.course_id === c.id && theirDivisions.includes(l.division_id))).map((c) => c.id);
    return { key, name: byId.get(key)?.name || m.name, linked: byId.has(key), note: m.note, divisions: theirDivisions, courses: theirCourses, cells, counts };
  });
  const courseCounts = Object.fromEntries(shownCourses.map((c) => [c.id, rows.reduce((t, r) => {
    const s = r.cells[c.id]?.status; if (s === 'expired' || s === 'missing') t.bad++; if (s === 'soon') t.soon++; return t;
  }, { bad: 0, soon: 0 })]));
  return {
    manage, divisions, division: div?.id || null,
    courses: shownCourses.map((c) => ({ id: c.id, name: c.name, category: c.category, frequency: c.frequency, months: c.months, about: c.about, ...courseCounts[c.id] })),
    allCourses: manage ? courses.map((c) => ({ id: c.id, name: c.name, category: c.category, frequency: c.frequency, months: c.months,
      divisions: links.filter((l) => l.course_id === c.id).map((l) => l.division_id) })) : [],
    rows,
    people: manage ? list.map(({ id, name }) => ({ id, name })) : [],
    totals: rows.reduce((t, r) => ({ expired: t.expired + r.counts.expired, soon: t.soon + r.counts.soon, missing: t.missing + r.counts.missing }), { expired: 0, soon: 0, missing: 0 }),
    dueSoonDays: DUE_SOON_DAYS,
  };
}

const STATES = ['done', 'na', 'required', 'optional'];
export async function setRecord(env, viewer, { personKey, courseId, state, completedOn, expiresOn, note, evidence }) {
  mustManage(viewer);
  const key = String(personKey || '');
  const course = await env.DB.prepare('SELECT * FROM training_courses WHERE id = ?').bind(Number(courseId)).first();
  if (!course) throw refuse('That course isn\'t in the matrix.', 404);
  if (!key) throw refuse('Whose training is it?');
  if (state === 'clear') {
    await env.DB.prepare('DELETE FROM training_records WHERE person_key = ? AND course_id = ?').bind(key, course.id).run();
  } else {
    if (!STATES.includes(state)) throw refuse('Choose done, required, optional or not applicable.');
    if (state === 'done' && !isDay(completedOn) && !isDay(expiresOn)) throw refuse('Give the date it was done, or when it expires.');
    if (evidence && !/^https?:\/\//i.test(String(evidence))) throw refuse('Evidence should be a link starting http.');
    await env.DB.prepare(`INSERT INTO training_records (person_key, course_id, state, completed_on, expires_on, note, evidence, source, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'hub', ?, ?) ON CONFLICT(person_key, course_id) DO UPDATE SET state = excluded.state, completed_on = excluded.completed_on,
      expires_on = excluded.expires_on, note = excluded.note, evidence = excluded.evidence, source = 'hub', updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(key, course.id, state, state === 'done' && isDay(completedOn) ? completedOn : null, state === 'done' && isDay(expiresOn) ? expiresOn : null,
        clip(note, 500) || null, clip(evidence, 1000) || null, viewer.employee?.name || viewer.email, new Date().toISOString()).run();
  }
  await record(env, viewer, { area: 'Training', action: 'updated the training matrix', subjectType: 'training', subjectId: `${key}|${course.id}`, label: course.name,
    changes: [{ label: course.name, before: '', after: state === 'done' ? `Done ${completedOn || ''}${expiresOn ? `, expires ${expiresOn}` : ''}` : state }] }).catch(() => {});
  return { ok: true };
}

const MONTHS = (text) => {
  const t = String(text || '').toLowerCase();
  if (/6 months/.test(t)) return 6;
  const y = /(\d+)\s*year/.exec(t);
  if (y) return Number(y[1]) * 12;
  if (/year/.test(t)) return 12;
  return null;
};

export async function saveCourse(env, viewer, { id, name, category, frequency, months, about, divisions, active = true }) {
  mustManage(viewer);
  const n = clip(name, 120);
  if (n.length < 2) throw refuse('Give the course a name.');
  const m = months === '' || months == null ? MONTHS(frequency) : Math.max(0, Math.min(240, Number(months) || 0)) || null;
  let courseId = Number(id) || null;
  if (courseId) {
    await env.DB.prepare('UPDATE training_courses SET name = ?, category = ?, frequency = ?, months = ?, about = ?, active = ? WHERE id = ?')
      .bind(n, clip(category, 80) || null, clip(frequency, 80) || null, m, clip(about, 1000) || null, active ? 1 : 0, courseId).run();
  } else {
    const r = await env.DB.prepare('INSERT INTO training_courses (name, category, frequency, months, about, position) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM training_courses)) RETURNING id')
      .bind(n, clip(category, 80) || null, clip(frequency, 80) || null, m, clip(about, 1000) || null).first();
    courseId = r.id;
  }
  if (Array.isArray(divisions)) {
    const want = new Set(divisions.map(Number));
    const { results: have } = await env.DB.prepare('SELECT division_id FROM training_division_courses WHERE course_id = ?').bind(courseId).all();
    for (const h of have) if (!want.has(h.division_id)) await env.DB.prepare('DELETE FROM training_division_courses WHERE division_id = ? AND course_id = ?').bind(h.division_id, courseId).run();
    for (const d of want) await env.DB.prepare('INSERT OR IGNORE INTO training_division_courses (division_id, course_id, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM training_division_courses WHERE division_id = ?))').bind(d, courseId, d).run();
  }
  return { ok: true, id: courseId };
}

export async function saveDivision(env, viewer, { id, name }) {
  mustManage(viewer);
  const n = clip(name, 80);
  if (n.length < 2) throw refuse('Give the division a name.');
  if (id) await env.DB.prepare('UPDATE training_divisions SET name = ? WHERE id = ?').bind(n, Number(id)).run();
  else await env.DB.prepare('INSERT INTO training_divisions (name, position) VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM training_divisions))').bind(n).run();
  return { ok: true };
}

// Someone added to or taken out of a division, or an old spreadsheet name matched to someone.
export async function saveMember(env, viewer, { divisionId, personKey, remove = false, linkTo = null, note }) {
  mustManage(viewer);
  const d = Number(divisionId);
  const key = String(personKey || '');
  if (linkTo) {
    const p = (await people(env)).find((x) => x.id === String(linkTo));
    if (!p) throw refuse('Choose someone from the list.');
    await relink(env, key, p.id);
    return { ok: true };
  }
  if (remove) { await env.DB.prepare('DELETE FROM training_members WHERE division_id = ? AND person_key = ?').bind(d, key).run(); return { ok: true }; }
  const p = (await people(env)).find((x) => x.id === key);
  if (!p) throw refuse('Choose someone from the list.');
  if (!(await env.DB.prepare('SELECT 1 FROM training_divisions WHERE id = ?').bind(d).first())) throw refuse('Choose a division.');
  await env.DB.prepare(`INSERT INTO training_members (division_id, person_key, name, note, position) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM training_members WHERE division_id = ?))
    ON CONFLICT(division_id, person_key) DO UPDATE SET note = excluded.note`).bind(d, p.id, p.name, clip(note, 200) || null, d).run();
  return { ok: true };
}

// ---------- tool box talks ----------

const INTERNAL_TRAINING = 'Internal Training';
const TALK_PROJECT = 'COMPLIANCE';

function talkWhen(iso) {
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export async function createTalk(env, viewer, input) {
  mustManage(viewer);
  const title = clip(input.title, 200).replace(/\s+/g, ' ');
  if (title.length < 3) throw refuse('Give the tool box talk a title.');
  const starts = Date.parse(String(input.startsAt || ''));
  if (!Number.isFinite(starts)) throw refuse('Give the date and time of the talk.');
  const audience = cleanAudience(input.audience);
  if (audienceEmpty(audience)) throw refuse('Choose who the talk is for.');
  const link = clip(input.meetLink, 1000);
  if (link && !/^https?:\/\//i.test(link)) throw refuse('The meeting link should start with https://');
  const courseId = Number(input.courseId) || null;
  const minutes = Math.max(5, Math.min(480, Number(input.minutes) || 30));
  const startsAt = new Date(starts).toISOString();
  const day = londonDate(starts);
  const list = await people(env);
  const ids = [...await audienceIds(env, audience, list)];
  // In Jira: an Internal Training item in Compliance & Training, on the day of the talk.
  const Ims = await import('./ims.js');
  const meta = await Ims.createMeta(env, TALK_PROJECT, INTERNAL_TRAINING);
  if (!meta) throw refuse('Compliance & Training has no Internal Training type in Jira.');
  const F = await Ims.fieldMap(env);
  const { adfFrom } = await import('./jiraview.js');
  const by = (n) => meta.byName[n.toLowerCase()];
  const text = [clip(input.about, 5000), `When: ${talkWhen(startsAt)} (${minutes} minutes)`, input.location ? `Where: ${clip(input.location, 200)}` : '', link ? `Join: ${link}` : '']
    .filter(Boolean).join('\n\n');
  const fields = { project: { key: TALK_PROJECT }, issuetype: { id: meta.typeId }, summary: title, description: adfFrom(text) };
  if (F.categories) fields[F.categories] = [{ value: 'Compliance & Training' }];
  if (F.start) fields[F.start] = day;
  if (F.target) fields[F.target] = day;
  const who = by('Who Requires the Training');
  if (who && ids.length) fields[who.id] = who.schema?.type === 'array' ? ids.slice(0, 100).map((accountId) => ({ accountId })) : { accountId: ids[0] };
  const linkField = by('Link');
  if (linkField && link) fields[linkField.id] = link;
  let made;
  try { made = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) }); } catch (err) {
    if (err.status !== 400) throw err;
    if (who) delete fields[who.id];
    if (linkField) delete fields[linkField.id];
    made = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
  }
  if (F.origin) await jira(env, `/rest/api/3/issue/${made.key}`, { method: 'PUT', body: JSON.stringify({ fields: { [F.origin]: made.key } }) }).catch(() => {});
  const r = await env.DB.prepare(`INSERT INTO toolbox_talks (issue_key, title, about, starts_at, minutes, location, meet_link, course_id, audience, created_by, created_by_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(made.key, title, clip(input.about, 5000) || null, startsAt, minutes, clip(input.location, 200) || null,
    link || null, courseId, JSON.stringify(audience), viewer.accountId || null, viewer.employee?.name || viewer.email, new Date().toISOString()).first();
  await tellTalk(env, { id: r.id, title, starts_at: startsAt, minutes, meet_link: link, location: input.location }, ids, 'talk-new');
  await record(env, viewer, { area: 'Training', action: 'arranged a tool box talk', subjectType: 'talk', subjectId: String(r.id), label: `${made.key} ${title}`.slice(0, 120),
    changes: [{ label: 'When', before: '', after: talkWhen(startsAt) }, { label: 'For', before: '', after: `${ids.length} people` }] }).catch(() => {});
  return { ok: true, id: r.id, key: made.key, people: ids.length };
}

export async function updateTalk(env, viewer, { id, title, about, startsAt, minutes, location, meetLink, courseId, audience, cancel }) {
  mustManage(viewer);
  const t = await env.DB.prepare('SELECT * FROM toolbox_talks WHERE id = ?').bind(Number(id)).first();
  if (!t) throw refuse('That talk isn\'t in the list.', 404);
  if (cancel) {
    await env.DB.prepare('UPDATE toolbox_talks SET cancelled = 1 WHERE id = ?').bind(t.id).run();
    return { ok: true };
  }
  const link = meetLink === undefined ? t.meet_link : clip(meetLink, 1000);
  if (link && !/^https?:\/\//i.test(link)) throw refuse('The meeting link should start with https://');
  const starts = startsAt ? Date.parse(String(startsAt)) : Date.parse(t.starts_at);
  if (!Number.isFinite(starts)) throw refuse('Give the date and time of the talk.');
  const aud = audience ? cleanAudience(audience) : json(t.audience, {});
  if (audienceEmpty(cleanAudience(aud))) throw refuse('Choose who the talk is for.');
  await env.DB.prepare('UPDATE toolbox_talks SET title = ?, about = ?, starts_at = ?, minutes = ?, location = ?, meet_link = ?, course_id = ?, audience = ? WHERE id = ?')
    .bind(clip(title ?? t.title, 200) || t.title, about === undefined ? t.about : clip(about, 5000) || null, new Date(starts).toISOString(),
      minutes ? Math.max(5, Math.min(480, Number(minutes))) : t.minutes, location === undefined ? t.location : clip(location, 200) || null, link || null,
      courseId === undefined ? t.course_id : Number(courseId) || null, JSON.stringify(aud), t.id).run();
  // The link goes on the Jira item too, where there's a field for it.
  if (t.issue_key && link !== t.meet_link) {
    const meta = await (await import('./ims.js')).createMeta(env, TALK_PROJECT, INTERNAL_TRAINING).catch(() => null);
    const f = meta?.byName.link;
    if (f) await jira(env, `/rest/api/3/issue/${t.issue_key}`, { method: 'PUT', body: JSON.stringify({ fields: { [f.id]: link || null } }) }).catch(() => {});
  }
  return { ok: true };
}

async function tellTalk(env, t, ids, kind) {
  const { toPerson } = await import('./notify.js');
  const days = Math.round((Date.parse(`${londonDate(Date.parse(t.starts_at))}T12:00:00Z`) - Date.parse(`${londonDate()}T12:00:00Z`)) / DAY);
  const count = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  const time = new Date(t.starts_at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  const subject = kind === 'talk-new' ? `Tool box talk: ${t.title}, ${talkWhen(t.starts_at)}` : `Tool box talk ${count}${days <= 0 ? ` at ${time}` : ''}: ${t.title}`;
  const body = [`${talkWhen(t.starts_at)}${t.minutes ? `, ${t.minutes} minutes` : ''}.`, t.location ? `Where: ${t.location}` : '', t.meet_link ? `Join: ${t.meet_link}` : ''].filter(Boolean).join('\n');
  for (const id of ids) {
    await toPerson(env, id, { tile: 'training', kind, dedupe: `${kind}:${t.id}:${kind === 'talk-new' ? 'made' : londonDate()}`, subject, body,
      link: `#/training?open=talk-${t.id}`, ref: { key: `talk-${t.id}` } }).catch(() => {});
  }
}

async function acksFor(env, kind, ids) {
  if (!ids.length) return new Map();
  const { results } = await env.DB.prepare(`SELECT item_id, account_id, at FROM acknowledgements WHERE kind = ? AND item_id IN (${ids.map(() => '?').join(',')})`).bind(kind, ...ids).all();
  const out = new Map();
  for (const r of results) (out.get(r.item_id) || out.set(r.item_id, new Map()).get(r.item_id)).set(r.account_id, r.at);
  return out;
}

export async function talks(env, viewer) {
  mustSee(viewer);
  const manage = canManage(viewer);
  const list = await people(env);
  const { results } = await env.DB.prepare('SELECT * FROM toolbox_talks WHERE cancelled = 0 ORDER BY starts_at DESC LIMIT 200').all();
  const acks = await acksFor(env, 'talk', results.map((t) => t.id));
  const names = new Map(list.map((p) => [p.id, p.name]));
  const now = Date.now();
  const out = [];
  for (const t of results) {
    const ids = [...await audienceIds(env, json(t.audience, {}), list)];
    const mine = ids.includes(viewer.accountId);
    if (!manage && !mine) continue;
    const ack = acks.get(t.id) || new Map();
    out.push({
      id: t.id, key: t.issue_key, title: t.title, about: t.about, startsAt: t.starts_at, minutes: t.minutes, location: t.location, link: t.meet_link, courseId: t.course_id,
      upcoming: Date.parse(t.starts_at) + (t.minutes || 30) * 60000 > now, started: Date.parse(t.starts_at) <= now,
      audience: manage ? json(t.audience, {}) : null, forMe: mine, acknowledged: ack.has(viewer.accountId) ? ack.get(viewer.accountId) : null,
      count: ids.length, done: ids.filter((id) => ack.has(id)).length,
      people: manage ? ids.map((id) => ({ id, name: names.get(id) || id, at: ack.get(id) || null })).sort((a, b) => Boolean(a.at) - Boolean(b.at) || a.name.localeCompare(b.name)) : null,
      by: t.created_by_name,
    });
  }
  out.sort((a, b) => (a.upcoming === b.upcoming ? (a.upcoming ? a.startsAt.localeCompare(b.startsAt) : b.startsAt.localeCompare(a.startsAt)) : a.upcoming ? -1 : 1));
  return { talks: out, manage };
}

// ---------- policies ----------

function cleanLinks(links) {
  const out = (Array.isArray(links) ? links : []).map((l) => ({ label: clip(l?.label, 120), url: clip(l?.url, 1000) })).filter((l) => l.url);
  for (const l of out) if (!/^https?:\/\//i.test(l.url)) throw refuse(`${l.label || 'A link'} should start with https://`);
  return out.slice(0, 20);
}

export async function savePolicy(env, viewer, input) {
  mustManage(viewer);
  const title = clip(input.title, 200).replace(/\s+/g, ' ');
  if (title.length < 3) throw refuse('Give the policy a title.');
  const links = cleanLinks(input.links);
  if (!links.length) throw refuse('Add a link to the policy document.');
  const audience = cleanAudience(input.audience);
  if (audienceEmpty(audience)) throw refuse('Choose who needs to acknowledge it.');
  const due = isDay(input.dueOn) ? input.dueOn : null;
  const now = new Date().toISOString();
  if (input.id) {
    const p = await env.DB.prepare('SELECT * FROM policies WHERE id = ?').bind(Number(input.id)).first();
    if (!p) throw refuse('That policy isn\'t in the list.', 404);
    await env.DB.prepare('UPDATE policies SET title = ?, about = ?, links = ?, audience = ?, version = ?, due_on = ?, archived = ? WHERE id = ?')
      .bind(title, clip(input.about, 5000) || null, JSON.stringify(links), JSON.stringify(audience), clip(input.version, 40) || null, due, input.archived ? 1 : 0, p.id).run();
    // A new version needs acknowledging again.
    if (input.version && input.version !== p.version) await env.DB.prepare("DELETE FROM acknowledgements WHERE kind = 'policy' AND item_id = ?").bind(p.id).run();
    return { ok: true, id: p.id };
  }
  const r = await env.DB.prepare('INSERT INTO policies (title, about, links, audience, version, due_on, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(title, clip(input.about, 5000) || null, JSON.stringify(links), JSON.stringify(audience), clip(input.version, 40) || null, due,
      viewer.accountId || null, viewer.employee?.name || viewer.email, now).first();
  const ids = [...await audienceIds(env, audience)];
  const { toPerson } = await import('./notify.js');
  for (const id of ids) {
    await toPerson(env, id, { tile: 'training', kind: 'policy-new', dedupe: `policy-new:${r.id}`, subject: `Please read and acknowledge: ${title}`,
      body: `${clip(input.about, 400)}${due ? `\nBy ${due}.` : ''}`.trim(), link: `#/training?open=policy-${r.id}`, ref: { key: `policy-${r.id}` } }).catch(() => {});
  }
  await record(env, viewer, { area: 'Policies', action: 'published a policy to acknowledge', subjectType: 'policy', subjectId: String(r.id), label: title,
    changes: [{ label: 'For', before: '', after: `${ids.length} people` }] }).catch(() => {});
  return { ok: true, id: r.id, people: ids.length };
}

export async function policies(env, viewer) {
  mustSee(viewer);
  const manage = canManage(viewer);
  const list = await people(env);
  const names = new Map(list.map((p) => [p.id, p.name]));
  const { results } = await env.DB.prepare('SELECT * FROM policies ORDER BY archived, created_at DESC LIMIT 200').all();
  const acks = await acksFor(env, 'policy', results.map((p) => p.id));
  const out = [];
  for (const p of results) {
    const ids = [...await audienceIds(env, json(p.audience, {}), list)];
    const mine = ids.includes(viewer.accountId);
    if (!manage && (!mine || p.archived)) continue;
    const ack = acks.get(p.id) || new Map();
    out.push({
      id: p.id, title: p.title, about: p.about, links: json(p.links, []), version: p.version, dueOn: p.due_on, archived: Boolean(p.archived), createdAt: p.created_at, by: p.created_by_name,
      audience: manage ? json(p.audience, {}) : null, forMe: mine, acknowledged: ack.get(viewer.accountId) || null, count: ids.length, done: ids.filter((id) => ack.has(id)).length,
      people: manage ? ids.map((id) => ({ id, name: names.get(id) || id, at: ack.get(id) || null })).sort((a, b) => Boolean(a.at) - Boolean(b.at) || a.name.localeCompare(b.name)) : null,
    });
  }
  return { policies: out, manage };
}

// ---------- acknowledging ----------

export async function acknowledge(env, viewer, { kind, id }) {
  mustSee(viewer);
  if (!viewer.accountId) throw refuse('Your account isn\'t linked to an employee record yet.');
  const item = kind === 'talk' ? await env.DB.prepare('SELECT * FROM toolbox_talks WHERE id = ? AND cancelled = 0').bind(Number(id)).first()
    : kind === 'policy' ? await env.DB.prepare('SELECT * FROM policies WHERE id = ? AND archived = 0').bind(Number(id)).first() : null;
  if (!item) throw refuse('That isn\'t in the list any more.', 404);
  const ids = await audienceIds(env, json(item.audience, {}));
  if (!ids.has(viewer.accountId)) throw refuse('That isn\'t one for you to acknowledge.', 403);
  if (kind === 'talk' && Date.parse(item.starts_at) > Date.now()) throw refuse('A tool box talk is acknowledged once it has started.');
  const at = new Date().toISOString();
  const name = viewer.employee?.name || viewer.email;
  await env.DB.prepare('INSERT OR IGNORE INTO acknowledgements (kind, item_id, account_id, name, at) VALUES (?, ?, ?, ?, ?)').bind(kind, item.id, viewer.accountId, name, at).run();
  // A talk that covers a course in the matrix counts as that course done, on the day of the talk.
  if (kind === 'talk' && item.course_id) {
    const day = londonDate(Date.parse(item.starts_at));
    await env.DB.prepare(`INSERT INTO training_records (person_key, course_id, state, completed_on, note, source, updated_by, updated_at) VALUES (?, ?, 'done', ?, ?, 'talk', ?, ?)
      ON CONFLICT(person_key, course_id) DO UPDATE SET state = 'done', completed_on = MAX(COALESCE(training_records.completed_on, ''), excluded.completed_on), expires_on = NULL,
        note = excluded.note, source = 'talk', updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(viewer.accountId, item.course_id, day, `Tool box talk: ${item.title}${item.issue_key ? ` (${item.issue_key})` : ''}`, name, at).run();
  }
  await record(env, viewer, { area: kind === 'talk' ? 'Training' : 'Policies', action: kind === 'talk' ? 'acknowledged a tool box talk' : 'acknowledged a policy',
    subjectType: kind, subjectId: String(item.id), label: item.title }).catch(() => {});
  return { ok: true, at };
}

// ---------- each morning ----------

// Each attendee is reminded every day until the talk, counting down; anyone yet to
// acknowledge a policy is reminded each Monday.
const REMIND_DAYS = 14;
export async function daily(env) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (hour < 7) return { idle: true };
  const today = londonDate();
  const done = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'training_daily'").first().catch(() => null);
  if (done?.value === today) return { idle: true };
  const list = await people(env);
  const until = new Date(Date.now() + REMIND_DAYS * DAY).toISOString();
  const { results: soon } = await env.DB.prepare('SELECT * FROM toolbox_talks WHERE cancelled = 0 AND starts_at >= ? AND starts_at <= ?').bind(new Date().toISOString(), until).all();
  let sent = 0;
  for (const t of soon) {
    const ids = [...await audienceIds(env, json(t.audience, {}), list)];
    await tellTalk(env, t, ids, 'talk-upcoming');
    sent += ids.length;
  }
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (weekday === 1) {
    const { results: pols } = await env.DB.prepare('SELECT * FROM policies WHERE archived = 0').all();
    const acks = await acksFor(env, 'policy', pols.map((p) => p.id));
    const { toPerson } = await import('./notify.js');
    for (const p of pols) {
      const ack = acks.get(p.id) || new Map();
      for (const id of await audienceIds(env, json(p.audience, {}), list)) {
        if (ack.has(id)) continue;
        await toPerson(env, id, { tile: 'training', kind: 'policy-reminder', dedupe: `policy-reminder:${p.id}:${today}`, subject: `Still to acknowledge: ${p.title}`,
          body: p.due_on ? `Due by ${p.due_on}.` : 'Open it in Training & Policy to read and acknowledge it.', link: `#/training?open=policy-${p.id}`, ref: { key: `policy-${p.id}` } }).catch(() => {});
        sent++;
      }
    }
  }
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('training_daily', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(today).run();
  return { sent };
}

// What's waiting for someone: talks coming up and things to acknowledge, for the home screen and the tile.
export async function mine(env, viewer) {
  if (!viewer.accountId) return { talks: [], policies: [] };
  const [t, p] = await Promise.all([talks(env, { ...viewer, isAdmin: false, can: {} }), policies(env, { ...viewer, isAdmin: false, can: {} })]);
  return {
    talks: t.talks.filter((x) => x.upcoming || (x.started && !x.acknowledged)),
    policies: p.policies.filter((x) => !x.acknowledged),
  };
}

export async function options(env, viewer) {
  mustSee(viewer);
  const { TEAMS } = await import('./permissions.js');
  const [{ results: divisions }, { results: courses }] = await Promise.all([
    env.DB.prepare('SELECT id, name FROM training_divisions ORDER BY position, name').all(),
    env.DB.prepare('SELECT id, name, category FROM training_courses WHERE active = 1 ORDER BY position, name').all(),
  ]);
  return { teams: TEAMS, divisions, courses, people: (await people(env)).map(({ id, name }) => ({ id, name })), manage: canManage(viewer) };
}
