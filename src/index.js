// Promtek Hub Worker: serves the web app and the /api routes, and runs the
// scheduled Tempo sync.
import { getUser } from './auth.js';
import { findAccountIdByEmail } from './jira.js';
import { progressFor, rankFor } from './progression.js';
import { getState, pollRecent, refreshProfiles, runScheduled, startLedger, londonDate } from './sync.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const user = await getUser(request, env);
    if (!user) return json({ error: 'Sign in with your Promtek Google account to continue.' }, 401);

    try {
      return await route(request, env, url, user);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};

async function route(request, env, url, user) {
  const { pathname } = url;
  const method = request.method;

  if (method === 'GET' && pathname === '/api/me') return json(await getMe(env, user));

  if (method === 'GET' && pathname === '/api/time') return json(await getTime(env, user, url));

  if (method === 'POST' && pathname === '/api/sync') {
    try {
      return json(await pollRecent(env));
    } catch (err) {
      return json({ error: `Couldn't reach Tempo just now: ${err.message}` }, 502);
    }
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!user.isAdmin) return json({ error: 'Only admins can do that.' }, 403);
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};

    if (method === 'GET' && pathname === '/api/admin/overview') return json(await adminOverview(env));

    if (method === 'POST' && pathname === '/api/admin/start-ledger') {
      if (body.confirm !== 'START') return json({ error: 'Type START to confirm.' }, 400);
      return json(await startLedger(env));
    }
    if (method === 'POST' && pathname === '/api/admin/refresh-profiles') return json(await refreshProfiles(env));
    if (method === 'POST' && pathname === '/api/admin/sync-now') return json(await pollRecent(env, { force: true }));

    if (method === 'POST' && pathname === '/api/admin/link') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!body.accountId || !email.endsWith('@' + env.ALLOWED_EMAIL_DOMAIN.toLowerCase())) {
        return json({ error: `Choose an employee and enter an @${env.ALLOWED_EMAIL_DOMAIN} email.` }, 400);
      }
      await env.DB.batch([
        env.DB.prepare('UPDATE employees SET email = NULL WHERE email = ?').bind(email),
        env.DB.prepare('UPDATE employees SET email = ? WHERE account_id = ?').bind(email, body.accountId),
      ]);
      return json({ ok: true });
    }
  }

  return json({ error: 'Not found' }, 404);
}

// ---------- Profile ----------

async function findEmployee(env, email) {
  let emp = await env.DB.prepare('SELECT * FROM employees WHERE email = ?').bind(email).first();
  if (emp) return emp;

  // First sign-in: match the Google email to the person's Atlassian account.
  let accountId = null;
  try {
    accountId = await findAccountIdByEmail(env, email);
  } catch (err) {
    console.warn('Account lookup failed:', err.message);
  }
  if (!accountId) return null;
  emp = await env.DB.prepare('SELECT * FROM employees WHERE account_id = ?').bind(accountId).first();
  if (!emp) return null;
  if (!emp.email) {
    await env.DB.prepare('UPDATE employees SET email = ? WHERE account_id = ?').bind(email, accountId).run();
    emp.email = email;
  }
  return emp;
}

function weekStart() {
  const today = londonDate();
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return londonDate(Date.parse(`${today}T12:00:00Z`) - ((dow + 6) % 7) * 86_400_000);
}

async function getMe(env, user) {
  const base = { user, jiraBaseUrl: env.JIRA_BASE_URL, ledgerStart: await getState(env, 'ledger_start') };
  const emp = await findEmployee(env, user.email);
  if (!emp) return { ...base, linked: false };

  const monday = weekStart();
  const [totals, week, recent] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(SUM(xp), 0) AS xp FROM xp_ledger WHERE account_id = ?').bind(emp.account_id).first(),
    env.DB.prepare(
      'SELECT COALESCE(SUM(xp), 0) AS xp, COALESCE(SUM(seconds), 0) AS seconds FROM xp_ledger WHERE account_id = ? AND work_date >= ?'
    ).bind(emp.account_id, monday).first(),
    env.DB.prepare(
      `SELECT l.worklog_id, l.work_date, l.seconds, l.description, l.job_elo, l.engineer_elo, l.override, l.rate, l.xp,
              j.issue_key, j.summary
         FROM xp_ledger l LEFT JOIN jobs j ON j.issue_id = l.issue_id
        WHERE l.account_id = ?
        ORDER BY l.work_date DESC, l.updated_at DESC
        LIMIT 50`
    ).bind(emp.account_id).all(),
  ]);

  const xp = emp.opening_xp + totals.xp;
  return {
    ...base,
    linked: true,
    employee: {
      name: emp.name,
      accountId: emp.account_id,
      profileKey: emp.profile_key,
      elo: emp.elo,
      rank: rankFor(emp.elo),
      progress: progressFor(xp),
      week: { xp: week.xp, seconds: week.seconds, from: monday },
    },
    recent: recent.results,
  };
}

// One week of the signed-in person's logged time. ?week=YYYY-MM-DD (a Monday).
async function getTime(env, user, url) {
  const emp = await findEmployee(env, user.email);
  if (!emp) return { linked: false };
  const requested = url.searchParams.get('week');
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(requested || '') ? requested : weekStart();
  const sunday = londonDate(Date.parse(`${monday}T12:00:00Z`) + 6 * 86_400_000);
  const { results } = await env.DB.prepare(
    `SELECT l.worklog_id, l.work_date, l.seconds, l.description, l.xp, j.issue_key, j.summary
       FROM xp_ledger l LEFT JOIN jobs j ON j.issue_id = l.issue_id
      WHERE l.account_id = ? AND l.work_date BETWEEN ? AND ?
      ORDER BY l.work_date, l.created_at`
  ).bind(emp.account_id, monday, sunday).all();
  return { linked: true, week: monday, entries: results, jiraBaseUrl: env.JIRA_BASE_URL };
}

// ---------- Admin ----------

async function adminOverview(env) {
  const [employees, unmatched, state] = await Promise.all([
    env.DB.prepare(
      `SELECT e.account_id, e.name, e.email, e.profile_key, e.elo, e.jira_xp, e.opening_xp,
              COALESCE(SUM(l.xp), 0) AS ledger_xp, COUNT(l.worklog_id) AS worklogs
         FROM employees e LEFT JOIN xp_ledger l ON l.account_id = e.account_id
        GROUP BY e.account_id ORDER BY e.name`
    ).all(),
    env.DB.prepare(
      `SELECT account_id, COUNT(*) AS worklogs, SUM(seconds) AS seconds, MAX(work_date) AS latest
         FROM unmatched_worklogs GROUP BY account_id ORDER BY worklogs DESC LIMIT 50`
    ).all(),
    env.DB.prepare('SELECT key, value FROM sync_state').all(),
  ]);

  return {
    employees: employees.results.map((e) => ({
      ...e,
      app_xp: e.opening_xp + e.ledger_xp,
      difference: e.opening_xp + e.ledger_xp - e.jira_xp,
    })),
    unmatched: unmatched.results,
    state: Object.fromEntries(state.results.map((r) => [r.key, r.value])),
  };
}
