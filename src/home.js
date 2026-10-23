// The rotating strip at the top of the home screen: alerts for this person,
// news from admins, and how their week is going. Admins send the alerts and
// news; the hub adds alerts of its own for things already waiting on someone.
import { londonDate, mondayOf, raiseAlert } from './sync.js';
import { record } from './audit.js';
import { teamsOf, TEAMS } from './permissions.js';
import { pendingDisputes } from './disputes.js';
import * as Modifiers from './modifiers.js';
import * as Eotq from './eotq.js';
import { workDaysOf, weekHoursOf, weekdayOf, daysToShow } from './hours.js';
import { overForLead, overtimeHours } from './overtime.js';

const DAY_MS = 86_400_000;
const KINDS = ['alert', 'announcement'];
const TONES = ['info', 'important'];
const DISCIPLINES = { software: 'Software', hardware: 'Hardware', engineering: 'Site visit', condor: 'Condor' };
const readerOf = (viewer) => viewer.accountId || viewer.email;
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listWords = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function reaches(audience, viewer) {
  if (audience.everyone) return true;
  if ((audience.people || []).includes(viewer.accountId)) return true;
  return (audience.teams || []).some((t) => (viewer.teams || []).includes(t));
}

// Links go to a page in the hub or to a web address, nothing else.
function cleanLink(v) {
  const link = clean(v, 500);
  if (!link) return null;
  if (/^#\/[a-z0-9/-]*$/i.test(link) || /^https:\/\/[^\s"'<>]+$/i.test(link)) return link;
  throw new Error('The link needs to be a page in the hub or a web address starting https://.');
}

// ---------- what each person sees ----------

export async function feed(env, viewer) {
  const now = new Date().toISOString();
  const reader = readerOf(viewer);
  const { results } = await env.DB.prepare(
    `SELECT m.*, r.dismissed_at FROM home_messages m
       LEFT JOIN home_message_reads r ON r.message_id = m.id AND r.account_id = ?
      WHERE m.ended_at IS NULL AND (m.starts_at IS NULL OR m.starts_at <= ?) AND (m.ends_at IS NULL OR m.ends_at > ?)
      ORDER BY m.id DESC LIMIT 200`
  ).bind(reader, now, now).all();
  const mine = results.filter((m) => !m.dismissed_at && reaches(parse(m.audience, {}), viewer));
  const shape = (m) => ({ id: m.id, title: m.title, body: m.body, link: m.link, tone: m.tone, from: m.created_by_name, at: m.created_at });

  // Who has seen what, so admins can tell a message has been read.
  if (mine.length) {
    await env.DB.batch(mine.map((m) => env.DB.prepare(
      'INSERT INTO home_message_reads (message_id, account_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(message_id, account_id) DO NOTHING'
    ).bind(m.id, reader, now)));
  }

  const [system, week, anniversaries] = await Promise.all([systemAlerts(env, viewer).catch(() => []), weekSoFar(env, viewer),
    Eotq.anniversaries(env).catch(() => [])]);
  const important = (a) => (a.tone === 'important' ? 0 : 1);
  return {
    alerts: [...mine.filter((m) => m.kind === 'alert').map(shape), ...system].sort((a, b) => important(a) - important(b)),
    news: [...Eotq.anniversaryNews(anniversaries, viewer), ...mine.filter((m) => m.kind === 'announcement').map(shape)].sort((a, b) => important(a) - important(b)),
    week,
  };
}

export async function dismiss(env, viewer, id) {
  if (String(id).startsWith('eotq:')) return Eotq.dismiss(env, viewer, id);
  const over = /^overtime:(\d{4}-\d{2}-\d{2}):([\w:.-]{1,128})$/.exec(String(id));
  if (over) {
    await env.DB.prepare('INSERT INTO home_dismissals (account_id, item, at) VALUES (?, ?, ?) ON CONFLICT(account_id, item) DO NOTHING')
      .bind(readerOf(viewer), String(id), new Date().toISOString()).run();
    return { ok: true };
  }
  const news = /^(order-new|psc-added):([A-Z0-9,-]{3,600})$/.exec(String(id));
  if (news) {
    const now = new Date().toISOString();
    const items = [...new Set(news[2].split(',').filter((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k)))].slice(0, 30);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM home_dismissals WHERE at < ?').bind(new Date(Date.now() - 30 * DAY_MS).toISOString()),
      ...items.map((k) => env.DB.prepare('INSERT INTO home_dismissals (account_id, item, at) VALUES (?, ?, ?) ON CONFLICT(account_id, item) DO NOTHING')
        .bind(readerOf(viewer), `${news[1]}:${k}`, now)),
    ]);
    return { ok: true };
  }
  await env.DB.prepare(
    `INSERT INTO home_message_reads (message_id, account_id, seen_at, dismissed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, account_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`
  ).bind(Number(id), readerOf(viewer), new Date().toISOString(), new Date().toISOString()).run();
  return { ok: true };
}

// Things already waiting on this person elsewhere in the hub. Each one goes
// away by itself once it's dealt with, so there's nothing to dismiss.
async function systemAlerts(env, viewer) {
  const out = [];
  const me = viewer.accountId;
  const today = londonDate();

  if (me) {
    const { results: asks } = await env.DB.prepare(
      `SELECT r.id, r.discipline, q.title, q.customer, e.name AS asker FROM quote_requests r
         JOIN quotes q ON q.id = r.quote_id LEFT JOIN employees e ON e.account_id = r.requested_by
        WHERE r.account_id = ? AND r.status = 'pending' ORDER BY r.id`
    ).bind(me).all();
    for (const a of asks) {
      out.push({ key: `quote:${a.id}`, tone: 'info', title: `${a.asker || 'Someone'} would like your estimate`,
        body: `${a.title}${a.customer ? ` for ${a.customer}` : ''}, ${DISCIPLINES[a.discipline] || a.discipline}.`, link: '#/quotes' });
    }

    const { results: pscs } = await env.DB.prepare(
      `SELECT issue_key, summary, org, project_key, team_first_at, team_last_at, customer_last_at, customer_last_by FROM psc_items
        WHERE assignee_id = ? AND done = 0 AND issuetype NOT IN ('Snag', 'Sub-Snag') AND LOWER(TRIM(COALESCE(status, ''))) != 'admin'`
    ).bind(me).all();
    const waiting = pscs.filter((p) => p.customer_last_at && p.team_first_at && p.customer_last_at > (p.team_last_at || ''));
    if (waiting.length === 1) {
      const p = waiting[0];
      out.push({ key: `psc-waiting:${p.issue_key}`, tone: 'important', title: `${p.customer_last_by || 'The customer'} is waiting on you`,
        body: `They replied on ${p.issue_key}, ${p.summary}.`, link: '#/psc' });
    } else if (waiting.length > 1) {
      out.push({ key: 'psc-waiting', tone: 'important', title: `${plural(waiting.length, 'customer')} waiting on you`,
        body: `${listWords(waiting.slice(0, 3).map((p) => p.issue_key))}${waiting.length > 3 ? ' and more' : ''} have replies you haven't answered.`, link: '#/psc' });
    }
    const unlooked = pscs.filter((p) => !p.team_first_at);
    if (unlooked.length) {
      out.push({ key: 'psc-unlooked', tone: 'important', title: unlooked.length === 1 ? `${unlooked[0].issue_key} is yours and needs a first look` : `${plural(unlooked.length, 'PSC')} of yours need a first look`,
        body: unlooked.length === 1 ? unlooked[0].summary : listWords(unlooked.slice(0, 3).map((p) => p.issue_key)), link: '#/psc' });
    }

    const { results: bookings } = await env.DB.prepare(
      `SELECT b.id, b.vehicle_id, b.starts_at, v.registration FROM vehicle_bookings b LEFT JOIN vehicles v ON v.id = b.vehicle_id
        WHERE b.account_id = ? AND substr(b.starts_at, 1, 10) = ?
          AND NOT EXISTS (SELECT 1 FROM vehicle_checks c WHERE c.vehicle_id = b.vehicle_id AND c.account_id = b.account_id AND c.created_at >= ?)`
    ).bind(me, today, `${today}T00:00:00`).all();
    for (const b of bookings) {
      out.push({ key: `vehicle:${b.id}`, tone: 'info', title: `${b.registration || 'Your vehicle'} is booked for you today`,
        body: `From ${b.starts_at.slice(11, 16)}. Do the walkaround check before you drive.`, link: '#/vehicles' });
    }

    // Release notes for Condor work this person did that still need writing.
    const notes = await (await import('./release-notes.js')).waitingFor(env, me).catch(() => 0);
    if (notes) {
      out.push({ key: 'release-notes', tone: 'info', title: notes === 1 ? 'A release note to write' : `${plural(notes, 'release note')} to write`,
        body: 'For Condor tickets of yours going in the release notes.', link: '#/condor?notes' });
    }

    // Time on a service contract item that hasn't been said to be chargeable or not.
    const undecided = await (await import('./contracts.js')).myUndecided(env, me).catch(() => []);
    if (undecided.length) {
      const first = undecided[0];
      out.push({ key: 'contract-charge', tone: 'important', title: undecided.length === 1 ? `Is your time on ${first.issue_key} chargeable?` : `${plural(undecided.length, 'bit')} of contract time need a chargeable answer`,
        body: undecided.length === 1 ? `${first.customer || first.issue_key}, ${first.work_date}. Only chargeable time goes on their token clock.`
          : 'Only chargeable time goes on a customer\'s token clock.', link: `#/contracts?charge` });
    }

    // Employee of the Quarter: weekly, then daily in the last week for anyone yet to nominate,
    // and a note when someone has nominated them.
    const [eotq, nominated] = await Promise.all([Eotq.reminder(env, viewer).catch(() => null), Eotq.nominatedAlert(env, viewer).catch(() => null)]);
    if (nominated) out.push(nominated);
    if (eotq) out.push(eotq);

    const timer = await env.DB.prepare('SELECT current FROM active_timers WHERE account_id = ?').bind(me).first().catch(() => null);
    const cur = parse(timer?.current, null);
    if (cur?.startedAt && Date.now() - Date.parse(cur.startedAt) > 10 * 3600_000) {
      out.push({ key: 'timer', tone: 'important', title: 'Your timer is still running', body: `It has been timing ${cur.issueKey || 'a job'} since ${new Date(cur.startedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Stop it, or say when you stopped.`, link: '#/log' });
    }
  }

  if ((viewer.teams || []).includes('Service') || viewer.isLead) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM psc_items p WHERE p.done = 0 AND p.assignee_id IS NULL AND p.team_first_at IS NULL
          AND p.issuetype NOT IN ('Snag', 'Sub-Snag') AND NOT (p.project_key = 'PSC' AND p.org IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM psc_actions a WHERE a.issue_id = p.issue_id)`
    ).first().catch(() => ({ n: 0 }));
    if (row?.n) out.push({ key: 'psc-new', tone: 'important', title: row.n === 1 ? '1 new PSC needs picking up' : `${row.n} new PSCs need picking up`, body: 'Nobody has them or has looked at them yet.', link: '#/psc' });
  }

  out.push(...await overtimeAlerts(env, viewer, today).catch(() => []));
  out.push(...await newOrderAlerts(env, viewer).catch(() => []));
  out.push(...await newPscAlerts(env, viewer).catch(() => []));

  if (viewer.isLead) {
    const [disputes, modifiers] = await Promise.all([pendingDisputes(env, viewer), Modifiers.pending(env, viewer)]);
    if (disputes.length) out.push({ key: 'disputes', tone: 'info', title: `${plural(disputes.length, 'dispute')} to decide`, body: listWords([...new Set(disputes.map((d) => d.raised_by || 'Someone'))].slice(0, 3)) + ' think a job was harder than quoted.', link: '#/jobs' });
    if (modifiers.length) out.push({ key: 'modifiers', tone: 'info', title: `${plural(modifiers.length, 'request')} to take something into account`, body: `From ${listWords([...new Set(modifiers.map((m) => m.name || 'someone'))].slice(0, 3))}.`, link: '#/jobs' });
  }

  if (viewer.isAdmin || (viewer.leads || []).includes('Service')) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM contract_flags WHERE resolved_at IS NULL').first().catch(() => ({ n: 0 }));
    if (row?.n) out.push({ key: 'contracts', tone: 'info', title: `${plural(row.n, 'contract problem')} to look at`, body: 'Dates, acceptance or PSCs missing an Organization.', link: '#/contracts' });
  }
  return out;
}

// Someone in a team this person leads has gone over their contracted hours this week.
async function overtimeAlerts(env, viewer, today) {
  if (!viewer.groups?.includes('lead')) return [];
  const over = await overForLead(env, viewer, today);
  if (!over.length) return [];
  const ids = over.map((o) => `overtime:${o.monday}:${o.accountId}`);
  const { results } = await env.DB.prepare(`SELECT item FROM home_dismissals WHERE account_id = ? AND item IN (${ids.map(() => '?').join(', ')})`)
    .bind(readerOf(viewer), ...ids).all();
  const gone = new Set(results.map((r) => r.item));
  return over.filter((o) => !gone.has(`overtime:${o.monday}:${o.accountId}`)).map((o) => ({
    id: `overtime:${o.monday}:${o.accountId}`, key: `overtime:${o.accountId}`, tone: 'info',
    title: `${o.name} is over their contracted hours`,
    body: `${overtimeHours(o.seconds)} logged this week, against ${overtimeHours(o.limit)}. Time over that earns 1.5x XP.`, link: '#/reports',
  }));
}

const ORDER_DAYS = 7;
const PSC_DAYS = 2;
const DIVISION_TEAM = { ProjectsTeam: 'Projecting', ServiceTeam: 'Service' };
const DIVISION_WORD = { ProjectsTeam: 'Projecting', ServiceTeam: 'Service' };

async function dismissedOf(env, viewer, prefix, keys) {
  if (!keys.length) return new Set();
  const { results } = await env.DB.prepare(
    `SELECT item FROM home_dismissals WHERE account_id = ? AND item IN (${keys.map(() => '?').join(', ')})`
  ).bind(readerOf(viewer), ...keys.map((k) => `${prefix}:${k}`)).all();
  return new Set(results.map((r) => r.item.slice(prefix.length + 1)));
}

// One alert each for up to three, then one alert covering the lot.
function grouped(prefix, rows, one, many) {
  if (rows.length <= 3) return rows.map((r) => ({ id: `${prefix}:${r.issue_key}`, key: `${prefix}:${r.issue_key}`, ...one(r) }));
  const keys = rows.slice(0, 30).map((r) => r.issue_key);
  return [{ id: `${prefix}:${keys.join(',')}`, key: prefix, ...many(rows) }];
}

// New orders to the leads of the team they're for. While an order's division
// isn't known yet, both teams' leads see it.
async function newOrderAlerts(env, viewer) {
  const leads = (viewer.leads || []).filter((t) => t === 'Projecting' || t === 'Service');
  if (!leads.length || !viewer.groups?.includes('lead')) return [];
  const since = new Date(Date.now() - ORDER_DAYS * DAY_MS).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT o.issue_key, o.summary, o.org, o.created, COALESCE(v.division, s.division, o.division_jira) AS division
       FROM wip_orders o LEFT JOIN wip_overrides v ON v.issue_key = o.issue_key LEFT JOIN wip_seed s ON s.issue_key = o.issue_key
      WHERE o.created >= ? AND o.gone = 0 ORDER BY o.created DESC LIMIT 60`
  ).bind(since).all();
  const mine = results.filter((o) => {
    const team = DIVISION_TEAM[o.division];
    return team ? leads.includes(team) : true;
  });
  const gone = await dismissedOf(env, viewer, 'order-new', mine.map((o) => o.issue_key));
  const fresh = mine.filter((o) => !gone.has(o.issue_key));
  return grouped('order-new', fresh,
    (o) => ({ tone: 'info', title: `New order ${o.issue_key}${o.org ? ` from ${o.org}` : ''}`,
      body: `${o.summary || 'No title yet'}. ${DIVISION_WORD[o.division] ? `${DIVISION_WORD[o.division]} order.` : 'Division not set yet.'}`, link: '#/jobs' }),
    (rows) => ({ tone: 'info', title: `${plural(rows.length, 'new order')} this week`,
      body: `${listWords(rows.slice(0, 3).map((o) => o.issue_key))}${rows.length > 3 ? ' and more' : ''}.`, link: '#/jobs' }));
}

// Every new PSC to everyone in the Service team, until they've seen it.
async function newPscAlerts(env, viewer) {
  if (!(viewer.teams || []).includes('Service')) return [];
  const since = new Date(Date.now() - PSC_DAYS * DAY_MS).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT issue_key, summary, org, project_key, issuetype, reporter_name, created_at FROM psc_items
      WHERE done = 0 AND created_at >= ? AND issuetype NOT IN ('Snag', 'Sub-Snag') ORDER BY created_at DESC LIMIT 60`
  ).bind(since).all();
  const myName = viewer.employee?.name || viewer.name;
  const others = results.filter((p) => !myName || p.reporter_name !== myName);
  const gone = await dismissedOf(env, viewer, 'psc-added', others.map((p) => p.issue_key));
  const fresh = others.filter((p) => !gone.has(p.issue_key));
  return grouped('psc-added', fresh,
    (p) => ({ tone: 'info', title: `New ${p.issuetype || 'PSC'} ${p.issue_key}${p.org ? ` for ${p.org}` : ''}`,
      body: `${p.summary || 'No summary'}${p.reporter_name ? `, raised by ${p.reporter_name}` : ''}.`, link: `#/psc?item=${p.issue_key}` }),
    (rows) => ({ tone: 'info', title: `${plural(rows.length, 'new PSC')} in the last two days`,
      body: `${listWords(rows.slice(0, 3).map((p) => p.issue_key))}${rows.length > 3 ? ' and more' : ''}.`, link: '#/psc' }));
}

// Monday to today on the days this person works, plus any other day they logged
// time on. Days before today with nothing logged are pointed out. Time logged
// ahead doesn't count yet.
async function weekSoFar(env, viewer) {
  const today = londonDate();
  const monday = mondayOf(today);
  const all = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${monday}T12:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10));
  if (!viewer.accountId) return null;
  const { results } = await env.DB.prepare(
    'SELECT work_date, SUM(seconds) AS seconds FROM xp_ledger WHERE account_id = ? AND work_date BETWEEN ? AND ? GROUP BY work_date'
  ).bind(viewer.accountId, monday, today).all();
  const by = new Map(results.map((r) => [r.work_date, r.seconds]));
  const workDays = workDaysOf(viewer.employee?.work_days);
  const days = daysToShow(all, workDays, by);
  return {
    seconds: results.reduce((t, r) => t + r.seconds, 0),
    target: weekHoursOf(viewer.employee) * 3600,
    days: days.map((d) => ({ date: d, seconds: by.get(d) || 0, past: d < today, today: d === today })),
    missing: days.filter((d) => d < today && !by.get(d) && workDays.includes(weekdayOf(d))),
  };
}

// ---------- admins: sending and ending ----------

export async function adminList(env) {
  const { results } = await env.DB.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM home_message_reads r WHERE r.message_id = m.id) AS seen,
            (SELECT COUNT(*) FROM home_message_reads r WHERE r.message_id = m.id AND r.dismissed_at IS NOT NULL) AS dismissed
       FROM home_messages m ORDER BY m.id DESC LIMIT 100`
  ).all();
  const { results: people } = await env.DB.prepare(
    'SELECT account_id, name, teams, team FROM employees WHERE active = 1 AND account_id NOT LIKE ? ORDER BY name'
  ).bind('pending:%').all();
  const now = new Date().toISOString();
  const shaped = people.map((p) => ({ id: p.account_id, name: p.name, teams: teamsOf(p) }));
  return {
    teams: TEAMS,
    people: shaped,
    messages: results.map((m) => {
      const audience = parse(m.audience, {});
      const reach = shaped.filter((p) => audience.everyone || (audience.people || []).includes(p.id) || (audience.teams || []).some((t) => p.teams.includes(t))).length;
      return { id: m.id, kind: m.kind, title: m.title, body: m.body, link: m.link, tone: m.tone, audience, reach, seen: m.seen, dismissed: m.dismissed,
        emailed: Boolean(m.emailed), from: m.created_by_name, at: m.created_at, endsAt: m.ends_at,
        live: !m.ended_at && (!m.ends_at || m.ends_at > now), endedAt: m.ended_at || (m.ends_at && m.ends_at <= now ? m.ends_at : null),
        audienceText: audience.everyone ? 'Everyone' : [...(audience.teams || []).map((t) => `${t} team`), ...(audience.people || []).map((id) => shaped.find((p) => p.id === id)?.name || 'someone who has left')].join(', ') };
    }),
  };
}

export async function send(env, viewer, input) {
  // A shout-out goes to everyone as news for a week, thanking one person.
  if (input.kind === 'shoutout') return Eotq.giveShoutout(env, viewer, input);
  const kind = KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) throw new Error('Choose whether it\'s an alert or news.');
  const title = clean(input.title, 120);
  if (title.length < 3) throw new Error('Give it a title.');
  const body = clean(input.body, 1000) || null;
  const link = cleanLink(input.link);
  const tone = TONES.includes(input.tone) ? input.tone : 'info';
  const everyone = Boolean(input.everyone);
  const teams = everyone ? [] : [...new Set(input.teams || [])].filter((t) => TEAMS.includes(t));
  const { results: staff } = await env.DB.prepare('SELECT account_id, name, email, teams, team FROM employees WHERE active = 1').all();
  const people = everyone ? [] : [...new Set(input.people || [])].filter((id) => staff.some((s) => s.account_id === id));
  if (!everyone && !teams.length && !people.length) throw new Error('Choose who it\'s for.');
  let endsAt = null;
  if (input.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until)) throw new Error('The end date isn\'t a date.');
    if (input.until < londonDate()) throw new Error('The end date has already passed.');
    endsAt = new Date(Date.parse(`${input.until}T23:59:59Z`)).toISOString();
  }
  const audience = { everyone, teams, people };
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO home_messages (kind, title, body, link, tone, audience, starts_at, ends_at, emailed, created_by, created_by_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(kind, title, body, link, tone, JSON.stringify(audience), now, endsAt, input.email ? 1 : 0, viewer.email, viewer.employee?.name || viewer.email, now).run();
  const id = res.meta.last_row_id;

  let emailed = 0;
  if (input.email) {
    const reached = staff.filter((s) => s.email && reaches(audience, { accountId: s.account_id, teams: teamsOf(s) }));
    for (const s of reached) {
      await raiseAlert(env, { kind: 'home-message', dedupe: `home-message:${id}:${s.account_id}`, recipient: s.email,
        subject: title, body: `${body || title}\n\nFrom ${viewer.employee?.name || viewer.email}, on the Promtek Hub home screen.` });
      emailed++;
    }
  }
  await record(env, viewer, { area: 'Home messages', action: 'sent', subjectType: 'home-message', subjectId: id, label: title,
    changes: [{ field: 'audience', label: 'Who for', before: '', after: everyone ? 'Everyone' : [...teams.map((t) => `${t} team`), ...people.map((p) => staff.find((s) => s.account_id === p)?.name || p)].join(', ') },
      { field: 'kind', label: 'Shown as', before: '', after: kind === 'alert' ? 'Alert' : 'News' }] });
  return { id, emailed };
}

export async function end(env, viewer, id) {
  const m = await env.DB.prepare('SELECT * FROM home_messages WHERE id = ?').bind(Number(id)).first();
  if (!m) throw new Error('That message has gone.');
  if (m.ended_at) return { ok: true };
  await env.DB.prepare('UPDATE home_messages SET ended_at = ?, ended_by = ? WHERE id = ?').bind(new Date().toISOString(), viewer.email, m.id).run();
  await record(env, viewer, { area: 'Home messages', action: 'ended', subjectType: 'home-message', subjectId: m.id, label: m.title });
  return { ok: true };
}
