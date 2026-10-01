// Employees live here now, rather than as issues in the DNM project. Everything
// the other apps need about a person is on this record.
import { progressFor } from './progression.js';
import { peakElos, rankWithPeak } from './elo.js';
import { getState, setState } from './sync.js';

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
        jobTitle: e.job_title,
        department: e.department,
        managerId: e.manager_id,
        order: e.org_order,
        role: e.role,
        team: e.team,
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

  const icons = JSON.stringify((person.icons || []).filter((id) => ICONS.some(([key]) => key === id)).slice(0, 6));
  const now = new Date().toISOString();
  const accountId = clean(person.accountId, 128) || newLocalId();

  if (person.managerId === accountId) throw new Error('Nobody reports to themselves.');

  const existing = await env.DB.prepare('SELECT account_id FROM employees WHERE account_id = ?').bind(accountId).first();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO employees (account_id, name, email, pronouns, job_title, department, manager_id, org_order,
         role, team, extension, baseline, elo, icons, avatar, notes, jira_xp, opening_xp, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?)`
    ).bind(accountId, name, clean(person.email), clean(person.pronouns, 40), clean(person.jobTitle, 120),
      clean(person.department, 40), clean(person.managerId, 128), Number(person.order) || 50,
      ['engineer', 'lead', 'admin'].includes(person.role) ? person.role : 'engineer',
      clean(person.team, 40), clean(person.extension, 20),
      Number(person.xpRate) || DEFAULT_XP_RATE, Number(person.elo) || null, icons,
      cleanAvatar(person.avatar), clean(person.notes, 500), now).run();
    return { accountId, created: true };
  }

  await env.DB.prepare(
    `UPDATE employees SET name = ?, email = ?, pronouns = ?, job_title = ?, department = ?, manager_id = ?,
       org_order = ?, role = ?, team = ?, extension = ?, baseline = ?, icons = ?, avatar = ?,
       notes = ?, active = ?, updated_at = ? WHERE account_id = ?`
  ).bind(name, clean(person.email), clean(person.pronouns, 40), clean(person.jobTitle, 120),
    clean(person.department, 40), clean(person.managerId, 128), Number(person.order) || 50,
    ['engineer', 'lead', 'admin'].includes(person.role) ? person.role : 'engineer',
    clean(person.team, 40), clean(person.extension, 20),
    Number(person.xpRate) || DEFAULT_XP_RATE,
    icons, cleanAvatar(person.avatar), clean(person.notes, 500), person.active === false ? 0 : 1, now, accountId).run();

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
