// Turns Bitbucket activity into draft worklogs, so logging a day of
// development is a check and a tap rather than a job in itself. Everything
// the Condor Dev team does in Bitbucket that the API can show counts: commits
// on any branch, pull requests opened, updated, reviewed, approved, commented
// on, merged or declined, pipelines they ran and tags they made.
import { searchJql, BLOCKED_PROJECTS } from './jira.js';
import { createWorklog } from './logging.js';
import { raiseAlert, londonDate } from './sync.js';
import { CONDOR_DEVS } from './permissions.js';

// Any Jira key; ones Jira doesn't know are treated as no ticket.
const KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;
const NOT_KEYS = /^(UTF|SHA|ISO|RFC|TLS|SSL|HTTP|MD|AES|RSA|X|V|COVID|CVE|PR|WIN|IE|ES|PEP|GPL|CP|IEC|BS|EN)-/;
const GAP_MS = 2 * 60 * 60_000;  // a longer pause than this starts a new block of work
const LUNCH_MS = 30 * 60_000;    // taken off a block that runs through 12:30
const LEAD_MS = 30 * 60_000;     // work starts a while before the first commit
const TAIL_MS = 15 * 60_000;
const ROUND_S = 15 * 60;
const DAYS_SHOWN = 7;
export const NO_TICKET = '';

export const keysIn = (...texts) => [...new Set((texts.join(' ').toUpperCase().match(KEY_PATTERN) || [])
  .filter((k) => !NOT_KEYS.test(k) && !BLOCKED_PROJECTS.includes(k.split('-')[0])))];

function londonParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// ---------- Who did it ----------

const lower = (v) => String(v || '').trim().toLowerCase();
const emailIn = (raw) => lower(String(raw || '').match(/<([^>]+)>/)?.[1]);
const nameIn = (raw) => String(raw || '').replace(/<[^>]*>/, '').trim();

// The Condor Dev team, anyone else on the hub (whose activity is left alone),
// and the Bitbucket identities an admin has linked to someone.
export async function people(env) {
  const [devs, all, aliases] = await Promise.all([
    env.DB.prepare(`SELECT account_id, email, name FROM employees e WHERE e.active = 1 AND ${CONDOR_DEVS('e')}`).all(),
    env.DB.prepare('SELECT account_id, email, name FROM employees WHERE active = 1').all(),
    env.DB.prepare('SELECT alias, account_id FROM dev_aliases').all().catch(() => ({ results: [] })),
  ]);
  const dev = new Set(devs.results.map((e) => e.account_id));
  const byEmail = new Map(), byName = new Map(), staff = new Set();
  for (const e of all.results) {
    staff.add(e.account_id);
    if (e.email) byEmail.set(lower(e.email), e.account_id);
    if (e.name) byName.set(lower(e.name), e.account_id);
  }
  return { dev, staff, byEmail, byName, alias: new Map(aliases.results.map((a) => [lower(a.alias), a.account_id])), unmatched: new Map() };
}

// Bitbucket's account ID is the same Atlassian account as Jira. A commit made
// before the accounts were linked is matched by its email, then its name.
export function whoIs(ppl, user, raw) {
  const id = user?.account_id || null;
  const email = emailIn(raw);
  const name = nameIn(raw) || user?.display_name || '';
  const tries = [id && ppl.alias.get(lower(id)), email && ppl.alias.get(email), id && ppl.staff.has(id) && id,
    email && ppl.byEmail.get(email), name && ppl.byName.get(lower(name))];
  const found = tries.find(Boolean);
  if (found === 'ignore') return null;
  if (found) return ppl.dev.has(found) ? found : null;
  // Nobody on the hub: kept for an admin to link to someone.
  const key = id || email || lower(name);
  if (key) {
    const u = ppl.unmatched.get(key) || { key, label: [name, email && `<${email}>`].filter(Boolean).join(' ') || key, n: 0 };
    u.n++;
    ppl.unmatched.set(key, u);
  }
  return null;
}

async function saveUnmatched(env, ppl) {
  const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'bitbucket_unmatched'").first();
  const saved = row ? JSON.parse(row.value) : {};
  const now = new Date().toISOString();
  for (const [k, u] of ppl.unmatched) {
    if (ppl.alias.has(k)) continue;
    saved[k] = { label: u.label, n: (saved[k]?.n || 0) + u.n, last: now };
  }
  const keep = Object.fromEntries(Object.entries(saved).sort((a, b) => b[1].last.localeCompare(a[1].last)).slice(0, 40));
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('bitbucket_unmatched', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(keep)).run();
}

// A commit is kept once, under the tickets in its message or its branch. Seen
// first on a branch with no ticket, it moves to a ticket once one turns up.
async function store(env, points) {
  const now = new Date().toISOString();
  let added = 0;
  const insert = (p, key) => env.DB.prepare(
    `INSERT INTO dev_activity (account_id, issue_key, at, day, kind, ref, repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`
  ).bind(p.accountId, key, p.at, londonParts(Date.parse(p.at)).day, p.kind, p.ref, p.repo, now).run();
  for (const p of points) {
    if (p.kind === 'commit') {
      const { results: have } = await env.DB.prepare("SELECT issue_key FROM dev_activity WHERE account_id = ? AND kind = 'commit' AND ref = ?")
        .bind(p.accountId, p.ref).all();
      if (!p.keys.length) {
        if (!have.length) added += (await insert(p, NO_TICKET)).meta?.changes || 0;
        continue;
      }
      if (have.some((h) => h.issue_key === NO_TICKET)) {
        await env.DB.prepare("DELETE FROM dev_activity WHERE account_id = ? AND kind = 'commit' AND ref = ? AND issue_key = ''").bind(p.accountId, p.ref).run();
      }
    }
    for (const key of p.keys.length ? p.keys : [NO_TICKET]) added += (await insert(p, key)).meta?.changes || 0;
  }
  return added;
}

// ---------- Reading Bitbucket ----------

const BB = 'https://api.bitbucket.org/2.0';
const POLL_MS = 15 * 60_000;
const OVERLAP_MS = 60 * 60_000;            // look back a little further than the last check
const FIRST_LOOK_MS = 3 * 86_400_000;      // the first check covers the last three days
const MAX_LOOK_MS = 8 * 86_400_000;        // after a gap, catch up on the days drafts still show
// At most 50 outside calls a run, shared with everything else.
export const BB_CALLS_PER_RUN = 30;

class OutOfCalls extends Error {}
class NotAllowed extends Error {}

const bbEmail = (env) => env.BITBUCKET_EMAIL || env.JIRA_EMAIL;
function bbAuth(env) {
  return `Basic ${btoa(`${bbEmail(env)}:${env.BITBUCKET_API_TOKEN}`)}`;
}

export const REFUSED_401 = (env) => `Bitbucket didn't accept the token for ${bbEmail(env)} (401). It has expired or been revoked, it was made by a different Atlassian account`
  + `${env.BITBUCKET_EMAIL ? '' : ' (set BITBUCKET_EMAIL if so)'}, or it's an old app password, which Atlassian switched off on 9 June 2026. Create a new API token with scopes for Bitbucket and replace BITBUCKET_API_TOKEN.`;

function bitbucketClient(env, maxCalls) {
  let calls = 0;
  const get = async (url, { optional = false } = {}) => {
    if (calls >= maxCalls) throw new OutOfCalls();
    calls++;
    const res = await fetch(url.startsWith('http') ? url : `${BB}${url}`, { headers: { Authorization: bbAuth(env), Accept: 'application/json' } });
    if (res.status === 401) throw new Error(REFUSED_401(env));
    if (res.status === 403 || (optional && res.status === 404)) {
      const body = (await res.text()).slice(0, 300);
      throw new NotAllowed(`Bitbucket refused (${res.status}). The token may be missing a scope.${body ? ` ${body}` : ''}`);
    }
    if (!res.ok) throw new Error(`Bitbucket ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  get.calls = () => calls;
  return get;
}

// Pages newest first, stopping once items are older than `since`.
async function newestFirst(get, url, dateOf, since, opts) {
  const out = [];
  let next = url;
  while (next) {
    const page = await get(next, opts);
    for (const item of page.values || []) {
      if (Date.parse(dateOf(item) || 0) < since) return out;
      out.push(item);
    }
    next = page.next || null;
  }
  return out;
}

const COMMIT_FIELDS = 'next,values.hash,values.date,values.message,values.author.raw,values.author.user.account_id,values.author.user.display_name';

// One check is a queue of small tasks (a repository, a branch, a pull request),
// worked through over as many runs as it takes, so no run goes over its calls.
export async function poll(env, { force = false, maxCalls = BB_CALLS_PER_RUN } = {}) {
  if (!env.BITBUCKET_API_TOKEN || !env.BITBUCKET_WORKSPACE) return { idle: true, skipped: "Bitbucket isn't set up" };
  const state = JSON.parse((await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'bitbucket_poll'").first())?.value || '{}');
  const now = Date.now();
  let queue = state.queue || [];
  if (!queue.length && !force && state.at && now - Date.parse(state.at) < POLL_MS) return { idle: true, skipped: 'Checked recently' };

  const get = bitbucketClient(env, maxCalls);
  const ppl = await people(env);
  const ws = encodeURIComponent(env.BITBUCKET_WORKSPACE);
  const points = [];
  const add = (accountId, keys, at, kind, ref, repo) => {
    if (!accountId || !at || Number.isNaN(Date.parse(at))) return;
    points.push({ accountId, keys, at: new Date(at).toISOString(), kind, ref: String(ref), repo });
  };
  let pipelinesOff = Boolean(state.pipelinesOff);

  let cycleStart = state.cycleStart || null;
  let since = state.since || null;
  let error = null, finished = false, reposThisCycle = state.repos || 0;
  try {
    if (!queue.length) {
      cycleStart = new Date(now).toISOString();
      since = Math.max(state.through ? Date.parse(state.through) - OVERLAP_MS : now - FIRST_LOOK_MS, now - MAX_LOOK_MS);
      const repos = await newestFirst(get, `/repositories/${ws}?sort=-updated_on&pagelen=100&fields=next,values.slug,values.full_name,values.updated_on`,
        (r) => r.updated_on, since);
      queue = repos.map((r) => ({ t: 'repo', slug: r.slug, full: r.full_name }));
      reposThisCycle = repos.length;
    }
    while (queue.length) {
      const task = queue[0];
      const base = `/repositories/${ws}/${encodeURIComponent(task.slug)}`;
      if (task.t === 'repo') {
        // Every branch with new commits, every pull request touched, and the tags.
        const branches = await newestFirst(get, `${base}/refs/branches?sort=-target.date&pagelen=100&fields=next,values.name,values.target.date`, (b) => b.target?.date, since);
        const prs = await newestFirst(get, `${base}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen=50`, (x) => x.updated_on, since);
        const tags = await newestFirst(get, `${base}/refs/tags?sort=-target.date&pagelen=50`, (x) => x.date || x.target?.date, since);
        queue.shift();
        for (const t of tags) add(whoIs(ppl, t.tagger?.user || t.target?.author?.user, t.tagger?.raw || t.target?.author?.raw), keysIn(t.name, t.message || ''),
          t.date || t.target?.date, 'tag', `${task.full}:tag:${t.name}`, task.full);
        for (const b of branches) queue.push({ t: 'branch', slug: task.slug, full: task.full, name: b.name });
        for (const pr of prs) {
          const keys = keysIn(pr.source?.branch?.name || '', pr.title || '', pr.description || '');
          if (Date.parse(pr.created_on) >= since) add(whoIs(ppl, pr.author), keys, pr.created_on, 'pr-created', `${task.full}#${pr.id}:created`, task.full);
          queue.push({ t: 'pr', slug: task.slug, full: task.full, id: pr.id, keys });
        }
        if (!pipelinesOff) queue.push({ t: 'pipes', slug: task.slug, full: task.full });
      } else if (task.t === 'branch') {
        const commits = await newestFirst(get, `${base}/commits/${encodeURIComponent(task.name)}?pagelen=50&fields=${COMMIT_FIELDS}`, (x) => x.date, since);
        const branchKeys = keysIn(task.name);
        for (const c of commits) {
          const own = keysIn(String(c.message || '').split('\n')[0], c.message || '');
          add(whoIs(ppl, c.author?.user, c.author?.raw), own.length ? own : branchKeys, c.date, 'commit', c.hash, task.full);
        }
        queue.shift();
      } else if (task.t === 'pr') {
        const activity = await newestFirst(get, `${base}/pullrequests/${task.id}/activity?pagelen=50`,
          (x) => x.approval?.date || x.comment?.created_on || x.update?.date || x.changes_requested?.date, since);
        const ref = `${task.full}#${task.id}`;
        for (const a of activity) {
          if (a.approval) add(whoIs(ppl, a.approval.user), task.keys, a.approval.date, 'pr-approved', `${ref}:approved:${a.approval.user?.account_id}:${a.approval.date}`, task.full);
          if (a.changes_requested) add(whoIs(ppl, a.changes_requested.user), task.keys, a.changes_requested.date, 'pr-changes', `${ref}:changes:${a.changes_requested.user?.account_id}:${a.changes_requested.date}`, task.full);
          if (a.comment) add(whoIs(ppl, a.comment.user), task.keys, a.comment.created_on, 'pr-comment', `${ref}:comment:${a.comment.id}`, task.full);
          if (a.update) {
            const st = String(a.update.state || '').toUpperCase();
            const kind = st === 'MERGED' ? 'pr-merged' : st === 'DECLINED' ? 'pr-declined' : 'pr-updated';
            add(whoIs(ppl, a.update.author), task.keys, a.update.date, kind, `${ref}:${kind}:${a.update.date}`, task.full);
          }
        }
        queue.shift();
      } else if (task.t === 'pipes') {
        // Pipelines need their own scope; without it they're skipped, not a problem.
        try {
          const runs = await newestFirst(get, `${base}/pipelines/?sort=-created_on&pagelen=50`, (x) => x.created_on, since, { optional: true });
          for (const r of runs) {
            const branch = r.target?.ref_name || '';
            add(whoIs(ppl, r.creator), keysIn(branch, r.target?.commit?.message || ''), r.created_on, 'pipeline', `${task.full}:pipeline:${r.uuid}`, task.full);
          }
        } catch (err) {
          if (!(err instanceof NotAllowed)) throw err;
          pipelinesOff = true;
          queue = queue.filter((t) => t.t !== 'pipes');
          continue;
        }
        queue.shift();
      } else queue.shift();
    }
    finished = true;
  } catch (err) {
    // Running out of calls isn't a problem: the rest of the queue carries on next run.
    if (!(err instanceof OutOfCalls)) error = err.message;
  }

  const added = await store(env, points);
  await saveUnmatched(env, ppl).catch(() => {});
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
    pipelinesOff,
    error,
  };
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('bitbucket_poll', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(next)).run();
  return { repos: reposThisCycle, added, waiting: next.queue.length, finished, error };
}

// Each thing the hub reads, tried in turn, so a missing scope is named.
export async function testConnection(env) {
  if (!env.BITBUCKET_API_TOKEN) throw new Error('Add BITBUCKET_API_TOKEN to the Worker first.');
  if (!env.BITBUCKET_WORKSPACE) throw new Error('Set BITBUCKET_WORKSPACE in wrangler.jsonc first.');
  const get = bitbucketClient(env, 8);
  const ws = encodeURIComponent(env.BITBUCKET_WORKSPACE);
  const checks = [];
  const tryOne = async (label, scope, url, { needed = true } = {}) => {
    try { const r = await get(url); checks.push({ label, scope, ok: true, needed }); return r; }
    catch (err) {
      if (err.message.includes('(401)')) throw err;
      checks.push({ label, scope, ok: false, needed, error: err.message });
      return null;
    }
  };
  const user = await tryOne('Whose token it is', 'read:user:bitbucket', '/user', { needed: false });
  await tryOne('The workspace', 'read:workspace:bitbucket', `/workspaces/${ws}`);
  const repos = await tryOne('Repositories, branches and commits', 'read:repository:bitbucket', `/repositories/${ws}?pagelen=5&sort=-updated_on&fields=size,values.full_name,values.slug`);
  const slug = repos?.values?.[0]?.slug;
  if (slug) {
    await tryOne('Pull requests, reviews and comments', 'read:pullrequest:bitbucket', `/repositories/${ws}/${encodeURIComponent(slug)}/pullrequests?pagelen=1`);
    await tryOne('Pipelines', 'read:pipeline:bitbucket', `/repositories/${ws}/${encodeURIComponent(slug)}/pipelines/?pagelen=1`, { needed: false });
  }
  // A test that passes clears the pipelines skip, so a newly added scope is used.
  const pipes = checks.find((c) => c.scope === 'read:pipeline:bitbucket');
  if (pipes?.ok) {
    const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'bitbucket_poll'").first();
    if (row) {
      const st = JSON.parse(row.value); st.pipelinesOff = false;
      await env.DB.prepare("UPDATE sync_state SET value = ? WHERE key = 'bitbucket_poll'").bind(JSON.stringify(st)).run();
    }
  }
  return {
    ok: checks.every((c) => c.ok || !c.needed), email: bbEmail(env), account: user?.display_name || null,
    repositories: repos?.size ?? null, recent: (repos?.values || []).map((r) => r.full_name), checks,
  };
}

// Read the last week again, for activity missed while the token was refused or
// before someone's Bitbucket identity was linked.
export async function readAgain(env) {
  const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'bitbucket_poll'").first();
  const st = row ? JSON.parse(row.value) : {};
  const next = { ...st, through: new Date(Date.now() - 7 * 86_400_000).toISOString(), queue: [], cycleStart: null, since: null, at: null };
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('bitbucket_poll', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(next)).run();
  return poll(env, { force: true });
}

export async function unmatched(env) {
  const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'bitbucket_unmatched'").first();
  const saved = row ? JSON.parse(row.value) : {};
  const { results: aliases } = await env.DB.prepare('SELECT a.alias, a.account_id, e.name FROM dev_aliases a LEFT JOIN employees e ON e.account_id = a.account_id ORDER BY a.alias').all();
  const { results: devs } = await env.DB.prepare(`SELECT account_id, name FROM employees e WHERE e.active = 1 AND ${CONDOR_DEVS('e')} ORDER BY name`).all();
  const linked = new Set(aliases.map((a) => lower(a.alias)));
  return {
    unmatched: Object.entries(saved).filter(([k]) => !linked.has(lower(k))).map(([key, u]) => ({ key, ...u })),
    aliases: aliases.map((a) => ({ alias: a.alias, accountId: a.account_id, name: a.account_id === 'ignore' ? null : a.name, ignored: a.account_id === 'ignore' })),
    devs: devs.map((d) => ({ id: d.account_id, name: d.name })),
  };
}

// Link a Bitbucket identity to a developer (or ignore it), then read the week again so their work shows.
export async function link(env, { key, accountId }) {
  const alias = lower(key).slice(0, 200);
  if (!alias) throw new Error('Which Bitbucket identity?');
  if (!accountId) {
    await env.DB.prepare('DELETE FROM dev_aliases WHERE alias = ?').bind(alias).run();
    return { ok: true };
  }
  if (accountId !== 'ignore' && !(await env.DB.prepare('SELECT 1 AS x FROM employees WHERE account_id = ?').bind(accountId).first())) throw new Error('That person isn\'t on the hub.');
  await env.DB.prepare('INSERT INTO dev_aliases (alias, account_id) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET account_id = excluded.account_id').bind(alias, accountId).run();
  const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'bitbucket_unmatched'").first();
  if (row) {
    const saved = JSON.parse(row.value); delete saved[alias];
    for (const k of Object.keys(saved)) if (lower(k) === alias) delete saved[k];
    await env.DB.prepare("UPDATE sync_state SET value = ? WHERE key = 'bitbucket_unmatched'").bind(JSON.stringify(saved)).run();
  }
  return { ok: true, reread: accountId !== 'ignore' };
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
    // Activity with no ticket counts towards the nearest ticket in the same block of work.
    const keyed = block.filter((p) => p.key !== NO_TICKET);
    if (keyed.length) {
      block = block.map((p) => (p.key !== NO_TICKET ? p : { ...p, key: keyed.reduce((best, k) =>
        (Math.abs(Date.parse(k.at) - Date.parse(p.at)) < Math.abs(Date.parse(best.at) - Date.parse(p.at)) ? k : best)).key }));
    }
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

// The keys Jira knows, a project at a time, so one unknown key doesn't hide the rest.
async function lookUp(env, keys) {
  const issues = new Map();
  const byProject = new Map();
  for (const k of keys) { const p = k.split('-')[0]; if (!byProject.has(p)) byProject.set(p, []); byProject.get(p).push(k); }
  const ask = async (list) => {
    for (let i = 0; i < list.length; i += 50) {
      const found = await searchJql(env, `key in (${list.slice(i, i + 50).join(',')})`, ['summary']);
      for (const issue of found) issues.set(issue.key.toUpperCase(), { id: String(issue.id), summary: issue.fields?.summary || '' });
    }
  };
  try { await ask(keys); } catch {
    for (const list of byProject.values()) await ask(list).catch(() => {});
  }
  return issues;
}

export async function drafts(env, accountId, { today = londonDate() } = {}) {
  const from = new Date(Date.parse(`${today}T12:00:00Z`) - (DAYS_SHOWN - 1) * 86_400_000).toISOString().slice(0, 10);
  const { results: raw } = await env.DB.prepare(
    'SELECT issue_key AS key, at, day FROM dev_activity WHERE account_id = ? AND day >= ? AND day <= ? ORDER BY at'
  ).bind(accountId, from, today).all();
  if (!raw.length) return { days: [] };
  const { results: handled } = await env.DB.prepare(
    'SELECT day, issue_key, status, seconds FROM dev_day_state WHERE account_id = ? AND day >= ?'
  ).bind(accountId, from).all();
  const done = new Set(handled.filter((h) => h.issue_key !== NO_TICKET || h.status === 'dismissed').map((h) => `${h.day}|${h.issue_key}`));
  const noTicketLogged = new Map(handled.filter((h) => h.issue_key === NO_TICKET && h.status === 'logged').map((h) => [h.day, h.seconds || 0]));

  const issues = await lookUp(env, [...new Set(raw.map((p) => p.key).filter(Boolean))]);
  // A key Jira doesn't know (or a blocked project's) is treated as no ticket.
  const points = raw.map((p) => (p.key && issues.has(p.key) ? p : { ...p, key: NO_TICKET }));

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
  let needChoices = false;
  for (const [day, dayPoints] of byDay) {
    const list = [];
    for (const d of draftDay(dayPoints)) {
      if (done.has(`${day}|${d.key}`)) continue;
      if (d.key === NO_TICKET) {
        const already = noTicketLogged.get(day) || 0;
        const seconds = Math.round((d.seconds - already) / ROUND_S) * ROUND_S;
        if (seconds < ROUND_S) continue;
        list.push({ ...d, seconds, alreadyLogged: 0, issueId: null, summary: '', noTicket: true });
        needChoices = true;
        continue;
      }
      const issue = issues.get(d.key);
      const already = logged.get(`${day}|${issue.id}`) || 0;
      const seconds = Math.round((d.seconds - already) / ROUND_S) * ROUND_S;
      if (seconds < ROUND_S) continue;
      list.push({ ...d, seconds, alreadyLogged: already, issueId: issue.id, summary: issue.summary });
    }
    if (list.length) days.push({ day, drafts: list });
  }
  // Work with no ticket is put on one of theirs: the tickets in their week's drafts and what's assigned to them.
  let choices = [];
  if (needChoices) {
    const seen = new Map([...issues.entries()].map(([k, v]) => [k, { key: k, issueId: v.id, summary: v.summary }]));
    try {
      const mine = await searchJql(env, `assignee = "${accountId}" AND statusCategory != Done ORDER BY updated DESC`, ['summary'], { limit: 20 });
      for (const i of mine) if (!seen.has(i.key)) seen.set(i.key, { key: i.key, issueId: String(i.id), summary: i.fields?.summary || '' });
    } catch { /* their drafts' tickets are still there to choose from */ }
    choices = [...seen.values()];
  }
  return { days: days.sort((a, b) => b.day.localeCompare(a.day)), choices };
}

export async function logDrafts(env, viewer, { day, items }) {
  if (!viewer.accountId) throw new Error("Your account isn't linked to a profile yet.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('Which day?');
  const results = [];
  for (const item of items || []) {
    try {
      let key = String(item.key || '').trim().toUpperCase();
      let issueId = item.issueId;
      if (item.noTicket) {
        key = String(item.chosenKey || '').trim().toUpperCase();
        issueId = item.chosenId || null;
        if (!key) throw new Error('Choose the ticket this time was for.');
        if (!issueId) {
          const found = await searchJql(env, `key = "${key.replace(/[^A-Z0-9-]/g, '')}"`, ['summary']).catch(() => []);
          if (!found.length) throw new Error(`${key} isn't a ticket Jira knows.`);
          issueId = String(found[0].id);
        }
      }
      const w = await createWorklog(env, viewer, { issueId, issueKey: key, seconds: item.seconds, date: day,
        startTime: item.start, description: item.description || 'Development, from Bitbucket activity' });
      if (item.noTicket) {
        // Kept against "no ticket", adding up, so later activity that day still shows.
        await env.DB.prepare(
          `INSERT INTO dev_day_state (account_id, day, issue_key, status, seconds, worklog_id, updated_at) VALUES (?, ?, '', 'logged', ?, ?, ?)
           ON CONFLICT(account_id, day, issue_key) DO UPDATE SET status = 'logged', seconds = COALESCE(dev_day_state.seconds, 0) + excluded.seconds,
             worklog_id = excluded.worklog_id, updated_at = excluded.updated_at`
        ).bind(viewer.accountId, day, w.seconds, w.worklogId, new Date().toISOString()).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO dev_day_state (account_id, day, issue_key, status, seconds, worklog_id, updated_at) VALUES (?, ?, ?, 'logged', ?, ?, ?)
           ON CONFLICT(account_id, day, issue_key) DO UPDATE SET status = 'logged', seconds = excluded.seconds, worklog_id = excluded.worklog_id, updated_at = excluded.updated_at`
        ).bind(viewer.accountId, day, key, w.seconds, w.worklogId, new Date().toISOString()).run();
      }
      results.push({ key: key || 'No ticket', ok: true });
    } catch (err) {
      // Anything Tempo refuses stays as a draft to try again.
      results.push({ key: item.noTicket ? 'the work with no ticket' : item.key, ok: false, error: err.message });
    }
  }
  return { results, logged: results.filter((r) => r.ok).length };
}

export async function dismiss(env, viewer, { day, key }) {
  if (!viewer.accountId) throw new Error("Your account isn't linked to a profile yet.");
  await env.DB.prepare(
    `INSERT INTO dev_day_state (account_id, day, issue_key, status, updated_at) VALUES (?, ?, ?, 'dismissed', ?)
     ON CONFLICT(account_id, day, issue_key) DO UPDATE SET status = 'dismissed', updated_at = excluded.updated_at`
  ).bind(viewer.accountId, day, String(key || '').toUpperCase(), new Date().toISOString()).run();
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
  const kinds = (await env.DB.prepare('SELECT kind, COUNT(*) AS n FROM dev_activity WHERE day >= ? GROUP BY kind ORDER BY n DESC')
    .bind(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)).all()).results;
  return { configured: Boolean(env.BITBUCKET_API_TOKEN && env.BITBUCKET_WORKSPACE), workspace: env.BITBUCKET_WORKSPACE || null, email: bbEmail(env),
    last: parsed, week, kinds, ...(await unmatched(env)) };
}
