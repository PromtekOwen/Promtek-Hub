// Promtek Hub Worker: serves the web app and the /api routes, and runs the
// scheduled Tempo sync.
import { getUser } from './auth.js';
import { findAccountIdByEmail } from './jira.js';
import { progressFor, rankFor } from './progression.js';
import { getState, pollRecent, refreshProfiles, runScheduled, startLedger, londonDate, snapshotWeek, sendAlerts } from './sync.js';
import { teamWeeks, engineerReport, leaderboard, exportCsv } from './reports.js';
import * as Pow from './pow.js';
import { browse, shortcuts, search, stageHint, createWorklog, createPsc, flagMissingStage } from './logging.js';
import { scanCompleted, backfillStep, startBackfill, quotingSummary, backfillStatus, stageLibrary, difficultyAnalysis, recomputeStages } from './jobs.js';

const ROLES = ['engineer', 'lead', 'admin'];
const TEAMS = ['Projecting', 'Service', 'Condor'];

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
      const viewer = await resolveViewer(env, user);
      return await route(request, env, url, viewer);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};

// Combines the signed-in identity with the role stored against their profile.
// The emails in ADMIN_EMAILS are always admins, so you can't lock yourself out.
async function resolveViewer(env, user) {
  const emp = await findEmployee(env, user.email);
  const role = user.isAdmin ? 'admin' : (emp?.role || 'engineer');
  return {
    ...user,
    employee: emp,
    accountId: emp?.account_id || null,
    role,
    team: emp?.team || null,
    isAdmin: role === 'admin',
    isLead: role === 'lead' || role === 'admin',
  };
}

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

  if (pathname.startsWith('/api/log/')) {
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (method === 'GET' && pathname === '/api/log/browse') return json(await browse(env, url.searchParams.get('node') || 'root'));
    if (method === 'GET' && pathname === '/api/log/shortcuts') {
      return json(user.accountId ? await shortcuts(env, user.accountId) : { recent: [], assigned: [] });
    }
    if (method === 'GET' && pathname === '/api/log/search') return json(await search(env, url.searchParams.get('q')));
    if (method === 'GET' && pathname === '/api/log/hint') return json(await stageHint(env, url.searchParams.get('issueKey')) || {});
    if (method === 'POST' && pathname === '/api/log/worklog') {
      const result = await createWorklog(env, user, body);
      try { await pollRecent(env, { force: true }); } catch (err) { console.warn('Post-log sync failed:', err.message); }
      return json(result);
    }
    if (method === 'POST' && pathname === '/api/log/psc') return json(await createPsc(env, user, body));
    if (method === 'POST' && pathname === '/api/log/flag-stage') return json(await flagMissingStage(env, user, body));
  }

  if (pathname.startsWith('/api/pow/')) {
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (method === 'GET' && pathname === '/api/pow/schema') {
      return json({ ...Pow.formSchema(), ras: (await Pow.raLibrary(env)).map((r) => r.title) });
    }
    if (method === 'GET' && pathname === '/api/pow/browse') return json(await Pow.browseVisits(env, url.searchParams.get('node') || 'root'));
    if (method === 'GET' && pathname === '/api/pow/visit') return json(await Pow.visitDetails(env, url.searchParams.get('issueKey')));
    if (method === 'GET' && pathname === '/api/pow/forms') {
      return json(await Pow.listForms(env, user, { all: url.searchParams.get('all') === '1' && user.isLead }));
    }
    if (method === 'GET' && pathname === '/api/pow/form') return json(await Pow.getForm(env, user, url.searchParams.get('id')));
    if (method === 'GET' && pathname === '/api/pow/pdf') {
      const { bytes, filename } = await Pow.renderPdf(env, user, url.searchParams.get('id'));
      return new Response(bytes, {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="${filename}"`,
          'cache-control': 'no-store',
        },
      });
    }
    if (method === 'POST' && pathname === '/api/pow/draft') return json(await Pow.saveDraft(env, user, body));
    if (method === 'POST' && pathname === '/api/pow/submit') return json(await Pow.submitForm(env, user, body));
    if (method === 'POST' && pathname === '/api/pow/delete') return json(await Pow.deleteDraft(env, user, body.id));
  }

  if (method === 'GET' && pathname === '/api/leaderboard') {
    return json(await leaderboard(env, { period: url.searchParams.get('period') || 'week', accountId: user.accountId }));
  }

  if (method === 'GET' && pathname === '/api/reports/me') {
    if (!user.accountId) return json({ error: 'Your account isn\'t linked to a profile yet.' }, 404);
    return json(await engineerReport(env, user.accountId, { weeks: 12 }));
  }

  if (pathname.startsWith('/api/reports/')) {
    if (!user.isLead) return json({ error: 'Only team leads and admins can see team reports.' }, 403);

    if (method === 'GET' && pathname === '/api/reports/team') {
      return json(await teamWeeks(env, {
        weeks: Math.min(26, Number(url.searchParams.get('weeks')) || 8),
        team: url.searchParams.get('team') || null,
      }));
    }
    if (method === 'GET' && pathname === '/api/reports/quoting') {
      return json(await quotingSummary(env, {
        discipline: url.searchParams.get('discipline') || null,
        minConfidence: url.searchParams.get('all') === '1' ? 'any' : 'good',
      }));
    }
    if (method === 'GET' && pathname === '/api/reports/stages') {
      const discipline = url.searchParams.get('discipline') || null;
      const [stages, difficulty] = await Promise.all([
        stageLibrary(env, { discipline, minJobs: Number(url.searchParams.get('minJobs')) || 2 }),
        difficultyAnalysis(env, { discipline }),
      ]);
      return json({ ...stages, difficulty });
    }
    if (method === 'GET' && pathname === '/api/reports/engineer') {
      const report = await engineerReport(env, url.searchParams.get('accountId'), { weeks: 12 });
      return report ? json(report) : json({ error: 'No such engineer.' }, 404);
    }
    if (method === 'GET' && pathname === '/api/reports/export') {
      const { filename, csv } = await exportCsv(env, {
        type: url.searchParams.get('type') || 'ledger',
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        accountId: url.searchParams.get('accountId'),
      });
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        },
      });
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
    if (method === 'POST' && pathname === '/api/admin/snapshot') return json(await snapshotWeek(env, body.week || null));
    if (method === 'POST' && pathname === '/api/admin/scan-jobs') return json(await scanCompleted(env));
    if (method === 'POST' && pathname === '/api/admin/backfill-start') return json(await startBackfill(env, Number(body.months) || 24));
    if (method === 'POST' && pathname === '/api/admin/backfill-step') return json(await backfillStep(env));
    if (method === 'POST' && pathname === '/api/admin/recompute-stages') return json(await recomputeStages(env));
    if (method === 'GET' && pathname === '/api/admin/ra-library') return json({ items: await Pow.raLibrary(env, { includeInactive: true }) });
    if (method === 'POST' && pathname === '/api/admin/ra-save') return json(await Pow.saveRa(env, body));
    if (method === 'POST' && pathname === '/api/admin/send-alerts') return json(await sendAlerts(env));

    if (method === 'POST' && pathname === '/api/admin/set-role') {
      const role = String(body.role || '');
      const team = body.team ? String(body.team) : null;
      if (!body.accountId || !ROLES.includes(role)) return json({ error: 'Choose an engineer and a role.' }, 400);
      if (team && !TEAMS.includes(team)) return json({ error: 'Unknown team.' }, 400);
      await env.DB.prepare('UPDATE employees SET role = ?, team = ? WHERE account_id = ?')
        .bind(role, team, body.accountId).run();
      return json({ ok: true });
    }
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
  const base = {
    user: { email: user.email, role: user.role, team: user.team, isAdmin: user.isAdmin, isLead: user.isLead },
    jiraBaseUrl: env.JIRA_BASE_URL,
    ledgerStart: await getState(env, 'ledger_start'),
  };
  const emp = user.employee;
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
      team: emp.team,
      elo: emp.elo,
      baseline: emp.baseline,
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
  const [employees, unmatched, state, alerts, jobs] = await Promise.all([
    env.DB.prepare(
      `SELECT e.account_id, e.name, e.email, e.profile_key, e.elo, e.jira_xp, e.opening_xp, e.role, e.team,
              COALESCE(SUM(l.xp), 0) AS ledger_xp, COUNT(l.worklog_id) AS worklogs
         FROM employees e LEFT JOIN xp_ledger l ON l.account_id = e.account_id
        GROUP BY e.account_id ORDER BY e.name`
    ).all(),
    env.DB.prepare(
      `SELECT account_id, COUNT(*) AS worklogs, SUM(seconds) AS seconds, MAX(work_date) AS latest
         FROM unmatched_worklogs GROUP BY account_id ORDER BY worklogs DESC LIMIT 50`
    ).all(),
    env.DB.prepare('SELECT key, value FROM sync_state').all(),
    env.DB.prepare('SELECT id, kind, subject, body, created_at, sent_at FROM alerts ORDER BY id DESC LIMIT 20').all(),
    backfillStatus(env),
  ]);

  return {
    employees: employees.results.map((e) => ({
      ...e,
      app_xp: e.opening_xp + e.ledger_xp,
      difference: e.opening_xp + e.ledger_xp - e.jira_xp,
    })),
    unmatched: unmatched.results,
    alerts: alerts.results,
    jobs,
    mailRelay: Boolean(env.ALERT_WEBHOOK_URL),
    state: Object.fromEntries(state.results.map((r) => [r.key, r.value])),
  };
}
