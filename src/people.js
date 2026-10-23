// Employees live here now, rather than as issues in the DNM project. Everything
// the other apps need about a person is on this record.
import { cleanChart } from './org.js';
import { progressFor } from './progression.js';
import { peakElos, rankWithPeak } from './elo.js';
import { cleanAccess, groupsOf, teamsOf, leadOf } from './permissions.js';
import { getState, setState, ledgerChanged } from './sync.js';

// Badges mark the people to go to in an emergency, so they stand out on the
// chart. Ordinary job roles are covered by the job title.
export const ICONS = [
  ['first-aid', 'First aider'],
  ['mental-health', 'Mental health first aider'],
  ['fire', 'Fire marshal'],
  ['evacuation', 'Evacuation warden'],
  ['defib', 'Defibrillator trained'],
  ['safety', 'Health and safety trained'],
];

export const DEFAULT_XP_RATE = 60;      // engineers; admin staff are usually 75

const newLocalId = () => `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
// Avatars arrive as a small data URI from the browser, already resized.
function cleanAvatar(value) {
  if (!value) return null;
  const text = String(value);
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(text)) return null;
  if (text.length > 200_000) throw new Error('That picture is too big. Try a smaller one.');
  return text;
}

// A start date, for work anniversaries. Never in the future.
function startDateOf(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T12:00:00Z`))) throw new Error('The start date isn\'t a date.');
  if (v > new Date().toISOString().slice(0, 10)) throw new Error('The start date can\'t be in the future.');
  return v;
}
// Hours a week, if not the usual 37.5, and the days they work (1 Monday to 7 Sunday), if not Monday to Friday.
function hoursOf(value) {
  if (value === '' || value === null || value === undefined) return null;
  const h = Number(value);
  if (!Number.isFinite(h) || h <= 0 || h > 100) throw new Error('Contracted hours should be between 0 and 100 a week.');
  return h === 37.5 ? null : Math.round(h * 100) / 100;
}
function daysOf(value) {
  if (value === null || value === undefined) return null;
  const d = [...new Set(String(value).replace(/[^1-7]/g, ''))].sort().join('');
  if (!d) throw new Error('Pick at least one day they work.');
  return d === '12345' ? null : d;
}
async function saveHours(env, accountId, hours) {
  if (!hours) return;
  await env.DB.prepare('UPDATE employees SET weekly_hours = ?, work_days = ? WHERE account_id = ?').bind(hours.hours, hours.days, accountId).run();
  // This week's overtime follows the new hours straight away; earlier weeks keep theirs.
  try {
    const { applyOvertime, mondayOfDay } = await import('./overtime.js');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
    const r = await applyOvertime(env, [{ accountId, monday: mondayOfDay(today) }]);
    if (r.changed) await (await import('./sync.js')).ledgerChanged(env);
  } catch (err) { console.warn('Overtime not worked out:', err.message); }
}
async function saveChart(env, accountId, chart) {
  if (!chart) return;
  await env.DB.prepare(
    'UPDATE employees SET chart_level = ?, chart_group = ?, chart_covers = ?, chart_ceremonial = ?, chart_sa = ?, chart_roles = ? WHERE account_id = ?'
  ).bind(chart.chart_level, chart.chart_group, chart.chart_covers, chart.chart_ceremonial, chart.chart_sa, chart.chart_roles, accountId).run();
}
// Today's anniversaries are worked out once a day, so a changed start date shows straight away.
const forgetAnniversaries = (env) => env.DB.prepare("DELETE FROM sync_state WHERE key = 'memo:anniversaries'").run().catch(() => null);

const listOf = (v) => { try { const x = v ? JSON.parse(v) : []; return Array.isArray(x) ? x : []; } catch { return []; } };
const clean = (value, max = 160) => (value === undefined || value === null ? null : String(value).trim().slice(0, max) || null);

export async function listPeople(env, { includeInactive = true } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT e.*, COALESCE(SUM(l.xp), 0) AS ledger_xp, COUNT(l.worklog_id) AS worklogs
       FROM employees e LEFT JOIN xp_ledger l ON l.account_id = e.account_id
      ${includeInactive ? '' : 'WHERE e.active = 1'}
      GROUP BY e.account_id ORDER BY e.active DESC, e.name`
  ).all();

  const peaks = await peakElos(env);
  return {
    source: (await getState(env, 'employees_source')) || 'jira',
    people: results.map((e) => {
      const xp = (e.opening_xp || 0) + (e.ledger_xp || 0);
      const progress = progressFor(xp);
      return {
        accountId: e.account_id,
        name: e.name,
        email: e.email,
        pronouns: e.pronouns,
        startDate: e.start_date || '',
        weeklyHours: e.weekly_hours ?? null,
        chart: {
          level: e.chart_level || null, group: e.chart_group || null, covers: listOf(e.chart_covers),
          ceremonial: Boolean(e.chart_ceremonial), sa: Boolean(e.chart_sa), roles: listOf(e.chart_roles),
        },
        workDays: e.work_days || null,
        jobTitle: e.job_title,
        department: e.department,
        managerId: e.manager_id,
        order: e.org_order,
        role: e.role,
        team: e.team,
        groups: groupsOf(e),
        teams: teamsOf(e),
        leadOf: leadOf(e),
        extension: e.extension,
        xpRate: e.baseline,
        elo: e.elo == null ? null : Math.round(e.elo * 10) / 10,
        rank: rankWithPeak(e.elo, peaks.get(e.account_id) ?? null),
        xp,
        level: progress.level,
        title: progress.title,
        worklogs: e.worklogs,
        icons: e.icons ? JSON.parse(e.icons) : [],
        avatar: e.avatar || null,
        notes: e.notes,
        active: e.active !== 0,
        pending: String(e.account_id).startsWith('pending-'),
        profileKey: e.profile_key,
      };
    }),
  };
}

export async function savePerson(env, person) {
  const name = clean(person.name, 120);
  if (!name) throw new Error('A name is needed.');
  // Checked before anything is saved, so a mistake here saves nothing.
  const hours = person.weeklyHours !== undefined || person.workDays !== undefined
    ? { hours: hoursOf(person.weeklyHours), days: daysOf(person.workDays === undefined ? '12345' : person.workDays) } : null;
  const chart = person.chart ? cleanChart({
    chartLevel: person.chart.level, chartGroup: person.chart.group, chartCovers: person.chart.covers, chartCeremonial: person.chart.ceremonial,
    chartSa: person.chart.sa, chartRoles: person.chart.roles,
  }, clean(person.accountId, 128)) : null;

  const icons = JSON.stringify((person.icons || []).filter((id) => ICONS.some(([key]) => key === id)).slice(0, 6));
  const now = new Date().toISOString();
  const accountId = clean(person.accountId, 128) || newLocalId();

  if (person.managerId === accountId) throw new Error('Nobody reports to themselves.');
  // Groups and teams decide what someone can do; role and team are kept in step for older parts of the hub.
  const acc = cleanAccess(person.groups !== undefined ? person
    : { groups: groupsOf({ role: person.role, team: person.team }), teams: person.team ? [person.team] : [], leadOf: person.role === 'lead' && person.team ? [person.team] : [] });

  const existing = await env.DB.prepare('SELECT account_id FROM employees WHERE account_id = ?').bind(accountId).first();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO employees (account_id, name, email, pronouns, job_title, department, manager_id, org_order,
         role, team, groups, teams, lead_of, extension, baseline, elo, icons, avatar, notes, start_date, jira_xp, opening_xp, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?)`
    ).bind(accountId, name, clean(person.email), clean(person.pronouns, 40), clean(person.jobTitle, 120),
      clean(person.department, 40), clean(person.managerId, 128), Number(person.order) || 50,
      acc.role, acc.team, JSON.stringify(acc.groups), JSON.stringify(acc.teams), JSON.stringify(acc.lead), clean(person.extension, 20),
      Number(person.xpRate) || DEFAULT_XP_RATE, Number(person.elo) || null, icons,
      cleanAvatar(person.avatar), clean(person.notes, 500), startDateOf(person.startDate), now).run();
    await saveHours(env, accountId, hours);
    await saveChart(env, accountId, chart);
    await forgetAnniversaries(env);
    return { accountId, created: true };
  }

  await env.DB.prepare(
    `UPDATE employees SET name = ?, email = ?, pronouns = ?, job_title = ?, department = ?, manager_id = ?,
       org_order = ?, role = ?, team = ?, groups = ?, teams = ?, lead_of = ?, extension = ?, baseline = ?, icons = ?, avatar = ?,
       notes = ?, start_date = ?, active = ?, updated_at = ? WHERE account_id = ?`
  ).bind(name, clean(person.email), clean(person.pronouns, 40), clean(person.jobTitle, 120),
    clean(person.department, 40), clean(person.managerId, 128), Number(person.order) || 50,
    acc.role, acc.team, JSON.stringify(acc.groups), JSON.stringify(acc.teams), JSON.stringify(acc.lead), clean(person.extension, 20),
    Number(person.xpRate) || DEFAULT_XP_RATE,
    icons, cleanAvatar(person.avatar), clean(person.notes, 500), startDateOf(person.startDate), person.active === false ? 0 : 1, now, accountId).run();
  await saveHours(env, accountId, hours);
  await saveChart(env, accountId, chart);
  await forgetAnniversaries(env);

  const edited = person.eloLoaded === undefined || String(person.elo ?? '') !== String(person.eloLoaded ?? '');
  if (edited) await setEloByHand(env, accountId, person.elo === '' || person.elo === null ? null : Number(person.elo));
  return { accountId, created: false };
}

// A hand-set rating goes in the history like any other change.
async function setEloByHand(env, accountId, elo) {
  const current = await env.DB.prepare('SELECT elo FROM employees WHERE account_id = ?').bind(accountId).first();
  const before = current?.elo ?? null;
  if (elo === before || (elo != null && !Number.isFinite(elo))) return;
  const now = new Date().toISOString();
  const stmts = [env.DB.prepare('UPDATE employees SET elo = ?, updated_at = ? WHERE account_id = ?').bind(elo, now, accountId)];
  if (elo != null && before != null) {
    stmts.push(env.DB.prepare(
      `INSERT INTO elo_events (account_id, kind, delta, elo_before, elo_after, note, created_at)
       VALUES (?, 'adjustment', ?, ?, ?, 'Set by hand on the Admin page', ?)`
    ).bind(accountId, elo - before, before, elo, now));
  }
  await env.DB.batch(stmts);
}

// Someone added before their Atlassian account existed keeps their history
// when the real ID arrives.
export async function changeAccountId(env, { from, to }) {
  const target = clean(to, 128);
  if (!from || !target) throw new Error('Both the old and new IDs are needed.');
  if (from === target) return { ok: true };
  const clash = await env.DB.prepare('SELECT name FROM employees WHERE account_id = ?').bind(target).first();
  if (clash) throw new Error(`${clash.name} already uses that account ID.`);

  await env.DB.batch([
    env.DB.prepare('UPDATE employees SET account_id = ?, updated_at = ? WHERE account_id = ?').bind(target, new Date().toISOString(), from),
    env.DB.prepare('UPDATE employees SET manager_id = ? WHERE manager_id = ?').bind(target, from),
    env.DB.prepare('UPDATE xp_ledger SET account_id = ? WHERE account_id = ?').bind(target, from),
    env.DB.prepare('UPDATE weekly_snapshots SET account_id = ? WHERE account_id = ?').bind(target, from),
    env.DB.prepare('UPDATE unmatched_worklogs SET account_id = ? WHERE account_id = ?').bind(target, from),
    env.DB.prepare('UPDATE vehicle_bookings SET account_id = ? WHERE account_id = ?').bind(target, from),
    env.DB.prepare('UPDATE pow_forms SET account_id = ? WHERE account_id = ?').bind(target, from),
    env.DB.prepare('UPDATE obs_surveys SET account_id = ? WHERE account_id = ?').bind(target, from),
  ]);
  await ledgerChanged(env);
  return { ok: true };
}

export async function removePerson(env, { accountId, keepHistory = false }) {
  if (!accountId) throw new Error('Which person?');
  if (keepHistory) {
    await env.DB.prepare('UPDATE employees SET active = 0, updated_at = ? WHERE account_id = ?')
      .bind(new Date().toISOString(), accountId).run();
    return { ok: true, kept: true };
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE employees SET manager_id = NULL WHERE manager_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM xp_ledger WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM weekly_snapshots WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM unmatched_worklogs WHERE account_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM employees WHERE account_id = ?').bind(accountId),
  ]);
  await ledgerChanged(env);
  return { ok: true, kept: false };
}

// Once this is switched to the hub, nothing reads the DNM project again.
export async function setSource(env, source) {
  if (!['jira', 'hub'].includes(source)) throw new Error('Unknown source.');
  await setState(env, 'employees_source', source);
  return { source };
}
