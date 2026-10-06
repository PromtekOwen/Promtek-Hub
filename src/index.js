// Promtek Hub Worker: serves the web app and the /api routes, and runs the
// scheduled Tempo sync.
import { getUser } from './auth.js';
import { findAccountIdByEmail } from './jira.js';
import { progressFor } from './progression.js';
import * as Elo from './elo.js';
import * as Disputes from './disputes.js';
import * as Modifiers from './modifiers.js';
import * as Quotes from './quotes.js';
import * as Audit from './audit.js';
import { access, TEAMS as ALL_TEAMS } from './permissions.js';
import * as OrgDocs from './orgdocs.js';
import { getState, pollRecent, refreshProfiles, runScheduled, startLedger, londonDate, snapshotWeek, sendAlerts } from './sync.js';
import { teamWeeks, engineerReport, leaderboard, exportCsv } from './reports.js';
import * as Pow from './pow.js';
import * as It from './itsupport.js';
import * as Vehicles from './vehicles.js';
import * as Calls from './calls.js';
import * as Shop from './shop.js';
import * as Obs from './obsolescence.js';
import * as Org from './org.js';
import * as People from './people.js';
import { browse, shortcuts, search, stageHint, createWorklog, createPsc, flagMissingStage } from './logging.js';
import { scanCompleted, scanCategories, backfillStep, startBackfill, quotingSummary, backfillStatus, stageLibrary, difficultyAnalysis, recomputeStages } from './jobs.js';

const ROLES = ['engineer', 'lead', 'admin'];

const rowOf = (env, table, key, id) => (id ? env.DB.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).bind(id).first() : null);

// Employee changes are logged, and checked against the chart for its next version.
async function auditedPerson(env, user, id, action, run) {
  const before = await rowOf(env, 'employees', 'account_id', id);
  const result = await run();
  const after = await rowOf(env, 'employees', 'account_id', result?.accountId || id);
  const changes = Audit.diff('employees', before, after);
  // Managers are stored by account ID; the log shows who they are.
  for (const c of changes.filter((x) => x.field === 'manager_id')) {
    c.before = (await rowOf(env, 'employees', 'account_id', before?.manager_id))?.name || c.before;
    c.after = (await rowOf(env, 'employees', 'account_id', after?.manager_id))?.name || c.after;
  }
  if (changes.length || !after) {
    await Audit.record(env, user, { area: 'Employees', action: action(before, after), subjectType: 'employee',
      subjectId: after?.account_id || id, label: after?.name || before?.name, changes });
  }
  await OrgDocs.track(env, user, before, after);
  return result;
}

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
      return json({ error: err.message }, err.status || 500);
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
  return { ...user, employee: emp, accountId: emp?.account_id || null, ...access(emp, { fallbackAdmin: user.isAdmin }) };
}

// Developers can reach the hub's technical side of Admin, and nothing else there.
const DEVELOPER_ADMIN = new Set(['/api/admin/overview', '/api/admin/sync-now', '/api/admin/bitbucket', '/api/admin/bitbucket-test',
  '/api/admin/bitbucket-poll', '/api/admin/send-alerts', '/api/admin/test-8x8']);

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

  if (method === 'GET' && pathname === '/api/prefs/tiles') {
    const row = await env.DB.prepare('SELECT tile_order, hidden_tiles FROM user_prefs WHERE account_id = ?')
      .bind(user.accountId || user.email).first();
    return json({
      order: row?.tile_order ? JSON.parse(row.tile_order) : null,
      hidden: row?.hidden_tiles ? JSON.parse(row.hidden_tiles) : [],
    });
  }
  if (method === 'POST' && pathname === '/api/prefs/tiles') {
    const body = await request.json().catch(() => ({}));
    await env.DB.prepare(
      `INSERT INTO user_prefs (account_id, tile_order, hidden_tiles, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET tile_order = excluded.tile_order,
         hidden_tiles = excluded.hidden_tiles, updated_at = excluded.updated_at`
    ).bind(user.accountId || user.email, JSON.stringify(body.order || []), JSON.stringify(body.hidden || []),
      new Date().toISOString()).run();
    return json({ ok: true });
  }

  if (method === 'GET' && pathname === '/api/org') {
    const latest = await OrgDocs.current(env);
    return json({ ...(await Org.chart(env)), document: { reference: latest.reference, issuedAt: latest.issued_at } });
  }

  if (pathname.startsWith('/api/obs')) {
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    const sales = user.can.quotes || user.inTeam('Sales');

    if (method === 'GET' && pathname === '/api/obs/config') {
      return json({ sections: Obs.SECTIONS, cardTypes: Obs.CARD_TYPES, conditions: Obs.CONDITIONS, sales });
    }
    if (method === 'GET' && pathname === '/api/obs/library') return json(await Obs.library(env, url.searchParams.get('kind')));
    if (method === 'GET' && pathname === '/api/obs/reports') return json(await Obs.listReports(env));
    if (method === 'GET' && pathname === '/api/obs/surveys') return json(await Obs.listSurveys(env, user, { all: url.searchParams.get('all') === '1' }));
    if (method === 'GET' && pathname === '/api/obs/survey') return json(await Obs.getSurvey(env, user, url.searchParams.get('id')));
    if (method === 'GET' && pathname === '/api/obs/pdf') {
      const { bytes, filename } = await Obs.renderPdf(env, user, url.searchParams.get('id'));
      return new Response(bytes, {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="${filename}"`,
          'cache-control': 'no-store',
        },
      });
    }
    if (method === 'GET' && pathname === '/api/obs/sales') {
      if (!sales) return json({ error: 'The sales review is for the sales team.' }, 403);
      return json(await Obs.salesQueue(env));
    }
    if (method === 'POST' && pathname === '/api/obs/draft') return json(await Obs.saveSurvey(env, user, body));
    if (method === 'POST' && pathname === '/api/obs/submit') return json(await Obs.submitSurvey(env, user, body));
    if (method === 'POST' && pathname === '/api/obs/delete') return json(await Obs.deleteSurvey(env, user, body.id));
    if (method === 'POST' && pathname === '/api/obs/quote') {
      if (!sales) return json({ error: 'Only the sales team can decide on quotes.' }, 403);
      return json(await Obs.quoteDecision(env, user, body));
    }
  }

  if (pathname.startsWith('/api/shop')) {
    // Demonstration only: admins can look, and nothing here spends anything.
    if (!user.can.shop) return json({ error: 'The shop is still being worked on.' }, 403);
    const totals = user.accountId
      ? await env.DB.prepare('SELECT COALESCE(SUM(xp), 0) AS xp FROM xp_ledger WHERE account_id = ?').bind(user.accountId).first()
      : { xp: 0 };
    const xp = (user.employee?.opening_xp || 0) + (totals?.xp || 0);
    if (method === 'GET' && pathname === '/api/shop') return json(Shop.catalogue(env, user, xp));
    if (method === 'GET' && pathname === '/api/shop/simulate') {
      return json(Shop.simulate(xp, url.searchParams.get('reward')));
    }
  }

  if (pathname.startsWith('/api/calls')) {
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (method === 'GET' && pathname === '/api/calls') {
      return json(await Calls.myCalls(env, user, {
        date: url.searchParams.get('date'),
        all: url.searchParams.get('all') === '1',
      }));
    }
    if (method === 'GET' && pathname === '/api/calls/customers') return json(await Calls.customerList(env));
    if (method === 'GET' && pathname === '/api/calls/pscs') return json(await Calls.openPscs(env, url.searchParams.get('projectKey')));
    if (method === 'POST' && pathname === '/api/calls/link') return json(await Calls.linkNumber(env, user, body));
    if (method === 'POST' && pathname === '/api/calls/handled') return json(await Calls.markHandled(env, user, body));
  }

  if (pathname.startsWith('/api/mes/')) {
    const Mes = await import('./mes.js');
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (method === 'GET' && pathname === '/api/mes/outstanding') {
      return json(await Mes.outstanding(env, user, { filter: url.searchParams.get('filter') || 'untriaged', query: url.searchParams.get('q') || '',
        releaseId: url.searchParams.get('release') || null }));
    }
    if (method === 'POST' && pathname === '/api/mes/question') return json(await Mes.nextQuestion(env, body));
    if (method === 'POST' && pathname === '/api/mes/estimate') return json(await Mes.saveEstimate(env, user, body));
    if (method === 'POST' && pathname === '/api/mes/triage') return json(await Mes.triage(env, user, body));
    if (method === 'GET' && pathname === '/api/mes/rating') return json(await Mes.ratingHistory(env, user, url.searchParams.get('accountId')));
    if (method === 'GET' && pathname === '/api/mes/team') return json({ team: await Mes.team(env, user) });
    const Plan = await import('./mes-plan.js');
    if (method === 'GET' && pathname === '/api/mes/plan') return json(await Plan.view(env, user, url.searchParams.get('versionId')));
    if (method === 'POST' && pathname === '/api/mes/capacity') {
      const before = await rowOf(env, 'mes_capacity', 'account_id', body.accountId);
      const r = await Plan.saveCapacity(env, user, body);
      const after = await rowOf(env, 'mes_capacity', 'account_id', body.accountId);
      const who = await rowOf(env, 'employees', 'account_id', body.accountId);
      await Audit.record(env, user, { area: 'Condor capacity', action: 'Capacity changed', subjectType: 'employee', subjectId: body.accountId,
        label: who?.name, changes: Audit.diff('mes_capacity', before, after) });
      return json(r);
    }
    if (method === 'POST' && pathname === '/api/mes/reserve') {
      const r = await Plan.saveReserve(env, user, body.percent);
      await Audit.record(env, user, { area: 'Condor capacity', action: 'Reserve changed', changes: [{ label: 'Kept free', before: '', after: `${body.percent}%` }] });
      return json(r);
    }
    if (method === 'POST' && pathname === '/api/mes/suggestion') return json(await Plan.decide(env, user, body));
    if (method === 'POST' && pathname === '/api/mes/accept-plan') return json(await Plan.accept(env, user, body.versionId));
    if (method === 'POST' && pathname === '/api/mes/release') {
      const r = await (await import('./mes-sprints.js')).createRelease(env, user, body);
      await Audit.record(env, user, { area: 'Condor releases', action: `Release ${r.name} started`, changes: [{ label: 'Dates', before: '', after: `${r.startDate} to ${r.releaseDate}` }] });
      return json(r);
    }
    if (method === 'POST' && pathname === '/api/mes/make-sprints') return json(await Plan.makeSprints(env, user, body.versionId));
  }

  if (pathname.startsWith('/api/devtime')) {
    const DevTime = await import('./devtime.js');
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (!user.accountId) return json({ days: [] });
    if (method === 'GET' && pathname === '/api/devtime/drafts') return json(await DevTime.drafts(env, user.accountId));
    if (method === 'POST' && pathname === '/api/devtime/log') return json(await DevTime.logDrafts(env, user, body));
    if (method === 'POST' && pathname === '/api/devtime/dismiss') return json(await DevTime.dismiss(env, user, body));
  }

  if (pathname.startsWith('/api/quotes')) {
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (method === 'GET' && pathname === '/api/quotes') return json(await Quotes.list(env, user, { scope: url.searchParams.get('scope') || 'open' }));
    if (method === 'GET' && pathname === '/api/quotes/get') return json(await Quotes.get(env, user, url.searchParams.get('id')));
    if (method === 'GET' && pathname === '/api/quotes/people') return json({ people: await Quotes.people(env) });
    if (method === 'GET' && pathname === '/api/quotes/customers') {
      const { customerList } = await import('./calls.js');
      return json(await customerList(env));
    }
    if (method === 'POST' && pathname === '/api/quotes/create') return json(await Quotes.create(env, user, body));
    if (method === 'POST' && pathname === '/api/quotes/section') return json(await Quotes.saveSection(env, user, body));
    if (method === 'POST' && pathname === '/api/quotes/status') return json(await Quotes.setStatus(env, user, body));
    if (method === 'POST' && pathname === '/api/quotes/description') return json(await Quotes.saveDescription(env, user, body));
    if (method === 'POST' && pathname === '/api/quotes/ask') return json(await Quotes.ask(env, user, body));
    if (method === 'POST' && pathname === '/api/quotes/answer') return json(await Quotes.answer(env, user, body));
    if (method === 'POST' && pathname === '/api/quotes/use-answer') return json(await Quotes.useAnswer(env, user, body.requestId));
    if (method === 'POST' && pathname === '/api/quotes/retry-jira') return json(await Quotes.retryJira(env, body.id));
    if (method === 'POST' && pathname === '/api/quotes/check-counts') return json(await Quotes.checkCounts(env, user, body));
  }

  if (pathname.startsWith('/api/jobs') || pathname.startsWith('/api/modifiers') || pathname === '/api/approvals') {
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (method === 'GET' && pathname === '/api/jobs') return json(await Disputes.listActive(env, user, { scope: url.searchParams.get('scope') || 'mine' }));
    if (method === 'GET' && pathname === '/api/jobs/category') return json(await Disputes.categoryDetail(env, url.searchParams.get('id')));
    if (method === 'POST' && pathname === '/api/jobs/dispute') return json(await Disputes.raiseDispute(env, user, body));
    if (method === 'POST' && pathname === '/api/jobs/dispute-withdraw') return json(await Disputes.withdrawDispute(env, user, body.id));
    if (method === 'POST' && pathname === '/api/jobs/dispute-decide') return json(await Disputes.decideDispute(env, user, body));
    if (method === 'GET' && pathname === '/api/approvals') {
      const [disputes, modifiers, supervised, countChecks] = await Promise.all([
        Disputes.pendingDisputes(env, user), Modifiers.pending(env, user), Modifiers.supervised(env, user), Quotes.pendingCountChecks(env, user)]);
      return json({ disputes, modifiers, supervised, countChecks });
    }
    if (method === 'GET' && pathname === '/api/modifiers') return json(await Modifiers.mine(env, user));
    if (method === 'POST' && pathname === '/api/modifiers/request') return json(await Modifiers.request(env, user, body));
    if (method === 'POST' && pathname === '/api/modifiers/end') return json(await Modifiers.end(env, user, body.id));
    if (method === 'POST' && pathname === '/api/modifiers/decide') return json(await Modifiers.decide(env, user, body));
  }

  if (pathname.startsWith('/api/it/')) {
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (method === 'GET' && pathname === '/api/it/options') return json(await It.options(env));
    if (method === 'GET' && pathname === '/api/it/assets') return json({ assets: await It.myAssets(env, user.accountId, url.searchParams.get('q')) });
    if (method === 'GET' && pathname === '/api/it/requests') return json(await It.myRequests(env, user, { all: url.searchParams.get('all') === '1' }));
    if (method === 'POST' && pathname === '/api/it/raise') return json(await It.raise(env, user, body));
    if (method === 'POST' && pathname === '/api/it/comment') return json(await It.comment(env, user, body));
  }

  if (pathname.startsWith('/api/vehicles')) {
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (method === 'GET' && pathname === '/api/vehicles') return json(await Vehicles.listVehicles(env));
    if (method === 'GET' && pathname === '/api/vehicles/week') return json(await Vehicles.weekBookings(env, url.searchParams.get('week') || londonDate()));
    if (method === 'GET' && pathname === '/api/vehicles/mine') return json(await Vehicles.myBookings(env, user));
    if (method === 'GET' && pathname === '/api/vehicles/check-schema') return json(Vehicles.checkSchema());
    if (method === 'GET' && pathname === '/api/vehicles/defects') return json(await Vehicles.listDefects(env, { status: url.searchParams.get('status') || 'open' }));
    if (method === 'POST' && pathname === '/api/vehicles/book') return json(await Vehicles.book(env, user, body));
    if (method === 'POST' && pathname === '/api/vehicles/cancel') return json(await Vehicles.cancelBooking(env, user, body.id));
    if (method === 'POST' && pathname === '/api/vehicles/check') return json(await Vehicles.submitCheck(env, user, body));
    if (method === 'POST' && pathname === '/api/vehicles/resolve-defect') {
      if (!user.isLead) return json({ error: 'Only team leads and admins can clear defects.' }, 403);
      return json(await Vehicles.resolveDefect(env, user, body));
    }
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
    return json(await leaderboard(env, { period: url.searchParams.get('period') || 'week', accountId: user.accountId, team: url.searchParams.get('team') || null }));
  }

  if (method === 'GET' && pathname === '/api/elo/history') {
    const accountId = url.searchParams.get('accountId') || user.accountId;
    if (!accountId) return json({ error: 'Your account isn\'t linked to a profile yet.' }, 404);
    if (accountId !== user.accountId && !user.isLead) return json({ error: 'Only team leads and admins can see someone else\'s history.' }, 403);
    const data = await Elo.history(env, accountId, user);
    return data ? json(data) : json({ error: 'No such person.' }, 404);
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
        team: url.searchParams.get('team') || null,
      }));
    }
    if (method === 'GET' && pathname === '/api/reports/stages') {
      const discipline = url.searchParams.get('discipline') || null;
      const [stages, difficulty] = await Promise.all([
        stageLibrary(env, { discipline, minJobs: Number(url.searchParams.get('minJobs')) || 2, team: url.searchParams.get('team') || null,
          customer: url.searchParams.get('customer') || null, groupBy: url.searchParams.get('group') || 'type' }),
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
        stageOptions: { discipline: url.searchParams.get('discipline') || null, team: url.searchParams.get('team') || null,
          customer: url.searchParams.get('customer') || null, groupBy: url.searchParams.get('group') || 'type' },
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
    if (!user.isAdmin && !(user.can.developer && DEVELOPER_ADMIN.has(pathname))) return json({ error: 'Only admins can do that.' }, 403);
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};

    if (method === 'GET' && pathname === '/api/admin/overview') return json(await adminOverview(env));
    if (method === 'GET' && pathname === '/api/admin/elo') return json(await Elo.status(env));
    if (method === 'GET' && pathname === '/api/admin/bitbucket') return json(await (await import('./devtime.js')).status(env));
    if (method === 'POST' && pathname === '/api/admin/bitbucket-test') return json(await (await import('./devtime.js')).testConnection(env));
    if (method === 'POST' && pathname === '/api/admin/bitbucket-poll') return json(await (await import('./devtime.js')).poll(env, { force: true }));
    if (method === 'GET' && pathname === '/api/admin/quote-config') return json(await Quotes.config(env));
    if (method === 'POST' && pathname === '/api/admin/quote-config') {
      const r = await Quotes.saveConfig(env, body);
      await Audit.record(env, user, { area: 'Settings', action: 'Quote counts and conditions changed' });
      return json(r);
    }
    if (method === 'POST' && pathname === '/api/admin/elo-start') {
      const r = await Elo.startEngine(env, body.from);
      await Audit.record(env, user, { area: 'Settings', action: 'ELO engine started', changes: [{ label: 'Rating jobs finished from', before: '', after: body.from }] });
      return json(r);
    }
    if (method === 'POST' && pathname === '/api/admin/elo-stop') {
      const r = await Elo.stopEngine(env);
      await Audit.record(env, user, { area: 'Settings', action: 'ELO engine paused' });
      return json(r);
    }
    if (method === 'GET' && pathname === '/api/admin/audit') {
      return json(await Audit.list(env, { area: url.searchParams.get('area') || '', q: url.searchParams.get('q') || '', before: url.searchParams.get('before') }));
    }
    if (method === 'GET' && pathname === '/api/admin/audit.csv') {
      return new Response(await Audit.csv(env, { area: url.searchParams.get('area') || '', q: url.searchParams.get('q') || '' }), {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="Promtek hub audit log ${new Date().toISOString().slice(0, 10)}.csv"` },
      });
    }
    if (method === 'GET' && pathname === '/api/admin/org') return json(await OrgDocs.status(env));
    if (method === 'POST' && pathname === '/api/admin/org-issue') {
      const r = await OrgDocs.issue(env, user, body);
      await Audit.record(env, user, { area: 'Company chart', action: `${r.reference} issued`, note: r.published ? 'Published to Confluence' : 'Waiting to reach Confluence' });
      return json(r);
    }
    if (method === 'POST' && pathname === '/api/admin/org-publish') return json({ published: await OrgDocs.publish(env, Number(body.n)) });
    if (method === 'POST' && pathname === '/api/admin/elo-step') return json(await Elo.rateStep(env));
    if (method === 'POST' && pathname === '/api/admin/elo-reverse') {
      const ev = await rowOf(env, 'elo_events', 'id', Number(body.id));
      const r = await Elo.reverseEvent(env, user, body.id);
      const who = ev && await rowOf(env, 'employees', 'account_id', ev.account_id);
      await Audit.record(env, user, { area: 'Settings', action: 'ELO rating undone', subjectType: 'employee', subjectId: ev?.account_id, label: who?.name,
        changes: [{ label: 'ELO', before: String(Math.round(r.elo + (ev?.delta || 0))), after: String(Math.round(r.elo)) }] });
      return json(r);
    }

    if (method === 'POST' && pathname === '/api/admin/start-ledger') {
      if (body.confirm !== 'START') return json({ error: 'Type START to confirm.' }, 400);
      const r = await startLedger(env);
      await Audit.record(env, user, { area: 'Settings', action: 'XP ledger started' });
      return json(r);
    }
    if (method === 'POST' && pathname === '/api/admin/refresh-profiles') return json(await refreshProfiles(env));
    if (method === 'POST' && pathname === '/api/admin/snapshot') return json(await snapshotWeek(env, body.week || null));
    if (method === 'POST' && pathname === '/api/admin/scan-jobs') {
      const orders = await scanCompleted(env);
      const categories = await scanCategories(env);
      return json({ ...orders, categories: categories.categories, rows: orders.rows + categories.rows });
    }
    if (method === 'POST' && pathname === '/api/admin/backfill-start') return json(await startBackfill(env, Number(body.months) || 24));
    if (method === 'POST' && pathname === '/api/admin/backfill-step') return json(await backfillStep(env));
    if (method === 'POST' && pathname === '/api/admin/recompute-stages') return json(await recomputeStages(env));
    if (method === 'GET' && pathname === '/api/admin/ra-library') return json({ items: await Pow.raLibrary(env, { includeInactive: true }) });
    if (method === 'POST' && pathname === '/api/admin/ra-save') return json(await Pow.saveRa(env, body));
    if (method === 'GET' && pathname === '/api/admin/it-types') {
      const map = await It.requestTypeMap(env);
      let jiraTypes = { types: [], serviceDeskId: null };
      try { jiraTypes = await It.jiraRequestTypes(env); } catch (err) { jiraTypes.error = err.message; }
      return json({
        categories: It.IT_CATEGORIES.map(([id, label]) => ({ id, label, mapped: map.get(id)?.request_type_id || null })),
        ...jiraTypes,
      });
    }
    if (method === 'POST' && pathname === '/api/admin/it-types') {
      const r = await It.saveRequestTypeMap(env, body);
      await Audit.record(env, user, { area: 'Settings', action: 'IT request types changed' });
      return json(r);
    }
    if (method === 'POST' && pathname === '/api/admin/vehicle') {
      const before = await rowOf(env, 'vehicles', 'id', body.id);
      const r = await Vehicles.saveVehicle(env, body);
      const after = await rowOf(env, 'vehicles', 'id', r.id);
      const changes = Audit.diff('vehicles', before, after);
      if (changes.length) {
        await Audit.record(env, user, { area: 'Vehicles', action: before ? 'Vehicle changed' : 'Vehicle added', subjectType: 'vehicle',
          subjectId: r.id, label: after?.registration, changes });
      }
      return json(r);
    }
    if (method === 'GET' && pathname === '/api/admin/vehicles') return json(await Vehicles.listVehicles(env, { includeInactive: true }));
    if (method === 'POST' && pathname === '/api/admin/vehicle-expiries') return json(await Vehicles.checkExpiries(env));
    if (method === 'POST' && pathname === '/api/admin/test-8x8') {
      try { return json(await Calls.testConnection(env)); } catch (err) { return json({ ok: false, error: err.message }); }
    }
    if (method === 'POST' && pathname === '/api/admin/set-extension') {
      await env.DB.prepare('UPDATE employees SET extension = ? WHERE account_id = ?')
        .bind(String(body.extension || '').trim() || null, body.accountId).run();
      return json({ ok: true });
    }
    if (method === 'POST' && pathname === '/api/admin/forget-number') return json(await Calls.forgetNumber(env, body.phone));
    if (method === 'POST' && pathname === '/api/admin/remove-employee') {
      const accountId = String(body.accountId || '');
      if (!accountId) return json({ error: 'Which person?' }, 400);
      if (body.keepHistory) {
        await env.DB.prepare('UPDATE employees SET active = 0, updated_at = ? WHERE account_id = ?')
          .bind(new Date().toISOString(), accountId).run();
        return json({ ok: true, kept: true });
      }
      // A full removal takes their XP history with them.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM xp_ledger WHERE account_id = ?').bind(accountId),
        env.DB.prepare('DELETE FROM weekly_snapshots WHERE account_id = ?').bind(accountId),
        env.DB.prepare('DELETE FROM unmatched_worklogs WHERE account_id = ?').bind(accountId),
        env.DB.prepare('DELETE FROM employees WHERE account_id = ?').bind(accountId),
      ]);
      return json({ ok: true, kept: false });
    }
    if (method === 'GET' && pathname === '/api/admin/people') return json({ ...(await People.listPeople(env)), icons: People.ICONS.map(([id, label]) => ({ id, label })), departments: Org.DEPARTMENTS.map(([name, colour]) => ({ name, colour })) });
    if (method === 'POST' && pathname === '/api/admin/person') {
      return json(await auditedPerson(env, user, body.accountId, (b) => (b ? 'Details changed' : 'Added'), () => People.savePerson(env, body)));
    }
    if (method === 'POST' && pathname === '/api/admin/person-id') {
      const who = await rowOf(env, 'employees', 'account_id', body.from);
      const r = await People.changeAccountId(env, body);
      await Audit.record(env, user, { area: 'Employees', action: 'Jira account ID changed', subjectType: 'employee', subjectId: body.to, label: who?.name,
        changes: [{ label: 'Jira account ID', before: body.from, after: body.to }] });
      return json(r);
    }
    if (method === 'POST' && pathname === '/api/admin/person-remove') {
      return json(await auditedPerson(env, user, body.accountId, (b, a) => (a ? 'Deactivated' : 'Removed with their history'), () => People.removePerson(env, body)));
    }
    if (method === 'POST' && pathname === '/api/admin/employees-source') {
      const r = await People.setSource(env, body.source);
      await Audit.record(env, user, { area: 'Settings', action: `Employees now kept in ${body.source === 'hub' ? 'the hub' : 'Jira'}` });
      return json(r);
    }
    if (method === 'POST' && pathname === '/api/admin/org-person') {
      return json(await auditedPerson(env, user, body.accountId, () => 'Chart details changed', () => Org.savePerson(env, body)));
    }
    if (method === 'POST' && pathname === '/api/admin/library-add') return json(await Obs.addLibraryEntry(env, body));
    if (method === 'POST' && pathname === '/api/admin/library-remove') return json(await Obs.removeLibraryEntry(env, body.id));
    if (method === 'POST' && pathname === '/api/admin/send-alerts') return json(await sendAlerts(env));

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
    user: { email: user.email, role: user.role, team: user.team, teams: user.teams, leads: user.leads, groups: user.groups, can: user.can,
      scopeTeams: user.scopeTeams, isAdmin: user.isAdmin, isLead: user.isLead },
    jiraBaseUrl: env.JIRA_BASE_URL,
    teamsList: ALL_TEAMS,
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
  const peak = (await Elo.peakElos(env)).get(emp.account_id) ?? null;
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
      rank: Elo.rankWithPeak(emp.elo, peak),
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
      `SELECT e.account_id, e.name, e.email, e.profile_key, e.elo, e.jira_xp, e.opening_xp, e.role, e.team, e.extension, e.active,
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
