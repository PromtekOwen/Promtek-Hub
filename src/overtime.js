// Time logged beyond someone's contracted hours for the week earns 1.5x XP, and
// their team leads hear when they first go over. A week runs Monday to Sunday;
// the worklogs latest in the week are the ones over the line.
import { weekHoursOf } from './hours.js';
import { teamsOf, leadsOfTeam } from './permissions.js';

export const OVERTIME_MULTIPLIER = 1.5;
const DAY_MS = 86_400_000;

export const xpWith = (rate, seconds, overtime = 0) => {
  const ot = Math.max(0, Math.min(seconds, overtime || 0));
  return Math.round(rate * ((seconds - ot) + ot * OVERTIME_MULTIPLIER) / 60);
};

const londonDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(ms));
export const mondayOfDay = (iso) => {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return new Date(Date.parse(`${iso}T12:00:00Z`) - ((dow + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const hoursText = (s) => { const m = Math.round(s / 60); return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };

// Overtime is counted from the week it was switched on; earlier weeks keep the XP they had.
async function startWeek(env) {
  const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'overtime_from'").first();
  if (row?.value) return row.value;
  const monday = mondayOfDay(londonDay(Date.now()));
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('overtime_from', ?) ON CONFLICT(key) DO NOTHING").bind(monday).run();
  return (await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'overtime_from'").first())?.value || monday;
}

// weeks: [{ accountId, monday }]. Works out each week's overtime afresh and
// rewrites only the worklogs whose share or XP changed.
export async function applyOvertime(env, weeks) {
  const from = await startWeek(env);
  const seen = new Set();
  let changed = 0;
  const thisMonday = mondayOfDay(londonDay(Date.now()));
  for (const w of weeks) {
    const k = `${w.accountId}|${w.monday}`;
    if (!w.accountId || !w.monday || w.monday < from || seen.has(k)) continue;
    seen.add(k);
    const emp = await env.DB.prepare('SELECT * FROM employees WHERE account_id = ?').bind(w.accountId).first();
    if (!emp) continue;
    const limit = weekHoursOf(emp) * 3600;
    const { results } = await env.DB.prepare(
      `SELECT worklog_id, seconds, rate, xp, overtime_seconds FROM xp_ledger WHERE account_id = ? AND work_date BETWEEN ? AND ?
        ORDER BY work_date, COALESCE(start_time, '99:99'), logged_at, worklog_id`
    ).bind(w.accountId, w.monday, addDays(w.monday, 6)).all();
    let total = 0;
    const stmts = [];
    for (const r of results) {
      const before = total;
      total += r.seconds;
      const ot = Math.max(0, total - Math.max(limit, before));
      const xp = xpWith(r.rate, r.seconds, ot);
      if (ot !== (r.overtime_seconds || 0) || xp !== r.xp) {
        stmts.push(env.DB.prepare('UPDATE xp_ledger SET overtime_seconds = ?, xp = ? WHERE worklog_id = ?').bind(ot, xp, r.worklog_id));
      }
    }
    if (stmts.length) { await env.DB.batch(stmts); changed += stmts.length; }
    // Leads hear once a week, and only about this week or last.
    if (total > limit && w.monday >= addDays(thisMonday, -7)) await tellLeads(env, emp, w.monday, total, limit);
  }
  return { changed };
}

async function tellLeads(env, emp, monday, total, limit) {
  const leads = [];
  for (const team of teamsOf(emp)) for (const l of await leadsOfTeam(env, team)) if (l.account_id !== emp.account_id && !leads.some((x) => x.email === l.email)) leads.push(l);
  const to = leads.length ? leads.map((l) => l.email) : [null];
  const first = String(emp.name || 'Someone').split(' ')[0];
  for (const r of to) {
    await env.DB.prepare(
      `INSERT INTO alerts (kind, dedupe, subject, body, recipient, created_at) VALUES ('overtime', ?, ?, ?, ?, ?) ON CONFLICT(dedupe) DO NOTHING`
    ).bind(`overtime:${emp.account_id}:${monday}:${r || 'admins'}`, `${emp.name} has gone over their contracted hours`,
      `${emp.name} has logged ${hoursText(total)} for the week starting ${monday}, over their contracted ${hoursText(limit)}.`
      + `\n\nTime over their contracted hours earns ${first} 1.5x XP. The hub's home screen lists anyone in your team who is over this week.`,
      r, new Date().toISOString()).run();
  }
}

// Who in the teams this lead runs is over their contracted hours this week.
export async function overForLead(env, viewer, today) {
  const leads = viewer.leads || [];
  if (!leads.length) return [];
  const monday = mondayOfDay(today);
  const { results } = await env.DB.prepare(
    `SELECT e.account_id, e.name, e.teams, e.team, e.weekly_hours, SUM(l.seconds) AS seconds, SUM(l.overtime_seconds) AS ot
       FROM employees e JOIN xp_ledger l ON l.account_id = e.account_id AND l.work_date BETWEEN ? AND ?
      WHERE e.active = 1 AND e.account_id != ? GROUP BY e.account_id`
  ).bind(monday, today, viewer.accountId || '').all();
  return results.filter((e) => teamsOf(e).some((t) => leads.includes(t)) && e.seconds > weekHoursOf(e) * 3600)
    .map((e) => ({ accountId: e.account_id, name: e.name, seconds: e.seconds, limit: weekHoursOf(e) * 3600, monday }));
}

export { hoursText as overtimeHours };
