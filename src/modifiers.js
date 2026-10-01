// Modifiers let a supervisor agree that something is making work harder for a
// while, so ELO counts that time for less. No details are recorded beyond the
// kind; the conversation belongs between the person and their supervisor.
import { raiseAlert, sendAlerts, londonDate } from './sync.js';

// How much a job still counts while each applies: 1 is fully, 0 not at all.
export const MODIFIERS = {
  'Supporting apprentices': 0.6,
  'Training someone': 0.6,
  'Covering for absence': 0.5,
  'Learning on the job': 0.5,
  'Heavy workload': 0.75,
  'Unwell': 0.25,
  'Personal circumstances': 0.5,
};

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function factorOn(mods, date) {
  let factor = 1;
  for (const m of mods) {
    if (m.status !== 'approved' || date < m.start_date || (m.end_date && date > m.end_date)) continue;
    factor = Math.min(factor, MODIFIERS[m.kind] ?? 1);
  }
  return factor;
}

export async function approvedFor(env, accountIds) {
  const map = new Map(accountIds.map((id) => [id, []]));
  if (!accountIds.length) return map;
  const { results } = await env.DB.prepare(
    `SELECT * FROM modifiers WHERE status = 'approved' AND account_id IN (${accountIds.map(() => '?').join(',')})`
  ).bind(...accountIds).all();
  for (const m of results) map.get(m.account_id)?.push(m);
  return map;
}

export async function mine(env, viewer) {
  if (!viewer.accountId) return { modifiers: [], kinds: Object.keys(MODIFIERS) };
  const { results } = await env.DB.prepare('SELECT * FROM modifiers WHERE account_id = ? ORDER BY id DESC LIMIT 30')
    .bind(viewer.accountId).all();
  const emp = await env.DB.prepare('SELECT m.name FROM employees e LEFT JOIN employees m ON m.account_id = e.manager_id WHERE e.account_id = ?')
    .bind(viewer.accountId).first();
  return { modifiers: results, kinds: Object.keys(MODIFIERS), supervisor: emp?.name || null };
}

export async function request(env, viewer, input) {
  if (!viewer.accountId) throw new Error('Your account isn\'t linked to a profile yet.');
  if (!(input.kind in MODIFIERS)) throw new Error('Choose what applies.');
  const today = londonDate();
  const from = isDate(input.from) ? input.from : today;
  if (from < addDays(today, -30)) throw new Error('It can start up to 30 days ago.');
  if (from > addDays(today, 60)) throw new Error('It can start up to 60 days ahead.');
  const until = isDate(input.until) ? input.until : null;
  if (until && until < from) throw new Error('The end date is before the start.');

  const emp = await env.DB.prepare('SELECT name, manager_id FROM employees WHERE account_id = ?').bind(viewer.accountId).first();
  const manager = emp?.manager_id
    ? await env.DB.prepare('SELECT account_id, email, name FROM employees WHERE account_id = ? AND active = 1').bind(emp.manager_id).first()
    : null;
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO modifiers (account_id, kind, start_date, end_date, status, manager_id, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(viewer.accountId, input.kind, from, until, manager?.account_id || null, now).run();

  // The email names no circumstances; the supervisor sees them in the hub.
  await raiseAlert(env, {
    kind: 'modifier',
    dedupe: `modifier:${res.meta?.last_row_id ?? `${viewer.accountId}:${now}`}`,
    subject: `${emp?.name || viewer.email} has asked for something to be taken into account`,
    body: `${emp?.name || viewer.email} has asked for something to be taken into account in how their jobs count towards ELO.\n\n`
      + 'Open Jobs in the hub to see it and approve it. It may be a good moment to check in with them and see whether they need any support.',
    recipient: manager?.email || null,
  });
  await sendAlerts(env).catch(() => {});
  return { ok: true, supervisor: manager?.name || null };
}

const canDecide = (viewer, m) => m.account_id !== viewer.accountId && (viewer.isAdmin || m.manager_id === viewer.accountId);

export async function pending(env, viewer) {
  if (!viewer.accountId && !viewer.isAdmin) return [];
  const { results } = await env.DB.prepare(
    `SELECT m.*, e.name FROM modifiers m LEFT JOIN employees e ON e.account_id = m.account_id
      WHERE m.status = 'pending' ORDER BY m.id`
  ).all();
  return results.filter((m) => canDecide(viewer, m));
}

// Approved modifiers for the people this viewer supervises.
export async function supervised(env, viewer) {
  if (!viewer.accountId && !viewer.isAdmin) return [];
  const { results } = await env.DB.prepare(
    `SELECT m.*, e.name FROM modifiers m LEFT JOIN employees e ON e.account_id = m.account_id
      WHERE m.status = 'approved' AND (m.end_date IS NULL OR m.end_date >= ?) ORDER BY e.name`
  ).bind(londonDate()).all();
  return results.filter((m) => canDecide(viewer, m));
}

export async function decide(env, viewer, input) {
  const m = await env.DB.prepare('SELECT * FROM modifiers WHERE id = ?').bind(Number(input.id)).first();
  if (!m) throw new Error('That request has gone.');
  if (!canDecide(viewer, m)) throw new Error('Only their supervisor or an admin can decide this.');
  if (m.status !== 'pending') throw new Error('That has already been decided.');
  const status = input.decision === 'approve' ? 'approved' : input.decision === 'decline' ? 'declined' : null;
  if (!status) throw new Error('Approve or decline it.');
  await env.DB.prepare('UPDATE modifiers SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
    .bind(status, viewer.email, new Date().toISOString(), m.id).run();
  return { ok: true, status };
}

export async function end(env, viewer, id) {
  const m = await env.DB.prepare('SELECT * FROM modifiers WHERE id = ?').bind(Number(id)).first();
  if (!m || !(m.account_id === viewer.accountId || canDecide(viewer, m))) throw new Error('That isn\'t yours to change.');
  const today = londonDate();
  if (m.status === 'pending') {
    await env.DB.prepare("UPDATE modifiers SET status = 'withdrawn' WHERE id = ?").bind(m.id).run();
  } else if (m.status === 'approved') {
    // Ending before it started removes it altogether.
    const endDate = today < m.start_date ? null : today;
    await env.DB.prepare('UPDATE modifiers SET status = ?, end_date = ? WHERE id = ?')
      .bind(endDate ? 'approved' : 'withdrawn', endDate ?? m.end_date, m.id).run();
  } else {
    throw new Error('That has already finished.');
  }
  return { ok: true };
}
