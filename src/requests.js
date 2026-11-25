// Requests for new tiles, changes to tiles, and problems people spot. Everyone
// can send one and follow their own; developers see them all and answer them. Each has a
// conversation between whoever sent it and the developers, open whatever its status: each
// message alerts the other side.
import { raiseAlert } from './sync.js';
import { groupsOf } from './permissions.js';

export const KINDS = { tile: 'A new tile', change: 'A change to a tile', problem: 'Something not working' };
export const STATUSES = { new: 'New', working: 'Working on it', complete: 'Complete', rejected: 'Not going ahead' };

const isDeveloper = (viewer) => Boolean(viewer.isAdmin || viewer.can?.developer);
const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const nameOf = (viewer) => viewer.employee?.name || viewer.email;
const mineOf = (viewer, r) => Boolean(r.email && viewer.email && r.email.toLowerCase() === viewer.email.toLowerCase());

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
  // How many messages each has, and whether there's one this person hasn't read.
  const ids = results.map((r) => r.id);
  const msgs = new Map();
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    const { results: m } = await env.DB.prepare(`SELECT request_id, COUNT(*) AS n FROM request_messages WHERE request_id IN (${part.map(() => '?').join(',')}) GROUP BY request_id`)
      .bind(...part).all().catch(() => ({ results: [] }));
    m.forEach((x) => msgs.set(x.request_id, x.n));
  }
  const requests = results.map((r) => ({ ...r, messages: msgs.get(r.id) || 0, mine: mineOf(viewer, r),
    unread: Boolean(mineOf(viewer, r) ? r.requester_unread : dev && r.dev_unread) }));
  return { requests, developer: dev, kinds: KINDS, statuses: STATUSES, counts };
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
  await env.DB.prepare('UPDATE feature_requests SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .bind(status, nameOf(viewer), new Date().toISOString(), r.id).run();
  // The person who asked hears when it moves on, not on every small edit.
  if (status !== r.status && r.email && !mineOf(viewer, r)) {
    await raiseAlert(env, { kind: 'request', dedupe: `request:${r.id}:${status}:${Date.now()}`, recipient: r.email, link: '#/requests',
      subject: `Your hub request: ${STATUSES[status]}`,
      body: `"${r.title}" is now: ${STATUSES[status]}.\n\nOpen Requests in the hub to see it.` });
  }
  return { ok: true };
}

async function requestFor(env, viewer, id) {
  const r = await env.DB.prepare('SELECT * FROM feature_requests WHERE id = ?').bind(Number(id)).first();
  if (!r) throw refuse('That request has gone.', 404);
  const mine = mineOf(viewer, r);
  const dev = isDeveloper(viewer);
  if (!mine && !dev) throw refuse('Only whoever sent it and the developers can see its conversation.', 403);
  return { r, mine, dev };
}

// The conversation on a request. Reading it clears what was new for whoever's reading
// (viewing the hub as someone else changes nothing).
export async function thread(env, viewer, id) {
  const { r, mine } = await requestFor(env, viewer, id);
  const { results } = await env.DB.prepare('SELECT id, from_dev, name, body, created_at FROM request_messages WHERE request_id = ? ORDER BY id').bind(r.id).all();
  if (!viewer.viewingAs) {
    if (mine && r.requester_unread) await env.DB.prepare('UPDATE feature_requests SET requester_unread = 0 WHERE id = ?').bind(r.id).run();
    else if (!mine && r.dev_unread) await env.DB.prepare('UPDATE feature_requests SET dev_unread = 0 WHERE id = ?').bind(r.id).run();
  }
  return { id: r.id, asRequester: mine, requester: r.name || r.email,
    messages: results.map((m) => ({ id: m.id, fromDev: Boolean(m.from_dev), by: m.name || (m.from_dev ? 'A developer' : r.name), body: m.body, at: m.created_at })) };
}

// A message on it, whatever its status: from whoever sent it to the developers, or from a
// developer to whoever sent it. The other side is alerted.
export async function message(env, viewer, { id, body }) {
  const { r, mine } = await requestFor(env, viewer, id);
  const text = clean(body, 4000);
  if (text.length < 2) throw refuse('Write a message first.');
  const now = new Date().toISOString();
  const fromDev = !mine;
  const res = await env.DB.prepare('INSERT INTO request_messages (request_id, from_dev, account_id, name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(r.id, fromDev ? 1 : 0, viewer.accountId || null, nameOf(viewer), text, now).run();
  await env.DB.prepare(`UPDATE feature_requests SET ${fromDev ? 'requester_unread' : 'dev_unread'} = 1, updated_at = ? WHERE id = ?`).bind(now, r.id).run();
  const msgId = res.meta?.last_row_id;
  const subject = `${nameOf(viewer)} on "${r.title}"`;
  const bodyText = `${nameOf(viewer)} wrote about ${fromDev ? 'your' : 'their'} hub request "${r.title}":\n\n${text}\n\nOpen Requests in the hub to reply.`;
  if (fromDev) {
    if (r.email) await raiseAlert(env, { kind: 'request', dedupe: `request-msg:${msgId}`, recipient: r.email, link: '#/requests', subject, body: bodyText });
  } else {
    for (const email of await developerEmails(env)) {
      if (email.toLowerCase() === String(viewer.email || '').toLowerCase()) continue;
      await raiseAlert(env, { kind: 'request', dedupe: `request-msg:${msgId}:${email}`, recipient: email, link: '#/requests', subject, body: bodyText });
    }
  }
  return { ok: true, id: msgId };
}

export async function unreadFor(env, viewer) {
  if (!viewer?.email) return 0;
  const own = await env.DB.prepare('SELECT COUNT(*) AS n FROM feature_requests WHERE LOWER(email) = LOWER(?) AND requester_unread = 1').bind(viewer.email).first().catch(() => null);
  const dev = isDeveloper(viewer) ? await env.DB.prepare('SELECT COUNT(*) AS n FROM feature_requests WHERE dev_unread = 1 AND LOWER(COALESCE(email, \'\')) != LOWER(?)').bind(viewer.email).first().catch(() => null) : null;
  return (own?.n || 0) + (dev?.n || 0);
}
