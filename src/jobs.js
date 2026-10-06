// Records finished work so estimates can be checked against reality.
// Nothing here touches XP or ELO; it only reads Jira and writes its own table.
import { searchJql } from './jira.js';
import { getState, setState, londonDate } from './sync.js';
import { weightedScore } from './progression.js';

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
export const isDone = (issue) => issue.fields?.status?.statusCategory?.key === 'done';
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const BASE_FIELDS = [
  'summary', 'issuetype', 'status', 'parent', 'project', 'resolutiondate', 'updated',
  'timespent', 'aggregatetimespent', 'timeoriginalestimate', 'customfield_14562', 'customfield_15378',
  'statuscategorychangedate', 'aggregatetimeoriginalestimate',
];
export const ALL_FIELDS = [...BASE_FIELDS, ...Object.values(DISCIPLINES).flatMap((d) => Object.values(d))];

export const teamOf = (issue) => {
  const value = issue.fields?.customfield_14562;
  if (Array.isArray(value)) return value[0]?.value || null;
  return value?.value || null;
};

// How much the row can be trusted for quoting.
function confidenceOf({ estimate_seconds, actual_seconds }) {
  if (!actual_seconds) return 'poor';
  if (!estimate_seconds) return 'partial';
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
       stage_name, stage_share, stage_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, kind = excluded.kind,
       epic_id = excluded.epic_id, epic_key = excluded.epic_key, parent_id = excluded.parent_id,
       project_key = excluded.project_key, project_name = excluded.project_name, team = excluded.team,
       discipline = excluded.discipline, summary = excluded.summary, status = excluded.status,
       done_date = excluded.done_date, story_points = excluded.story_points, score_scope = excluded.score_scope,
       score_tech = excluded.score_tech, score_dep = excluded.score_dep, score_risk = excluded.score_risk,
       weighted_score = excluded.weighted_score, job_elo = excluded.job_elo,
       estimate_seconds = excluded.estimate_seconds, actual_seconds = excluded.actual_seconds,
       child_count = excluded.child_count, legacy = excluded.legacy, confidence = excluded.confidence,
       updated_at = excluded.updated_at, stage_name = excluded.stage_name, stage_share = excluded.stage_share,
       stage_type = COALESCE(excluded.stage_type, completed_jobs.stage_type)`
  ).bind(r.issue_id, r.issue_key, r.kind, r.epic_id, r.epic_key, r.parent_id, r.project_key, r.project_name,
    r.team, r.discipline, r.summary, r.status, r.done_date, r.story_points, r.score_scope, r.score_tech,
    r.score_dep, r.score_risk, r.weighted_score, r.job_elo, r.estimate_seconds, r.actual_seconds,
    r.child_count, r.legacy, r.confidence, r.updated_at, r.stage_name ?? null, r.stage_share ?? null, r.stage_type ?? null));
}

// A category's estimate is its own Original Estimate plus its stages', since
// older jobs were quoted by stage. Where the stages simply share out the
// category's own hours, those hours are counted once, not twice. Base sprints
// only fill in when there's no Original Estimate anywhere.
const SPLIT_TOLERANCE = 0.05;
export function categoryEstimate(cf, sprints = null) {
  const own = num(cf.timeoriginalestimate) || 0;
  const total = num(cf.aggregatetimeoriginalestimate) || own;
  const stages = Math.max(0, total - own);
  let seconds;
  if (own && stages && Math.abs(stages - own) <= own * SPLIT_TOLERANCE) seconds = own;
  else seconds = own + stages;
  if (seconds) return seconds;
  return sprints ? Math.round(sprints * SPRINT_HOURS * 3600) : null;
}

// The latest move into Done is the end of a category; reopening one means it
// was closed in error.
const categoryDoneDate = (issue) => {
  const f = issue.fields || {};
  return (f.statuscategorychangedate || f.resolutiondate || f.updated || '').slice(0, 10) || null;
};

// One finished category and its stages, as rows. Scores live on the order.
export function categoryRows({ epic, category, categoryStages, doneDate = null }) {
  const f = epic.fields || {};
  const team = teamOf(epic);
  const project = f.project || {};
  const out = [];
  const cf = category.fields || {};
  const discipline = disciplineOf(category);
  const map = DISCIPLINES[discipline];
  const scope = num(f[map.scope]);
  const tech = num(f[map.tech]);
  const dep = num(f[map.dep]);
  const risk = num(f[map.risk]);
  const weighted = [scope, tech, dep, risk].every((v) => v != null)
    ? weightedScore({ tech, scope, risk, dep })
    : null;
  const sprints = num(cf[map.sprint]);

  out.push(row({
    issue_id: String(category.id), issue_key: category.key, kind: 'category',
    epic_id: String(epic.id), epic_key: epic.key, parent_id: String(epic.id),
    project_key: project.key || null, project_name: project.name || null,
    team, discipline, summary: cf.summary || '', status: cf.status?.name || null,
    done_date: categoryDoneDate(category) || doneDate,
    story_points: num(f[map.points]),
    score_scope: scope, score_tech: tech, score_dep: dep, score_risk: risk, weighted_score: weighted,
    job_elo: num(cf.customfield_15378),
    estimate_seconds: categoryEstimate(cf, sprints),
    // Stage time rolls up here, which is how each category is estimated.
    actual_seconds: num(cf.aggregatetimespent) || num(cf.timespent) || 0,
    child_count: categoryStages.length,
    legacy: 0,
  }));

  const categoryActual = num(cf.aggregatetimespent) || num(cf.timespent) || 0;
  for (const stage of categoryStages) {
    const sf = stage.fields || {};
    const stageActual = num(sf.timespent) || 0;
    out.push(row({
      stage_name: stageNameOf(sf.summary, stage.key),
      stage_type: sf.issuetype?.name || null,
      stage_share: categoryActual > 0 ? stageActual / categoryActual : null,
      issue_id: String(stage.id), issue_key: stage.key, kind: 'stage',
      epic_id: String(epic.id), epic_key: epic.key, parent_id: String(category.id),
      project_key: project.key || null, project_name: project.name || null,
      team, discipline, summary: sf.summary || '', status: sf.status?.name || null,
      done_date: (sf.resolutiondate || sf.updated || '').slice(0, 10) || categoryDoneDate(category) || doneDate,
      story_points: null, score_scope: null, score_tech: null, score_dep: null, score_risk: null,
      weighted_score: null, job_elo: null,
      estimate_seconds: num(sf.timeoriginalestimate),
      actual_seconds: num(sf.timespent) || 0,
      child_count: 0, legacy: 0,
    }));
  }
  return out;
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
      rows.push(...categoryRows({ epic, category, categoryStages: stagesByParent.get(category.id) || [], doneDate }));
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
        stage_type: cf.issuetype?.name || null,
      }));
    }
  }

  for (const part of chunk(rows, 40)) await env.DB.batch(saveRows(env, part));
  return { epics: epics.length, rows: rows.length };
}

export const customerFilter = `category in (${CUSTOMER_CATEGORIES.map((c) => `"${c}"`).join(', ')})`;

// Picks up jobs finished since the last scan.
export async function scanCompleted(env) {
  const since = (await getState(env, 'jobs_cursor')) || londonDate(Date.now() - 14 * 86_400_000);
  const jql = `${customerFilter} AND issuetype = Epic AND statusCategory = Done AND updated >= "${since.replace(/-/g, '/')}" ORDER BY updated ASC`;
  const epics = await searchJql(env, jql, ALL_FIELDS, { limit: EPIC_BATCH });
  const result = await processEpics(env, epics.filter(isDone));
  await setState(env, 'jobs_cursor', londonDate(Date.now() - 2 * 86_400_000));
  return result;
}

const CATEGORY_BATCH = 25;

// Jira reads JQL dates in the API user's time zone, which is London.
function jqlMinute(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}
const jqlMinuteOf = (jiraTime) => String(jiraTime || '').slice(0, 16).replace('T', ' ').replace(/-/g, '/');
const addMinute = (minute) => jqlMinute(Date.parse(`${minute.replace(/\//g, '-').replace(' ', 'T')}:00Z`) + 60_000 - londonOffsetMs(minute));
function londonOffsetMs(minute) {
  const utc = Date.parse(`${minute.replace(/\//g, '-').replace(' ', 'T')}:00Z`);
  return Date.parse(`${jqlMinute(utc).replace(/\//g, '-').replace(' ', 'T')}:00Z`) - utc;
}

// Categories are measured when they finish, not when their whole order does.
// Works forwards from the backfill date a batch at a time, then keeps up.
export async function scanCategories(env) {
  let cursor = await getState(env, 'category_cursor');
  if (!cursor) {
    const from = (await getState(env, 'backfill_until')) || londonDate(Date.now() - 24 * 30 * 86_400_000);
    cursor = `${from.replace(/-/g, '/')} 00:00`;
  }
  const jql = `${customerFilter} AND statusCategory = Done AND issuetype != Epic AND issuetype not in subTaskIssueTypes()`
    + ` AND parent is not EMPTY AND updated >= "${cursor}" ORDER BY updated ASC`;
  const startedAt = Date.now();
  const issues = await searchJql(env, jql, ALL_FIELDS, { limit: CATEGORY_BATCH });
  const result = await processCategories(env, issues.filter((i) => isDone(i) && disciplineOf(i)));

  let next;
  if (issues.length < CATEGORY_BATCH) {
    // Caught up: look back a few minutes next time for anything updated mid-scan.
    next = jqlMinute(startedAt - 10 * 60_000);
    if (next < cursor) next = cursor;
  } else {
    next = jqlMinuteOf(issues[issues.length - 1].fields?.updated) || cursor;
    // A full batch inside one minute would otherwise be read again forever.
    if (next <= cursor) next = addMinute(cursor);
  }
  await setState(env, 'category_cursor', next);
  return { checked: issues.length, ...result, cursor: next };
}

export async function processCategories(env, categories) {
  if (!categories.length) return { categories: 0, rows: 0 };
  const epicIds = [...new Set(categories.map((c) => c.fields?.parent?.id).filter(Boolean))];
  const epics = new Map();
  for (const part of chunk(epicIds, 50)) {
    for (const epic of await searchJql(env, `id in (${part.join(',')})`, ALL_FIELDS)) epics.set(String(epic.id), epic);
  }
  const stagesByParent = new Map();
  for (const part of chunk(categories.map((c) => c.key), 50)) {
    for (const stage of await searchJql(env, `parent in (${part.join(',')})`, ALL_FIELDS)) {
      const parent = String(stage.fields?.parent?.id || '');
      if (!stagesByParent.has(parent)) stagesByParent.set(parent, []);
      stagesByParent.get(parent).push(stage);
    }
  }
  const rows = [];
  let recorded = 0;
  for (const category of categories) {
    const epic = epics.get(String(category.fields?.parent?.id));
    if (!epic) continue;
    recorded++;
    rows.push(...categoryRows({ epic, category, categoryStages: stagesByParent.get(String(category.id)) || [] }));
  }
  for (const part of chunk(rows, 40)) await env.DB.batch(saveRows(env, part));
  return { categories: recorded, rows: rows.length };
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

// Estimates grouped by working time: a day, three days, a week, two weeks, a month.
const SIZE_BANDS = [['Up to a day', 7.5], ['Up to 3 days', 22.5], ['Up to a week', 37.5], ['Up to 2 weeks', 75], ['Up to a month', 150], ['Over a month', Infinity]];

export async function quotingSummary(env, { discipline = null, minConfidence = 'good', team = null } = {}) {
  const params = [];
  let filter = "kind = 'category' AND actual_seconds > 0";
  if (discipline) { filter += ' AND discipline = ?'; params.push(discipline); }
  if (minConfidence === 'good') filter += " AND confidence = 'good'";
  if (team) { filter += ' AND team = ?'; params.push(team); }

  const { results } = await env.DB.prepare(
    `SELECT discipline, story_points, weighted_score, estimate_seconds, actual_seconds, done_date,
            issue_key, epic_key, project_name, team, job_elo
       FROM completed_jobs WHERE ${filter} ORDER BY done_date DESC`
  ).bind(...params).all();

  // Median actual hours per discipline and size of estimate.
  const bands = new Map();
  for (const r of results) {
    if (!r.discipline || !r.estimate_seconds) continue;
    const size = SIZE_BANDS.findIndex(([, upTo]) => r.estimate_seconds / 3600 <= upTo);
    const key = `${r.discipline}|${size}`;
    if (!bands.has(key)) bands.set(key, { discipline: r.discipline, size, actual: [], estimate: [], ratios: [] });
    const band = bands.get(key);
    band.actual.push(r.actual_seconds / 3600);
    if (r.estimate_seconds) {
      band.estimate.push(r.estimate_seconds / 3600);
      band.ratios.push(r.actual_seconds / r.estimate_seconds);
    }
  }

  const byBand = [...bands.values()].map((b) => ({
    discipline: b.discipline,
    size: SIZE_BANDS[b.size][0],
    sizeOrder: b.size,
    jobs: b.actual.length,
    medianActualHours: median(b.actual),
    medianEstimateHours: median(b.estimate),
    medianRatio: median(b.ratios),
    spreadHours: b.actual.length > 1 ? [Math.min(...b.actual), Math.max(...b.actual)] : null,
  })).sort((a, b) => a.discipline.localeCompare(b.discipline) || a.sizeOrder - b.sizeOrder);

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
// The stage types used on quotes. Older orders used the same stages without
// "New" in front, and with no category layer, so they map across here; any
// other issue type isn't a quoted stage and is left out.
export const STAGE_TYPES = {
  'New Design': ['hardware', 'New Design'], 'Design': ['hardware', 'New Design'],
  'New Purchase Order': ['hardware', 'New Purchase Order'], 'Purchase Order': ['hardware', 'New Purchase Order'],
  'New Build': ['hardware', 'New Build'], 'Build': ['hardware', 'New Build'],
  'New Configuration & Testing': ['hardware', 'New Configuration & Testing'], 'Configuration & Test': ['hardware', 'New Configuration & Testing'],
  'New Dispatch': ['hardware', 'New Dispatch'], 'Dispatch': ['hardware', 'New Dispatch'],
  'New Software Development': ['software', 'New Software Development'],
  'Storaweigh Software Development': ['software', 'New Software Development'], 'Kestrel Software Development': ['software', 'New Software Development'],
  'New Order Site Visit': ['engineering', 'New Order Site Visit'], 'Commissioning Site Visit': ['engineering', 'New Order Site Visit'],
  'New Condor Development': ['condor', 'New Condor Development'], 'Condor Development': ['condor', 'New Condor Development'],
  // Download phases belong to Software or Condor; which one comes from the job.
  'New Download Phase': [null, 'New Download Phase'], 'Download Phase': [null, 'New Download Phase'],
};

// Every finished stage that maps to a quoted stage type, grouped the way the
// hours were shared: by category, or for older orders by order and category type.
export async function mappedStages(env, { team = null } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT s.issue_id, s.issue_key, s.stage_type, s.actual_seconds, s.parent_id, s.epic_key, s.done_date, s.team, s.legacy, s.project_name,
            c.kind AS parent_kind, c.discipline AS parent_discipline, c.confidence AS parent_confidence
       FROM completed_jobs s LEFT JOIN completed_jobs c ON c.issue_id = s.parent_id
      WHERE s.kind = 'stage' AND s.stage_type IS NOT NULL AND s.stage_type != '' ${team ? 'AND s.team = ?' : ''}`
  ).bind(...(team ? [team] : [])).all();
  const condorOrders = new Set(results.filter((r) => STAGE_TYPES[r.stage_type]?.[0] === 'condor').map((r) => r.epic_key));
  const rows = [];
  for (const r of results) {
    const map = STAGE_TYPES[r.stage_type];
    if (!map) continue;
    let discipline = r.parent_kind === 'category' ? r.parent_discipline : map[0];
    if (!discipline) discipline = condorOrders.has(r.epic_key) ? 'condor' : 'software';
    if (r.parent_kind !== 'category' && map[0] && map[0] !== discipline) continue;
    const group = r.parent_kind === 'category' ? r.parent_id : `${r.epic_key}|${discipline}`;
    rows.push({ ...r, discipline, type: map[1], group, hours: (r.actual_seconds || 0) / 3600 });
  }
  const totals = new Map();
  for (const r of rows) totals.set(r.group, (totals.get(r.group) || 0) + r.hours);
  return rows.map((r) => ({ ...r, share: totals.get(r.group) > 0 ? r.hours / totals.get(r.group) : null }));
}

// The order stages happen in, so the library reads like a job.
const DISCIPLINE_ORDER = ['hardware', 'software', 'engineering', 'condor'];
const STAGE_ORDER = ['New Design', 'New Purchase Order', 'New Build', 'New Configuration & Testing', 'New Dispatch',
  'New Software Development', 'New Condor Development', 'New Download Phase', 'New Order Site Visit'];

// Grouped by stage type, optionally split by customer or team, and filterable by either.
export async function stageLibrary(env, { discipline = null, minJobs = 2, team = null, customer = null, groupBy = 'type' } = {}) {
  const all = (await mappedStages(env, { team })).filter((r) => r.hours > 0 && (!discipline || r.discipline === discipline));
  const customers = [...new Set(all.map((r) => r.project_name).filter(Boolean))].sort();
  const rows = customer ? all.filter((r) => r.project_name === customer) : all;
  const split = groupBy === 'customer' ? (r) => r.project_name || 'No customer' : groupBy === 'team' ? (r) => r.team || 'No team' : () => null;
  const groups = new Map();
  for (const r of rows) {
    const by = split(r);
    const key = `${r.discipline}|${r.type}|${by ?? ''}`;
    if (!groups.has(key)) groups.set(key, { discipline: r.discipline, stage: r.type, by, hours: [], shares: [], last: null, older: 0 });
    const g = groups.get(key);
    g.hours.push(r.hours);
    if (r.share != null) g.shares.push(r.share);
    if (r.legacy) g.older++;
    if (!g.last || (r.done_date || '') > g.last) g.last = r.done_date;
  }
  const stages = [...groups.values()]
    .filter((g) => g.hours.length >= minJobs)
    .map((g) => ({
      discipline: g.discipline, stage: g.stage, by: g.by, times: g.hours.length, fromOlderOrders: g.older,
      medianHours: median(g.hours), lowHours: Math.min(...g.hours), highHours: Math.max(...g.hours),
      medianShare: median(g.shares), lastSeen: g.last,
    }))
    .sort((a, b) => DISCIPLINE_ORDER.indexOf(a.discipline) - DISCIPLINE_ORDER.indexOf(b.discipline)
      || STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
      || String(a.by ?? '').localeCompare(String(b.by ?? '')));
  const skipped = [...groups.values()].filter((g) => g.hours.length < minJobs).length;
  return { stages, skipped, minJobs, customers, groupBy };
}

// The typical share of a category's time each stage type takes, for sharing
// quoted hours out once there's enough history.
export async function stageShares(env, discipline) {
  const by = new Map();
  for (const r of await mappedStages(env)) {
    if (r.discipline !== discipline || r.share == null || r.share <= 0) continue;
    if (!by.has(r.type)) by.set(r.type, []);
    by.get(r.type).push(r.share);
  }
  return new Map([...by].map(([type, shares]) => [type, { share: median(shares), jobs: shares.length }]));
}

// Stages recorded before their issue type was kept get it looked up, a batch at a time.
export async function fillStageTypes(env, { batch = 50 } = {}) {
  const { results } = await env.DB.prepare("SELECT issue_id FROM completed_jobs WHERE kind = 'stage' AND stage_type IS NULL LIMIT ?").bind(batch).all();
  if (!results.length) return { idle: true };
  const ids = results.map((r) => r.issue_id);
  const found = await searchJql(env, `id in (${ids.join(',')})`, ['issuetype'], { limit: batch });
  const types = new Map(found.map((i) => [String(i.id), i.fields?.issuetype?.name || '']));
  // Issues Jira no longer has are marked empty, so they aren't looked up again.
  await env.DB.batch(ids.map((id) => env.DB.prepare('UPDATE completed_jobs SET stage_type = ? WHERE issue_id = ?').bind(types.get(id) ?? '', id)));
  return { filled: ids.length };
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
  const [until, before, cursor, categoryCursor, counts] = await Promise.all([
    getState(env, 'backfill_until'),
    getState(env, 'backfill_before'),
    getState(env, 'jobs_cursor'),
    getState(env, 'category_cursor'),
    env.DB.prepare(
      `SELECT COUNT(*) AS rows, SUM(kind = 'epic') AS epics, SUM(kind = 'category') AS categories,
              SUM(kind = 'stage') AS stages, MIN(done_date) AS earliest, MAX(done_date) AS latest
         FROM completed_jobs`
    ).first(),
  ]);
  return { until, before, cursor, categoryCursor, done: Boolean(until && before && before <= until), ...counts };
}
