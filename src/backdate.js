// Sets the date XP counts from, so all XP comes from Tempo time logged since then.
// XP carried over from before the hub is replaced. An earlier date has Tempo read a
// few days per scheduled run, up to the day before the old start; a later one drops
// the time before it straight away. Weekly history is rebuilt either way.
import { getState, setState, londonDate, ledgerChanged, processWorklogs, mondayOf } from './sync.js';
import { fetchWorklogs } from './tempo.js';
import { levelFromXp } from './progression.js';

const KEY = 'xp_backdate';
export const DAYS_PER_RUN = 3;
const DAY_MS = 86_400_000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);

async function job(env) {
  try { return JSON.parse((await getState(env, KEY)) || 'null'); } catch { return null; }
}
const save = (env, j) => setState(env, KEY, JSON.stringify(j));

export async function status(env) {
  const [ledgerStart, j, opening] = await Promise.all([
    getState(env, 'ledger_start'),
    job(env),
    env.DB.prepare('SELECT COUNT(*) AS people, COALESCE(SUM(opening_xp), 0) AS xp FROM employees WHERE opening_xp > 0').first(),
  ]);
  const days = j ? Math.max(0, daysBetween(j.from, j.until) + 1) : 0;
  const progress = j ? { ...j, days, daysDone: j.done ? days : Math.max(0, daysBetween(j.from, j.next)) } : null;
  return { ledgerStart, job: progress, opening: { people: opening?.people || 0, xp: opening?.xp || 0 } };
}

export async function start(env, { from, by = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) throw new Error('Choose the date for XP to run from.');
  const ledgerStart = await getState(env, 'ledger_start');
  if (!ledgerStart) throw new Error('The ledger hasn\'t started yet.');
  const current = await job(env);
  if (current && !current.done) throw new Error(`XP is already being backdated to ${current.from}.`);
  if (from > londonDate()) throw new Error('That date is in the future.');
  const opening = await env.DB.prepare('SELECT COALESCE(SUM(opening_xp), 0) AS xp FROM employees').first();
  const cleared = opening?.xp || 0;
  if (from === ledgerStart && !cleared) throw new Error(`XP already runs from ${ledgerStart}, all from Tempo.`);

  // All XP comes from Tempo, so whatever was carried over goes.
  if (cleared) await env.DB.prepare('UPDATE employees SET opening_xp = 0 WHERE opening_xp <> 0').run();
  const base = { from, previousStart: ledgerStart, clearedOpening: cleared, logs: 0, startedAt: new Date().toISOString(), by };

  if (from >= ledgerStart) {
    // Nothing to read: time before the new start no longer counts.
    const out = await env.DB.batch([
      env.DB.prepare('DELETE FROM xp_ledger WHERE work_date < ?').bind(from),
      env.DB.prepare('DELETE FROM unmatched_worklogs WHERE work_date < ?').bind(from),
      env.DB.prepare('DELETE FROM weekly_snapshots WHERE week_start < ?').bind(mondayOf(from)),
    ]);
    await setState(env, 'ledger_start', from);
    await rebuildSnapshots(env, from);
    await save(env, { ...base, until: addDays(from, -1), next: from, removed: out[0].meta?.changes || 0, done: true, finishedAt: new Date().toISOString() });
    await ledgerChanged(env);
    return status(env);
  }

  await save(env, { ...base, until: addDays(ledgerStart, -1), next: from, done: false });
  // From now on, time from the new start counts as it's read.
  await setState(env, 'ledger_start', from);
  await ledgerChanged(env);
  return status(env);
}

// A few days of Tempo per scheduled run. Returns { idle: true } when there's nothing to do.
export async function step(env, { days = DAYS_PER_RUN } = {}) {
  const j = await job(env);
  if (!j || j.done) return { idle: true };
  for (let i = 0; i < days && j.next <= j.until; i++) {
    const wls = await fetchWorklogs(env, { from: j.next, to: j.next });
    await processWorklogs(env, wls, { backfill: true });
    j.logs += wls.length;
    j.next = addDays(j.next, 1);
    await save(env, j);
  }
  if (j.next > j.until) {
    await rebuildSnapshots(env, j.from);
    j.done = true;
    j.finishedAt = new Date().toISOString();
    await save(env, j);
    await ledgerChanged(env);
  }
  return { from: j.from, next: j.next, done: j.done, logs: j.logs };
}

// Every finished week from the new start gets its total again: opening XP plus
// everything logged up to its Sunday. Weeks with no record yet are added, without an
// ELO, since what it was then isn't known.
export async function rebuildSnapshots(env, from) {
  const lastMonday = addDays(mondayOf(londonDate()), -7);
  const firstMonday = mondayOf(from);
  if (firstMonday > lastMonday) return { weeks: 0 };
  const [{ results: people }, { results: days }, { results: snaps }] = await Promise.all([
    env.DB.prepare('SELECT account_id, opening_xp FROM employees').all(),
    env.DB.prepare(
      `SELECT account_id, work_date, SUM(xp) AS xp, SUM(seconds) AS seconds, COUNT(*) AS worklogs
         FROM xp_ledger WHERE work_date <= ? GROUP BY account_id, work_date ORDER BY work_date`
    ).bind(addDays(lastMonday, 6)).all(),
    env.DB.prepare('SELECT account_id, week_start, xp FROM weekly_snapshots WHERE week_start >= ?').bind(firstMonday).all(),
  ]);
  const have = new Map(snaps.map((s) => [`${s.account_id}|${s.week_start}`, s.xp]));
  const byPerson = new Map();
  for (const d of days) {
    if (!byPerson.has(d.account_id)) byPerson.set(d.account_id, []);
    byPerson.get(d.account_id).push(d);
  }
  const now = new Date().toISOString();
  const stmts = [];
  for (const p of people) {
    const list = byPerson.get(p.account_id) || [];
    let i = 0;
    let total = p.opening_xp || 0;
    for (let monday = firstMonday; monday <= lastMonday; monday = addDays(monday, 7)) {
      const sunday = addDays(monday, 6);
      // Everything before this week counts towards the running total too.
      while (i < list.length && list[i].work_date < monday) total += list[i++].xp;
      let seconds = 0, worklogs = 0, daysLogged = 0;
      while (i < list.length && list[i].work_date <= sunday) {
        total += list[i].xp; seconds += list[i].seconds; worklogs += list[i].worklogs; daysLogged++; i++;
      }
      const key = `${p.account_id}|${monday}`;
      if (have.has(key)) {
        if (have.get(key) !== total) {
          stmts.push(env.DB.prepare('UPDATE weekly_snapshots SET xp = ?, level = ? WHERE account_id = ? AND week_start = ?')
            .bind(total, levelFromXp(total), p.account_id, monday));
        }
      } else {
        stmts.push(env.DB.prepare(
          `INSERT INTO weekly_snapshots (account_id, week_start, xp, level, elo, seconds, worklogs, days_logged, avg_lag_days, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?) ON CONFLICT(account_id, week_start) DO NOTHING`
        ).bind(p.account_id, monday, total, levelFromXp(total), seconds, worklogs, daysLogged, now));
      }
    }
  }
  for (let k = 0; k < stmts.length; k += 50) await env.DB.batch(stmts.slice(k, k + 50));
  return { weeks: stmts.length };
}
