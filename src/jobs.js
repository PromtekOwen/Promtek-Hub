// Records finished work so estimates can be checked against reality.
// Nothing here touches XP or ELO; it only reads Jira and writes its own table.
import { searchJql } from './jira.js';
import { getState, setState, londonDate } from './sync.js';

const SPRINT_HOURS = 37.5;
const CUSTOMER_CATEGORIES = ['Promtek UK Customers', 'Promtek SA Customers'];
const EPIC_BATCH = 15;

// Difficulty, story point and base sprint fields, per discipline.
export const DISCIPLINES = {
  software: { scope: 'customfield_15413', tech: 'customfield_15412', dep: 'customfield_15415', risk: 'customfield_15414', points: 'customfield_10004', sprint: 'customfield_15431' },
  hardware: { scope: 'customfield_15417', tech: 'customfield_15416', dep: 'customfield_15419', risk: 'customfield_15418', points: 'customfield_15650', sprint: 'customfield_16464' },
  engineering: { scope: 'customfield_15421', tech: 'customfield_15420', dep: 'customfield_15423', risk: 'customfield_15422', points: 'customfield_15651', sprint: 'customfield_16465' },
  condor: { scope: 'customfield_16458', tech: 'customfield_16457', dep: 'customfield_16460', risk: 'customfield_16459', points: 'customfield_16463', sprint: 'customfield_16466' },
};

const CATEGORY_WORDS = [
  ['software', 'software'],
  ['hardware', 'hardware'],
  ['condor', 'condor'],
  ['site visit', 'engineering'],
  ['commissioning', 'engineering'],
  ['engineering', 'engineering'],
];

// Works out which discipline a "Category - ..." item belongs to.
export function disciplineOf(issue) {
  const text = `${issue.fields?.issuetype?.name || ''} ${issue.fields?.summary || ''}`.toLowerCase();
  if (!text.includes('category')) return null;
  for (const [word, discipline] of CATEGORY_WORDS) if (text.includes(word)) return discipline;
  return null;
}

// Stage summaries repeat across jobs with small differences, so they're
// tidied into a common name that can be grouped and counted.
export function stageNameOf(summary, issueKey) {
  let name = String(summary || '').toLowerCase();
  if (issueKey) name = name.replace(new RegExp(issueKey.split('-')[0].toLowerCase() + '[- ]?\\d*', 'g'), ' ');
  name = name
    .replace(/\b[a-z]{2,10}-\d+\b/g, ' ')          // other issue keys
    .replace(/\bstage\s*\d+\b/g, ' ')
    .replace(/\bphase\s*\d+\b/g, ' ')
    .replace(/\bweek\s*\d+\b/g, ' ')
    .replace(/\bday\s*\d+\b/g, ' ')
    .replace(/\bno\.?\s*\d+\b/g, ' ')
    .replace(/\bv?\d+(\.\d+)?\b/g, ' ')            // bare numbers and versions
    .replace(/[^a-z&\/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return 'Unnamed stage';
  const acronyms = new Set(['hmi', 'io', 'i/o', 'fat', 'sat', 'plc', 'mes', 'ups', 'scada', 'p&id', 'atex', 'psc', 'rd', 'qa', 'it', 'vpn', 'pc', 'hv', 'lv']);
  return name.split(' ')
    .map((word) => (acronyms.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

const num = (v) => {
  const parsed = parseFloat(v);
  return Number.isFinite(parsed) ? parsed : null;
};
const isDone = (issue) => issue.fields?.status?.statusCategory?.key === 'done';
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const BASE_FIELDS = [
  'summary', 'issuetype', 'status', 'parent', 'project', 'resolutiondate', 'updated',
  'timespent', 'aggregatetimespent', 'timeoriginalestimate', 'customfield_14562', 'customfield_15378',
];
const ALL_FIELDS = [...BASE_FIELDS, ...Object.values(DISCIPLINES).flatMap((d) => Object.values(d))];

const teamOf = (issue) => {
  const value = issue.fields?.customfield_14562;
  if (Array.isArray(value)) return value[0]?.value || null;
  return value?.value || null;
};

// How much the row can be trusted for quoting.
function confidenceOf({ estimate_seconds, actual_seconds, story_points }) {
  if (!actual_seconds) return 'poor';
  if (!estimate_seconds || !story_points) return 'partial';
  const ratio = actual_seconds / estimate_seconds;
  if (ratio > 10 || ratio < 0.05) return 'partial';
  return 'good';
}

function row(base) {
  return { ...base, confidence: confidenceOf(base), updated_at: new Date().toISOString() };
}

function saveRows(env, rows) {
  return rows.map((r) => env.DB.prepare(
    `INSERT INTO completed_jobs (issue_id, issue_key, kind, epic_id, epic_key, parent_id, project_key, project_name,
       team, discipline, summary, status, done_date, story_points, score_scope, score_tech, score_dep, score_risk,
       weighted_score, job_elo, estimate_seconds, actual_seconds, child_count, legacy, confidence, updated_at,
       stage_name, stage_share)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, kind = excluded.kind,
       epic_id = excluded.epic_id, epic_key = excluded.epic_key, parent_id = excluded.parent_id,
       project_key = excluded.project_key, project_name = excluded.project_name, team = excluded.team,
       discipline = excluded.discipline, summary = excluded.summary, status = excluded.status,
       done_date = excluded.done_date, story_points = excluded.story_points, score_scope = excluded.score_scope,
       score_tech = excluded.score_tech, score_dep = excluded.score_dep, score_risk = excluded.score_risk,
       weighted_score = excluded.weighted_score, job_elo = excluded.job_elo,
       estimate_seconds = excluded.estimate_seconds, actual_seconds = excluded.actual_seconds,
       child_count = excluded.child_count, legacy = excluded.legacy, confidence = excluded.confidence,
       updated_at = excluded.updated_at, stage_name = excluded.stage_name, stage_share = excluded.stage_share`
  ).bind(r.issue_id, r.issue_key, r.kind, r.epic_id, r.epic_key, r.parent_id, r.project_key, r.project_name,
    r.team, r.discipline, r.summary, r.status, r.done_date, r.story_points, r.score_scope, r.score_tech,
    r.score_dep, r.score_risk, r.weighted_score, r.job_elo, r.estimate_seconds, r.actual_seconds,
    r.child_count, r.legacy, r.confidence, r.updated_at, r.stage_name ?? null, r.stage_share ?? null));
}

// Turns a batch of finished epics, with their categories and stages, into rows.
export async function processEpics(env, epics) {
  if (!epics.length) return { epics: 0, rows: 0 };
  const keys = epics.map((e) => e.key);

  const categories = await searchJql(env, `parent in (${keys.join(',')})`, ALL_FIELDS);
  const categoryKeys = categories.map((c) => c.key);
  const stages = categoryKeys.length
    ? await searchJql(env, `parent in (${categoryKeys.join(',')})`, ALL_FIELDS)
    : [];

  const stagesByParent = new Map();
  for (const stage of stages) {
    const parent = stage.fields?.parent?.id;
    if (!parent) continue;
    if (!stagesByParent.has(parent)) stagesByParent.set(parent, []);
    stagesByParent.get(parent).push(stage);
  }
  const categoriesByEpic = new Map();
  for (const category of categories) {
    const parent = category.fields?.parent?.id;
    if (!parent) continue;
    if (!categoriesByEpic.has(parent)) categoriesByEpic.set(parent, []);
    categoriesByEpic.get(parent).push(category);
  }

  const rows = [];
  for (const epic of epics) {
    const f = epic.fields || {};
    const epicCategories = (categoriesByEpic.get(epic.id) || []).filter((c) => disciplineOf(c));
    const nonCategoryChildren = (categoriesByEpic.get(epic.id) || []).filter((c) => !disciplineOf(c));
    const team = teamOf(epic);
    const project = f.project || {};
    const doneDate = (f.resolutiondate || f.updated || '').slice(0, 10) || null;

    rows.push(row({
      issue_id: String(epic.id), issue_key: epic.key, kind: 'epic',
      epic_id: String(epic.id), epic_key: epic.key, parent_id: null,
      project_key: project.key || null, project_name: project.name || null,
      team, discipline: null, summary: f.summary || '', status: f.status?.name || null, done_date: doneDate,
      story_points: null, score_scope: null, score_tech: null, score_dep: null, score_risk: null,
      weighted_score: null, job_elo: num(f.customfield_15378),
      estimate_seconds: num(f.timeoriginalestimate),
      actual_seconds: num(f.aggregatetimespent) || num(f.timespent) || 0,
      child_count: epicCategories.length,
      legacy: epicCategories.length ? 0 : 1,
    }));

    for (const category of epicCategories) {
      const cf = category.fields || {};
      const discipline = disciplineOf(category);
      const map = DISCIPLINES[discipline];
      const scope = num(f[map.scope]);
      const tech = num(f[map.tech]);
      const dep = num(f[map.dep]);
      const risk = num(f[map.risk]);
      const weighted = [scope, tech, dep, risk].every((v) => v != null)
        ? tech * 0.40 + scope * 0.30 + dep * 0.20 + risk * 0.10
        : null;
      const sprints = num(cf[map.sprint]);
      const categoryStages = stagesByParent.get(category.id) || [];

      rows.push(row({
        issue_id: String(category.id), issue_key: category.key, kind: 'category',
        epic_id: String(epic.id), epic_key: epic.key, parent_id: String(epic.id),
        project_key: project.key || null, project_name: project.name || null,
        team, discipline, summary: cf.summary || '', status: cf.status?.name || null,
        done_date: (cf.resolutiondate || cf.updated || '').slice(0, 10) || doneDate,
        story_points: num(f[map.points]),
        score_scope: scope, score_tech: tech, score_dep: dep, score_risk: risk, weighted_score: weighted,
        job_elo: num(cf.customfield_15378),
        estimate_seconds: sprints ? Math.round(sprints * SPRINT_HOURS * 3600) : num(cf.timeoriginalestimate),
        // Stage time rolls up here, which is how each category is estimated.
        actual_seconds: num(cf.aggregatetimespent) || num(cf.timespent) || 0,
        child_count: categoryStages.length,
        legacy: 0,
      }));

      const categoryActual = num(cf.aggregatetimespent) || num(cf.timespent) || 0;
      for (const stage of categoryStages) {
        const sf = stage.fields || {};
        const stageActual = num(sf.timespent) || 0;
        rows.push(row({
          stage_name: stageNameOf(sf.summary, stage.key),
          stage_share: categoryActual > 0 ? stageActual / categoryActual : null,
          issue_id: String(stage.id), issue_key: stage.key, kind: 'stage',
          epic_id: String(epic.id), epic_key: epic.key, parent_id: String(category.id),
          project_key: project.key || null, project_name: project.name || null,
          team, discipline, summary: sf.summary || '', status: sf.status?.name || null,
          done_date: (sf.resolutiondate || sf.updated || '').slice(0, 10) || doneDate,
          story_points: null, score_scope: null, score_tech: null, score_dep: null, score_risk: null,
          weighted_score: null, job_elo: null,
          estimate_seconds: num(sf.timeoriginalestimate),
          actual_seconds: num(sf.timespent) || 0,
          child_count: 0, legacy: 0,
        }));
      }
    }

    // Legacy epics: children hang straight off the epic with no category layer.
    const epicActual = num(f.aggregatetimespent) || num(f.timespent) || 0;
    for (const child of nonCategoryChildren) {
      const cf = child.fields || {};
      const childActual = num(cf.aggregatetimespent) || num(cf.timespent) || 0;
      rows.push(row({
        stage_name: stageNameOf(cf.summary, child.key),
        stage_share: epicActual > 0 ? childActual / epicActual : null,
        issue_id: String(child.id), issue_key: child.key, kind: 'stage',
        epic_id: String(epic.id), epic_key: epic.key, parent_id: String(epic.id),
        project_key: project.key || null, project_name: project.name || null,
        team, discipline: null, summary: cf.summary || '', status: cf.status?.name || null,
        done_date: (cf.resolutiondate || cf.updated || '').slice(0, 10) || doneDate,
        story_points: null, score_scope: null, score_tech: null, score_dep: null, score_risk: null,
        weighted_score: null, job_elo: null,
        estimate_seconds: num(cf.timeoriginalestimate),
        actual_seconds: num(cf.aggregatetimespent) || num(cf.timespent) || 0,
        child_count: 0, legacy: 1,
      }));
    }
  }

  for (const part of chunk(rows, 40)) await env.DB.batch(saveRows(env, part));
  return { epics: epics.length, rows: rows.length };
}

const customerFilter = `category in (${CUSTOMER_CATEGORIES.map((c) => `"${c}"`).join(', ')})`;

// Picks up jobs finished since the last scan.
export async function scanCompleted(env) {
  const since = (await getState(env, 'jobs_cursor')) || londonDate(Date.now() - 14 * 86_400_000);
  const jql = `${customerFilter} AND issuetype = Epic AND statusCategory = Done AND updated >= "${since.replace(/-/g, '/')}" ORDER BY updated ASC`;
  const epics = await searchJql(env, jql, ALL_FIELDS, { limit: EPIC_BATCH });
  const result = await processEpics(env, epics.filter(isDone));
  await setState(env, 'jobs_cursor', londonDate(Date.now() - 2 * 86_400_000));
  return result;
}

// Walks backwards through history a batch at a time, so nothing times out.
export async function backfillStep(env) {
  const until = await getState(env, 'backfill_until');
  if (!until) return { skipped: 'Backfill not started' };
  const before = (await getState(env, 'backfill_before')) || londonDate();
  if (before <= until) return { done: true };

  const jql = `${customerFilter} AND issuetype = Epic AND statusCategory = Done`
    + ` AND updated >= "${until.replace(/-/g, '/')}" AND updated < "${before.replace(/-/g, '/')}" ORDER BY updated DESC`;
  const epics = await searchJql(env, jql, ALL_FIELDS, { limit: EPIC_BATCH });
  if (!epics.length) {
    await setState(env, 'backfill_before', until);
    return { done: true };
  }

  const result = await processEpics(env, epics);
  const oldest = epics[epics.length - 1].fields?.updated?.slice(0, 10) || until;
  // Step back a day when a batch fills up on one date, so we never loop on it.
  await setState(env, 'backfill_before', oldest === before ? londonDate(Date.parse(`${oldest}T12:00:00Z`) - 86_400_000) : oldest);
  return { ...result, reached: oldest };
}

export async function startBackfill(env, months = 24) {
  const until = londonDate(Date.now() - months * 30 * 86_400_000);
  await setState(env, 'backfill_until', until);
  await setState(env, 'backfill_before', londonDate());
  return { until };
}

// ---------- Quoting reports ----------

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export async function quotingSummary(env, { discipline = null, minConfidence = 'good' } = {}) {
  const params = [];
  let filter = "kind = 'category' AND actual_seconds > 0";
  if (discipline) { filter += ' AND discipline = ?'; params.push(discipline); }
  if (minConfidence === 'good') filter += " AND confidence = 'good'";

  const { results } = await env.DB.prepare(
    `SELECT discipline, story_points, weighted_score, estimate_seconds, actual_seconds, done_date,
            issue_key, epic_key, project_name, team, job_elo
       FROM completed_jobs WHERE ${filter} ORDER BY done_date DESC`
  ).bind(...params).all();

  // Median actual hours per discipline and story point band.
  const bands = new Map();
  for (const r of results) {
    if (!r.discipline || r.story_points == null) continue;
    const key = `${r.discipline}|${r.story_points}`;
    if (!bands.has(key)) bands.set(key, { discipline: r.discipline, storyPoints: r.story_points, actual: [], estimate: [], ratios: [] });
    const band = bands.get(key);
    band.actual.push(r.actual_seconds / 3600);
    if (r.estimate_seconds) {
      band.estimate.push(r.estimate_seconds / 3600);
      band.ratios.push(r.actual_seconds / r.estimate_seconds);
    }
  }

  const byBand = [...bands.values()].map((b) => ({
    discipline: b.discipline,
    storyPoints: b.storyPoints,
    jobs: b.actual.length,
    medianActualHours: median(b.actual),
    medianEstimateHours: median(b.estimate),
    medianRatio: median(b.ratios),
    spreadHours: b.actual.length > 1 ? [Math.min(...b.actual), Math.max(...b.actual)] : null,
  })).sort((a, b) => a.discipline.localeCompare(b.discipline) || a.storyPoints - b.storyPoints);

  // Accuracy by customer and by team.
  const group = (keyOf) => {
    const map = new Map();
    for (const r of results) {
      if (!r.estimate_seconds) continue;
      const key = keyOf(r) || 'Unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r.actual_seconds / r.estimate_seconds);
    }
    return [...map.entries()]
      .map(([name, ratios]) => ({ name, jobs: ratios.length, medianRatio: median(ratios) }))
      .sort((a, b) => b.jobs - a.jobs);
  };

  const coverage = await env.DB.prepare(
    `SELECT kind, confidence, COUNT(*) AS n, SUM(legacy) AS legacy FROM completed_jobs GROUP BY kind, confidence`
  ).all();

  return {
    byBand,
    byCustomer: group((r) => r.project_name),
    byTeam: group((r) => r.team),
    coverage: coverage.results,
    jobs: results.slice(0, 200),
    sprintHours: SPRINT_HOURS,
  };
}

// ---------- Stage-level estimating ----------

// Stages rarely carry an estimate of their own, so their value comes from how
// long they actually take, and from what share of their category they use.
export async function stageLibrary(env, { discipline = null, minJobs = 2 } = {}) {
  const params = [];
  let filter = "kind = 'stage' AND actual_seconds > 0 AND stage_name IS NOT NULL";
  if (discipline) { filter += ' AND discipline = ?'; params.push(discipline); }

  const { results } = await env.DB.prepare(
    `SELECT discipline, stage_name, actual_seconds, stage_share, epic_key, issue_key, done_date
       FROM completed_jobs WHERE ${filter}`
  ).bind(...params).all();

  const groups = new Map();
  for (const r of results) {
    const key = `${r.discipline || 'none'}|${r.stage_name}`;
    if (!groups.has(key)) groups.set(key, { discipline: r.discipline, stage: r.stage_name, hours: [], shares: [], last: null });
    const g = groups.get(key);
    g.hours.push(r.actual_seconds / 3600);
    if (r.stage_share != null) g.shares.push(r.stage_share);
    if (!g.last || (r.done_date || '') > g.last) g.last = r.done_date;
  }

  const stages = [...groups.values()]
    .filter((g) => g.hours.length >= minJobs)
    .map((g) => ({
      discipline: g.discipline,
      stage: g.stage,
      times: g.hours.length,
      medianHours: median(g.hours),
      lowHours: Math.min(...g.hours),
      highHours: Math.max(...g.hours),
      medianShare: median(g.shares),
      lastSeen: g.last,
    }))
    .sort((a, b) => (a.discipline || '').localeCompare(b.discipline || '') || b.times - a.times);

  const skipped = [...groups.values()].filter((g) => g.hours.length < minJobs).length;
  return { stages, skipped, minJobs };
}

// Whether the difficulty scores actually predict how long work takes.
export async function difficultyAnalysis(env, { discipline = null } = {}) {
  const params = [];
  let filter = "kind = 'category' AND actual_seconds > 0 AND weighted_score IS NOT NULL";
  if (discipline) { filter += ' AND discipline = ?'; params.push(discipline); }

  const { results } = await env.DB.prepare(
    `SELECT discipline, weighted_score, score_scope, score_tech, score_dep, score_risk,
            story_points, estimate_seconds, actual_seconds, job_elo
       FROM completed_jobs WHERE ${filter}`
  ).bind(...params).all();

  // Median hours per half point of weighted score.
  const bands = new Map();
  for (const r of results) {
    const band = Math.round(r.weighted_score * 2) / 2;
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band).push(r.actual_seconds / 3600);
  }
  const byScore = [...bands.entries()]
    .map(([score, hours]) => ({ score, jobs: hours.length, medianHours: median(hours) }))
    .sort((a, b) => a.score - b.score);

  // Which of the four scores tracks real hours most closely.
  const drivers = ['score_scope', 'score_tech', 'score_dep', 'score_risk'].map((field) => {
    const pairs = results.filter((r) => r[field] != null).map((r) => [r[field], r.actual_seconds / 3600]);
    const levels = new Map();
    for (const [score, hours] of pairs) {
      if (!levels.has(score)) levels.set(score, []);
      levels.get(score).push(hours);
    }
    return {
      field,
      name: { score_scope: 'Scope and size', score_tech: 'Technical complexity', score_dep: 'Dependencies', score_risk: 'Uncertainty and risk' }[field],
      levels: [...levels.entries()].map(([score, hours]) => ({ score, jobs: hours.length, medianHours: median(hours) }))
        .sort((a, b) => a.score - b.score),
      correlation: correlation(pairs),
    };
  }).sort((a, b) => (b.correlation ?? -1) - (a.correlation ?? -1));

  return { byScore, drivers, jobs: results.length };
}

function correlation(pairs) {
  if (pairs.length < 4) return null;
  const n = pairs.length;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  const my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let top = 0, bx = 0, by = 0;
  for (const [x, y] of pairs) {
    top += (x - mx) * (y - my);
    bx += (x - mx) ** 2;
    by += (y - my) ** 2;
  }
  return bx && by ? top / Math.sqrt(bx * by) : null;
}

// Fills in stage names and shares for rows recorded before this was added.
export async function recomputeStages(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.issue_id, s.issue_key, s.summary, s.actual_seconds, p.actual_seconds AS parent_seconds
       FROM completed_jobs s LEFT JOIN completed_jobs p ON p.issue_id = s.parent_id
      WHERE s.kind = 'stage'`
  ).all();
  const stmts = results.map((r) => env.DB.prepare(
    'UPDATE completed_jobs SET stage_name = ?, stage_share = ? WHERE issue_id = ?'
  ).bind(stageNameOf(r.summary, r.issue_key), r.parent_seconds > 0 ? r.actual_seconds / r.parent_seconds : null, r.issue_id));
  for (const part of chunk(stmts, 40)) await env.DB.batch(part);
  return { stages: stmts.length };
}

export async function backfillStatus(env) {
  const [until, before, cursor, counts] = await Promise.all([
    getState(env, 'backfill_until'),
    getState(env, 'backfill_before'),
    getState(env, 'jobs_cursor'),
    env.DB.prepare(
      `SELECT COUNT(*) AS rows, SUM(kind = 'epic') AS epics, SUM(kind = 'category') AS categories,
              SUM(kind = 'stage') AS stages, MIN(done_date) AS earliest, MAX(done_date) AS latest
         FROM completed_jobs`
    ).first(),
  ]);
  return { until, before, cursor, done: Boolean(until && before && before <= until), ...counts };
}
