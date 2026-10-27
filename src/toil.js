// Time off in lieu. Each person has a running overtime balance: time logged over
// their contracted hours adds to it, and a working day short of the daily share of
// those hours takes the difference off. Time logged to the TOIL item (PMB-25) is
// time off being taken, so it doesn't count as worked and comes off the balance.
//
// The balance runs from when they started logging consistently: the working day
// after the latest working day, before this week, with nothing logged at all.
// Admins can add or take off hours, to bring in balances kept elsewhere or put one right.
import { getIssue } from './jira.js';
import { getState, setState, londonDate } from './sync.js';
import { weekHoursOf, workDaysOf, weekdayOf } from './hours.js';
import { record } from './audit.js';

export const TOIL_KEY = 'PMB-25';
const DAY_MS = 86_400_000;
const LOOK_BACK_DAYS = 3 * 366;
const MAX_ADJUST_HOURS = 1000;

const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const mondayOfDay = (iso) => addDays(iso, -((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7));
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });

// The TOIL item's Jira ID, looked up once.
export async function toilIssueId(env) {
  const saved = await getState(env, 'toil_issue_id');
  if (saved) return saved;
  const cached = await env.DB.prepare('SELECT issue_id FROM jobs WHERE issue_key = ?').bind(TOIL_KEY).first().catch(() => null);
  let id = cached?.issue_id || null;
  if (!id) id = (await getIssue(env, TOIL_KEY, ['summary']).catch(() => null))?.id || null;
  if (id) await setState(env, 'toil_issue_id', String(id));
  return id ? String(id) : null;
}

export const dailySecondsOf = (emp) => Math.round((weekHoursOf(emp) * 3600) / workDaysOf(emp?.work_days).length);

// One day's effect on the balance. Today only counts once it's over the day's
// share, so a day still being worked never takes anything off; TOIL taken today comes off straight away.
export function dayChange({ date, total, toil, workDay, daily, today }) {
  const worked = total - toil;
  if (!workDay) return worked - toil;
  if (date < today) return worked - daily;
  return total >= daily ? worked - daily : 0 - toil;
}

// Where the balance starts: the working day after the latest working day, before
// this week, with no time logged at all.
export function startOf({ days, workDays, floor, today }) {
  const monday = mondayOfDay(today);
  for (let d = addDays(monday, -1), n = 0; d >= floor && n < LOOK_BACK_DAYS; d = addDays(d, -1), n++) {
    if (workDays.includes(weekdayOf(d)) && !(days.get(d)?.total > 0)) return addDays(d, 1);
  }
  return floor;
}

export async function balanceFor(env, emp, { today = londonDate(), toilId } = {}) {
  if (!emp?.account_id) return null;
  const ledgerStart = (await getState(env, 'ledger_start')) || addDays(today, -LOOK_BACK_DAYS);
  const lookBack = addDays(today, -LOOK_BACK_DAYS);
  const floor = [ledgerStart, emp.start_date || '', lookBack].sort().pop();
  const id = toilId === undefined ? await toilIssueId(env) : toilId;
  const { results } = await env.DB.prepare(
    `SELECT work_date, SUM(seconds) AS total, SUM(CASE WHEN issue_id = ? THEN seconds ELSE 0 END) AS toil
       FROM xp_ledger WHERE account_id = ? AND work_date BETWEEN ? AND ? GROUP BY work_date`
  ).bind(id || '', emp.account_id, floor, today).all();
  const days = new Map(results.map((r) => [r.work_date, { total: r.total || 0, toil: r.toil || 0 }]));
  const workDays = workDaysOf(emp.work_days);
  const daily = dailySecondsOf(emp);
  const start = startOf({ days, workDays, floor, today });

  const weeks = new Map();
  let worked = 0;
  let taken = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const day = days.get(d) || { total: 0, toil: 0 };
    const change = dayChange({ date: d, total: day.total, toil: day.toil, workDay: workDays.includes(weekdayOf(d)), daily, today });
    const monday = mondayOfDay(d);
    const w = weeks.get(monday) || { monday, logged: 0, toil: 0, change: 0 };
    w.logged += day.total; w.toil += day.toil; w.change += change;
    weeks.set(monday, w);
    worked += change + day.toil;
    taken += day.toil;
  }
  const { results: adjustments } = await env.DB.prepare(
    'SELECT id, seconds, effective_date, note, created_by_name, created_at FROM toil_adjustments WHERE account_id = ? ORDER BY effective_date DESC, id DESC'
  ).bind(emp.account_id).all().catch(() => ({ results: [] }));
  // Adjustments made before the balance's start went with the time before it.
  const counted = adjustments.filter((a) => a.effective_date >= start);
  const adjusted = counted.reduce((t, a) => t + a.seconds, 0);
  return {
    start, today, dailySeconds: daily, weekSeconds: Math.round(weekHoursOf(emp) * 3600), workDays,
    seconds: worked - taken + adjusted, overtimeSeconds: worked, toilSeconds: taken, adjustedSeconds: adjusted,
    weeks: [...weeks.values()].reverse(),
    adjustments: adjustments.map((a) => ({ id: a.id, seconds: a.seconds, date: a.effective_date, note: a.note, by: a.created_by_name, at: a.created_at, counted: a.effective_date >= start })),
    toilKey: TOIL_KEY,
  };
}

export async function mine(env, viewer) {
  const emp = await env.DB.prepare('SELECT * FROM employees WHERE account_id = ?').bind(viewer.accountId || '').first();
  if (!emp) return { linked: false };
  return { linked: true, ...(await balanceFor(env, emp)) };
}

// ---------- for admins ----------

export async function overview(env) {
  const { results } = await env.DB.prepare("SELECT * FROM employees WHERE active = 1 AND account_id NOT LIKE 'pending%' ORDER BY name").all();
  const toilId = await toilIssueId(env);
  const today = londonDate();
  const people = [];
  for (const e of results) {
    const b = await balanceFor(env, e, { today, toilId });
    people.push({ accountId: e.account_id, name: e.name, seconds: b.seconds, start: b.start, toilSeconds: b.toilSeconds, adjustedSeconds: b.adjustedSeconds });
  }
  return { people, toilKey: TOIL_KEY };
}

export async function personFor(env, accountId) {
  const emp = await env.DB.prepare('SELECT * FROM employees WHERE account_id = ?').bind(String(accountId || '')).first();
  if (!emp) throw refuse('That person isn\'t in the hub.', 404);
  return { name: emp.name, accountId: emp.account_id, ...(await balanceFor(env, emp)) };
}

export async function adjust(env, viewer, { accountId, hours, note, date }) {
  const emp = await env.DB.prepare('SELECT * FROM employees WHERE account_id = ?').bind(String(accountId || '')).first();
  if (!emp) throw refuse('That person isn\'t in the hub.', 404);
  const h = Number(hours);
  if (!Number.isFinite(h) || h === 0 || Math.abs(h) > MAX_ADJUST_HOURS) throw refuse('Give the hours to add, or a minus number to take off.');
  const seconds = Math.round(h * 3600);
  const text = String(note || '').trim().slice(0, 300);
  if (text.length < 3) throw refuse('Say what the adjustment is for.');
  const today = londonDate();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : today;
  if (day > today) throw refuse('The date can\'t be in the future.');
  await env.DB.prepare(
    'INSERT INTO toil_adjustments (account_id, seconds, effective_date, note, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(emp.account_id, seconds, day, text, viewer.email, viewer.employee?.name || viewer.email, new Date().toISOString()).run();
  await record(env, viewer, { area: 'TOIL', action: seconds > 0 ? 'added overtime' : 'took off overtime', subjectType: 'employee', subjectId: emp.account_id, label: emp.name,
    changes: [{ label: 'Hours', before: '', after: `${h > 0 ? '+' : ''}${h}` }], note: text }).catch(() => {});
  return personFor(env, emp.account_id);
}

export async function removeAdjustment(env, viewer, id) {
  const a = await env.DB.prepare('SELECT * FROM toil_adjustments WHERE id = ?').bind(Number(id)).first();
  if (!a) throw refuse('That adjustment has gone.', 404);
  await env.DB.prepare('DELETE FROM toil_adjustments WHERE id = ?').bind(a.id).run();
  const emp = await env.DB.prepare('SELECT name FROM employees WHERE account_id = ?').bind(a.account_id).first();
  await record(env, viewer, { area: 'TOIL', action: 'removed an adjustment', subjectType: 'employee', subjectId: a.account_id, label: emp?.name || a.account_id,
    changes: [{ label: 'Hours', before: String(a.seconds / 3600), after: '' }], note: a.note }).catch(() => {});
  return personFor(env, a.account_id);
}
