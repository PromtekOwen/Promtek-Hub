// Gap analysis: finding the gaps in a team's skills, and closing them.
//
// Each management meeting has a gap analysis (reused while nothing has been put in it). Inside it,
// one gap area per team or group of people goes through set steps, each showing only what's needed
// then, so nothing earlier colours what comes later:
//   skills    the objectives, the industry standards and the skills needed, each with the level needed
//   plan      who assesses whom (their line manager), how and when
//   assess    each assessor rates their people on each skill, without seeing the level needed or anyone else's ratings
//   gaps      the ratings and levels needed side by side; each gap is kept or dismissed and given a plan
//   training  a Training Requirement for each planned gap, done in the hub or in Jira
//   filled    every gap closed
// The hub makes the Jira items (Gap Analysis, Gap Area, Skill Assessment, Training Requirement, all in
// Compliance & Training) and writes what's entered to their fields, so the same shows in either place.

import { jira } from './jira.js';
import { mustSee, createMeta, valueFor, adfTable, linkMeeting, MAIN } from './ims.js';
import { londonDate } from './sync.js';
import { record } from './audit.js';

const PROJECT = 'COMPLIANCE';
export const SCALE = [
  [0, 'None', 'No knowledge or experience of it'],
  [1, 'Aware', 'Knows what it is, but hasn\'t done it'],
  [2, 'With help', 'Can do it with guidance'],
  [3, 'Competent', 'Does it well on their own'],
  [4, 'Can teach it', 'Expert; could train others'],
];
export const METHODS = ['Demonstration of Skill', 'One-to-One', 'Performance Chat', 'Self Assessment', 'Team Meeting', 'Other'];
export const PROVISIONS = ['Workshop', 'Course', 'Toolbox Talk', 'Certification', 'Mentoring', 'Business Restructure'];
export const STAGES = ['skills', 'plan', 'assess', 'gaps', 'training', 'filled'];
// Where each Jira item should be, by the hub's step: the first status Jira offers that fits.
const STATUS = {
  analysisActive: [/in progress/i, /analys/i, /progress/i, /open/i],
  analysisClosed: [/all gaps closed/i, /closed/i, /complete/i, /done/i],
  areaAssess: [/assess/i, /current skill/i],
  areaGaps: [/identif\w* gap/i, /plan/i, /^(?!.*filled).*gap/i],
  areaTraining: [/training/i, /plan/i],
  areaFilled: [/gaps filled/i, /filled/i, /complete/i, /done/i],
  assessmentDone: [/complete/i, /done/i],
  trainingDone: [/complete/i, /done/i, /provided/i, /trained/i],
};

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const clip = (v, n = 4000) => String(v ?? '').trim().slice(0, n);
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const now = () => new Date().toISOString();
const levelName = (n) => (n == null ? 'Not rated' : `${n} ${SCALE[n]?.[1] || ''}`.trim());

async function people(env) {
  const { results } = await env.DB.prepare("SELECT account_id, name, manager_id, teams FROM employees WHERE active = 1 AND account_id NOT LIKE 'pending%' ORDER BY name").all();
  return results.map((e) => ({ id: e.account_id, name: e.name, managerId: e.manager_id || null, teams: json(e.teams, []) }));
}

// ---------- Jira ----------

// Fields by Jira's names, as the type's screens have them. Any Jira won't take are left off and noted.
async function jiraFields(env, typeName, values) {
  const meta = await createMeta(env, PROJECT, typeName).catch(() => null);
  if (!meta) return { meta: null, fields: {}, missing: Object.keys(values) };
  const fields = {}; const missing = [];
  for (const [name, v] of Object.entries(values)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const m = meta.byName[name.toLowerCase()];
    if (!m) { missing.push(name); continue; }
    let val = valueFor(m, v);
    // A single choice given several: the first.
    if (m.schema?.type === 'option' && Array.isArray(v)) val = valueFor(m, v[0]);
    if (m.schema?.type === 'user' && Array.isArray(v)) val = valueFor(m, v[0]);
    if (val != null && val !== '') fields[m.id] = val;
  }
  return { meta, fields, missing };
}
async function withoutRefused(meta, fields, attempt) {
  try { await attempt(fields); return []; } catch (err) {
    if (err.status !== 400) throw err;
    let bad = {};
    try { bad = JSON.parse(String(err.message).replace(/^[^{]*/, '')).errors || {}; } catch { bad = {}; }
    const keys = Object.keys(bad).filter((k) => k in fields);
    if (!keys.length) throw err;
    for (const k of keys) delete fields[k];
    await attempt(fields);
    return keys.map((k) => Object.values(meta?.byName || {}).find((f) => f.id === k)?.name || k);
  }
}
async function createIssue(env, typeName, { summary, parent = null, values = {}, assignee = null }) {
  const { meta, fields, missing } = await jiraFields(env, typeName, values);
  if (!meta) throw refuse(`Compliance & Training has no ${typeName} type in Jira.`);
  const base = { project: { key: PROJECT }, issuetype: { id: meta.typeId }, summary: clip(summary, 250), ...(parent ? { parent: { key: parent } } : {}), ...(assignee ? { assignee: { accountId: assignee } } : {}) };
  let made = null;
  const refused = await withoutRefused(meta, fields, async (f) => { made = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields: { ...base, ...f } }) }); });
  return { key: made?.key, skipped: [...missing, ...refused] };
}
async function updateIssue(env, key, typeName, values) {
  if (!key) return { skipped: [] };
  const { meta, fields, missing } = await jiraFields(env, typeName, values);
  if (!Object.keys(fields).length) return { skipped: missing };
  const refused = await withoutRefused(meta, fields, (f) => (Object.keys(f).length ? jira(env, `/rest/api/3/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ fields: f }) }) : null));
  return { skipped: [...missing, ...refused] };
}
// Moves an item to the first status that fits, if Jira's workflow allows it from where it is.
async function moveIssue(env, key, patterns) {
  if (!key) return null;
  const t = (await jira(env, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`))?.transitions || [];
  for (const p of patterns) {
    const to = t.find((x) => p.test(String(x.to?.name || x.name || '')));
    if (to) {
      await jira(env, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: to.id } }) });
      return to.to?.name || to.name;
    }
  }
  return null;
}
// Jira trouble never stops the hub: it's noted on the record and shown.
async function tryJira(env, table, id, work) {
  try {
    const r = await work();
    const note = r?.skipped?.length ? `Jira didn't take: ${[...new Set(r.skipped)].join(', ')}` : null;
    await env.DB.prepare(`UPDATE ${table} SET jira_note = ? WHERE id = ?`).bind(note, id).run();
    return r;
  } catch (err) {
    await env.DB.prepare(`UPDATE ${table} SET jira_note = ? WHERE id = ?`).bind(`Jira: ${String(err.message || err).slice(0, 300)}`, id).run();
    return null;
  }
}
const doc = (t) => ({ type: 'doc', version: 1, content: [t] });
const skillsTable = (skills) => adfTable(['Skill', 'Level needed'], skills.map((s) => [s.name, levelName(s.level)]), { boldFirstColumn: true });
const ratingsTable = (skills, ratings) => adfTable(['Skill', 'Assessed', 'Notes'], skills.map((s) => [s.name, levelName(ratings[s.id]?.level), ratings[s.id]?.note || '']), { boldFirstColumn: true });

// ---------- reading ----------

const shapeArea = (a) => ({ id: a.id, analysisId: a.analysis_id, key: a.jira_key, title: a.title, objectives: a.objectives || '', team: a.team || '', people: json(a.people, []),
  standards: a.standards || '', skills: json(a.skills, []), stage: a.stage, createdAt: a.created_at, filledAt: a.filled_at, jiraNote: a.jira_note });

export async function overview(env, viewer) {
  mustSee(viewer);
  const [{ results: analyses }, { results: areas }, { results: assess }, { results: gaps }] = await Promise.all([
    env.DB.prepare('SELECT * FROM gap_analyses ORDER BY id DESC LIMIT 36').all(),
    env.DB.prepare('SELECT * FROM gap_areas ORDER BY id').all(),
    env.DB.prepare('SELECT area_id, status, COUNT(*) AS n FROM gap_assessments GROUP BY area_id, status').all(),
    env.DB.prepare('SELECT area_id, status, COUNT(*) AS n FROM gap_gaps GROUP BY area_id, status').all(),
  ]);
  const count = (rows, id, status) => rows.filter((r) => r.area_id === id && (!status || r.status === status)).reduce((t, r) => t + r.n, 0);
  // Skills that keep coming up as gaps.
  const { results: recurring } = await env.DB.prepare("SELECT skill, COUNT(*) AS n, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS closed FROM gap_gaps WHERE status != 'dismissed' GROUP BY lower(skill) ORDER BY n DESC LIMIT 8").all();
  // Assessments waiting on the person looking.
  const { results: mine } = await env.DB.prepare(`SELECT x.id, x.person_name, x.due_on, x.status, a.title FROM gap_assessments x JOIN gap_areas a ON a.id = x.area_id
    WHERE x.assessor_id = ? AND x.status != 'done' AND a.stage = 'assess' ORDER BY x.due_on`).bind(viewer.accountId || '').all();
  return {
    mine: mine.map((x) => ({ id: x.id, personName: x.person_name, dueOn: x.due_on, status: x.status, areaTitle: x.title })),
    analyses: analyses.map((g) => ({ id: g.id, key: g.jira_key, meeting: g.meeting_key, meetingName: g.meeting_name, status: g.status, createdAt: g.created_at, closedAt: g.closed_at, jiraNote: g.jira_note,
      areas: areas.filter((a) => a.analysis_id === g.id).map((a) => ({ ...shapeArea(a), assessments: { all: count(assess, a.id), done: count(assess, a.id, 'done') },
        gaps: { all: count(gaps, a.id) - count(gaps, a.id, 'dismissed'), done: count(gaps, a.id, 'done') } })) })),
    open: { gaps: gaps.filter((r) => ['open', 'planned'].includes(r.status)).reduce((t, r) => t + r.n, 0) },
    recurring: recurring.filter((r) => r.n > 1),
  };
}

export async function options(env, viewer) {
  mustSee(viewer);
  const [area, assessment, training] = await Promise.all([createMeta(env, PROJECT, 'Gap Area').catch(() => null), createMeta(env, PROJECT, 'Skill Assessment').catch(() => null),
    createMeta(env, PROJECT, 'Training Requirement').catch(() => null)]);
  const allowed = (meta, name, fallback) => (meta?.byName[name.toLowerCase()]?.allowed?.length ? meta.byName[name.toLowerCase()].allowed : fallback);
  const { TEAMS } = await import('./permissions.js');
  const { results: courses } = await env.DB.prepare('SELECT id, name, category FROM training_courses WHERE active = 1 ORDER BY position, name').all().catch(() => ({ results: [] }));
  const { results: divisions } = await env.DB.prepare('SELECT id, name FROM training_divisions ORDER BY position, name').all().catch(() => ({ results: [] }));
  return { scale: SCALE.map(([n, name, about]) => ({ n, name, about })), teams: allowed(area, 'Team', TEAMS), methods: allowed(assessment, 'Assessment Tasks', METHODS),
    provisions: allowed(training, 'Training Provision', allowed(area, 'Training Provision', PROVISIONS)), people: await people(env), courses, divisions };
}

// One area, as much as its step allows: the levels needed and the ratings stay hidden until every assessment is in.
export async function area(env, viewer, id) {
  mustSee(viewer);
  const a = await env.DB.prepare('SELECT * FROM gap_areas WHERE id = ?').bind(Number(id)).first();
  if (!a) throw refuse('That gap area isn\'t there.', 404);
  const g = await env.DB.prepare('SELECT * FROM gap_analyses WHERE id = ?').bind(a.analysis_id).first();
  const out = shapeArea(a);
  const reveal = ['gaps', 'training', 'filled'].includes(a.stage);
  const { results: list } = await env.DB.prepare('SELECT * FROM gap_assessments WHERE area_id = ? ORDER BY person_name').bind(a.id).all();
  out.assessments = list.map((x) => ({ id: x.id, key: x.jira_key, personId: x.person_id, personName: x.person_name, assessorId: x.assessor_id, methods: json(x.methods, []), dueOn: x.due_on,
    status: x.status, doneAt: x.done_at, jiraNote: x.jira_note, ...(reveal ? { ratings: json(x.ratings, {}) } : {}) }));
  // While assessing, the skills are shown without the level needed.
  if (a.stage === 'assess') out.skills = out.skills.map(({ id: sid, name }) => ({ id: sid, name }));
  if (reveal) {
    const { results: gaps } = await env.DB.prepare('SELECT * FROM gap_gaps WHERE area_id = ? ORDER BY person_name, skill').bind(a.id).all();
    out.gaps = gaps.map((x) => ({ id: x.id, personId: x.person_id, personName: x.person_name, skillId: x.skill_id, skill: x.skill, needed: x.needed, has: x.has, status: x.status,
      plan: x.plan || '', provision: x.provision || '', dueOn: x.due_on || '', key: x.jira_key, courseId: x.course_id, check: x.check_level, doneAt: x.done_at, jiraNote: x.jira_note }));
  }
  out.analysis = g ? { id: g.id, key: g.jira_key, meetingName: g.meeting_name } : null;
  return out;
}

// One assessment, for rating: the skills (no levels needed) and this person's ratings only.
export async function assessment(env, viewer, id) {
  mustSee(viewer);
  const x = await env.DB.prepare('SELECT * FROM gap_assessments WHERE id = ?').bind(Number(id)).first();
  if (!x) throw refuse('That assessment isn\'t there.', 404);
  const a = await env.DB.prepare('SELECT * FROM gap_areas WHERE id = ?').bind(x.area_id).first();
  return { id: x.id, key: x.jira_key, areaId: a.id, areaTitle: a.title, objectives: a.objectives || '', personId: x.person_id, personName: x.person_name, assessorId: x.assessor_id,
    methods: json(x.methods, []), dueOn: x.due_on, status: x.status, ratings: json(x.ratings, {}), skills: json(a.skills, []).map(({ id: sid, name }) => ({ id: sid, name })),
    scale: SCALE.map(([n, name, about]) => ({ n, name, about })) };
}

// ---------- each meeting's gap analysis ----------

// A new meeting gets a gap analysis; one still empty from an earlier meeting is moved on to it instead.
export async function forMeeting(env, viewer, { key, summary }) {
  const empty = await env.DB.prepare("SELECT g.* FROM gap_analyses g WHERE g.status = 'open' AND NOT EXISTS (SELECT 1 FROM gap_areas a WHERE a.analysis_id = g.id) ORDER BY g.id DESC LIMIT 1").first().catch(() => null);
  const title = `Gap Analysis: ${clip(summary, 200)}`;
  if (empty) {
    await env.DB.prepare('UPDATE gap_analyses SET meeting_key = ?, meeting_name = ? WHERE id = ?').bind(key, summary, empty.id).run();
    await tryJira(env, 'gap_analyses', empty.id, async () => {
      if (!empty.jira_key) return null;
      await jira(env, `/rest/api/3/issue/${encodeURIComponent(empty.jira_key)}`, { method: 'PUT', body: JSON.stringify({ fields: { summary: title } }) });
      await linkMeeting(env, empty.jira_key, key).catch(() => {});
      return null;
    });
    return { id: empty.id, reused: true };
  }
  const r = await env.DB.prepare('INSERT INTO gap_analyses (meeting_key, meeting_name, status, created_at) VALUES (?, ?, ?, ?) RETURNING id').bind(key, summary, 'open', now()).first();
  await tryJira(env, 'gap_analyses', r.id, async () => {
    const made = await createIssue(env, 'Gap Analysis', { summary: title });
    if (made.key) {
      await env.DB.prepare('UPDATE gap_analyses SET jira_key = ? WHERE id = ?').bind(made.key, r.id).run();
      await linkMeeting(env, made.key, key).catch(() => {});
    }
    return made;
  });
  return { id: r.id, reused: false };
}

// The first one, before any meeting has been added through the hub.
export async function start(env, viewer) {
  mustSee(viewer);
  const open = await env.DB.prepare("SELECT id FROM gap_analyses WHERE status != 'closed' ORDER BY id DESC LIMIT 1").first();
  if (open) return { id: open.id };
  const m = await env.DB.prepare(`SELECT issue_key, summary FROM ims_items WHERE project_key = ? AND issuetype = 'Meeting' ORDER BY created_at DESC LIMIT 1`).bind(MAIN).first().catch(() => null);
  return forMeeting(env, viewer, { key: m?.issue_key || null, summary: m?.summary || `Management meeting ${londonDate().slice(0, 7)}` });
}

// The Gap Analysis item in Jira lists its areas, and everyone in them.
async function writeAnalysis(env, analysisId) {
  const g = await env.DB.prepare('SELECT * FROM gap_analyses WHERE id = ?').bind(analysisId).first();
  if (!g?.jira_key) return;
  const { results: areas } = await env.DB.prepare('SELECT * FROM gap_areas WHERE analysis_id = ? ORDER BY id').bind(analysisId).all();
  const names = new Map((await people(env)).map((p) => [p.id, p.name]));
  await tryJira(env, 'gap_analyses', g.id, () => updateIssue(env, g.jira_key, 'Gap Analysis', {
    'Objective(s)': adfTable(['Gap area', 'Team', 'Objectives', 'People'], areas.map((a) => [a.title, a.team || '', a.objectives || '', json(a.people, []).map((id) => names.get(id) || id).join(', ')]), { boldFirstColumn: true }),
    'Team': [...new Set(areas.map((a) => a.team).filter(Boolean))],
    'Promtek Staff Involved': [...new Set(areas.flatMap((a) => json(a.people, [])))],
  }));
}

// ---------- a gap area, step by step ----------

export async function addArea(env, viewer, { analysisId, title, objectives, team, people: ids }) {
  mustSee(viewer);
  const g = await env.DB.prepare('SELECT * FROM gap_analyses WHERE id = ?').bind(Number(analysisId)).first();
  if (!g) throw refuse('Choose the gap analysis it belongs to.');
  if (g.status === 'closed') throw refuse('That gap analysis is closed.');
  const name = clip(title, 200);
  if (name.length < 3) throw refuse('Give the gap area a name.');
  if (!clip(objectives)) throw refuse('Write the objectives.');
  const everyone = new Set((await people(env)).map((p) => p.id));
  const who = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((x) => everyone.has(x));
  if (!who.length) throw refuse('Choose the people being looked at.');
  const r = await env.DB.prepare('INSERT INTO gap_areas (analysis_id, title, objectives, team, people, stage, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(g.id, name, clip(objectives), clip(team, 80) || null, JSON.stringify(who), 'skills', viewer.employee?.name || viewer.email, now(), now()).first();
  if (g.status === 'open') await env.DB.prepare("UPDATE gap_analyses SET status = 'active' WHERE id = ?").bind(g.id).run();
  await tryJira(env, 'gap_areas', r.id, async () => {
    const made = await createIssue(env, 'Gap Area', { summary: name, parent: g.jira_key, values: { 'Objective(s)': clip(objectives), 'Team': clip(team, 80), 'Promtek Staff Involved': who } });
    if (made.key) await env.DB.prepare('UPDATE gap_areas SET jira_key = ? WHERE id = ?').bind(made.key, r.id).run();
    return made;
  });
  if (g.status === 'open' && g.jira_key) await tryJira(env, 'gap_analyses', g.id, async () => { await moveIssue(env, g.jira_key, STATUS.analysisActive); return null; });
  await writeAnalysis(env, g.id);
  await record(env, viewer, { area: 'IMS', action: 'started a gap area', subjectType: 'gap', subjectId: String(r.id), label: name }).catch(() => {});
  return { ok: true, id: r.id };
}

const cleanSkills = (list) => (Array.isArray(list) ? list : []).map((s, i) => ({ id: clip(s.id, 20) || `s${Date.now().toString(36)}${i}`, name: clip(s.name, 200), level: Math.max(1, Math.min(4, Number(s.level) || 0)) }))
  .filter((s) => s.name).slice(0, 40);

// Step 1: the scope, standards and skills needed. Saved as often as wanted until locked.
export async function saveSkills(env, viewer, { id, title, objectives, team, people: ids, standards, skills, lock = false }) {
  mustSee(viewer);
  const a = await env.DB.prepare('SELECT * FROM gap_areas WHERE id = ?').bind(Number(id)).first();
  if (!a) throw refuse('That gap area isn\'t there.', 404);
  if (a.stage !== 'skills') throw refuse('The skills are locked: the assessments have been planned.');
  const list = cleanSkills(skills);
  const everyone = new Set((await people(env)).map((p) => p.id));
  const who = ids === undefined ? json(a.people, []) : [...new Set(ids.map(String))].filter((x) => everyone.has(x));
  if (!who.length) throw refuse('Keep at least one person in it.');
  if (lock && !list.length) throw refuse('List the skills needed before moving on.');
  if (lock && !clip(standards)) throw refuse('Write the industry standards before moving on.');
  await env.DB.prepare('UPDATE gap_areas SET title = ?, objectives = ?, team = ?, people = ?, standards = ?, skills = ?, stage = ?, updated_at = ? WHERE id = ?')
    .bind(clip(title, 200) || a.title, objectives === undefined ? a.objectives : clip(objectives), team === undefined ? a.team : clip(team, 80) || null, JSON.stringify(who),
      clip(standards, 20000) || null, JSON.stringify(list), lock ? 'plan' : 'skills', now(), a.id).run();
  await tryJira(env, 'gap_areas', a.id, () => updateIssue(env, a.jira_key, 'Gap Area', {
    'Objective(s)': objectives === undefined ? a.objectives : clip(objectives), 'Team': team === undefined ? a.team : clip(team, 80), 'Promtek Staff Involved': who,
    'Industry Regulations / Standards': clip(standards, 20000), 'Identified Skills Required': list.length ? skillsTable(list) : null }));
  if (title && a.jira_key && clip(title, 200) !== a.title) await jira(env, `/rest/api/3/issue/${encodeURIComponent(a.jira_key)}`, { method: 'PUT', body: JSON.stringify({ fields: { summary: clip(title, 200) } }) }).catch(() => {});
  await writeAnalysis(env, a.analysis_id);
  if (lock) await record(env, viewer, { area: 'IMS', action: 'set the skills needed for a gap area', subjectType: 'gap', subjectId: String(a.id), label: a.title }).catch(() => {});
  return { ok: true };
}

// Step 2: who assesses each person, how and when. Sending makes a Skill Assessment for each.
export async function sendAssessments(env, viewer, { id, plans }) {
  mustSee(viewer);
  const a = await env.DB.prepare('SELECT * FROM gap_areas WHERE id = ?').bind(Number(id)).first();
  if (!a) throw refuse('That gap area isn\'t there.', 404);
  if (a.stage !== 'plan') throw refuse('The assessments have already been sent.');
  const list = await people(env);
  const byId = new Map(list.map((p) => [p.id, p]));
  const who = json(a.people, []);
  const rows = who.map((pid) => {
    const p = (Array.isArray(plans) ? plans : []).find((x) => x.personId === pid) || {};
    return { personId: pid, personName: byId.get(pid)?.name || pid, assessorId: byId.has(String(p.assessorId)) ? String(p.assessorId) : byId.get(pid)?.managerId || null,
      methods: (Array.isArray(p.methods) ? p.methods : []).map((m) => clip(m, 80)).filter(Boolean), dueOn: isoDay(p.dueOn) };
  });
  const missing = rows.find((r) => !r.assessorId || !r.methods.length || !r.dueOn);
  if (missing) throw refuse(`Give ${missing.personName} an assessor, how they'll be assessed and a date.`);
  if (rows.length > 25) throw refuse('Up to 25 people in one gap area.');
  const skills = json(a.skills, []);
  await env.DB.prepare("UPDATE gap_areas SET stage = 'assess', updated_at = ? WHERE id = ?").bind(now(), a.id).run();
  const { toPerson } = await import('./notify.js');
  for (const r of rows) {
    const x = await env.DB.prepare('INSERT INTO gap_assessments (area_id, person_id, person_name, assessor_id, methods, due_on, status) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(a.id, r.personId, r.personName, r.assessorId, JSON.stringify(r.methods), r.dueOn, 'planned').first();
    await tryJira(env, 'gap_assessments', x.id, async () => {
      const made = await createIssue(env, 'Skill Assessment', { summary: `Skill assessment: ${r.personName}`, parent: a.jira_key, assignee: r.assessorId,
        values: { 'Assessment Tasks': r.methods, 'Who is being assessed': r.personId, 'Date of Assessment': r.dueOn,
          'Identified Skills Required': adfTable(['Skill'], skills.map((s) => [s.name])) } });
      if (made.key) await env.DB.prepare('UPDATE gap_assessments SET jira_key = ? WHERE id = ?').bind(made.key, x.id).run();
      return made;
    });
    await toPerson(env, r.assessorId, { tile: 'ims', kind: 'gap-assessment', dedupe: `gap-assessment:${x.id}`, subject: `Skill assessment: ${r.personName}`,
      body: `You're asked to assess ${r.personName} for "${a.title}" by ${r.dueOn} (${r.methods.join(', ')}).`, link: `#/ims`, ref: { key: `gap-assess-${x.id}` } }).catch(() => {});
  }
  await tryJira(env, 'gap_areas', a.id, async () => { await moveIssue(env, a.jira_key, STATUS.areaAssess); return null; });
  await record(env, viewer, { area: 'IMS', action: 'sent skill assessments', subjectType: 'gap', subjectId: String(a.id), label: `${a.title}: ${rows.length}` }).catch(() => {});
  return { ok: true, sent: rows.length };
}

// Step 3: the ratings. Saved as a draft, or completed; the last one in reveals the gaps.
export async function rate(env, viewer, { id, ratings, complete = false }) {
  mustSee(viewer);
  const x = await env.DB.prepare('SELECT * FROM gap_assessments WHERE id = ?').bind(Number(id)).first();
  if (!x) throw refuse('That assessment isn\'t there.', 404);
  if (x.status === 'done') throw refuse('That assessment is complete.');
  const a = await env.DB.prepare('SELECT * FROM gap_areas WHERE id = ?').bind(x.area_id).first();
  const skills = json(a.skills, []);
  const clean = {};
  for (const s of skills) {
    const r = ratings?.[s.id] || {};
    const level = r.level === '' || r.level == null ? null : Math.max(0, Math.min(4, Number(r.level)));
    if (level != null || clip(r.note)) clean[s.id] = { level: Number.isFinite(level) ? level : null, note: clip(r.note, 1000) };
  }
  if (complete) {
    const missing = skills.find((s) => clean[s.id]?.level == null);
    if (missing) throw refuse(`Rate "${missing.name}" before completing it.`);
  }
  await env.DB.prepare('UPDATE gap_assessments SET ratings = ?, status = ?, done_at = ?, done_by = ? WHERE id = ?')
    .bind(JSON.stringify(clean), complete ? 'done' : 'started', complete ? now() : null, complete ? viewer.employee?.name || viewer.email : null, x.id).run();
  if (!complete) return { ok: true };
  await tryJira(env, 'gap_assessments', x.id, async () => {
    const r = await updateIssue(env, x.jira_key, 'Skill Assessment', { 'Assessed Current Skill': ratingsTable(skills, clean) });
    await moveIssue(env, x.jira_key, STATUS.assessmentDone);
    return r;
  });
  await record(env, viewer, { area: 'IMS', action: 'completed a skill assessment', subjectType: 'gap', subjectId: String(a.id), label: `${a.title}: ${x.person_name}` }).catch(() => {});
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM gap_assessments WHERE area_id = ? AND status != 'done'").bind(a.id).first();
  if (!left.n) await revealGaps(env, a.id);
  return { ok: true, revealed: !left.n };
}

// Every assessment in: each skill rated below the level needed is a gap, to keep or dismiss.
export async function revealGaps(env, areaId) {
  const a = await env.DB.prepare('SELECT * FROM gap_areas WHERE id = ?').bind(areaId).first();
  if (!a || a.stage !== 'assess') return;
  const skills = json(a.skills, []);
  const { results: list } = await env.DB.prepare('SELECT * FROM gap_assessments WHERE area_id = ? ORDER BY person_name').bind(a.id).all();
  for (const x of list) {
    const ratings = json(x.ratings, {});
    for (const s of skills) {
      const has = ratings[s.id]?.level;
      if (has != null && has < s.level) {
        await env.DB.prepare('INSERT INTO gap_gaps (area_id, person_id, person_name, skill_id, skill, needed, has, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(a.id, x.person_id, x.person_name, s.id, s.name, s.level, has, 'open').run();
      }
    }
  }
  await env.DB.prepare("UPDATE gap_areas SET stage = 'gaps', updated_at = ? WHERE id = ?").bind(now(), a.id).run();
  const all = adfTable(['Person', 'Skill', 'Needed', 'Assessed', 'Notes'], list.flatMap((x) => { const r = json(x.ratings, {}); return skills.map((s) => [x.person_name, s.name, levelName(s.level), levelName(r[s.id]?.level), r[s.id]?.note || '']); }), { boldFirstColumn: true });
  const { results: gaps } = await env.DB.prepare('SELECT * FROM gap_gaps WHERE area_id = ? ORDER BY person_name, skill').bind(a.id).all();
  await tryJira(env, 'gap_areas', a.id, async () => {
    const r = await updateIssue(env, a.jira_key, 'Gap Area', { 'Assessed Current Skill': all,
      'Identified Gap': gaps.length ? adfTable(['Person', 'Skill', 'Needed', 'Assessed'], gaps.map((x) => [x.person_name, x.skill, levelName(x.needed), levelName(x.has)]), { boldFirstColumn: true }) : 'No gaps found.' });
    await moveIssue(env, a.jira_key, STATUS.areaGaps);
    return r;
  });
}

// Step 4: each gap kept with a plan, or dismissed; gaps the ratings didn't show can be added.
export async function saveGaps(env, viewer, { id, gaps, added = [] }) {
  mustSee(viewer);
  const a = await env.DB.prepare('SELECT * FROM gap_areas WHERE id = ?').bind(Number(id)).first();
  if (!a) throw refuse('That gap area isn\'t there.', 404);
  if (!['gaps', 'training'].includes(a.stage)) throw refuse('The gaps aren\'t open yet.');
  for (const g of Array.isArray(gaps) ? gaps : []) {
    const row = await env.DB.prepare('SELECT * FROM gap_gaps WHERE id = ? AND area_id = ?').bind(Number(g.id), a.id).first();
    if (!row || ['done'].includes(row.status) || row.jira_key) continue;
    const status = g.dismissed ? 'dismissed' : 'open';
    await env.DB.prepare('UPDATE gap_gaps SET status = ?, plan = ?, provision = ?, due_on = ? WHERE id = ?').bind(status, clip(g.plan, 4000) || null, clip(g.provision, 80) || null, isoDay(g.dueOn), row.id).run();
  }
  const names = new Map((await people(env)).map((p) => [p.id, p.name]));
  for (const g of Array.isArray(added) ? added : []) {
    if (!names.has(String(g.personId)) || !clip(g.skill)) continue;
    await env.DB.prepare('INSERT INTO gap_gaps (area_id, person_id, person_name, skill, needed, has, status, plan, provision, due_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(a.id, String(g.personId), names.get(String(g.personId)), clip(g.skill, 200), null, null, 'open', clip(g.plan, 4000) || null, clip(g.provision, 80) || null, isoDay(g.dueOn)).run();
  }
  return { ok: true };
}

// Raising the training: a Training Requirement for each kept gap. With none kept, the area is filled.
export async function raiseTraining(env, viewer, { id }) {
  mustSee(viewer);
  const a = await env.DB.prepare('SELECT * FROM gap_areas WHERE id = ?').bind(Number(id)).first();
  if (!a) throw refuse('That gap area isn\'t there.', 404);
  if (!['gaps', 'training'].includes(a.stage)) throw refuse('The gaps aren\'t open yet.');
  const { results: open } = await env.DB.prepare("SELECT * FROM gap_gaps WHERE area_id = ? AND status = 'open' ORDER BY person_name, skill").bind(a.id).all();
  const bad = open.find((g) => !g.plan || !g.provision);
  if (bad) throw refuse(`Give the gap in "${bad.skill}" for ${bad.person_name} a plan and how it'll be provided, or dismiss it.`);
  const batch = open.slice(0, 20);
  for (const g of batch) {
    await env.DB.prepare("UPDATE gap_gaps SET status = 'planned' WHERE id = ?").bind(g.id).run();
    await tryJira(env, 'gap_gaps', g.id, async () => {
      const made = await createIssue(env, 'Training Requirement', { summary: `${g.provision} for ${g.person_name}: ${g.skill}`, parent: a.jira_key,
        values: { 'Identified Gap': `${g.skill}: needs ${levelName(g.needed)}, assessed ${levelName(g.has)}`, 'Plan for Gap': g.plan, 'Who Requires the Training': [g.person_id],
          'Training Provision': g.provision, 'Due date': g.due_on } });
      if (made.key) await env.DB.prepare('UPDATE gap_gaps SET jira_key = ? WHERE id = ?').bind(made.key, g.id).run();
      return made;
    });
  }
  const { results: kept } = await env.DB.prepare("SELECT * FROM gap_gaps WHERE area_id = ? AND status IN ('planned', 'done') ORDER BY person_name, skill").bind(a.id).all();
  await env.DB.prepare('UPDATE gap_areas SET stage = ?, updated_at = ? WHERE id = ?').bind(kept.length ? 'training' : 'gaps', now(), a.id).run();
  await tryJira(env, 'gap_areas', a.id, async () => {
    const r = await updateIssue(env, a.jira_key, 'Gap Area', {
      'Plan for Gap': kept.length ? adfTable(['Person', 'Skill', 'Plan', 'Provision', 'Due'], kept.map((g) => [g.person_name, g.skill, g.plan || '', g.provision || '', g.due_on || '']), { boldFirstColumn: true }) : null,
      'Who Requires the Training': [...new Set(kept.map((g) => g.person_id))], 'Training Provision': [...new Set(kept.map((g) => g.provision).filter(Boolean))] });
    if (kept.length) await moveIssue(env, a.jira_key, STATUS.areaTraining);
    return r;
  });
  await record(env, viewer, { area: 'IMS', action: 'raised training for gaps', subjectType: 'gap', subjectId: String(a.id), label: `${a.title}: ${batch.length}` }).catch(() => {});
  if (!kept.length) { await fill(env, a.id); return { ok: true, raised: 0, filled: true }; }
  return { ok: true, raised: batch.length, more: open.length - batch.length };
}

// A gap's training done: in the hub, or found done in Jira. Linked to the matrix, it's recorded there too.
export async function trainingDone(env, viewer, { id, check = null }) {
  mustSee(viewer);
  const g = await env.DB.prepare('SELECT * FROM gap_gaps WHERE id = ?').bind(Number(id)).first();
  if (!g) throw refuse('That gap isn\'t there.', 404);
  if (g.status === 'done') {
    // "Did it work?": the skill rated again after the training.
    if (check != null) await env.DB.prepare('UPDATE gap_gaps SET check_level = ? WHERE id = ?').bind(Math.max(0, Math.min(4, Number(check))), g.id).run();
    return { ok: true };
  }
  if (g.status !== 'planned') throw refuse('Raise its training first.');
  await markDone(env, g, viewer.employee?.name || viewer.email);
  await tryJira(env, 'gap_gaps', g.id, async () => { await moveIssue(env, g.jira_key, STATUS.trainingDone); return null; });
  await checkFilled(env, g.area_id);
  return { ok: true };
}
async function markDone(env, g, by) {
  await env.DB.prepare("UPDATE gap_gaps SET status = 'done', done_at = ? WHERE id = ?").bind(now(), g.id).run();
  if (g.course_id) await recordOnMatrix(env, g, by);
}
async function recordOnMatrix(env, g, by) {
  await env.DB.prepare(`INSERT INTO training_records (person_key, course_id, state, completed_on, note, source, updated_by, updated_at) VALUES (?, ?, 'done', ?, ?, 'gap', ?, ?)
    ON CONFLICT(person_key, course_id) DO UPDATE SET state = 'done', completed_on = excluded.completed_on, note = excluded.note, source = 'gap', updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(g.person_id, g.course_id, londonDate(), `Gap analysis: ${g.skill}`.slice(0, 200), by || 'The hub', now()).run().catch(() => null);
}

// Linking a gap's skill to the matrix, by hand once its training is planned: an existing course, or a new one.
export async function linkCourse(env, viewer, { id, courseId = null, newCourse = null }) {
  mustSee(viewer);
  const g = await env.DB.prepare('SELECT * FROM gap_gaps WHERE id = ?').bind(Number(id)).first();
  if (!g) throw refuse('That gap isn\'t there.', 404);
  if (!['planned', 'done'].includes(g.status)) throw refuse('Plan its training first.');
  let course = courseId ? Number(courseId) : null;
  if (newCourse) {
    const T = await import('./training.js');
    const r = await T.saveCourse(env, viewer, { name: newCourse.name || g.skill, category: newCourse.category || 'Gap analysis', frequency: newCourse.frequency || 'As required', divisions: newCourse.divisions || [] });
    course = r.id;
  }
  if (course != null && !(await env.DB.prepare('SELECT 1 FROM training_courses WHERE id = ?').bind(course).first())) throw refuse('That course isn\'t in the matrix.');
  await env.DB.prepare('UPDATE gap_gaps SET course_id = ? WHERE id = ?').bind(course, g.id).run();
  if (course && g.status === 'done') await recordOnMatrix(env, { ...g, course_id: course }, viewer.employee?.name || viewer.email);
  return { ok: true, courseId: course };
}

async function fill(env, areaId) {
  const a = await env.DB.prepare('SELECT * FROM gap_areas WHERE id = ?').bind(areaId).first();
  if (!a || a.stage === 'filled') return;
  await env.DB.prepare("UPDATE gap_areas SET stage = 'filled', filled_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), a.id).run();
  await tryJira(env, 'gap_areas', a.id, async () => { await moveIssue(env, a.jira_key, STATUS.areaFilled); return null; });
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM gap_areas WHERE analysis_id = ? AND stage != 'filled'").bind(a.analysis_id).first();
  if (!left.n) {
    const g = await env.DB.prepare('SELECT * FROM gap_analyses WHERE id = ?').bind(a.analysis_id).first();
    await env.DB.prepare("UPDATE gap_analyses SET status = 'closed', closed_at = ? WHERE id = ?").bind(now(), g.id).run();
    await tryJira(env, 'gap_analyses', g.id, async () => { await moveIssue(env, g.jira_key, STATUS.analysisClosed); return null; });
  }
}
async function checkFilled(env, areaId) {
  const a = await env.DB.prepare('SELECT stage FROM gap_areas WHERE id = ?').bind(areaId).first();
  if (a?.stage !== 'training') return;
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM gap_gaps WHERE area_id = ? AND status IN ('open', 'planned')").bind(areaId).first();
  if (!left.n) await fill(env, areaId);
}

// At each IMS read: training finished in Jira is picked up, and areas and analyses closed as they complete.
export async function sweep(env) {
  const { results } = await env.DB.prepare(`SELECT g.*, i.status_cat FROM gap_gaps g JOIN ims_items i ON i.issue_key = g.jira_key WHERE g.status = 'planned' AND i.status_cat = 'done'`).all().catch(() => ({ results: [] }));
  const areas = new Set();
  for (const g of results) { await markDone(env, g, 'Jira'); areas.add(g.area_id); }
  for (const id of areas) await checkFilled(env, id);
  return { done: results.length };
}

// Removing an area started by mistake, before any assessments have gone out.
export async function removeArea(env, viewer, { id }) {
  mustSee(viewer);
  const a = await env.DB.prepare('SELECT * FROM gap_areas WHERE id = ?').bind(Number(id)).first();
  if (!a) throw refuse('That gap area isn\'t there.', 404);
  if (!['skills', 'plan'].includes(a.stage)) throw refuse('Assessments have gone out for it, so it stays.');
  await env.DB.prepare('DELETE FROM gap_areas WHERE id = ?').bind(a.id).run();
  if (a.jira_key) await jira(env, `/rest/api/3/issue/${encodeURIComponent(a.jira_key)}`, { method: 'DELETE' }).catch(() => {});
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM gap_areas WHERE analysis_id = ?').bind(a.analysis_id).first();
  if (!left.n) await env.DB.prepare("UPDATE gap_analyses SET status = 'open' WHERE id = ?").bind(a.analysis_id).run();
  else await writeAnalysis(env, a.analysis_id);
  await record(env, viewer, { area: 'IMS', action: 'removed a gap area', subjectType: 'gap', subjectId: String(a.id), label: a.title }).catch(() => {});
  return { ok: true };
}
