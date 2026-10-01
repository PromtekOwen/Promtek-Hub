// Employees live here now, rather than as issues in the DNM project. Everything
// the other apps need about a person is on this record.
import { progressFor, rankFor } from './progression.js';
import { getState, setState } from './sync.js';

// Small badges that appear on someone's nameplate on the company chart.
export const ICONS = [
  ['star', 'Star'], ['spanner', 'Engineer'], ['laptop', 'Developer'], ['headset', 'Support'],
  ['chart', 'Analyst'], ['shield', 'Compliance'], ['cap', 'Apprentice'], ['van', 'Field'],
  ['phone', 'On call'], ['first-aid', 'First aider'], ['fire', 'Fire marshal'], ['leaf', 'Sustainability'],
];

export const DEFAULT_XP_RATE = 75;      // non-engineers; engineers are usually higher

const newLocalId = () => `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const clean = (value, max = 160) => (value === undefined || value === null ? null : String(value).trim().slice(0, max) || null);

export async function listPeople(env, { includeInactive = true } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT e.*, COALESCE(SUM(l.xp), 0) AS ledger_xp, COUNT(l.worklog_id) AS worklogs
       FROM employees e LEFT JOIN xp_ledger l ON l.account_id = e.account_id
      ${includeInactive ? '' : 'WHERE e.active = 1'}
      GROUP BY e.account_id ORDER BY e.active DESC, e.name`
  ).all();

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
        jobTitle: e.job_title,
        department: e.department,
        managerId: e.manager_id,
        order: e.org_order,
        role: e.role,
        team: e.team,
        extension: e.extension,
        xpRate: e.baseline,
        elo: e.elo,
        rank: rankFor(e.elo),
        xp,
        level: progress.level,
        title: progress.title,
        worklogs: e.worklogs,
        icons: e.icons ? JSON.parse(e.icons) : [],
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

  const icons = JSON.stringify((person.icons || []).filter((id) => ICONS.some(([key]) => key === id)).slice(0, 6));
  const now = new Date().toISOString();
  const accountId = clean(person.accountId, 128) || newLocalId();

  if (person.managerId === accountId) throw new Error('Nobody reports to themselves.');

  const existing = await env.DB.prepare('SELECT account_id FROM employees WHERE account_id = ?').bind(accountId).first();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO employees (account_id, name, email, pronouns, job_title, department, manager_id, org_order,
         role, team, extension, baseline, elo, icons, notes, jira_xp, opening_xp, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?)`
    ).bind(accountId, name, clean(person.email), clean(person.pronouns, 40), clean(person.jobTitle, 120),
      clean(person.department, 40), clean(person.managerId, 128), Number(person.order) || 50,
      ['engineer', 'lead', 'admin'].includes(person.role) ? person.role : 'engineer',
      clean(person.team, 40), clean(person.extension, 20),
      Number(person.xpRate) || DEFAULT_XP_RATE, Number(person.elo) || null, icons, clean(person.notes, 500), now).run();
    return { accountId, created: true };
  }

  await env.DB.prepare(
    `UPDATE employees SET name = ?, email = ?, pronouns = ?, job_title = ?, department = ?, manager_id = ?,
       org_order = ?, role = ?, team = ?, extension = ?, baseline = ?, elo = ?, icons = ?, notes = ?,
       active = ?, updated_at = ? WHERE account_id = ?`
  ).bind(name, clean(person.email), clean(person.pronouns, 40), clean(person.jobTitle, 120),
    clean(person.department, 40), clean(person.managerId, 128), Number(person.order) || 50,
    ['engineer', 'lead', 'admin'].includes(person.role) ? person.role : 'engineer',
    clean(person.team, 40), clean(person.extension, 20),
    Number(person.xpRate) || DEFAULT_XP_RATE, person.elo === '' || person.elo === null ? null : Number(person.elo),
    icons, clean(person.notes, 500), person.active === false ? 0 : 1, now, accountId).run();
  return { accountId, created: false };
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
  return { ok: true, kept: false };
}

// Once this is switched to the hub, nothing reads the DNM project again.
export async function setSource(env, source) {
  if (!['jira', 'hub'].includes(source)) throw new Error('Unknown source.');
  await setState(env, 'employees_source', source);
  return { source };
}
