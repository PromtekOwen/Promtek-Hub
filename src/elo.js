// The ELO engine. Each finished category is a match between the job and the
// people who worked on it. Points are zero-sum: whatever the engineers gain,
// the job's learned difficulty loses, and the other way round, so ratings
// can't drift upwards over time and stay comparable with job difficulty.
import { fetchIssueWorklogs } from './tempo.js';
import { getState, setState, londonDate, mondayOf } from './sync.js';
import { DEFAULT_ELO, rankFor, jobEloFromScore } from './progression.js';
import { approvedFor, factorOn } from './modifiers.js';
import { managesPerson } from './permissions.js';

export const K_FACTOR = 32;
export const PROVISIONAL_K = 48;        // bigger steps until someone has a few jobs behind them
export const PROVISIONAL_MATCHES = 10;
const SETTLE_DAYS = 3;                  // time is often logged a day or two after a job closes
const STEP_SIZE = 5;
const PEAK_DAYS = 90;
const LOCK_MS = 90_000;

// 0.5 on estimate, 1 at half the time, 0 at double. Log scale, so running 50%
// over costs the same as finishing a third early gains.
export function outcomeScore(actualSeconds, estimateSeconds) {
  const s = 0.5 - 0.5 * Math.log2(actualSeconds / estimateSeconds);
  return Math.min(1, Math.max(0, s));
}

export function expectedScore(engineerElo, jobElo) {
  return 1 / (1 + 10 ** ((jobElo - engineerElo) / 400));
}

// A wildly short or long actual usually means time was logged elsewhere, so
// it still counts but only a little.
export function matchWeight(ratio) {
  return ratio >= 0.2 && ratio <= 5 ? 1 : 0.25;
}

const round1 = (v) => Math.round(v * 10) / 10;

async function ratedCounts(env) {
  const { results } = await env.DB.prepare(
    "SELECT account_id, COUNT(*) AS n FROM elo_events WHERE kind = 'match' AND reversed_at IS NULL GROUP BY account_id"
  ).all();
  return new Map(results.map((r) => [r.account_id, r.n]));
}

function skipRow(env, cat, status, reason, extra = {}) {
  return env.DB.prepare(
    `INSERT INTO elo_matches (category_id, issue_key, epic_key, summary, discipline, done_date, status, reason,
       job_elo, estimate_seconds, actual_seconds, ratio, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(cat.issue_id, cat.issue_key, cat.epic_key, cat.summary, cat.discipline, cat.done_date, status, reason,
    extra.jobElo ?? null, cat.estimate_seconds ?? null, cat.actual_seconds ?? null, extra.ratio ?? null,
    new Date().toISOString());
}

// Rates one finished category. Returns the statements to run, so the match
// and every rating change land together or not at all.
export async function rateCategory(env, cat, { employees, counts, worklogsFor = fetchIssueWorklogs }) {
  // An approved dispute replaces the quoted difficulty and estimate.
  const override = await env.DB.prepare('SELECT job_elo, estimate_seconds FROM job_overrides WHERE category_id = ?')
    .bind(cat.issue_id).first();
  if (override?.estimate_seconds) cat = { ...cat, estimate_seconds: override.estimate_seconds };
  const jobElo = override?.job_elo ?? cat.job_elo ?? jobEloFromScore(cat.weighted_score);
  if (!cat.estimate_seconds) return { status: 'skipped', stmts: [skipRow(env, cat, 'skipped', 'No estimate', { jobElo })] };
  if (jobElo == null) return { status: 'skipped', stmts: [skipRow(env, cat, 'skipped', 'No difficulty set') ] };

  const { results: stages } = await env.DB.prepare(
    "SELECT issue_id FROM completed_jobs WHERE parent_id = ? AND kind = 'stage'"
  ).bind(cat.issue_id).all();
  const seconds = new Map();
  const days = new Map();
  let total = 0;
  for (const issueId of [cat.issue_id, ...stages.map((s) => s.issue_id)]) {
    for (const wl of await worklogsFor(env, issueId)) {
      if (!wl.accountId || !wl.seconds) continue;
      seconds.set(wl.accountId, (seconds.get(wl.accountId) || 0) + wl.seconds);
      if (!days.has(wl.accountId)) days.set(wl.accountId, []);
      days.get(wl.accountId).push([wl.startDate, wl.seconds]);
      total += wl.seconds;
    }
  }

  // Jira's total was read when the category closed; Tempo has anything logged since.
  const actual = Math.max(cat.actual_seconds || 0, total);
  cat = { ...cat, actual_seconds: actual };
  if (!actual) return { status: 'skipped', stmts: [skipRow(env, cat, 'skipped', 'No time logged', { jobElo })] };
  const ratio = actual / cat.estimate_seconds;
  const rated = [...seconds].filter(([id]) => employees.get(id)?.active);
  if (!total || !rated.length) {
    return { status: 'skipped', stmts: [skipRow(env, cat, 'skipped', 'Nobody with a profile logged time on it', { jobElo, ratio })] };
  }

  const score = outcomeScore(cat.actual_seconds, cat.estimate_seconds);
  const weight = matchWeight(ratio);
  const now = new Date().toISOString();
  const stmts = [];
  let jobDelta = 0;
  const modifiers = await approvedFor(env, rated.map(([id]) => id));

  for (const [accountId, secs] of rated) {
    const emp = employees.get(accountId);
    const before = emp.elo ?? DEFAULT_ELO;
    const share = secs / total;
    const expected = expectedScore(before, jobElo);
    const k = (counts.get(accountId) || 0) < PROVISIONAL_MATCHES ? PROVISIONAL_K : K_FACTOR;
    // Time logged while an approved modifier applied counts for less, both ways.
    const mods = modifiers.get(accountId) || [];
    const factor = mods.length
      ? days.get(accountId).reduce((a, [date, s]) => a + s * factorOn(mods, date), 0) / secs
      : 1;
    const delta = round1(k * weight * factor * share * (score - expected));
    jobDelta -= delta;
    emp.elo = before + delta;
    counts.set(accountId, (counts.get(accountId) || 0) + 1);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO elo_events (account_id, category_id, kind, seconds, share, expected, score, k, weight, delta,
           elo_before, elo_after, modifier_factor, created_at) VALUES (?, ?, 'match', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(accountId, cat.issue_id, secs, share, expected, score, k, weight, delta, before, before + delta,
        factor < 1 ? factor : null, now),
      env.DB.prepare('UPDATE employees SET elo = COALESCE(elo, ?) + ?, updated_at = ? WHERE account_id = ?')
        .bind(DEFAULT_ELO, delta, now, accountId),
    );
  }

  stmts.unshift(env.DB.prepare(
    `INSERT INTO elo_matches (category_id, issue_key, epic_key, summary, discipline, done_date, status, job_elo,
       job_elo_after, estimate_seconds, actual_seconds, ratio, score, weight, people, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'rated', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(cat.issue_id, cat.issue_key, cat.epic_key, cat.summary, cat.discipline, cat.done_date, jobElo,
    round1(jobElo + jobDelta), cat.estimate_seconds, cat.actual_seconds, ratio, score, weight, rated.length, now));
  return { status: 'rated', stmts };
}

// Rates the next few finished categories, oldest first.
export async function rateStep(env, { limit = STEP_SIZE, worklogsFor } = {}) {
  const from = await getState(env, 'elo_from');
  if (!from) return { skipped: 'The ELO engine is off' };
  const lock = Number((await getState(env, 'elo_lock')) || 0);
  if (Date.now() - lock < LOCK_MS) return { skipped: 'Already running' };
  await setState(env, 'elo_lock', Date.now());

  try {
    const settled = londonDate(Date.now() - SETTLE_DAYS * 86_400_000);
    const { results: cats } = await env.DB.prepare(
      `SELECT c.* FROM completed_jobs c LEFT JOIN elo_matches m ON m.category_id = c.issue_id
        WHERE c.kind = 'category' AND m.category_id IS NULL AND c.done_date >= ? AND c.done_date <= ?
        ORDER BY c.done_date, c.issue_id LIMIT ?`
    ).bind(from, settled, limit).all();
    if (!cats.length) return { rated: 0, skipped: 0 };

    const { results: emps } = await env.DB.prepare('SELECT account_id, elo, active FROM employees').all();
    const employees = new Map(emps.map((e) => [e.account_id, e]));
    const counts = await ratedCounts(env);
    let rated = 0, skipped = 0;
    for (const cat of cats) {
      // A Tempo failure leaves the category waiting, to be tried again next run.
      const result = await rateCategory(env, cat, { employees, counts, worklogsFor });
      await env.DB.batch(result.stmts);
      if (result.status === 'rated') rated++; else skipped++;
    }
    return { rated, skipped };
  } finally {
    await setState(env, 'elo_lock', 0);
  }
}

export async function startEngine(env, from) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) throw new Error('Choose the date to rate finished jobs from.');
  if (from > londonDate()) throw new Error('That date is in the future.');
  // Refreshing from DNM would overwrite the ratings the engine sets.
  if (((await getState(env, 'employees_source')) || 'jira') !== 'hub') {
    throw new Error('Employees are still read from Jira. Switch them to the hub first.');
  }
  const ledgerStart = await getState(env, 'ledger_start');
  await setState(env, 'elo_from', from);
  await freezeWeek(env, { force: true });
  return { from, ledgerStart };
}

export async function stopEngine(env) {
  await setState(env, 'elo_from', '');
  return { stopped: true };
}

// The XP rate uses each person's ELO as it stood on Monday morning, so a job
// finishing mid-week never changes what the rest of that week's time earns.
export async function freezeWeek(env, { force = false } = {}) {
  const monday = mondayOf(londonDate());
  if (!force && (await getState(env, 'elo_week_of')) === monday) return { skipped: 'Already frozen this week' };
  await env.DB.prepare('UPDATE employees SET elo_week = COALESCE(elo, ?), condor_elo_week = COALESCE(condor_elo, ?)').bind(DEFAULT_ELO, DEFAULT_ELO).run();
  await setState(env, 'elo_week_of', monday);
  return { week: monday };
}

// Highest rating reached in the last three months, which is what rank shows,
// so one hard job never costs anyone their rank.
export async function peakElos(env, accountIds = null) {
  const since = new Date(Date.now() - PEAK_DAYS * 86_400_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT account_id, MAX(elo_after) AS peak FROM elo_events
      WHERE created_at >= ? AND reversed_at IS NULL AND kind != 'reversal' GROUP BY account_id`
  ).bind(since).all();
  const map = new Map(results.map((r) => [r.account_id, r.peak]));
  if (accountIds) for (const id of accountIds) if (!map.has(id)) map.set(id, null);
  return map;
}

export function rankWithPeak(elo, peak) {
  const current = elo ?? null;
  if (current == null && peak == null) return null;
  const best = Math.max(current ?? -Infinity, peak ?? -Infinity);
  const rank = rankFor(best);
  const held = current == null || rankFor(current).name !== rank.name;
  return { ...rank, heldFrom: held ? best : null };
}

export async function history(env, accountId, viewer = null) {
  const emp = await env.DB.prepare('SELECT account_id, name, elo, manager_id, teams, team FROM employees WHERE account_id = ?').bind(accountId).first();
  if (!emp) return null;
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.kind, e.seconds, e.share, e.expected, e.score, e.k, e.weight, e.delta, e.elo_before, e.elo_after,
            e.reverses_id, e.reversed_at, e.note, e.created_at, e.modifier_factor,
            m.issue_key, m.epic_key, m.summary, m.discipline, m.done_date, m.job_elo, m.estimate_seconds, m.actual_seconds
       FROM elo_events e LEFT JOIN elo_matches m ON m.category_id = e.category_id
      WHERE e.account_id = ? ORDER BY e.id`
  ).bind(accountId).all();
  const peak = (await peakElos(env)).get(accountId) ?? null;
  // Only the person, their supervisor and admins see that a modifier applied.
  const seesModifiers = !viewer || viewer.accountId === accountId || managesPerson(viewer, emp);
  if (!seesModifiers) for (const e of results) e.modifier_factor = null;
  return {
    elo: emp.elo,
    start: results[0]?.elo_before ?? emp.elo ?? DEFAULT_ELO,
    rank: rankWithPeak(emp.elo ?? DEFAULT_ELO, peak),
    events: results,
  };
}

export async function reverseEvent(env, viewer, id) {
  const event = await env.DB.prepare('SELECT * FROM elo_events WHERE id = ?').bind(Number(id)).first();
  if (!event) throw new Error('That rating change has gone.');
  if (event.kind !== 'match') throw new Error('Only job ratings can be undone.');
  if (event.reversed_at) throw new Error('That one has already been undone.');
  const emp = await env.DB.prepare('SELECT elo FROM employees WHERE account_id = ?').bind(event.account_id).first();
  const before = emp?.elo ?? DEFAULT_ELO;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE elo_events SET reversed_at = ?, reversed_by = ? WHERE id = ? AND reversed_at IS NULL')
      .bind(now, viewer.email, event.id),
    env.DB.prepare(
      `INSERT INTO elo_events (account_id, category_id, kind, delta, elo_before, elo_after, reverses_id, note, created_at)
       VALUES (?, ?, 'reversal', ?, ?, ?, ?, ?, ?)`
    ).bind(event.account_id, event.category_id, -event.delta, before, before - event.delta, event.id,
      `Undone by ${viewer.email}`, now),
    env.DB.prepare('UPDATE employees SET elo = COALESCE(elo, ?) - ? WHERE account_id = ?')
      .bind(DEFAULT_ELO, event.delta, event.account_id),
    env.DB.prepare('UPDATE elo_matches SET job_elo_after = job_elo_after + ? WHERE category_id = ?')
      .bind(event.delta, event.category_id),
  ]);
  return { ok: true, elo: before - event.delta };
}

export async function status(env) {
  const [from, weekOf, counts, recent, waiting] = await Promise.all([
    getState(env, 'elo_from'),
    getState(env, 'elo_week_of'),
    env.DB.prepare("SELECT status, reason, COUNT(*) AS n FROM elo_matches GROUP BY status, reason").all(),
    env.DB.prepare(
      `SELECT category_id, issue_key, epic_key, summary, discipline, done_date, status, reason, job_elo, job_elo_after,
              estimate_seconds, actual_seconds, ratio, score, people
         FROM elo_matches ORDER BY done_date DESC, created_at DESC LIMIT 25`
    ).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM completed_jobs c LEFT JOIN elo_matches m ON m.category_id = c.issue_id
        WHERE c.kind = 'category' AND m.category_id IS NULL AND c.done_date >= ?`
    ).bind((await getState(env, 'elo_from')) || '9999').first(),
  ]);
  return {
    from: from || null,
    weekOf,
    rated: counts.results.filter((r) => r.status === 'rated').reduce((a, r) => a + r.n, 0),
    skipped: counts.results.filter((r) => r.status === 'skipped').map((r) => ({ reason: r.reason, n: r.n })),
    waiting: waiting?.n || 0,
    recent: recent.results,
  };
}
