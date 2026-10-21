// Employee of the Quarter. Nominations are gathered in rounds that end on a date
// management set, usually their meeting. Anyone can nominate anyone else, as many
// people as they like but each person once a round. People read what was written
// about them without the names; management see everything, choose the winner,
// and the hub announces it. Shout-outs, sent from Admin's home screen messages,
// let management thank someone at any time.
import { londonDate, mondayOf, remembered } from './sync.js';

const DAY_MS = 86_400_000;
const MIN_REASON = 10;
const MAX_REASON = 3000;
const MAX_CERTIFICATE = 1_900_000;           // a D1 row holds up to 2 MB
const ANNOUNCE_DAYS = 14;
const SHOUTOUT_DAYS = 7;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MEDALS = ['bronze', 'silver', 'gold', 'diamond'];
export const DEFAULT_AWARD = 'Going the extra mile';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const nameKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
const quarterEnd = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return addDays(addMonths(`${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`, 3), -1);
};
export const dayWords = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });

export function roundLabel(r) {
  if (r.name) return r.name;
  const [y1, m1] = r.opens_on.split('-').map(Number);
  const [y2, m2] = r.closes_on.split('-').map(Number);
  if (y1 === y2 && m1 === m2) return `${MONTHS[m1 - 1]} ${y1}`;
  return y1 === y2 ? `${MONTHS[m1 - 1]} to ${MONTHS[m2 - 1]} ${y2}` : `${MONTHS[m1 - 1]} ${y1} to ${MONTHS[m2 - 1]} ${y2}`;
}

export const medalFor = (wins) => (wins > 0 ? MEDALS[Math.min(wins, MEDALS.length) - 1] : null);

// ---------- who can see what ----------

export const canManage = (viewer) => Boolean(viewer?.isAdmin || viewer?.can?.eotq);
const mustManage = (viewer, what = 'do that') => { if (!canManage(viewer)) throw fail(`Only the management team can ${what}.`, 403); };
const mustBeLinked = (viewer) => { if (!viewer?.accountId) throw fail('Your account isn\'t linked to an employee profile yet.', 403); };

async function everyone(env, { includeLeft = false } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT account_id, name, active FROM employees ${includeLeft ? '' : 'WHERE active = 1'} ORDER BY name`
  ).all();
  return results.filter((p) => p.name);
}

// A steady order that isn't the order they were written in, so the newest
// comment can't be matched to whoever nominated last.
const scramble = (id) => {
  let h = 2166136261;
  for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

// ---------- rounds ----------

// The round open for nominations. When one ends, the next starts the day after
// and runs three months, until management set its date.
export async function currentRound(env, today = londonDate()) {
  const find = () => env.DB.prepare('SELECT * FROM eotq_rounds WHERE imported = 0 AND closes_on >= ? ORDER BY closes_on LIMIT 1').bind(today).first();
  const row = await find();
  if (row) return row;
  const lastLive = await env.DB.prepare('SELECT closes_on FROM eotq_rounds WHERE imported = 0 ORDER BY closes_on DESC LIMIT 1').first();
  let opens = today;
  let closes = quarterEnd(today);
  if (lastLive) {
    opens = addDays(lastLive.closes_on, 1);
    closes = addMonths(lastLive.closes_on, 3);
    while (closes < today) closes = addMonths(closes, 3);
  }
  // Only made if nobody else made it a moment ago.
  await env.DB.prepare(
    `INSERT INTO eotq_rounds (opens_on, closes_on, created_at) SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM eotq_rounds WHERE imported = 0 AND closes_on >= ?)`
  ).bind(opens, closes, new Date().toISOString(), today).run();
  return find();
}

const roundById = async (env, id) => {
  const r = await env.DB.prepare('SELECT * FROM eotq_rounds WHERE id = ?').bind(Number(id) || 0).first();
  if (!r) throw fail('That round isn\'t there any more.', 404);
  return r;
};

// ---------- medals ----------

export async function medal(env, accountId) {
  if (!accountId) return null;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM eotq_rounds WHERE winner_id = ?').bind(accountId).first().catch(() => null);
  const wins = row?.n || 0;
  return wins ? { tier: medalFor(wins), wins } : null;
}

// ---------- the page ----------

export async function page(env, viewer) {
  mustBeLinked(viewer);
  const today = londonDate();
  const round = await currentRound(env, today);
  const [all, mineRes, aboutRes, myMedal] = await Promise.all([
    everyone(env),
    env.DB.prepare('SELECT id, nominee_id, nominee_name, reason, created_at FROM eotq_votes WHERE voter_id = ? AND round_id = ? ORDER BY id')
      .bind(viewer.accountId, round.id).all(),
    env.DB.prepare(`SELECT v.id, v.reason, r.id AS round_id, r.name, r.opens_on, r.closes_on FROM eotq_votes v JOIN eotq_rounds r ON r.id = v.round_id
      WHERE v.nominee_id = ? ORDER BY r.closes_on DESC`).bind(viewer.accountId).all(),
    medal(env, viewer.accountId),
  ]);
  const nominated = new Set(mineRes.results.map((v) => v.nominee_id));
  const rounds = new Map();
  for (const v of aboutRes.results) {
    if (!rounds.has(v.round_id)) rounds.set(v.round_id, { round: v.round_id, label: roundLabel(v), current: v.round_id === round.id, reasons: [] });
    rounds.get(v.round_id).reasons.push(v);
  }
  return {
    round: { id: round.id, label: roundLabel(round), closes: round.closes_on, closesWords: dayWords(round.closes_on), closesDay: weekday(round.closes_on) },
    me: { id: viewer.accountId, name: viewer.employee?.name || viewer.email, medal: myMedal },
    people: all.filter((p) => p.account_id !== viewer.accountId).map((p) => ({ id: p.account_id, name: p.name, nominated: nominated.has(p.account_id) })),
    mine: mineRes.results.map((v) => ({ id: v.id, nomineeId: v.nominee_id, nominee: v.nominee_name, reason: v.reason, at: v.created_at })),
    aboutMe: [...rounds.values()].map((r) => ({ ...r, reasons: r.reasons.sort((a, b) => scramble(a.id) - scramble(b.id)).map((v) => v.reason) })),
    canManage: canManage(viewer),
  };
}

function checkReason(input) {
  const reason = clean(input, MAX_REASON);
  if (reason.length < MIN_REASON) throw fail('Say why you\'ve nominated them.');
  return reason;
}

export async function vote(env, viewer, input = {}) {
  mustBeLinked(viewer);
  const nomineeId = String(input.nomineeId || '');
  if (!nomineeId) throw fail('Choose who you\'re nominating.');
  if (nomineeId === viewer.accountId) throw fail('You can\'t nominate yourself.');
  const nominee = await env.DB.prepare('SELECT account_id, name FROM employees WHERE account_id = ? AND active = 1').bind(nomineeId).first();
  if (!nominee) throw fail('That person isn\'t on the employee list.');
  const reason = checkReason(input.reason);
  const round = await currentRound(env);
  const res = await env.DB.prepare(
    `INSERT INTO eotq_votes (round_id, voter_id, voter_name, nominee_id, nominee_name, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(round_id, voter_id, nominee_id) DO NOTHING`
  ).bind(round.id, viewer.accountId, viewer.employee?.name || viewer.email, nominee.account_id, nominee.name, reason, new Date().toISOString()).run();
  if (!res.meta?.changes) throw fail(`You've already nominated ${nominee.name} this round. You can change what you wrote instead.`, 409);
  return { ok: true, id: res.meta.last_row_id };
}

async function ownVote(env, viewer, id) {
  mustBeLinked(viewer);
  const row = await env.DB.prepare('SELECT id, round_id, voter_id FROM eotq_votes WHERE id = ?').bind(Number(id) || 0).first();
  if (!row || row.voter_id !== viewer.accountId) throw fail('That nomination isn\'t one of yours.', 404);
  if (row.round_id !== (await currentRound(env)).id) throw fail('Nominations from an earlier round can\'t be changed.', 409);
  return row;
}

export async function edit(env, viewer, input = {}) {
  const row = await ownVote(env, viewer, input.id);
  await env.DB.prepare('UPDATE eotq_votes SET reason = ?, updated_at = ? WHERE id = ?').bind(checkReason(input.reason), new Date().toISOString(), row.id).run();
  return { ok: true };
}

export async function withdraw(env, viewer, input = {}) {
  const row = await ownVote(env, viewer, input.id);
  await env.DB.prepare('DELETE FROM eotq_votes WHERE id = ?').bind(row.id).run();
  return { ok: true };
}

// ---------- history: every finished round and its winner ----------

export async function history(env, viewer) {
  mustManage(viewer, 'see the history');
  const today = londonDate();
  const { results } = await env.DB.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM eotq_votes v WHERE v.round_id = r.id) AS nominations,
            (SELECT 1 FROM eotq_certificates c WHERE c.round_id = r.id) AS uploaded,
            (SELECT mime FROM eotq_certificates c WHERE c.round_id = r.id) AS upload_mime
       FROM eotq_rounds r WHERE r.imported = 1 OR r.closes_on <= ? OR r.winner_id IS NOT NULL ORDER BY r.closes_on DESC`
  ).bind(today).all();
  const wins = new Map();
  // Medals as they stood after each win, oldest first.
  const tierAt = new Map();
  for (const r of [...results].reverse()) {
    if (!r.winner_id) continue;
    wins.set(r.winner_id, (wins.get(r.winner_id) || 0) + 1);
    tierAt.set(r.id, medalFor(wins.get(r.winner_id)));
  }
  return {
    canManage: canManage(viewer),
    shares: await shares(env, today),
    rounds: results.map((r) => ({
      id: r.id, label: roundLabel(r), opens: r.opens_on, closes: r.closes_on, imported: Boolean(r.imported), open: r.closes_on >= today && !r.imported,
      nominations: canManage(viewer) ? r.nominations : undefined,
      winner: r.winner_id ? { id: r.winner_id, name: r.winner_name, medal: tierAt.get(r.id) } : null,
      award: r.award, announced: r.announced_at,
      certificate: r.winner_id ? { made: true } : r.uploaded ? { uploaded: true, pdf: r.upload_mime === 'application/pdf' } : null,
    })),
  };
}

// How many nominations each person has had, over every round and in the one open
// now. A name typed into the old form counts as the person it's linked to; until
// then, the same name however it was typed counts as one.
async function shares(env, today) {
  const current = await currentRound(env, today);
  const [{ results: votes }, { results: people }] = await Promise.all([
    env.DB.prepare('SELECT round_id, nominee_id, nominee_name FROM eotq_votes').all(),
    env.DB.prepare('SELECT account_id, name FROM employees').all(),
  ]);
  const name = new Map(people.map((p) => [p.account_id, p.name]));
  const byName = new Map();
  for (const p of people) if (p.name) byName.set(nameKey(p.name), byName.has(nameKey(p.name)) ? null : p.account_id);
  const tidy = (t) => String(t || '').trim().replace(/\s+/g, ' ').replace(/(^|[\s-])(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
  const count = (list) => {
    const m = new Map();
    for (const v of list) {
      const id = v.nominee_id || byName.get(nameKey(v.nominee_name));
      const key = id ? `id:${id}` : `name:${nameKey(v.nominee_name)}`;
      const e = m.get(key) || { key, name: (id && name.get(id)) || tidy(v.nominee_name), n: 0 };
      e.n++;
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  };
  return { all: count(votes), current: { label: roundLabel(current), people: count(votes.filter((v) => v.round_id === current.id)) } };
}

// What the certificate shows, for the browser to draw.
export async function certificateData(env, viewer, roundId) {
  mustManage(viewer, 'see certificates');
  const r = await roundById(env, roundId);
  if (!r.winner_id) throw fail('That round has no winner yet.', 404);
  const emp = await env.DB.prepare('SELECT name, avatar, pronouns FROM employees WHERE account_id = ?').bind(r.winner_id).first();
  return { round: r.id, label: roundLabel(r), name: r.winner_name || emp?.name, avatar: emp?.avatar || null,
    award: r.award || DEFAULT_AWARD, citation: r.citation || defaultCitation(emp?.pronouns) };
}

export function defaultCitation(pronouns) {
  const p = String(pronouns || '').toLowerCase();
  const [his, him] = p.startsWith('she') ? ['her', 'her'] : p.startsWith('they') ? ['their', 'them'] : p.startsWith('he') ? ['his', 'him'] : ['their', 'them'];
  return `For ${his} invaluable work and team involvement, the company recognise ${him} as the most outstanding employee of the quarter. Thank you for your effort, congratulations!`;
}

export async function uploadCertificate(env, viewer, roundId, request) {
  mustManage(viewer, 'add certificates');
  const r = await roundById(env, roundId);
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(type)) throw fail('Certificates need to be a PDF, PNG, JPEG or WebP.');
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw fail('That file was empty.');
  if (bytes.byteLength > MAX_CERTIFICATE) throw fail('Certificates need to be under 1.9 MB. A picture is made smaller before it\'s sent, so a large PDF is the likely cause.');
  if (type === 'application/pdf' && new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw fail('That isn\'t a PDF.');
  const filename = clean(decodeURIComponent(request.headers.get('x-filename') || ''), 120).replace(/[^\w .()-]+/g, '_') || 'certificate';
  await env.DB.prepare(
    `INSERT INTO eotq_certificates (round_id, mime, filename, data, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(round_id) DO UPDATE SET mime = excluded.mime, filename = excluded.filename, data = excluded.data,
       uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at`
  ).bind(r.id, type, filename, bytes, viewer.employee?.name || viewer.email, new Date().toISOString()).run();
  return { ok: true };
}

export async function removeCertificate(env, viewer, roundId) {
  mustManage(viewer, 'remove certificates');
  await env.DB.prepare('DELETE FROM eotq_certificates WHERE round_id = ?').bind(Number(roundId) || 0).run();
  return { ok: true };
}

export async function certificateFile(env, viewer, roundId) {
  mustManage(viewer, 'see certificates');
  const row = await env.DB.prepare('SELECT mime, filename, data FROM eotq_certificates WHERE round_id = ?').bind(Number(roundId) || 0).first();
  if (!row) throw fail('There\'s no certificate for that round.', 404);
  return { mime: row.mime, filename: row.filename, bytes: row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data) };
}

// ---------- management ----------

// Names typed into the old form are matched to people where the full name is
// the same, so what was written reaches them. The rest are linked by hand.
async function linkByName(env, roundId, people) {
  const { results } = await env.DB.prepare('SELECT DISTINCT nominee_name FROM eotq_votes WHERE round_id = ? AND nominee_id IS NULL').bind(roundId).all();
  if (!results.length) return;
  const byName = new Map();
  for (const p of people) byName.set(nameKey(p.name), byName.has(nameKey(p.name)) ? null : p.account_id);
  const stmts = results.map((r) => [r.nominee_name, byName.get(nameKey(r.nominee_name))]).filter(([, id]) => id)
    .map(([n, id]) => env.DB.prepare('UPDATE eotq_votes SET nominee_id = ? WHERE round_id = ? AND nominee_name = ? AND nominee_id IS NULL').bind(id, roundId, n));
  if (stmts.length) await env.DB.batch(stmts);
}

export async function manage(env, viewer, roundParam) {
  mustManage(viewer, 'see every nomination');
  const today = londonDate();
  const current = await currentRound(env, today);
  const round = roundParam ? await roundById(env, roundParam) : current;
  const people = await everyone(env, { includeLeft: true });
  await linkByName(env, round.id, people);
  const [{ results: rounds }, { results: votes }] = await Promise.all([
    env.DB.prepare(`SELECT r.id, r.name, r.opens_on, r.closes_on, r.winner_name, r.imported, (SELECT COUNT(*) FROM eotq_votes v WHERE v.round_id = r.id) AS n
      FROM eotq_rounds r ORDER BY r.closes_on DESC`).all(),
    env.DB.prepare('SELECT id, nominee_id, nominee_name, voter_id, voter_name, reason, created_at, updated_at FROM eotq_votes WHERE round_id = ? ORDER BY created_at, id').bind(round.id).all(),
  ]);
  const name = new Map(people.map((p) => [p.account_id, p.name]));
  const tally = new Map();
  for (const v of votes) {
    const key = v.nominee_id || `name:${nameKey(v.nominee_name)}`;
    const t = tally.get(key) || { id: v.nominee_id, name: (v.nominee_id && name.get(v.nominee_id)) || v.nominee_name, typed: v.nominee_name, votes: 0 };
    t.votes++;
    tally.set(key, t);
  }
  // Who has nominated, out of everyone on the list now. Only for a live round.
  let turnout = null;
  if (!round.imported && round.closes_on >= addDays(today, -30)) {
    const active = people.filter((p) => p.active);
    const voted = new Set(votes.map((v) => v.voter_id));
    turnout = { total: active.length, voted: active.filter((p) => voted.has(p.account_id)).map((p) => p.name),
      notYet: active.filter((p) => !voted.has(p.account_id)).map((p) => p.name) };
  }
  return {
    round: { id: round.id, label: roundLabel(round), name: round.name || '', opens: round.opens_on, closes: round.closes_on, closesWords: dayWords(round.closes_on),
      current: round.id === current.id, imported: Boolean(round.imported), open: round.closes_on >= today && !round.imported,
      winner: round.winner_id ? { id: round.winner_id, name: round.winner_name } : null, award: round.award || DEFAULT_AWARD, citation: round.citation || '',
      announced: round.announced_at },
    today,
    rounds: rounds.map((r) => ({ id: r.id, label: roundLabel(r), count: r.n, winner: r.winner_name, current: r.id === current.id })),
    tally: [...tally.values()].sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name)),
    votes: votes.map((v) => ({ id: v.id, nomineeId: v.nominee_id, nominee: (v.nominee_id && name.get(v.nominee_id)) || v.nominee_name, typed: v.nominee_name,
      by: v.voter_name, reason: v.reason, at: v.created_at, edited: v.updated_at })),
    turnout,
    people: people.map((p) => ({ id: p.account_id, name: p.name, left: !p.active })),
  };
}

export async function saveRound(env, viewer, input = {}) {
  mustManage(viewer, 'change rounds');
  const r = await roundById(env, input.id);
  const today = londonDate();
  const name = clean(input.name, 80) || null;
  let closes = r.closes_on;
  if (input.closesOn !== undefined && input.closesOn !== r.closes_on) {
    if (r.imported || r.closes_on < today) throw fail('A round that has finished keeps its dates.');
    if (!isDate(input.closesOn)) throw fail('Choose the date nominations close.');
    if (input.closesOn < today) throw fail('The closing date can\'t be in the past.');
    if (input.closesOn < r.opens_on) throw fail('The closing date can\'t be before the round started.');
    if (input.closesOn > addMonths(today, 12)) throw fail('Choose a date within the next year.');
    closes = input.closesOn;
  }
  await env.DB.prepare('UPDATE eotq_rounds SET name = ?, closes_on = ? WHERE id = ?').bind(name, closes, r.id).run();
  return { ok: true };
}

// Points what was typed into the old form at the person it meant.
export async function link(env, viewer, input = {}) {
  mustManage(viewer, 'link names');
  const r = await roundById(env, input.roundId);
  const typed = String(input.typed || '');
  const id = String(input.accountId || '') || null;
  if (id && !(await env.DB.prepare('SELECT 1 AS n FROM employees WHERE account_id = ?').bind(id).first())) throw fail('That person isn\'t on the employee list.');
  await env.DB.prepare('UPDATE eotq_votes SET nominee_id = ? WHERE round_id = ? AND nominee_name = ?').bind(id, r.id, typed).run();
  return { ok: true };
}

export async function chooseWinner(env, viewer, input = {}) {
  mustManage(viewer, 'choose the winner');
  const r = await roundById(env, input.roundId);
  const today = londonDate();
  const accountId = String(input.accountId || '');
  const endMessage = () => (r.message_id ? env.DB.prepare('UPDATE home_messages SET ended_at = ? WHERE id = ? AND ended_at IS NULL').bind(new Date().toISOString(), r.message_id).run() : null);
  if (!accountId) {
    await endMessage();
    await env.DB.prepare('UPDATE eotq_rounds SET winner_id = NULL, winner_name = NULL, award = NULL, citation = NULL, announced_at = NULL, announced_by = NULL, message_id = NULL WHERE id = ?').bind(r.id).run();
    return { ok: true };
  }
  if (!r.imported && r.closes_on > today) throw fail(`Nominations are open until ${dayWords(r.closes_on)}. Choose the winner on or after that day.`);
  const emp = await env.DB.prepare('SELECT account_id, name, pronouns FROM employees WHERE account_id = ?').bind(accountId).first();
  if (!emp) throw fail('That person isn\'t on the employee list.');
  const award = clean(input.award, 60) || DEFAULT_AWARD;
  const citation = clean(input.citation, 400) || defaultCitation(emp.pronouns);
  const now = new Date().toISOString();
  let messageId = r.message_id;
  if (input.announce) {
    await endMessage();
    const ends = new Date(Date.now() + ANNOUNCE_DAYS * DAY_MS).toISOString();
    const res = await env.DB.prepare(
      `INSERT INTO home_messages (kind, title, body, link, tone, audience, starts_at, ends_at, emailed, created_by, created_by_name, created_at)
       VALUES ('announcement', ?, ?, '#/eotq', 'important', ?, ?, ?, 0, ?, ?, ?)`
    ).bind(`${emp.name} is Employee of the Quarter`, `${award}. Chosen by the management team for ${roundLabel(r)}. Congratulations!`,
      JSON.stringify({ everyone: true, teams: [], people: [] }), now, ends, viewer.email, viewer.employee?.name || viewer.email, now).run();
    messageId = res.meta.last_row_id;
  }
  await env.DB.prepare(
    'UPDATE eotq_rounds SET winner_id = ?, winner_name = ?, award = ?, citation = ?, announced_at = ?, announced_by = ?, message_id = ? WHERE id = ?'
  ).bind(emp.account_id, emp.name, award, citation, input.announce ? now : r.announced_at, viewer.employee?.name || viewer.email, messageId, r.id).run();
  return { ok: true };
}

// The same columns as the old form's response sheet, with the round added.
export async function csv(env, viewer, roundParam) {
  mustManage(viewer, 'download nominations');
  const all = roundParam === 'all';
  const round = all ? null : roundParam ? await roundById(env, roundParam) : await currentRound(env);
  const { results } = await env.DB.prepare(
    `SELECT v.created_at, v.nominee_name, v.reason, v.voter_name, r.name, r.opens_on, r.closes_on FROM eotq_votes v JOIN eotq_rounds r ON r.id = v.round_id
      ${all ? '' : 'WHERE v.round_id = ?'} ORDER BY v.created_at, v.id`
  ).bind(...(all ? [] : [round.id])).all();
  // A leading = + - or @ would be read as a formula by a spreadsheet.
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const when = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '');
  const lines = [['Timestamp', 'Who do you think should be nominated', 'Why have you nominated this person?', 'Your name', 'Round'].map(cell).join(',')];
  for (const r of results) lines.push([when(r.created_at), r.nominee_name, r.reason, r.voter_name, roundLabel(r)].map(cell).join(','));
  return { body: `\ufeff${lines.join('\r\n')}\r\n`, filename: `Employee of the Quarter ${all ? 'all rounds' : roundLabel(round)}.csv` };
}

// ---------- settings: the date, and rounds from before the hub ----------

export async function settings(env, viewer) {
  mustManage(viewer, 'change Employee of the Quarter settings');
  const today = londonDate();
  const r = await currentRound(env, today);
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.name, r.opens_on, r.closes_on, r.winner_name, (SELECT COUNT(*) FROM eotq_votes v WHERE v.round_id = r.id) AS n
       FROM eotq_rounds r WHERE r.imported = 1 ORDER BY r.closes_on DESC`
  ).all();
  return {
    today,
    round: { id: r.id, name: r.name || '', label: roundLabel(r), opens: r.opens_on, closes: r.closes_on },
    past: results.map((x) => ({ id: x.id, label: roundLabel(x), opens: x.opens_on, closes: x.closes_on, count: x.n, winner: x.winner_name })),
  };
}

const MAX_IMPORT = 5000;

// Nominations from before the hub, a round (a vote cycle) at a time. Those marked
// as current join the round open now. Bringing the same sheet in again changes
// nothing, and a nomination already brought in is moved if its cycle has changed.
export async function importHistory(env, viewer, input = {}) {
  mustManage(viewer, 'bring in past nominations');
  const rounds = Array.isArray(input.rounds) ? input.rounds : [];
  if (!rounds.length) throw fail('There\'s nothing to bring in.');
  if (rounds.length > 60 || rounds.reduce((t, r) => t + (r.nominations?.length || 0), 0) > MAX_IMPORT) throw fail('That\'s more than the hub can bring in at once.');
  const now = new Date().toISOString();
  const today = londonDate();
  const current = await currentRound(env, today);
  // People are matched by their full name, where only one person has it.
  const byName = new Map();
  for (const p of await everyone(env, { includeLeft: true })) byName.set(nameKey(p.name), byName.has(nameKey(p.name)) ? null : p.account_id);
  const idOf = (name) => byName.get(nameKey(name)) || null;
  // Past rounds that held nominations before, so any left empty by a move can be tidied away.
  const { results: before } = await env.DB.prepare('SELECT DISTINCT v.round_id AS id FROM eotq_votes v JOIN eotq_rounds r ON r.id = v.round_id WHERE r.imported = 1').all();
  let added = 0, moved = 0, skipped = 0, made = 0;
  for (const r of rounds) {
    const noms = (Array.isArray(r.nominations) ? r.nominations : []).map((x) => ({
      at: Number.isNaN(Date.parse(x.at)) ? null : new Date(x.at).toISOString(),
      nominee: clean(x.nominee, 120), reason: clean(x.reason, MAX_REASON) || '(nothing written)', voter: clean(x.voter, 120) || null,
    })).filter((x) => x.at && x.nominee);
    if (!noms.length) continue;
    let roundId;
    const live = Boolean(r.current);
    if (live) {
      roundId = current.id;
      // The round open now started when its first nomination came in, even if that was on the old form.
      const first = noms.map((x) => londonDate(Date.parse(x.at))).sort()[0];
      if (first < current.opens_on) await env.DB.prepare('UPDATE eotq_rounds SET opens_on = ? WHERE id = ?').bind(first, current.id).run();
    } else {
      const days = noms.map((x) => londonDate(Date.parse(x.at))).sort();
      const opens = days[0], closes = days[days.length - 1];
      const name = clean(r.name, 80) || (r.cycle != null && String(r.cycle).trim() ? `Vote cycle ${clean(r.cycle, 20)}` : null);
      let round = name ? await env.DB.prepare('SELECT id FROM eotq_rounds WHERE imported = 1 AND name = ?').bind(name).first() : null;
      round ||= await env.DB.prepare('SELECT id FROM eotq_rounds WHERE imported = 1 AND opens_on = ? AND closes_on = ?').bind(opens, closes).first();
      if (round) {
        await env.DB.prepare('UPDATE eotq_rounds SET opens_on = ?, closes_on = ?, name = COALESCE(?, name) WHERE id = ?').bind(opens, closes, name, round.id).run();
        roundId = round.id;
      } else {
        const res = await env.DB.prepare('INSERT INTO eotq_rounds (name, opens_on, closes_on, imported, created_at) VALUES (?, ?, ?, 1, ?)').bind(name, opens, closes, now).run();
        roundId = res.meta.last_row_id;
        made++;
      }
    }
    for (let i = 0; i < noms.length; i += 20) {
      const part = noms.slice(i, i + 20);
      const stmts = part.flatMap((x) => {
        const voterId = live ? idOf(x.voter) : null, nomineeId = idOf(x.nominee);
        return [
          env.DB.prepare(`UPDATE OR IGNORE eotq_votes SET round_id = ?, voter_id = COALESCE(voter_id, ?), nominee_id = COALESCE(nominee_id, ?)
            WHERE created_at = ? AND nominee_name = ? AND round_id != ?`).bind(roundId, voterId, nomineeId, x.at, x.nominee, roundId),
          env.DB.prepare(`INSERT OR IGNORE INTO eotq_votes (round_id, voter_id, voter_name, nominee_id, nominee_name, reason, created_at) SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM eotq_votes WHERE created_at = ? AND nominee_name = ?)`).bind(roundId, voterId, x.voter, nomineeId, x.nominee, x.reason, x.at, x.at, x.nominee),
        ];
      });
      const out = await env.DB.batch(stmts);
      for (let k = 0; k < part.length; k++) {
        if (out[k * 2].meta?.changes) moved++;
        else if (out[k * 2 + 1].meta?.changes) added++;
        else skipped++;
      }
    }
  }
  // A past round emptied by moving its nominations, with no winner or certificate, goes.
  for (const { id } of before) {
    await env.DB.prepare(`DELETE FROM eotq_rounds WHERE id = ? AND imported = 1 AND winner_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM eotq_votes WHERE round_id = ?) AND NOT EXISTS (SELECT 1 FROM eotq_certificates WHERE round_id = ?)`).bind(id, id, id).run();
  }
  return { rounds: made, added, moved, skipped };
}

// A round from before the hub with no nominations to bring in, so its winner and certificate can be added.
export async function addPastRound(env, viewer, input = {}) {
  mustManage(viewer, 'add past rounds');
  const opens = String(input.opens || ''), closes = String(input.closes || '');
  if (!isDate(opens) || !isDate(closes)) throw fail('Give the dates the round ran.');
  if (closes < opens) throw fail('The round can\'t end before it starts.');
  if (closes >= londonDate()) throw fail('A past round has to have ended already.');
  const res = await env.DB.prepare('INSERT INTO eotq_rounds (name, opens_on, closes_on, imported, created_at) VALUES (?, ?, ?, 1, ?)')
    .bind(clean(input.name, 80) || null, opens, closes, new Date().toISOString()).run();
  return { ok: true, id: res.meta.last_row_id };
}

export async function removePastRound(env, viewer, input = {}) {
  mustManage(viewer, 'remove past rounds');
  const r = await roundById(env, input.id);
  if (!r.imported) throw fail('Only rounds from before the hub can be removed.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM eotq_votes WHERE round_id = ?').bind(r.id),
    env.DB.prepare('DELETE FROM eotq_certificates WHERE round_id = ?').bind(r.id),
    env.DB.prepare('DELETE FROM eotq_rounds WHERE id = ?').bind(r.id),
  ]);
  return { ok: true };
}

// ---------- shout-outs ----------

export async function giveShoutout(env, viewer, input = {}) {
  mustManage(viewer, 'give shout-outs');
  const person = await env.DB.prepare('SELECT account_id, name FROM employees WHERE account_id = ? AND active = 1').bind(String(input.accountId || '')).first();
  if (!person) throw fail('Choose who the shout-out is for.');
  const message = clean(input.message, 600);
  if (message.length < 5) throw fail('Say what they did.');
  const now = new Date().toISOString();
  const from = viewer.employee?.name || viewer.email;
  const res = await env.DB.prepare(
    `INSERT INTO home_messages (kind, title, body, link, tone, audience, starts_at, ends_at, emailed, created_by, created_by_name, created_at)
     VALUES ('announcement', ?, ?, NULL, 'info', ?, ?, ?, 0, ?, ?, ?)`
  ).bind(`Shout-out for ${person.name}`, message, JSON.stringify({ everyone: true, teams: [], people: [] }), now,
    new Date(Date.now() + SHOUTOUT_DAYS * DAY_MS).toISOString(), viewer.email, from, now).run();
  await env.DB.prepare('INSERT INTO shoutouts (account_id, name, message, given_by, given_by_name, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(person.account_id, person.name, message, viewer.accountId || viewer.email, from, res.meta.last_row_id, now).run();
  return { ok: true };
}

// ---------- on the home screen ----------

// Weekly from Monday until it's dismissed for that week. In the last seven days
// of a round it comes back daily for anyone who hasn't nominated yet.
export async function reminder(env, viewer) {
  if (!viewer?.accountId) return null;
  const today = londonDate();
  const round = await currentRound(env, today);
  const finalWeek = today >= addDays(round.closes_on, -6);
  const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM eotq_votes WHERE voter_id = ? AND round_id = ?').bind(viewer.accountId, round.id).first();
  const count = mine?.n || 0;
  if (finalWeek && count) return null;
  const period = finalWeek ? `day:${today}` : `week:${mondayOf(today)}`;
  if (await env.DB.prepare('SELECT 1 AS n FROM eotq_dismissals WHERE account_id = ? AND period = ?').bind(viewer.accountId, period).first()) return null;
  const closing = today === round.closes_on ? 'today' : finalWeek ? `on ${weekday(round.closes_on)}` : `on ${dayWords(round.closes_on)}`;
  return {
    id: `eotq:${period}`, key: 'eotq', link: '#/eotq', tone: finalWeek ? 'important' : 'info',
    title: finalWeek ? `Employee of the Quarter nominations close ${closing}` : 'Nominate someone for Employee of the Quarter',
    body: finalWeek ? 'You haven\'t nominated anyone yet.'
      : `${count ? `You've nominated ${count === 1 ? 'one person' : `${count} people`} so far. ` : ''}Who has gone above and beyond? Nominations close ${closing}.`,
  };
}

// New nominations about this person since they last looked.
export async function nominatedAlert(env, viewer) {
  if (!viewer?.accountId) return null;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n, MAX(v.id) AS last FROM eotq_votes v JOIN eotq_rounds r ON r.id = v.round_id AND r.imported = 0
      WHERE v.nominee_id = ? AND v.id > COALESCE((SELECT last_vote_id FROM eotq_seen WHERE account_id = ?), 0)`
  ).bind(viewer.accountId, viewer.accountId).first();
  if (!row?.n) return null;
  return { id: `eotq:seen:${row.last}`, key: 'eotq-nominated', link: '#/eotq?about', tone: 'info',
    title: row.n === 1 ? 'You\'ve been nominated for Employee of the Quarter' : `You've been nominated ${row.n} times for Employee of the Quarter`,
    body: 'Read what was written about you.' };
}

export async function markSeen(env, viewer, upTo = null) {
  if (!viewer?.accountId) return { ok: true };
  const last = upTo ?? (await env.DB.prepare('SELECT MAX(id) AS m FROM eotq_votes WHERE nominee_id = ?').bind(viewer.accountId).first())?.m;
  if (!last) return { ok: true };
  await env.DB.prepare(
    `INSERT INTO eotq_seen (account_id, last_vote_id, at) VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET last_vote_id = MAX(eotq_seen.last_vote_id, excluded.last_vote_id), at = excluded.at`
  ).bind(viewer.accountId, Number(last), new Date().toISOString()).run();
  return { ok: true };
}

export async function dismiss(env, viewer, id) {
  if (!viewer?.accountId) throw fail('That isn\'t an alert that can be dismissed.');
  const seen = String(id || '').match(/^eotq:seen:(\d+)$/);
  if (seen) return markSeen(env, viewer, Number(seen[1]));
  const m = String(id || '').match(/^eotq:((?:day|week):\d{4}-\d{2}-\d{2})$/);
  if (!m) throw fail('That isn\'t an alert that can be dismissed.');
  await env.DB.prepare('INSERT INTO eotq_dismissals (account_id, period, at) VALUES (?, ?, ?) ON CONFLICT(account_id, period) DO NOTHING')
    .bind(viewer.accountId, m[1], new Date().toISOString()).run();
  return { ok: true };
}

// ---------- work anniversaries ----------

const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;

// Today's anniversaries. On a Monday, the weekend's are included, so nobody's is missed.
export async function anniversaries(env, today = londonDate()) {
  return remembered(env, 'anniversaries', today, async () => {
    const { results } = await env.DB.prepare("SELECT account_id, name, start_date FROM employees WHERE active = 1 AND start_date IS NOT NULL AND start_date != ''").all();
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) return [];
    const days = dow === 1 ? [addDays(today, -2), addDays(today, -1), today] : [today];
    const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const out = [];
    for (const e of results) {
      if (!isDate(e.start_date)) continue;
      for (const d of days) {
        let md = e.start_date.slice(5);
        if (md === '02-29' && !leap(Number(d.slice(0, 4)))) md = '02-28';
        const years = Number(d.slice(0, 4)) - Number(e.start_date.slice(0, 4));
        if (md === d.slice(5) && years >= 1) out.push({ accountId: e.account_id, name: e.name, years, on: d });
      }
    }
    return out;
  });
}

export function anniversaryNews(list, viewer, today = londonDate()) {
  return list.map((a) => {
    const when = a.on === today ? 'today' : `on ${weekday(a.on)}`;
    const yours = a.accountId === viewer?.accountId;
    return { key: `anniversary:${a.accountId}`, tone: 'info', link: null,
      title: yours ? `Happy ${ordinal(a.years)} work anniversary, ${a.name.split(' ')[0]}!` : `${a.name}: ${a.years} year${a.years === 1 ? '' : 's'} at Promtek`,
      body: yours ? `${a.years} year${a.years === 1 ? '' : 's'} at Promtek ${when}. Thank you for everything you do.` : `${a.years === 1 ? 'One year' : `${a.years} years`} ${when}. Wish them a happy work anniversary.` };
  });
}
