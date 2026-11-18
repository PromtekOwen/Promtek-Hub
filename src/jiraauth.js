// Each person's own Jira account, so a change they make in the hub is made as them in Jira.
// Someone connects once (Atlassian asks them to allow the hub); the hub keeps their access,
// renewing it as it runs out, locked with a key made from ATLASSIAN_CLIENT_SECRET.
// Without ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET everything is done as the hub's
// own account, as before.
const AUTH = 'https://auth.atlassian.com';
const SCOPES = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'];
const STATE_MS = 15 * 60 * 1000;
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });

export const configured = (env) => Boolean(env.ATLASSIAN_CLIENT_ID && env.ATLASSIAN_CLIENT_SECRET);

// ---------- locking the tokens away ----------

const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function keyOf(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`promtek-hub-jira-tokens|${env.ATLASSIAN_CLIENT_SECRET}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function lock(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyOf(env), enc.encode(text));
  return `${b64(iv)}.${b64(out)}`;
}
async function unlock(env, text) {
  const [iv, data] = String(text || '').split('.');
  const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await keyOf(env), unb64(data));
  return new TextDecoder().decode(out);
}

// ---------- connecting ----------

const callbackUrl = (origin) => `${origin}/api/jira-connect/callback`;

// Where someone is sent to allow the hub to act as them.
export async function start(env, viewer, origin) {
  if (!configured(env)) throw refuse('Connecting Jira accounts isn\'t set up yet.');
  if (!viewer.accountId) throw refuse('Your account isn\'t linked to an employee record yet.');
  const state = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, '');
  await env.DB.prepare('DELETE FROM jira_oauth_states WHERE created_at < ?').bind(Date.now() - STATE_MS).run();
  await env.DB.prepare('INSERT INTO jira_oauth_states (state, account_id, created_at) VALUES (?, ?, ?)').bind(state, viewer.accountId, Date.now()).run();
  const q = new URLSearchParams({ audience: 'api.atlassian.com', client_id: env.ATLASSIAN_CLIENT_ID, scope: SCOPES.join(' '), redirect_uri: callbackUrl(origin), state, response_type: 'code', prompt: 'consent' });
  return `${AUTH}/authorize?${q}`;
}

async function tokenCall(env, body) {
  const res = await fetch(`${AUTH}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: env.ATLASSIAN_CLIENT_ID, client_secret: env.ATLASSIAN_CLIENT_SECRET, ...body }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw refuse(`Atlassian didn't give access (${data.error_description || data.error || res.status}).`, 502);
  return data;
}

// Back from Atlassian: the code is swapped for access, checked to be this person's own account on Promtek's Jira.
export async function finish(env, viewer, origin, { code, state, error }) {
  if (error) throw refuse(error === 'access_denied' ? 'You chose not to connect your Jira account.' : `Atlassian said: ${error}`);
  const saved = await env.DB.prepare('SELECT * FROM jira_oauth_states WHERE state = ?').bind(String(state || '')).first();
  await env.DB.prepare('DELETE FROM jira_oauth_states WHERE state = ?').bind(String(state || '')).run();
  if (!saved || Date.now() - saved.created_at > STATE_MS || saved.account_id !== viewer.accountId) throw refuse('That link has run out or wasn\'t yours. Start again from the hub.');
  const t = await tokenCall(env, { grant_type: 'authorization_code', code: String(code || ''), redirect_uri: callbackUrl(origin) });
  const sites = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', { headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' } }).then((r) => r.json()).catch(() => []);
  const want = String(env.JIRA_BASE_URL || '').replace(/\/$/, '').toLowerCase();
  const site = (Array.isArray(sites) ? sites : []).find((s) => String(s.url).replace(/\/$/, '').toLowerCase() === want);
  if (!site) throw refuse('That Atlassian account can\'t reach Promtek\'s Jira. Sign in to Atlassian with your Promtek account and try again.');
  const myself = await fetch(`https://api.atlassian.com/ex/jira/${site.id}/rest/api/3/myself`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' } }).then((r) => r.json()).catch(() => null);
  if (!myself?.accountId) throw refuse('Jira didn\'t say whose account that is. Try again.', 502);
  if (myself.accountId !== viewer.accountId) throw refuse(`That's ${myself.displayName || 'someone else'}'s Jira account, not yours. Sign out of Atlassian, sign in as yourself and try again.`, 403);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO jira_users (account_id, email, cloud_id, access_token, refresh_token, expires_at, connected_at, problem) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(account_id) DO UPDATE SET email = excluded.email, cloud_id = excluded.cloud_id, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at, connected_at = excluded.connected_at, problem = NULL`)
    .bind(viewer.accountId, viewer.email || null, site.id, await lock(env, t.access_token), await lock(env, t.refresh_token || ''), Date.now() + (Number(t.expires_in) || 3600) * 1000, now).run();
  const { record } = await import('./audit.js');
  await record(env, viewer, { area: 'Hub', action: 'connected their Jira account', subjectType: 'person', subjectId: viewer.accountId, label: viewer.employee?.name || viewer.email }).catch(() => {});
  return { ok: true };
}

export async function status(env, viewer) {
  if (!configured(env) || !viewer.accountId) return { available: false };
  const row = await env.DB.prepare('SELECT connected_at, problem FROM jira_users WHERE account_id = ?').bind(viewer.accountId).first().catch(() => null);
  return { available: true, connected: Boolean(row && !row.problem), connectedAt: row?.connected_at || null, problem: row?.problem || null };
}

export async function disconnect(env, viewer) {
  await env.DB.prepare('DELETE FROM jira_users WHERE account_id = ?').bind(viewer.accountId || '').run();
  return { ok: true };
}

// ---------- acting as them ----------

// The access for whoever is making this change, renewed if it's run out; null to use the hub's own account.
export async function actorAuth(env) {
  const who = env.JIRA_ACTOR;
  if (!who?.accountId || !configured(env)) return null;
  if (who.auth !== undefined) return who.auth;
  who.auth = (async () => {
    const row = await env.DB.prepare('SELECT * FROM jira_users WHERE account_id = ?').bind(who.accountId).first().catch(() => null);
    if (!row || row.problem) return null;
    const lost = async (why = 'Jira stopped accepting the connection') => {
      await env.DB.prepare('UPDATE jira_users SET problem = ? WHERE account_id = ?').bind(why, who.accountId).run();
      who.auth = null;
    };
    let token;
    if (row.expires_at > Date.now() + 60_000) token = await unlock(env, row.access_token);
    else {
      try {
        const t = await tokenCall(env, { grant_type: 'refresh_token', refresh_token: await unlock(env, row.refresh_token) });
        token = t.access_token;
        await env.DB.prepare('UPDATE jira_users SET access_token = ?, refresh_token = ?, expires_at = ? WHERE account_id = ?')
          .bind(await lock(env, token), await lock(env, t.refresh_token || await unlock(env, row.refresh_token)), Date.now() + (Number(t.expires_in) || 3600) * 1000, who.accountId).run();
      } catch (err) {
        // Another change may have renewed it at the same moment: theirs is used.
        const again = await env.DB.prepare('SELECT access_token, expires_at FROM jira_users WHERE account_id = ?').bind(who.accountId).first().catch(() => null);
        if (again && again.expires_at > Date.now() + 60_000) token = await unlock(env, again.access_token);
        else { await lost('The connection to Jira ran out'); return null; }
      }
    }
    await env.DB.prepare('UPDATE jira_users SET last_used_at = ? WHERE account_id = ?').bind(new Date().toISOString(), who.accountId).run().catch(() => {});
    return { token, cloudId: row.cloud_id, lost };
  })().catch((err) => { console.warn('Jira connection:', err.message); return null; });
  return who.auth;
}

// Which hub requests are made as the person: their own changes, but not fetching the latest
// from Jira, which may carry others' changes. (The PSC board's own items stay with the hub's
// account whoever changes them: see jira.js.)
export function actsAsUser(method, pathname) {
  if (['GET', 'HEAD'].includes(method)) return false;
  if (pathname.startsWith('/api/dev/') || pathname.startsWith('/api/jira-connect')) return false;
  return !/\/(refresh|recheck|sync|sync-now|rebuild|poll|bitbucket-poll|import)$/.test(pathname);
}
