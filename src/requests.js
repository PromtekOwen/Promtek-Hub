// Requests for new tiles, changes to tiles, and problems people spot. Everyone
// can send one and follow their own; developers see them all and answer them.
import { raiseAlert } from './sync.js';
import { groupsOf } from './permissions.js';

export const KINDS = { tile: 'A new tile', change: 'A change to a tile', problem: 'Something not working' };
export const STATUSES = { new: 'New', working: 'Working on it', complete: 'Complete', rejected: 'Not going ahead' };

const isDeveloper = (viewer) => Boolean(viewer.isAdmin || viewer.can?.developer);
const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

export async function list(env, viewer, { status = '' } = {}) {
  const dev = isDeveloper(viewer);
  const where = [], args = [];
  if (!dev) { where.push('email = ?'); args.push(viewer.email); }
  if (dev && status === 'open') where.push("status IN ('new', 'working')");
  else if (dev && STATUSES[status]) { where.push('status = ?'); args.push(status); }
  const { results } = await env.DB.prepare(
    `SELECT * FROM feature_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 300`
  ).bind(...args).all();
  const counts = dev ? Object.fromEntries((await env.DB.prepare('SELECT status, COUNT(*) AS n FROM feature_requests GROUP BY status').all()).results.map((r) => [r.status, r.n])) : null;
  return { requests: results, developer: dev, kinds: KINDS, statuses: STATUSES, counts };
}

async function developerEmails(env) {
  const { results } = await env.DB.prepare('SELECT * FROM employees WHERE active = 1 AND email IS NOT NULL').all();
  return results.filter((e) => groupsOf(e).includes('developer')).map((e) => e.email);
}

export async function create(env, viewer, input) {
  const kind = KINDS[input.kind] ? input.kind : null;
  if (!kind) throw new Error('Choose what kind of request this is.');
  const title = clean(input.title, 140);
  const details = clean(input.details, 5000);
  if (title.length < 4) throw new Error('Give it a short title.');
  if (details.length < 10) throw new Error('Say a bit more about it, so whoever picks it up knows what you mean.');
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO feature_requests (kind, tile, title, details, account_id, email, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`
  ).bind(kind, clean(input.tile, 60) || null, title, details, viewer.accountId || null, viewer.email,
    viewer.employee?.name || viewer.email, now, now).run();
  const id = res.meta?.last_row_id;
  for (const email of await developerEmails(env)) {
    await raiseAlert(env, { kind: 'request', dedupe: `request:${id}:${email}`, recipient: email,
      subject: `New hub request: ${title}`,
      body: `${viewer.employee?.name || viewer.email} sent ${KINDS[kind].toLowerCase()}${input.tile ? ` for ${clean(input.tile, 60)}` : ''}.\n\n${details}\n\nOpen Requests in the hub to answer it.` });
  }
  return { ok: true, id };
}

export async function update(env, viewer, input) {
  if (!isDeveloper(viewer)) throw new Error('Only developers can update requests.');
  const r = await env.DB.prepare('SELECT * FROM feature_requests WHERE id = ?').bind(Number(input.id)).first();
  if (!r) throw new Error('That request has gone.');
  const status = STATUSES[input.status] ? input.status : r.status;
  const reply = input.reply === undefined ? r.reply : clean(input.reply, 2000) || null;
  await env.DB.prepare('UPDATE feature_requests SET status = ?, reply = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .bind(status, reply, viewer.employee?.name || viewer.email, new Date().toISOString(), r.id).run();
  // The person who asked hears when it moves on, not on every small edit.
  if (status !== r.status && r.email && r.email !== viewer.email) {
    await raiseAlert(env, { kind: 'request', dedupe: `request:${r.id}:${status}`, recipient: r.email,
      subject: `Your hub request: ${STATUSES[status]}`,
      body: `"${r.title}" is now: ${STATUSES[status]}.${reply ? `\n\n${reply}` : ''}\n\nOpen Requests in the hub to see it.` });
  }
  return { ok: true };
}
