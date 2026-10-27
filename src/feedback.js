// Anonymous feedback. Nobody can see who wrote a post or how anyone voted, admins
// included. Each post, and each vote, is stored against a code worked out from the
// writer's sign-in and a secret that only the Worker holds (FEEDBACK_SECRET). The
// code is different for every post, so even two posts by the same person can't be
// matched. When the writer is signed in, the hub can still work out "this one is
// yours", which is how replies reach them, both ways, without anyone knowing who
// they are. Posts carry the day they were made, never the time.
import { check, explain, nameWords } from './feedback-filter.js';
import { raiseAlert, getState, setState, londonDate } from './sync.js';
import { peopleWith } from './permissions.js';

export const CATEGORIES = [
  ['quality', 'Quality Improvement'],
  ['safety', 'Safety Improvement'],
  ['cost', 'Cost Reduction'],
  ['productivity', 'Productivity Improvement'],
  ['cleanliness', 'Cleanliness Improvement (5S)'],
  ['customer', 'Customer Service Improvement'],
  ['environment', 'Environmental Standards / Waste Separation'],
  ['infosec', 'Information Security'],
  ['marketing', 'Marketing and Advertisement'],
  ['general', 'General'],
];
const CATEGORY_KEYS = new Set(CATEGORIES.map(([k]) => k));
export const STATUSES = { pending: 'Waiting for an admin', approved: 'Posted', rejected: 'Not posted' };
const SETTINGS_KEY = 'feedback_words';
const PER_DAY = 5;
const IN = 90;

const refuse = (message, status = 400) => { const err = new Error(message); err.status = status; return err; };
const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const isAdmin = (viewer) => Boolean(viewer?.isAdmin || viewer?.can?.feedbackReview);
// Who someone is, for working out their codes. Nobody viewing the hub as someone
// else ever counts as them here, so a developer can't see whose posts are whose.
const whoOf = (viewer) => (viewer?.viewingAs ? null : String(viewer?.email || '').trim().toLowerCase() || null);

// ---------- the codes ----------

let keyFor = { secret: null, key: null };
async function hmac(env, text) {
  const secret = env.FEEDBACK_SECRET;
  if (!secret) throw refuse('Anonymous feedback needs setting up first: an admin adds FEEDBACK_SECRET to the hub.', 503);
  if (keyFor.secret !== secret) {
    keyFor = { secret, key: await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) };
  }
  const sig = await crypto.subtle.sign('HMAC', keyFor.key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const authorTag = (env, id, who) => hmac(env, `author|${id}|${who}`);
const voterTag = (env, id, who) => hmac(env, `vote|${id}|${who}`);
const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Which of these posts are the viewer's own.
async function ownOf(env, viewer, rows) {
  const who = whoOf(viewer);
  if (!who || !env.FEEDBACK_SECRET) return new Set();
  const mine = new Set();
  for (const r of rows) if (r.author_tag === await authorTag(env, r.id, who)) mine.add(r.id);
  return mine;
}

// ---------- the word filter ----------

export async function settings(env) {
  try {
    const s = JSON.parse((await getState(env, SETTINGS_KEY)) || '{}');
    return { blocked: Array.isArray(s.blocked) ? s.blocked : [], allowed: Array.isArray(s.allowed) ? s.allowed : [] };
  } catch { return { blocked: [], allowed: [] }; }
}

export async function saveSettings(env, viewer, input) {
  if (!isAdmin(viewer)) throw refuse('Only admins can change the word lists.', 403);
  const words = (v) => [...new Set(String(v || '').split(/[\n,]+/).map((w) => w.trim().toLowerCase()).filter((w) => w && w.length <= 40))].slice(0, 300);
  const s = { blocked: words(input.blocked), allowed: words(input.allowed) };
  await setState(env, SETTINGS_KEY, JSON.stringify(s));
  return s;
}

async function filterFor(env) {
  const [{ results: people }, s] = await Promise.all([env.DB.prepare('SELECT name FROM employees').all(), settings(env)]);
  return { names: nameWords(people), ...s };
}

// For checking as someone types.
export async function checkText(env, text) {
  const problems = check(clean(text, 4000), await filterFor(env));
  return { ok: !problems.length, problems, message: explain(problems) };
}

async function mustPass(env, ...texts) {
  const f = await filterFor(env);
  const problems = texts.flatMap((t) => check(t, f));
  if (problems.length) throw refuse(explain(problems));
}

// ---------- reading ----------

const shape = (r, { mine = false, myVote = 0, admin = false } = {}) => ({
  id: r.id, day: r.created_day, categories: JSON.parse(r.categories || '[]'), problem: r.problem, solution: r.solution || '',
  status: r.status, ups: r.ups, downs: r.downs, score: r.ups - r.downs, myVote, mine,
  messages: mine || admin ? r.messages || 0 : undefined,
  unread: mine ? Boolean(r.author_unread) : admin ? Boolean(r.admin_unread) : false,
  rejectReason: mine || admin ? r.reject_reason || null : undefined,
  decidedBy: admin ? r.decided_by || null : undefined, decidedDay: r.decided_day || null,
});

const SELECT = `SELECT f.*, (SELECT COUNT(*) FROM feedback_messages m WHERE m.feedback_id = f.id) AS messages FROM feedback f`;

// Everything the tile needs: the board, the viewer's own posts, and for admins
// what's waiting for them.
export async function overview(env, viewer) {
  const admin = isAdmin(viewer);
  const ready = Boolean(env.FEEDBACK_SECRET);
  const { results: all } = await env.DB.prepare(`${SELECT} ORDER BY f.rowid DESC LIMIT 1000`).all();
  const mine = ready ? await ownOf(env, viewer, all) : new Set();
  const approved = all.filter((r) => r.status === 'approved');

  // Their votes, by working out their code for each post on the board.
  const votes = new Map();
  const who = whoOf(viewer);
  if (ready && who && approved.length) {
    const tags = new Map();
    for (const r of approved) tags.set(await voterTag(env, r.id, who), r.id);
    for (const part of chunk([...tags.keys()], IN)) {
      const { results } = await env.DB.prepare(`SELECT voter_tag, vote FROM feedback_votes WHERE voter_tag IN (${part.map(() => '?').join(',')})`).bind(...part).all();
      for (const v of results) votes.set(tags.get(v.voter_tag), v.vote);
    }
  }
  const out = (r) => shape(r, { mine: mine.has(r.id), myVote: votes.get(r.id) || 0, admin });
  return {
    ready, admin, categories: CATEGORIES, statuses: STATUSES, canVote: Boolean(ready && who),
    board: approved.map(out),
    mine: all.filter((r) => mine.has(r.id)).map(out),
    review: admin ? all.filter((r) => r.status === 'pending').map(out) : [],
    conversations: admin ? all.filter((r) => r.messages > 0 || r.admin_unread).map(out) : [],
  };
}

// How many of the viewer's posts have something new for them, for the tile.
export async function unreadFor(env, viewer) {
  if (!env.FEEDBACK_SECRET || !whoOf(viewer)) return 0;
  const { results } = await env.DB.prepare('SELECT id, author_tag FROM feedback WHERE author_unread = 1').all();
  return (await ownOf(env, viewer, results)).size;
}

async function postFor(env, id) {
  const r = await env.DB.prepare(`${SELECT} WHERE f.id = ?`).bind(String(id || '')).first();
  if (!r) throw refuse('That feedback has gone.', 404);
  return r;
}

// The conversation on a post, for its writer and for admins only.
export async function thread(env, viewer, id) {
  const r = await postFor(env, id);
  const mine = (await ownOf(env, viewer, [r])).has(r.id);
  const admin = isAdmin(viewer);
  if (!mine && !admin) throw refuse('Only the person who wrote this and the admins can see its conversation.', 403);
  const { results } = await env.DB.prepare('SELECT id, from_admin, admin_name, body, day FROM feedback_messages WHERE feedback_id = ? ORDER BY id').bind(r.id).all();
  // Reading it clears what was new for whoever is reading. Viewing the hub as someone changes nothing.
  if (!viewer.viewingAs) {
    if (mine && r.author_unread) await env.DB.prepare('UPDATE feedback SET author_unread = 0 WHERE id = ?').bind(r.id).run();
    else if (!mine && admin && r.admin_unread) await env.DB.prepare('UPDATE feedback SET admin_unread = 0 WHERE id = ?').bind(r.id).run();
  }
  return {
    post: shape(r, { mine, admin }),
    asWriter: mine,
    messages: results.map((m) => ({ id: m.id, fromAdmin: Boolean(m.from_admin), by: m.from_admin ? m.admin_name || 'Admin' : 'The writer', body: m.body, day: m.day })),
  };
}

// ---------- telling admins ----------

// New feedback and writers' replies reach admins in a round-up twice a day, rather
// than as they're sent, so an email's time says nothing about who wrote it.
const ROUND_UP_HOURS = [8, 14];
const londonHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));

export async function roundUp(env, { force = false } = {}) {
  const hour = londonHour();
  if (!force && !ROUND_UP_HOURS.includes(hour)) return { idle: true };
  const [{ results: posts }, { results: replies }] = await Promise.all([
    env.DB.prepare("SELECT id FROM feedback WHERE status = 'pending' AND admin_told = 0").all(),
    env.DB.prepare('SELECT DISTINCT feedback_id FROM feedback_messages WHERE from_admin = 0 AND admin_told = 0').all(),
  ]);
  if (!posts.length && !replies.length) return { idle: true };
  const lines = [];
  if (posts.length) lines.push(`${posts.length} new ${posts.length === 1 ? 'piece' : 'pieces'} of anonymous feedback to read, and post or turn down.`);
  if (replies.length) lines.push(`${replies.length} ${replies.length === 1 ? 'conversation has' : 'conversations have'} a new reply from the writer.`);
  await tellAdmins(env, `feedback-round-up:${londonDate()}:${hour}`, 'Anonymous feedback waiting for you',
    `${lines.join('\n')}\n\nOpen Feedback in the hub to see them.`);
  await env.DB.batch([
    env.DB.prepare("UPDATE feedback SET admin_told = 1 WHERE status = 'pending' AND admin_told = 0"),
    env.DB.prepare('UPDATE feedback_messages SET admin_told = 1 WHERE from_admin = 0 AND admin_told = 0'),
  ]);
  return { posts: posts.length, replies: replies.length };
}

// ---------- writing ----------

// Everyone who reads feedback: admins, and whoever else has Feedback moderation.
async function adminEmails(env) {
  const set = new Set((env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  for (const e of await peopleWith(env, 'feedbackReview')) set.add(String(e.email).toLowerCase());
  return [...set];
}

async function tellAdmins(env, dedupe, subject, body) {
  for (const email of await adminEmails(env)) {
    await raiseAlert(env, { kind: 'feedback', dedupe: `${dedupe}:${email}`, recipient: email, subject, body });
  }
}

export async function create(env, viewer, input) {
  const who = whoOf(viewer);
  if (!who) throw refuse('Feedback can only be sent as yourself.', 403);
  const categories = [...new Set((input.categories || []).filter((c) => CATEGORY_KEYS.has(c)))];
  if (!categories.length) throw refuse('Tick at least one category.');
  const problem = clean(input.problem, 3000);
  const solution = clean(input.solution, 3000);
  if (problem.length < 15) throw refuse('Describe the problem in a sentence or two.');
  await mustPass(env, problem, solution);

  // A few a day each, worked out from today's posts alone.
  const today = londonDate();
  const { results: todays } = await env.DB.prepare('SELECT id, author_tag FROM feedback WHERE created_day = ?').bind(today).all();
  if ((await ownOf(env, viewer, todays)).size >= PER_DAY) throw refuse(`That's ${PER_DAY} today, the most in one day. Send any more tomorrow.`);

  const id = newId();
  await env.DB.prepare(
    `INSERT INTO feedback (id, author_tag, created_day, categories, problem, solution, status, ups, downs, author_unread, admin_unread)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, 0)`
  ).bind(id, await authorTag(env, id, who), today, JSON.stringify(categories), problem, solution || null).run();
  // Admins hear about it in the next round-up, not now, so the time of the email
  // can't be matched with who had the hub open.
  return { ok: true, id };
}

export async function decide(env, viewer, { id, decision, reason }) {
  if (!isAdmin(viewer)) throw refuse('Only admins can post or turn down feedback.', 403);
  const r = await postFor(env, id);
  if (!['approve', 'reject'].includes(decision)) throw refuse('Post it or turn it down?');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const why = clean(reason, 1000) || null;
  const stmts = [env.DB.prepare('UPDATE feedback SET status = ?, reject_reason = ?, decided_by = ?, decided_day = ?, author_unread = 1 WHERE id = ?')
    .bind(status, status === 'rejected' ? why : null, viewer.employee?.name || viewer.email, londonDate(), r.id)];
  // A reason for turning it down reaches the writer in its conversation.
  if (status === 'rejected' && why) {
    stmts.push(env.DB.prepare('INSERT INTO feedback_messages (feedback_id, from_admin, admin_name, body, day) VALUES (?, 1, ?, ?, ?)')
      .bind(r.id, viewer.employee?.name || 'Admin', why, londonDate()));
  }
  await env.DB.batch(stmts);
  return { ok: true, status };
}

export async function vote(env, viewer, { id, vote: v }) {
  const who = whoOf(viewer);
  if (!who) throw refuse('Votes can only be made as yourself.', 403);
  const r = await postFor(env, id);
  if (r.status !== 'approved') throw refuse('Only posted feedback can be voted on.');
  const value = Number(v) > 0 ? 1 : Number(v) < 0 ? -1 : 0;
  const t = await voterTag(env, r.id, who);
  const write = value
    ? env.DB.prepare('INSERT INTO feedback_votes (feedback_id, voter_tag, vote) VALUES (?, ?, ?) ON CONFLICT(feedback_id, voter_tag) DO UPDATE SET vote = excluded.vote').bind(r.id, t, value)
    : env.DB.prepare('DELETE FROM feedback_votes WHERE feedback_id = ? AND voter_tag = ?').bind(r.id, t);
  await env.DB.batch([write, env.DB.prepare(
    `UPDATE feedback SET ups = (SELECT COUNT(*) FROM feedback_votes WHERE feedback_id = ? AND vote = 1),
       downs = (SELECT COUNT(*) FROM feedback_votes WHERE feedback_id = ? AND vote = -1) WHERE id = ?`
  ).bind(r.id, r.id, r.id)]);
  const after = await env.DB.prepare('SELECT ups, downs FROM feedback WHERE id = ?').bind(r.id).first();
  return { ok: true, myVote: value, ups: after.ups, downs: after.downs };
}

// A reply on a post: from an admin, shown with their name, or from its writer,
// shown only as "the writer". The writer's replies go through the same filter.
export async function reply(env, viewer, { id, body }) {
  const r = await postFor(env, id);
  const mine = (await ownOf(env, viewer, [r])).has(r.id);
  const admin = isAdmin(viewer);
  if (!mine && !admin) throw refuse('Only the person who wrote this and the admins can reply to it.', 403);
  const text = clean(body, 2000);
  if (text.length < 2) throw refuse('Write a reply first.');
  const day = londonDate();
  if (mine) {
    await mustPass(env, text);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO feedback_messages (feedback_id, from_admin, admin_name, body, day) VALUES (?, 0, NULL, ?, ?)').bind(r.id, text, day),
      env.DB.prepare('UPDATE feedback SET admin_unread = 1 WHERE id = ?').bind(r.id),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO feedback_messages (feedback_id, from_admin, admin_name, body, day) VALUES (?, 1, ?, ?, ?)').bind(r.id, viewer.employee?.name || 'Admin', text, day),
      env.DB.prepare('UPDATE feedback SET author_unread = 1 WHERE id = ?').bind(r.id),
    ]);
  }
  return { ok: true };
}
