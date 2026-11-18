// The shared tablet. It stays signed in as its own account (automation@promtek.com unless
// TABLET_EMAILS says otherwise); whoever picks it up taps their name and enters their PIN,
// and the hub is theirs until they switch or leave it for a few minutes. PINs are set by each
// person from their own sign-in, and kept only as a salted hash. On the tablet nobody has
// admin rights: admin work is done from someone's own sign-in.
const COOKIE = 'hub_tablet';
const TRIES = 5;
const LOCK_MS = 15 * 60 * 1000;
const ITERATIONS = 100_000;
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const tabletEmails = (env) => String(env.TABLET_EMAILS || 'automation@promtek.com').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
export const isTablet = (env, email) => tabletEmails(env).includes(String(email || '').toLowerCase());
export const idleMinutes = (env) => Math.min(240, Math.max(1, Number(env.TABLET_IDLE_MINUTES) || 30));
// The hub on the tablet asks "Still you?" after the idle time; the session itself lasts a little longer,
// so a change sent just as it asks isn't refused.
const GRACE_MS = 5 * 60_000;

async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: ITERATIONS }, key, 256));
}
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

// A PIN that isn't one anyone would guess first.
export function pinProblem(pin) {
  const p = String(pin || '');
  if (!/^\d{4,8}$/.test(p)) return 'Use 4 to 8 digits.';
  if (/^(\d)\1+$/.test(p)) return 'Use a PIN that isn\'t the same digit repeated.';
  const up = '01234567890123456789'; const down = '98765432109876543210';
  if (up.includes(p) || down.includes(p)) return 'Use a PIN that isn\'t a run of digits like 1234.';
  return null;
}

// ---------- from someone's own sign-in ----------

export async function pinState(env, viewer) {
  const row = viewer.accountId ? await env.DB.prepare('SELECT set_at FROM tablet_pins WHERE account_id = ?').bind(viewer.accountId).first().catch(() => null) : null;
  return { set: Boolean(row), setAt: row?.set_at || null };
}

export async function setPin(env, viewer, { pin, remove = false }) {
  if (viewer.tablet) throw refuse('Set your tablet PIN from your own sign-in, not on the tablet.', 403);
  if (!viewer.accountId) throw refuse('Your account isn\'t linked to an employee record yet.');
  if (remove) {
    await env.DB.prepare('DELETE FROM tablet_pins WHERE account_id = ?').bind(viewer.accountId).run();
    await env.DB.prepare('DELETE FROM tablet_sessions WHERE account_id = ?').bind(viewer.accountId).run();
    return { ok: true, set: false };
  }
  const problem = pinProblem(pin);
  if (problem) throw refuse(problem);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare(`INSERT INTO tablet_pins (account_id, pin_hash, salt, set_at, fails, locked_until) VALUES (?, ?, ?, ?, 0, NULL)
    ON CONFLICT(account_id) DO UPDATE SET pin_hash = excluded.pin_hash, salt = excluded.salt, set_at = excluded.set_at, fails = 0, locked_until = NULL`)
    .bind(viewer.accountId, await hashPin(pin, salt), salt, new Date().toISOString()).run();
  // A new PIN ends any session on the tablet under the old one.
  await env.DB.prepare('DELETE FROM tablet_sessions WHERE account_id = ?').bind(viewer.accountId).run();
  const { record } = await import('./audit.js');
  await record(env, viewer, { area: 'Hub', action: 'set their tablet PIN', subjectType: 'person', subjectId: viewer.accountId, label: viewer.employee?.name || viewer.email }).catch(() => {});
  return { ok: true, set: true };
}

// ---------- on the tablet ----------

function cookieOf(request) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m && /^[a-f0-9]{64}$/.test(m[1]) ? m[1] : null;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// Who is using the tablet now, if anyone: their session lasts while they keep using it.
export async function sessionOf(env, request) {
  const token = cookieOf(request);
  if (!token) return null;
  const id = await sha(token);
  const row = await env.DB.prepare('SELECT * FROM tablet_sessions WHERE token = ?').bind(id).first().catch(() => null);
  if (!row) return null;
  const now = Date.now();
  if (now - row.last_seen > idleMinutes(env) * 60_000 + GRACE_MS) {
    await env.DB.prepare('DELETE FROM tablet_sessions WHERE token = ?').bind(id).run();
    return null;
  }
  if (now - row.last_seen > 20_000) await env.DB.prepare('UPDATE tablet_sessions SET last_seen = ? WHERE token = ?').bind(now, id).run();
  return { accountId: row.account_id, token: id };
}

// Everyone in the UK (not Promtek Africa), with whether they've set a PIN yet.
export async function people(env) {
  const { results } = await env.DB.prepare(`SELECT e.account_id, e.name, e.avatar, p.account_id AS pin FROM employees e LEFT JOIN tablet_pins p ON p.account_id = e.account_id
    WHERE e.active = 1 AND e.account_id NOT LIKE 'pending%' AND COALESCE(e.chart_sa, 0) = 0 ORDER BY e.name`).all();
  return { people: results.map((e) => ({ id: e.account_id, name: e.name, avatar: e.avatar || null, hasPin: Boolean(e.pin) })), idleMinutes: idleMinutes(env) };
}

export async function unlock(env, { accountId, pin }) {
  const row = await env.DB.prepare('SELECT p.*, e.name FROM tablet_pins p JOIN employees e ON e.account_id = p.account_id WHERE p.account_id = ? AND e.active = 1').bind(String(accountId || '')).first();
  if (!row) throw refuse('You haven\'t set a tablet PIN yet. Set one from your own sign-in first.', 409);
  const now = Date.now();
  if (row.locked_until && row.locked_until > now) throw refuse(`Too many wrong PINs. Try again in ${Math.ceil((row.locked_until - now) / 60000)} minutes, or use your own sign-in.`, 429);
  if (!/^\d{4,8}$/.test(String(pin || '')) || await hashPin(pin, row.salt) !== row.pin_hash) {
    const fails = (row.locked_until && row.locked_until <= now ? 0 : row.fails || 0) + 1;
    const locked = fails >= TRIES ? now + LOCK_MS : null;
    await env.DB.prepare('UPDATE tablet_pins SET fails = ?, locked_until = ? WHERE account_id = ?').bind(locked ? 0 : fails, locked, row.account_id).run();
    throw refuse(locked ? 'Too many wrong PINs. It\'s locked for 15 minutes.' : `That PIN isn't right. ${TRIES - fails} ${TRIES - fails === 1 ? 'try' : 'tries'} left.`, 403);
  }
  await env.DB.prepare('UPDATE tablet_pins SET fails = 0, locked_until = NULL WHERE account_id = ?').bind(row.account_id).run();
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('DELETE FROM tablet_sessions WHERE last_seen < ?').bind(now - 24 * 3600_000).run();
  await env.DB.prepare('INSERT INTO tablet_sessions (token, account_id, created_at, last_seen) VALUES (?, ?, ?, ?)').bind(await sha(token), row.account_id, now, now).run();
  return { ok: true, name: row.name, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict` };
}

export async function lock(env, request) {
  const token = cookieOf(request);
  if (token) await env.DB.prepare('DELETE FROM tablet_sessions WHERE token = ?').bind(await sha(token)).run();
  return { ok: true };
}

// What can't be done on the tablet, whoever is using it.
export function blocked(pathname) {
  return pathname.startsWith('/api/admin') || pathname.startsWith('/api/dev/') || pathname.startsWith('/api/jira-connect') || pathname === '/api/tablet/pin';
}
