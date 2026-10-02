// Turns Bitbucket activity into draft worklogs, so logging a day of
// development is a check and a tap rather than a job in itself.
import { searchJql } from './jira.js';
import { createWorklog } from './logging.js';
import { raiseAlert, londonDate } from './sync.js';

const KEY_PATTERN = /\b(MES-\d+)\b/gi;
const GAP_MS = 2 * 60 * 60_000;  // a longer pause than this starts a new block of work
const LUNCH_MS = 30 * 60_000;    // taken off a block that runs through 12:30
const LEAD_MS = 30 * 60_000;     // work starts a while before the first commit
const TAIL_MS = 15 * 60_000;
const ROUND_S = 15 * 60;
const DAYS_SHOWN = 7;

const keysIn = (...texts) => [...new Set(texts.join(' ').match(KEY_PATTERN)?.map((k) => k.toUpperCase()) || [])];

function londonParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

async function employeeIndex(env) {
  const { results } = await env.DB.prepare('SELECT account_id, email FROM employees WHERE active = 1').all();
  return {
    ids: new Set(results.map((e) => e.account_id)),
    byEmail: new Map(results.filter((e) => e.email).map((e) => [e.email.toLowerCase(), e.account_id])),
  };
}

// Bitbucket's account ID is the same Atlassian account as Jira; the email in a
// commit's author line covers commits made before the accounts were linked.
function whoIs(people, user, raw) {
  if (user?.account_id && people.ids.has(user.account_id)) return user.account_id;
  const email = String(raw || '').match(/<([^>]+)>/)?.[1]?.toLowerCase();
  return email ? people.byEmail.get(email) || null : null;
}

async function store(env, points) {
  const now = new Date().toISOString();
  let added = 0;
  for (const p of points) {
    const res = await env.DB.prepare(
      `INSERT INTO dev_activity (account_id, issue_key, at, day, kind, ref, repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    ).bind(p.accountId, p.key, p.at, londonParts(Date.parse(p.at)).day, p.kind, p.ref, p.repo, now).run();
    added += res.meta?.changes || 0;
  }
  return added;
}

// ---------- Reading Bitbucket ----------

const BB = 'https://api.bitbucket.org/2.0';
const POLL_MS = 15 * 60_000;
const OVERLAP_MS = 60 * 60_000;        // look back a little further than the last check
const FIRST_LOOK_MS = 3 * 86_400_000;  // the first check covers the last three days
// The free Workers plan allows 50 outside calls per run, shared with everything else.
export const BB_CALLS_PER_RUN = 30;

class OutOfCalls extends Error {}

function bbAuth(env) {
  const email = env.BITBUCKET_EMAIL || env.JIRA_EMAIL;
  return `Basic ${btoa(`${email}:${env.BITBUCKET_API_TOKEN}`)}`;
}

function bitbucketClient(env, maxCalls) {
  let calls = 0;
  const get = async (url) => {
    if (calls >= maxCalls) throw new OutOfCalls();
    calls++;
    const res = await fetch(url.startsWith('http') ? url : `${BB}${url}`, { headers: { Authorization: bbAuth(env), Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) throw new Error(`Bitbucket refused the token (${res.status}). Check it has the Bitbucket read scopes and hasn't expired.`);
    if (!res.ok) throw new Error(`Bitbucket ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  get.calls = () => calls;
  return get;
}

// Pages newest first, stopping once items are older than `since`.
async function newestFirst(get, url, dateOf, since) {
  const out = [];
  let next = url;
  while (next) {
    const page = await get(next);
    for (const item of page.values || []) {
      if (Date.parse(dateOf(item) || 0) < since) return out;
      out.push(item);
    }
    next = page.next || null;
  }
  return out;
}

// One check is a queue of small tasks (a repository, a branch, a pull request),
// worked through over as many runs as it takes, so no run goes over its calls.
export async function poll(env, { force = false, maxCalls = BB_CALLS_PER_RUN } = {}) {
  if (!env.BITBUCKET_API_TOKEN || !env.BITBUCKET_WORKSPACE) return { idle: true, skipped: "Bitbucket isn't set up" };
  const state = JSON.parse((await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'bitbucket_poll'").first())?.value || '{}');
  const now = Date.now();
  let queue = state.queue || [];
  if (!queue.length && !force && state.at && now - Date.parse(state.at) < POLL_MS) return { idle: true, skipped: 'Checked recently' };

  const get = bitbucketClient(env, maxCalls);
  const people = await employeeIndex(env);
  const ws = encodeURIComponent(env.BITBUCKET_WORKSPACE);
  const points = [];
  const add = (accountId, keys, at, kind, ref, repo) => {
    if (!accountId || !keys.length || !at || Number.isNaN(Date.parse(at))) return;
    for (const key of keys) points.push({ accountId, key, at: new Date(at).toISOString(), kind, ref: String(ref), repo });
  };

  let cycleStart = state.cycleStart || null;
  let since = state.since || null;
  let error = null, finished = false, reposThisCycle = state.repos || 0;
  try {
    if (!queue.length) {
      cycleStart = new Date(now).toISOString();
      since = state.through ? Date.parse(state.through) - OVERLAP_MS : now - FIRST_LOOK_MS;
      const repos = await newestFirst(get, `/repositories/${ws}?sort=-updated_on&pagelen=100&fields=next,values.slug,values.full_name,values.updated_on`,
        (r) => r.updated_on, since);
      queue = repos.map((r) => ({ t: 'repo', slug: r.slug, full: r.full_name }));
      reposThisCycle = repos.length;
    }
    while (queue.length) {
      const task = queue[0];
      const base = `/repositories/${ws}/${encodeURIComponent(task.slug)}`;
      if (task.t === 'repo') {
        const branches = await newestFirst(get, `${base}/refs/branches?sort=-target.date&pagelen=100&fields=next,values.name,values.target.date`, (b) => b.target?.date, since);
        const prs = await newestFirst(get, `${base}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&sort=-updated_on&pagelen=50`, (x) => x.updated_on, since);
        queue.shift();
        for (const b of branches) if (keysIn(b.name).length) queue.push({ t: 'branch', slug: task.slug, full: task.full, name: b.name });
        for (const pr of prs) {
          const keys = keysIn(pr.source?.branch?.name || '', pr.title || '');
          if (!keys.length) continue;
          add(whoIs(people, pr.author), keys, pr.created_on, 'pr-created', `${task.full}#${pr.id}:created`, task.full);
          queue.push({ t: 'pr', slug: task.slug, full: task.full, id: pr.id, keys });
        }
      } else if (task.t === 'branch') {
        // Commits on ticket branches count for the branch's ticket.
        const commits = await newestFirst(get, `${base}/commits/${encodeURIComponent(task.name)}?pagelen=50`, (x) => x.date, since);
        for (const c of commits) add(whoIs(people, c.author?.user, c.author?.raw), keysIn(task.name), c.date, 'commit', c.hash, task.full);
        queue.shift();
      } else {
        const activity = await newestFirst(get, `${base}/pullrequests/${task.id}/activity?pagelen=50`,
          (x) => x.approval?.date || x.comment?.created_on || x.update?.date, since);
        for (const a of activity) {
          if (a.approval) add(whoIs(people, a.approval.user), task.keys, a.approval.date, 'pr-approved', `${task.full}#${task.id}:approved:${a.approval.user?.account_id}`, task.full);
          if (a.comment) add(whoIs(people, a.comment.user), task.keys, a.comment.created_on, 'pr-comment', `${task.full}#${task.id}:comment:${a.comment.id}`, task.full);
        }
        queue.shift();
      }
    }
    finished = true;
  } catch (err) {
    // Running out of calls isn't a problem: the rest of the queue carries on next run.
    if (!(err instanceof OutOfCalls)) error = err.message;
  }

  const added = await store(env, points);
  const next = {
    at: new Date(now).toISOString(),
    // Only a finished check moves the starting point on, so nothing is missed.
    through: finished && !error ? cycleStart : state.through || null,
    cycleStart: finished ? null : cycleStart,
    since: finished ? null : since,
    queue: finished ? [] : queue,
    repos: reposThisCycle,
    added: (state.queue?.length ? state.added || 0 : 0) + added,
    calls: get.calls(),
    error,
  };
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('bitbucket_poll', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(next)).run();
  return { repos: reposThisCycle, added, waiting: next.queue.length, finished, error };
}

export async function testConnection(env) {
  if (!env.BITBUCKET_API_TOKEN) throw new Error('Add BITBUCKET_API_TOKEN to the Worker first.');
  if (!env.BITBUCKET_WORKSPACE) throw new Error('Set BITBUCKET_WORKSPACE in wrangler.jsonc first.');
  const get = bitbucketClient(env, 2);
  const page = await get(`/repositories/${encodeURIComponent(env.BITBUCKET_WORKSPACE)}?pagelen=5&sort=-updated_on&fields=size,values.full_name`);
  return { ok: true, repositories: page.size ?? null, recent: (page.values || []).map((r) => r.full_name) };
}

// Blocks of nearby activity, each split between tickets where the work switched.
function londonMs(day, hhmm) {
  const guess = Date.parse(`${day}T${hhmm}:00Z`);
  const p = londonParts(guess);
  return guess - (Date.parse(`${p.day}T${p.time}:00Z`) - guess);
}

export function draftDay(points) {
  const sorted = [...points].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.key.localeCompare(b.key));
  const byKey = new Map();
  let block = [];
  const flush = () => {
    if (!block.length) return;
    const start = Date.parse(block[0].at) - LEAD_MS;
    const end = Date.parse(block[block.length - 1].at) + TAIL_MS;
    const lunch = londonMs(londonParts(start).day, '12:30');
    let segStart = start;
    for (let i = 0; i < block.length; i++) {
      const next = block[i + 1];
      if (next && next.key === block[i].key) continue;
      const segEnd = next ? (Date.parse(block[i].at) + Date.parse(next.at)) / 2 : end;
      const d = byKey.get(block[i].key) || { key: block[i].key, seconds: 0, start: segStart };
      const lunchHere = lunch >= segStart && lunch < segEnd && start < lunch && end > lunch ? LUNCH_MS : 0;
      d.seconds += Math.max(0, segEnd - segStart - lunchHere) / 1000;
      d.start = Math.min(d.start, segStart);
      byKey.set(block[i].key, d);
      segStart = segEnd;
    }
    block = [];
  };
  for (const p of sorted) {
    if (block.length && Date.parse(p.at) - Date.parse(block[block.length - 1].at) > GAP_MS) flush();
    block.push(p);
  }
  flush();
  return [...byKey.values()]
    .map((d) => ({ key: d.key, seconds: Math.max(ROUND_S, Math.round(d.seconds / ROUND_S) * ROUND_S), start: londonParts(d.start).time }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export async function drafts(env, accountId, { today = londonDate() } = {}) {
  const from = new Date(Date.parse(`${today}T12:00:00Z`) - (DAYS_SHOWN - 1) * 86_400_000).toISOString().slice(0, 10);
  const { results: points } = await env.DB.prepare(
    'SELECT issue_key AS key, at, day FROM dev_activity WHERE account_id = ? AND day >= ? AND day <= ? ORDER BY at'
  ).bind(accountId, from, today).all();
  if (!points.length) return { days: [] };
  const { results: handled } = await env.DB.prepare(
    'SELECT day, issue_key FROM dev_day_state WHERE account_id = ? AND day >= ?'
  ).bind(accountId, from).all();
  const done = new Set(handled.map((h) => `${h.day}|${h.issue_key}`));

  const keys = [...new Set(points.map((p) => p.key))];
  const issues = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const found = await searchJql(env, `key in (${keys.slice(i, i + 50).join(',')})`, ['summary']).catch(() => []);
    for (const issue of found) issues.set(issue.key.toUpperCase(), { id: String(issue.id), summary: issue.fields?.summary || '' });
  }
  // Time already logged counts against the draft, so nothing is logged twice.
  const ids = [...issues.values()].map((x) => x.id);
  const logged = new Map();
  if (ids.length) {
    const { results } = await env.DB.prepare(
      `SELECT issue_id, work_date, SUM(seconds) AS s FROM xp_ledger WHERE account_id = ? AND work_date >= ?
         AND issue_id IN (${ids.map(() => '?').join(',')}) GROUP BY issue_id, work_date`
    ).bind(accountId, from, ...ids).all();
    for (const r of results) logged.set(`${r.work_date}|${r.issue_id}`, r.s);
  }

  const byDay = new Map();
  for (const p of points) { if (!byDay.has(p.day)) byDay.set(p.day, []); byDay.get(p.day).push(p); }
  const days = [];
  for (const [day, dayPoints] of byDay) {
    const list = [];
    for (const d of draftDay(dayPoints)) {
      const issue = issues.get(d.key);
      if (!issue || done.has(`${day}|${d.key}`)) continue;
      const already = logged.get(`${day}|${issue.id}`) || 0;
      const seconds = Math.round((d.seconds - already) / ROUND_S) * ROUND_S;
      if (seconds < ROUND_S) continue;
      list.push({ ...d, seconds, alreadyLogged: already, issueId: issue.id, summary: issue.summary });
    }
    if (list.length) days.push({ day, drafts: list });
  }
  return { days: days.sort((a, b) => b.day.localeCompare(a.day)) };
}

export async function logDrafts(env, viewer, { day, items }) {
  if (!viewer.accountId) throw new Error("Your account isn't linked to a profile yet.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('Which day?');
  const results = [];
  for (const item of items || []) {
    try {
      const w = await createWorklog(env, viewer, { issueId: item.issueId, issueKey: item.key, seconds: item.seconds, date: day,
        startTime: item.start, description: item.description || 'Development, from Bitbucket activity' });
      await env.DB.prepare(
        `INSERT INTO dev_day_state (account_id, day, issue_key, status, seconds, worklog_id, updated_at) VALUES (?, ?, ?, 'logged', ?, ?, ?)
         ON CONFLICT(account_id, day, issue_key) DO UPDATE SET status = 'logged', seconds = excluded.seconds, worklog_id = excluded.worklog_id, updated_at = excluded.updated_at`
      ).bind(viewer.accountId, day, item.key, w.seconds, w.worklogId, new Date().toISOString()).run();
      results.push({ key: item.key, ok: true });
    } catch (err) {
      // Anything Tempo refuses stays as a draft to try again.
      results.push({ key: item.key, ok: false, error: err.message });
    }
  }
  return { results, logged: results.filter((r) => r.ok).length };
}

export async function dismiss(env, viewer, { day, key }) {
  if (!viewer.accountId) throw new Error("Your account isn't linked to a profile yet.");
  await env.DB.prepare(
    `INSERT INTO dev_day_state (account_id, day, issue_key, status, updated_at) VALUES (?, ?, ?, 'dismissed', ?)
     ON CONFLICT(account_id, day, issue_key) DO UPDATE SET status = 'dismissed', updated_at = excluded.updated_at`
  ).bind(viewer.accountId, day, String(key).toUpperCase(), new Date().toISOString()).run();
  return { ok: true };
}

// Late afternoon: today's day is ready. Next morning: a reminder if it wasn't logged.
export async function reminders(env, { now = Date.now() } = {}) {
  const { day: today, time } = londonParts(now);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return { skipped: 'Weekend' };
  const hour = Number(time.slice(0, 2));
  let day, kind;
  if (hour === 16) { day = today; kind = 'ready'; }
  else if (hour === 9) {
    const back = weekday === 1 ? 3 : 1;
    day = new Date(Date.parse(`${today}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    kind = 'reminder';
  } else return { skipped: 'Not a reminder hour' };

  const { results } = await env.DB.prepare(
    'SELECT DISTINCT a.account_id, e.email, e.name FROM dev_activity a JOIN employees e ON e.account_id = a.account_id WHERE a.day = ? AND e.email IS NOT NULL'
  ).bind(day).all();
  let sent = 0;
  for (const p of results) {
    const d = await drafts(env, p.account_id, { today });
    const waiting = d.days.find((x) => x.day === day);
    if (!waiting) continue;
    const total = waiting.drafts.reduce((a, x) => a + x.seconds, 0) / 3600;
    await raiseAlert(env, {
      kind: 'dev-day', dedupe: `dev-day:${kind}:${p.account_id}:${day}`, recipient: p.email,
      subject: kind === 'ready' ? 'Your day is ready to log' : 'Yesterday is still waiting to be logged',
      body: `${(p.name || '').split(' ')[0] || 'Hi'}, Bitbucket shows about ${Math.round(total * 4) / 4}h of work across ${waiting.drafts.length} ${waiting.drafts.length === 1 ? 'ticket' : 'tickets'}`
        + `${kind === 'ready' ? ' today' : ''}. Open Condor Dev in the hub to check it and log it in one go.`,
    });
    sent++;
  }
  return { sent };
}

export async function status(env) {
  const last = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'bitbucket_poll'").first();
  const week = await env.DB.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT account_id) AS people FROM dev_activity WHERE day >= ?')
    .bind(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)).first();
  const parsed = last ? JSON.parse(last.value) : null;
  if (parsed) { parsed.waiting = parsed.queue?.length || 0; delete parsed.queue; }
  return { configured: Boolean(env.BITBUCKET_API_TOKEN && env.BITBUCKET_WORKSPACE), workspace: env.BITBUCKET_WORKSPACE || null, last: parsed, week };
}
