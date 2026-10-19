// Service contracts. Reads each contract and its visits and tokens from Jira,
// moves contracts through their statuses as their dates arrive, keeps one
// running clock per contract of the time that uses tokens, and uses a token in
// Jira each time the clock passes another four hours.
//
// Everything is read in a few searches and kept in the hub's database, so the
// tile itself never waits on Jira. Changes to Jira are made by the background
// job, kept to a fixed number of calls per run, and picked up again on the next
// run if they don't finish.
import { jira, searchPage, customerProjects, projectFilter } from './jira.js';
import { raiseAlert, getState, setState, londonDate } from './sync.js';
import { leadsOfTeam, groupsOf } from './permissions.js';

export const FIELDS = {
  start: 'customfield_14268',
  renewal: 'customfield_14267',
  end: 'customfield_14269',
  available: 'customfield_14882',
  used: 'customfield_16049',
  overdraft: 'customfield_16050',
  tier: 'customfield_12700',
  bankHoliday: 'customfield_16764',
  org: 'customfield_12900',
};

export const STATUS = {
  new: 'New',
  sent: 'Contract Sent',
  chasing: 'Needs Chasing',
  confirmed: 'Contract Confirmed',
  inContract: 'In Contract',
  renewal: 'Required Renewal',
  expired: 'Contract Expired',
  archived: 'Archived',
  lost: 'Contract Lost',
};
const MANUAL = [STATUS.archived, STATUS.lost];                       // set by people; the hub leaves them alone
const LIVE = [STATUS.confirmed, STATUS.inContract, STATUS.renewal, STATUS.expired]; // visits and tokens exist
const CLOCKED = [STATUS.inContract, STATUS.renewal, STATUS.expired];

const TOKEN = { available: 'Available', allocated: 'Token Allocated', used: 'Token Used', expired: 'Token Expired', admin: 'Admin' };
const OVERDRAFT = '[OVERDRAFT]';
const UNCHARGED_TYPES = ['snag', 'sub-snag'];                      // part of an order's own time

export const TOKEN_SECONDS = 4 * 3600;
export const END_MIN_SECONDS = 3600;                                // what's left at the end uses a token from an hour
const CHASE_DAYS = 14;
const SYNC_EVERY_MS = 20 * 60 * 1000;
const FULL_EVERY_MS = 24 * 3600 * 1000;
const LOOKBACK_DAYS = 90;
const TIME_DAYS = 30;
const RUN_CALLS = 35;                                               // of the 50 a run may make; Tempo uses some first
const MAX_ATTEMPTS = 8;

const dayMs = 86_400_000;
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => iso(toMs(d) + n * dayMs);
const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / dayMs);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(toMs(d));
const placeholders = (n) => Array(n).fill('?').join(',');
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export function minusMonth(d) {
  const [y, m, day] = d.split('-').map(Number);
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return `${py}-${String(pm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

const text = (v) => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ');
  if (typeof v === 'object') return String(v.value ?? v.name ?? '');
  return String(v);
};
const orgNames = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((o) => (typeof o === 'object' ? o.name ?? o.value : o)).filter(Boolean).map(String);
const hasValue = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== '');
const issueNum = (key) => Number(String(key).split('-')[1]) || 0;

// ---------- calls to Jira, counted ----------

class OutOfCalls extends Error {}

function budget(env, max) {
  let used = 0;
  return {
    env,
    async call(path, init) {
      if (used >= max) throw new OutOfCalls('Call budget used');
      used++;
      return jira(env, path, init);
    },
    get used() { return used; },
    left: () => max - used,
  };
}

async function search(b, jql, fields, pageSize = 100) {
  const out = [];
  let token = null;
  do {
    const params = { fields: fields.join(','), maxResults: String(pageSize) };
    if (token) params.nextPageToken = token;
    const data = await searchPage(b.env, (path) => b.call(path), jql, params);
    out.push(...(data.issues || []));
    token = data.nextPageToken || null;
  } while (token);
  return out;
}

// Moves an issue to a status, through the steps in `via` if Jira has no direct way.
async function moveTo(b, key, target, via = []) {
  const steps = [...via];
  for (let hop = 0; hop < 4; hop++) {
    const { transitions = [] } = await b.call(`/rest/api/3/issue/${key}/transitions`);
    const named = (name) => transitions.find((t) => String(t.to?.name || t.name).toLowerCase() === name.toLowerCase());
    const direct = named(target);
    if (direct) {
      await b.call(`/rest/api/3/issue/${key}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: direct.id } }) });
      return;
    }
    const i = steps.findIndex((s) => named(s));
    if (i < 0) throw new Error(`Jira has no way to move ${key} to ${target} from where it is.`);
    await b.call(`/rest/api/3/issue/${key}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: named(steps[i]).id } }) });
    steps.splice(i, 1);
  }
  throw new Error(`Couldn't move ${key} to ${target}.`);
}

// ---------- who hears about contracts ----------

export async function recipients(env) {
  const leads = (await leadsOfTeam(env, 'Service')).map((e) => e.email).filter(Boolean);
  let extra = [];
  try { extra = JSON.parse((await getState(env, 'contracts_recipients')) || '[]'); } catch { /* none */ }
  const all = [...new Set([...leads, ...extra].map((e) => String(e).toLowerCase()))];
  return all.length ? all : [null];                                 // null goes to the hub's alert address
}

async function tell(env, { kind, dedupe, subject, body, also = [] }) {
  const to = [...new Set([...(await recipients(env)), ...also.map((e) => e && e.toLowerCase())].filter((e) => e !== undefined))];
  for (const r of to) await raiseAlert(env, { kind, dedupe: `${dedupe}:${r || 'default'}`, subject, body, recipient: r });
}

async function flag(env, { kind, dedupe, contractKey = null, refKey = null, detail }) {
  const res = await env.DB.prepare(
    `INSERT INTO contract_flags (dedupe, kind, contract_key, ref_key, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe) DO NOTHING`
  ).bind(dedupe, kind, contractKey, refKey, detail, new Date().toISOString()).run();
  return (res.meta?.changes || 0) > 0;
}

async function clearFlags(env, kind, where, args, by = 'Fixed in Jira') {
  await env.DB.prepare(`UPDATE contract_flags SET resolved_at = ?, resolved_by = ? WHERE kind = ? AND resolved_at IS NULL AND ${where}`)
    .bind(new Date().toISOString(), by, kind, ...args).run();
}

async function isResolved(env, dedupe) {
  const r = await env.DB.prepare('SELECT resolved_at FROM contract_flags WHERE dedupe = ?').bind(dedupe).first();
  return Boolean(r?.resolved_at);
}

async function event(env, contractKey, textLine) {
  await env.DB.prepare('INSERT INTO contract_events (contract_key, at, text) VALUES (?, ?, ?)')
    .bind(contractKey, new Date().toISOString(), textLine).run();
}

// ---------- reading Jira ----------

const CONTRACT_FIELDS = ['summary', 'status', 'project', FIELDS.start, FIELDS.renewal, FIELDS.end, FIELDS.available, FIELDS.used,
  FIELDS.overdraft, FIELDS.tier, FIELDS.bankHoliday];

export function contractFromIssue(issue, now = new Date().toISOString()) {
  const f = issue.fields || {};
  const date = (v) => (isDate(String(v || '').slice(0, 10)) ? String(v).slice(0, 10) : null);
  const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    issue_key: issue.key,
    issue_id: String(issue.id),
    project_key: f.project?.key || issue.key.split('-')[0],
    customer: f.project?.name || f.project?.key || '',
    summary: f.summary || '',
    status: f.status?.name || '',
    tier: text(f[FIELDS.tier]) || null,
    bank_holiday: hasValue(f[FIELDS.bankHoliday]) ? 1 : 0,
    start_date: date(f[FIELDS.start]),
    renewal_date: date(f[FIELDS.renewal]),
    end_date: date(f[FIELDS.end]),
    f_available: n(f[FIELDS.available]),
    f_used: n(f[FIELDS.used]),
    f_overdraft: n(f[FIELDS.overdraft]),
    synced_at: now,
  };
}

export function itemKind(issue) {
  const type = String(issue.fields?.issuetype?.name || '').toLowerCase();
  if (type === 'service token') return 'token';
  if (type === 'calibration visit') return 'calibration';
  if (/obsolescence report/i.test(issue.fields?.summary || '')) return 'obsolescence';
  return 'visit';
}

async function syncContracts(env, b) {
  // Everything not yet expired, plus the last year or so of finished ones for renewal figures.
  const jql = `issuetype = "Service Contract" AND (status NOT IN ("${STATUS.archived}", "${STATUS.lost}", "${STATUS.expired}") OR cf[${FIELDS.end.split('_')[1]}] >= -400d) ORDER BY key`;
  const issues = await search(b, jql, CONTRACT_FIELDS);
  const now = new Date().toISOString();
  const rows = issues.map((i) => contractFromIssue(i, now));
  const stmts = rows.map((c) => env.DB.prepare(
    `INSERT INTO contracts (issue_key, issue_id, project_key, customer, summary, status, tier, bank_holiday, start_date, renewal_date, end_date,
       f_available, f_used, f_overdraft, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_key) DO UPDATE SET issue_id = excluded.issue_id, project_key = excluded.project_key, customer = excluded.customer,
       summary = excluded.summary, status = excluded.status, tier = excluded.tier, bank_holiday = excluded.bank_holiday,
       start_date = excluded.start_date, renewal_date = excluded.renewal_date, end_date = excluded.end_date,
       f_available = excluded.f_available, f_used = excluded.f_used, f_overdraft = excluded.f_overdraft, synced_at = excluded.synced_at`
  ).bind(c.issue_key, c.issue_id, c.project_key, c.customer, c.summary, c.status, c.tier, c.bank_holiday, c.start_date, c.renewal_date,
    c.end_date, c.f_available, c.f_used, c.f_overdraft, c.synced_at));
  for (const part of chunk(stmts, 50)) await env.DB.batch(part);
  // Gone from the search: deleted, finished long ago, or not in a customer project.
  await env.DB.prepare('DELETE FROM contracts WHERE synced_at < ?').bind(now).run();
  const allowed = await projectFilter(env);
  for (const c of rows.filter((r) => !allowed(r.project_key))) await env.DB.prepare('DELETE FROM contracts WHERE issue_key = ?').bind(c.issue_key).run();
  return rows.length;
}

async function syncItems(env, b, { full }) {
  const { results } = await env.DB.prepare(`SELECT issue_key FROM contracts WHERE status IN (${placeholders(LIVE.length)}) ORDER BY issue_key`)
    .bind(...LIVE).all();
  const keys = results.map((r) => r.issue_key);
  if (!keys.length) return 0;
  const last = Number((await getState(env, 'contracts_items_at')) || 0);
  const minutes = Math.ceil((Date.now() - last) / 60000) + 5;
  const since = full || !last ? '' : ` AND updated >= -${minutes}m`;
  // A full read can take a few runs; carry on from where the last one stopped.
  let from = full ? Number((await getState(env, 'contracts_full_cursor')) || 0) : 0;
  let count = 0;
  const parts = chunk(keys, 40);
  for (let p = from; p < parts.length; p++) {
    const part = parts[p];
    const now = new Date().toISOString();
    const issues = await search(b, `parent in (${part.join(',')}) AND issuetype in ("Service Visit", "Calibration Visit", "Service Token")${since}`,
      ['summary', 'status', 'issuetype', 'parent']);
    const stmts = issues.map((i) => env.DB.prepare(
      `INSERT INTO contract_items (issue_id, issue_key, contract_key, kind, summary, status, done, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, contract_key = excluded.contract_key, kind = excluded.kind,
         summary = excluded.summary, status = excluded.status, done = excluded.done, synced_at = excluded.synced_at`
    ).bind(String(i.id), i.key, i.fields.parent?.key || '', itemKind(i), i.fields.summary || '', i.fields.status?.name || '',
      i.fields.status?.statusCategory?.key === 'done' ? 1 : 0, now));
    for (const s of chunk(stmts, 50)) await env.DB.batch(s);
    if (full) {
      await env.DB.prepare(`DELETE FROM contract_items WHERE contract_key IN (${placeholders(part.length)}) AND synced_at < ?`).bind(...part, now).run();
      await setState(env, 'contracts_full_cursor', p + 1);
    }
    count += issues.length;
  }
  if (full) {
    await setState(env, 'contracts_full_cursor', 0);
    await setState(env, 'contracts_full_at', Date.now());
  }
  await setState(env, 'contracts_items_at', Date.now());
  return count;
}

// Which customer each PSC item people log time to belongs to. Only items with
// time on them are looked up, and items with no Organization are checked again
// each run so their time joins the clock as soon as someone fills it in.
async function lookupIssues(env, b, windowStart) {
  const cutoff = new Date(Date.now() - FULL_EVERY_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT w.issue_id FROM (
        SELECT l.issue_id FROM xp_ledger l JOIN jobs j ON j.issue_id = l.issue_id WHERE l.work_date >= ? AND j.issue_key LIKE 'PSC-%'
        UNION SELECT issue_id FROM unmatched_worklogs WHERE work_date >= ?
      ) w LEFT JOIN contract_issues c ON c.issue_id = w.issue_id
      WHERE c.issue_id IS NULL OR c.checked_at < ? OR (c.issue_key LIKE 'PSC-%' AND (c.org IS NULL OR c.org = '') AND c.parent_id IS NULL)
     UNION
     SELECT DISTINCT c.parent_id FROM contract_issues c LEFT JOIN contract_issues p ON p.issue_id = c.parent_id
      WHERE c.parent_id IS NOT NULL AND c.issue_key LIKE 'PSC-%'
        AND (p.issue_id IS NULL OR p.checked_at < ? OR ((c.org IS NULL OR c.org = '') AND (p.org IS NULL OR p.org = '')))`
  ).bind(windowStart, windowStart, cutoff, cutoff).all();
  const queue = chunk(results.map((r) => r.issue_id).filter(Boolean), 100);
  let looked = 0;
  while (queue.length) {
    const part = queue.shift();
    let issues;
    try {
      issues = await search(b, `id in (${part.join(',')})`, ['summary', 'issuetype', 'parent', FIELDS.org]);
    } catch (err) {
      if (err instanceof OutOfCalls) throw err;
      // One deleted or hidden item spoils the search; halve until it's found.
      if (part.length > 1) { queue.unshift(part.slice(0, part.length / 2), part.slice(part.length / 2)); continue; }
      issues = [];
      await env.DB.prepare(`INSERT INTO contract_issues (issue_id, checked_at) VALUES (?, ?)
        ON CONFLICT(issue_id) DO UPDATE SET checked_at = excluded.checked_at`).bind(part[0], new Date().toISOString()).run();
    }
    const now = new Date().toISOString();
    const stmts = issues.map((i) => env.DB.prepare(
      `INSERT INTO contract_issues (issue_id, issue_key, issuetype, parent_id, org, summary, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, issuetype = excluded.issuetype, parent_id = excluded.parent_id,
         org = excluded.org, summary = excluded.summary, checked_at = excluded.checked_at`
    ).bind(String(i.id), i.key, i.fields.issuetype?.name || '', i.fields.parent?.id ? String(i.fields.parent.id) : null,
      orgNames(i.fields[FIELDS.org]).join(' | ') || null, i.fields.summary || '', now));
    for (const s of chunk(stmts, 50)) await env.DB.batch(s);
    looked += issues.length;
  }
  return looked;
}

// ---------- matching PSC Organizations to customers ----------

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ')
  .replace(/\b(ltd|limited|plc|llp|uk|the|group|co|company|and)\b/g, ' ').replace(/[^a-z0-9]/g, '');

// Every customer project, not only those with a contract, so time for a customer
// without one still finds them. An Organization is named exactly as its project.
export function orgMatcher(projectList, manual) {
  const byNorm = projectList.map((p) => ({ key: p.key, name: String(p.name).trim().toLowerCase(), n: norm(p.name), k: p.key.toLowerCase() }));
  const map = new Map(manual.map((m) => [m.org.toLowerCase(), m.project_key]));
  return (org) => {
    if (!org) return null;
    const hand = map.get(org.toLowerCase());
    if (hand) return hand;
    const same = byNorm.find((p) => p.name === org.trim().toLowerCase());
    if (same) return same.key;
    const n = norm(org);
    if (!n) return null;
    const exact = byNorm.find((p) => p.n === n || p.k === n);
    if (exact) return exact.key;
    const near = byNorm.filter((p) => p.n.length >= 4 && n.length >= 4 && (p.n.startsWith(n) || n.startsWith(p.n)));
    return near.length === 1 ? near[0].key : null;
  };
}

// ---------- the token clock ----------

async function loadState(env) {
  const [{ results: all }, { results: items }, { results: issues }, { results: manual }] = await Promise.all([
    env.DB.prepare('SELECT * FROM contracts').all(),
    env.DB.prepare('SELECT * FROM contract_items').all(),
    env.DB.prepare('SELECT * FROM contract_issues').all(),
    env.DB.prepare('SELECT * FROM contract_org_map').all(),
  ]);
  const allowed = await projectFilter(env);
  const contracts = all.filter((c) => allowed(c.project_key));
  // Customer projects from Jira; if Jira can't be reached, the ones with contracts.
  let projects;
  try { projects = await customerProjects(env); } catch { projects = null; }
  if (!projects?.length) projects = [...new Map(contracts.map((c) => [c.project_key, { key: c.project_key, name: c.customer }])).values()];
  // Service items in customers' own projects (read by the PSC tile) count towards that customer's contract too.
  let psc = new Map();
  try {
    const { results } = await env.DB.prepare("SELECT issue_id, issue_key, project_key, issuetype, summary FROM psc_items WHERE project_key != 'PSC'").all();
    psc = new Map(results.map((r) => [r.issue_id, r]));
  } catch { /* the PSC tile isn't set up */ }
  return { contracts, items, issues: new Map(issues.map((i) => [i.issue_id, i])), psc, projects, match: orgMatcher(projects, manual) };
}

async function worklogsSince(env, from) {
  const { results } = await env.DB.prepare(
    `WITH relevant AS (
       SELECT issue_id FROM contract_issues WHERE issue_key LIKE 'PSC-%'
       UNION SELECT issue_id FROM contracts UNION SELECT issue_id FROM contract_items WHERE kind = 'token'
       UNION SELECT issue_id FROM psc_items WHERE project_key != 'PSC')
     SELECT worklog_id, issue_id, account_id, work_date, seconds, created_at AS seen FROM xp_ledger
      WHERE work_date >= ? AND issue_id IN (SELECT issue_id FROM relevant)
     UNION ALL SELECT worklog_id, issue_id, account_id, work_date, seconds, seen_at AS seen FROM unmatched_worklogs
      WHERE work_date >= ? AND issue_id IN (SELECT issue_id FROM relevant)`
  ).bind(from, from).all();
  return results.sort((a, b) => String(a.seen).localeCompare(String(b.seen)) || String(a.worklog_id).localeCompare(String(b.worklog_id)));
}

// What a worklog counts towards: a contract, or a reason it doesn't.
export function placeWorklog(w, st) {
  // Time on the contract or its tokens after the contract has ended belongs to no contract.
  const ended = (c, issue) => (c.end_date && w.work_date > c.end_date ? { skip: 'no-contract', project: c.project_key, issue } : null);
  const contract = st.contracts.find((c) => c.issue_id === String(w.issue_id));
  if (contract) return ended(contract, { issue_key: contract.issue_key, summary: 'Time on the service contract' }) || { contract, via: 'contract' };
  const token = st.items.find((i) => i.issue_id === String(w.issue_id));
  if (token) {
    if (token.kind !== 'token') return { skip: 'visit' };
    const c = st.contracts.find((x) => x.issue_key === token.contract_key);
    if (!c) return { skip: 'unknown' };
    return ended(c, { issue_key: token.issue_key, summary: token.summary }) || { contract: c, via: 'token' };
  }
  const own = st.psc?.get(String(w.issue_id));
  if (own) {
    const asIssue = { issue_key: own.issue_key, summary: own.summary };
    if (UNCHARGED_TYPES.includes(String(own.issuetype || '').toLowerCase())) return { skip: 'snag', issue: asIssue };
    const covering = st.contracts.filter((c) => c.project_key === own.project_key && CLOCKED.includes(c.status) && c.start_date && c.end_date
      && w.work_date >= c.start_date && w.work_date <= c.end_date).sort((a, b) => b.start_date.localeCompare(a.start_date));
    return covering.length ? { contract: covering[0], via: 'psc', issue: asIssue } : { skip: 'no-contract', issue: asIssue, project: own.project_key };
  }
  const issue = st.issues.get(String(w.issue_id));
  if (!issue?.issue_key || !/^PSC-/i.test(issue.issue_key)) return { skip: 'other' };
  const parent = issue.parent_id ? st.issues.get(issue.parent_id) : null;
  if ([issue.issuetype, parent?.issuetype].some((t) => UNCHARGED_TYPES.includes(String(t || '').toLowerCase()))) return { skip: 'snag', issue };
  const org = issue.org || parent?.org || '';
  if (!org) return { skip: 'no-org', issue };
  const project = org.split(' | ').map(st.match).find(Boolean);
  if (!project) return { skip: 'unmatched', issue, org };
  const covering = st.contracts
    .filter((c) => c.project_key === project && CLOCKED.includes(c.status) && c.start_date && c.end_date
      && w.work_date >= c.start_date && w.work_date <= c.end_date)
    .sort((a, b) => b.start_date.localeCompare(a.start_date));
  if (!covering.length) return { skip: 'no-contract', issue, project };
  return { contract: covering[0], via: 'psc', issue };
}

export function buildClocks(worklogs, st, clockStart) {
  const clocks = new Map();
  for (const w of worklogs) {
    if (w.work_date < clockStart) continue;
    const p = placeWorklog(w, st);
    if (!p.contract) continue;
    const key = p.contract.issue_key;
    if (!clocks.has(key)) clocks.set(key, { seconds: 0, logs: [] });
    const c = clocks.get(key);
    c.seconds += w.seconds;
    c.logs.push({ ...w, via: p.via, running: c.seconds });
  }
  return clocks;
}

// The worklog that took the clock past the nth four hours.
function triggerFor(clock, n, st) {
  const target = n * TOKEN_SECONDS;
  const w = clock.logs.find((l) => l.running >= target) || clock.logs[clock.logs.length - 1];
  if (!w) return { key: null, summary: null };
  const issue = st.issues.get(String(w.issue_id)) || st.psc?.get(String(w.issue_id));
  const contract = st.contracts.find((c) => c.issue_id === String(w.issue_id));
  const item = st.items.find((i) => i.issue_id === String(w.issue_id));
  if (issue?.issue_key) return { key: issue.issue_key, summary: issue.summary || issue.issue_key };
  if (contract) return { key: contract.issue_key, summary: 'Service time' };
  if (item) return { key: item.contract_key, summary: 'Service time' };
  return { key: null, summary: 'Service time' };
}

export function tokensDue(clock, contract, clockStart) {
  const seconds = clock?.seconds || 0;
  let due = Math.floor(seconds / TOKEN_SECONDS);
  const rest = seconds - due * TOKEN_SECONDS;
  const ended = contract.status === STATUS.expired && contract.end_date && contract.end_date >= clockStart;
  if (ended && rest >= END_MIN_SECONDS) due++;
  return { due, rest, ended };
}

async function queueCharges(env, st, clocks, clockStart) {
  const { results } = await env.DB.prepare('SELECT contract_key, COUNT(*) AS n, MAX(seq) AS top FROM contract_charges GROUP BY contract_key').all();
  const have = new Map(results.map((r) => [r.contract_key, r]));
  const now = new Date().toISOString();
  for (const contract of st.contracts) {
    if (!CLOCKED.includes(contract.status)) continue;
    const clock = clocks.get(contract.issue_key);
    const { due, ended } = tokensDue(clock, contract, clockStart);
    const charged = have.get(contract.issue_key)?.n || 0;
    for (let seq = charged + 1; seq <= due; seq++) {
      const isEnd = ended && seq * TOKEN_SECONDS > (clock?.seconds || 0);
      const t = triggerFor(clock || { logs: [] }, seq, st);
      await env.DB.prepare(
        `INSERT INTO contract_charges (contract_key, seq, reason, trigger_key, trigger_summary, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(contract_key, seq) DO NOTHING`
      ).bind(contract.issue_key, seq, isEnd ? 'end' : 'clock', t.key, t.summary, now).run();
    }
    if (charged > due) {
      const hrs = ((clock?.seconds || 0) / 3600).toFixed(1);
      await flag(env, { kind: 'clock', dedupe: `clock-over:${contract.issue_key}:${charged}`, contractKey: contract.issue_key,
        detail: `${charged} ${charged === 1 ? 'token has' : 'tokens have'} been used by the clock, but it now holds ${hrs}h. A worklog may have been deleted or shortened. Check the tokens in Jira.` });
    }
  }
}

let linkTypeCache = null;
async function linkType(env, b) {
  if (linkTypeCache) return linkTypeCache;
  const saved = await getState(env, 'contracts_link_type');
  if (saved) return (linkTypeCache = JSON.parse(saved));
  const { issueLinkTypes = [] } = await b.call('/rest/api/3/issueLinkType');
  const t = issueLinkTypes.find((x) => /^implements$/i.test(x.outward || '') || /^is implemented by$/i.test(x.inward || ''))
    || issueLinkTypes.find((x) => /implement/i.test(`${x.outward} ${x.inward} ${x.name}`));
  linkTypeCache = t ? { name: t.name, outward: t.outward } : { name: null };
  await setState(env, 'contracts_link_type', JSON.stringify(linkTypeCache));
  return linkTypeCache;
}

async function pickToken(env, contractKey) {
  return env.DB.prepare(
    `SELECT * FROM contract_items WHERE contract_key = ? AND kind = 'token' AND status = ? AND done = 0
       AND issue_key NOT IN (SELECT token_key FROM contract_charges WHERE token_key IS NOT NULL)`
  ).bind(contractKey, TOKEN.available).all().then(({ results }) => results.sort((a, b) => issueNum(a.issue_key) - issueNum(b.issue_key))[0] || null);
}

async function processCharges(env, b) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM contract_charges WHERE step < 3 AND attempts < ? ORDER BY id LIMIT 20'
  ).bind(MAX_ATTEMPTS).all();
  let done = 0;
  for (const ch of results) {
    if (b.left() < 6) break;
    const contract = await env.DB.prepare('SELECT * FROM contracts WHERE issue_key = ?').bind(ch.contract_key).first();
    if (!contract) continue;
    try {
      const name = `Token used for ${ch.trigger_summary || 'Service time'}`;
      if (!ch.token_key) {
        const token = await pickToken(env, ch.contract_key);
        if (token) {
          ch.token_key = token.issue_key;
          await env.DB.prepare('UPDATE contract_charges SET token_key = ? WHERE id = ?').bind(ch.token_key, ch.id).run();
        } else {
          const created = await b.call('/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields: {
            project: { key: contract.project_key }, parent: { key: contract.issue_key }, issuetype: { name: 'Service Token' },
            summary: `${OVERDRAFT} ${name}`.slice(0, 250) } }) });
          ch.token_key = created.key; ch.overdraft = 1; ch.step = 1;
          await env.DB.prepare('UPDATE contract_charges SET token_key = ?, overdraft = 1, step = 1 WHERE id = ?').bind(ch.token_key, ch.id).run();
          await env.DB.prepare(
            `INSERT INTO contract_items (issue_id, issue_key, contract_key, kind, summary, status, done, synced_at) VALUES (?, ?, ?, 'token', ?, ?, 0, ?)
             ON CONFLICT(issue_id) DO NOTHING`
          ).bind(String(created.id), created.key, contract.issue_key, `${OVERDRAFT} ${name}`, TOKEN.available, new Date().toISOString()).run();
          await tell(env, { kind: 'contract-overdraft', dedupe: `contract-overdraft:${ch.contract_key}:${ch.seq}`,
            subject: `${contract.customer} is in overdraft on their service contract`,
            body: `${contract.customer} has no tokens left on ${contract.issue_key}, so ${created.key} was added as an overdraft token for ${ch.trigger_key || 'service time'}.\n\nOpen Service contracts in the hub to see their contract.` });
        }
      }
      if (ch.step < 1) {
        await b.call(`/rest/api/3/issue/${ch.token_key}`, { method: 'PUT', body: JSON.stringify({ fields: { summary: name.slice(0, 250) } }) });
        await env.DB.prepare('UPDATE contract_charges SET step = 1 WHERE id = ?').bind(ch.id).run();
        await env.DB.prepare('UPDATE contract_items SET summary = ? WHERE issue_key = ?').bind(name, ch.token_key).run();
        ch.step = 1;
      }
      if (ch.step < 2) {
        const lt = await linkType(env, b);
        if (lt.name && ch.trigger_key && ch.trigger_key !== ch.contract_key) {
          await b.call('/rest/api/3/issueLink', { method: 'POST', body: JSON.stringify({
            type: { name: lt.name }, outwardIssue: { key: ch.trigger_key }, inwardIssue: { key: ch.token_key } }) });
        }
        await env.DB.prepare('UPDATE contract_charges SET step = 2 WHERE id = ?').bind(ch.id).run();
        ch.step = 2;
      }
      await moveTo(b, ch.token_key, TOKEN.used, [TOKEN.allocated]);
      const at = new Date().toISOString();
      await env.DB.prepare('UPDATE contract_charges SET step = 3, done_at = ?, error = NULL WHERE id = ?').bind(at, ch.id).run();
      await env.DB.prepare('UPDATE contract_items SET status = ?, done = 1 WHERE issue_key = ?').bind(TOKEN.used, ch.token_key).run();
      await event(env, ch.contract_key, ch.reason === 'end'
        ? `${ch.token_key} used for the time left on the clock when the contract ended`
        : `${ch.token_key} used: the clock passed ${ch.seq * 4}h${ch.trigger_key ? ` on ${ch.trigger_key}` : ''}${ch.overdraft ? ' (overdraft)' : ''}`);
      done++;
    } catch (err) {
      if (err instanceof OutOfCalls) break;
      const attempts = ch.attempts + 1;
      await env.DB.prepare('UPDATE contract_charges SET attempts = ?, error = ? WHERE id = ?').bind(attempts, String(err.message).slice(0, 400), ch.id).run();
      if (attempts >= 3) await writeProblem(env, ch.contract_key, `token-${ch.seq}`, `Using token ${ch.seq} for ${ch.contract_key}: ${err.message}`);
    }
  }
  return done;
}

async function writeProblem(env, contractKey, what, message) {
  const dedupe = `write:${contractKey}:${what}`;
  // Still failing after being marked resolved: show it again.
  await env.DB.prepare('UPDATE contract_flags SET resolved_at = NULL, resolved_by = NULL, detail = ? WHERE dedupe = ? AND resolved_at IS NOT NULL')
    .bind(message, dedupe).run();
  const fresh = await flag(env, { kind: 'write', dedupe, contractKey, detail: message });
  if (fresh) {
    await tell(env, { kind: 'contract-write', dedupe: `contract-write:${contractKey}:${what}`,
      subject: `The hub couldn't update ${contractKey} in Jira`,
      body: `${message}\n\nThe hub keeps trying. If Jira's workflow or permissions have changed, fix that and it will carry on.` });
  }
}

// ---------- dates and statuses ----------

// Spots dates that look as if the day and month have been swapped, or otherwise don't add up.
export function checkDates(c) {
  const problems = [];
  const { start_date: s, renewal_date: r, end_date: e } = c;
  if (!s || !e) {
    if ([STATUS.sent, STATUS.chasing, STATUS.confirmed, STATUS.inContract, STATUS.renewal].includes(c.status)) problems.push('The start or end date is empty.');
    return problems;
  }
  const swap = (d) => {
    const [y, m, day] = d.split('-').map(Number);
    if (day > 12 || day === m) return null;
    const x = `${y}-${String(day).padStart(2, '0')}-${String(m).padStart(2, '0')}`;
    return isDate(x) ? x : null;
  };
  const span = (a, b) => daysBetween(a, b) + 1;
  const sensible = (a, b) => {
    const d = span(a, b);
    const years = Math.round(d / 365.25);
    return years >= 1 && years <= 5 && Math.abs(d - years * 365.25) <= 20;
  };
  const fmt = (d) => new Date(toMs(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (toMs(e) <= toMs(s)) problems.push(`It ends (${fmt(e)}) before it starts (${fmt(s)}).`);
  else if (!sensible(s, e)) {
    const d = span(s, e);
    let hint = '';
    for (const [which, a, b] of [['start', swap(s), e], ['end', s, swap(e)]]) {
      if (a && b && toMs(b) > toMs(a) && sensible(a, b)) { hint = ` The ${which} date may have its day and month swapped: ${fmt(which === 'start' ? a : b)}?`; break; }
    }
    problems.push(`It runs for ${d} days, which isn't a whole number of years.${hint}`);
  }
  if (r && toMs(e) > toMs(s)) {
    const expected = minusMonth(e);
    if (Math.abs(daysBetween(expected, r)) > 7) {
      const alt = swap(r);
      const hint = alt && Math.abs(daysBetween(expected, alt)) <= 7 ? ` It may have its day and month swapped: ${fmt(alt)}?` : '';
      problems.push(`The renewal date (${fmt(r)}) isn't a month before the end date (${fmt(e)}).${hint}`);
    }
  } else if (!r && [STATUS.confirmed, STATUS.inContract].includes(c.status)) {
    problems.push(`The renewal date is empty, so a month before the end (${fmt(minusMonth(e))}) is being used.`);
  }
  return problems;
}

const datesKey = (c) => `dates:${c.issue_key}:${c.start_date}|${c.renewal_date}|${c.end_date}`;

// The status a contract should have today, or null to leave it.
export function nextStatus(c, today) {
  const s = c.start_date, e = c.end_date, r = c.renewal_date || (e ? minusMonth(e) : null);
  if (c.status === STATUS.sent && s && daysBetween(today, s) <= CHASE_DAYS) return STATUS.chasing;
  if (c.status === STATUS.confirmed && s && s <= today) return e && e < today ? STATUS.expired : STATUS.inContract;
  if (c.status === STATUS.inContract && e && e < today) return STATUS.expired;
  if (c.status === STATUS.inContract && r && r <= today) return STATUS.renewal;
  if (c.status === STATUS.renewal && e && e < today) return STATUS.expired;
  return null;
}

const fmtDate = (d) => (d ? new Date(toMs(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'not set');

async function applyStatuses(env, b, st, today) {
  for (const c of st.contracts) {
    if (MANUAL.includes(c.status)) continue;

    // Dates first: a contract whose dates look wrong is left where it is until they're fixed.
    const problems = c.status === STATUS.expired ? [] : checkDates(c);
    let hold = false;
    if (problems.length) {
      const key = datesKey(c);
      await clearFlags(env, 'dates', 'contract_key = ? AND dedupe != ?', [c.issue_key, key]);
      const fresh = await flag(env, { kind: 'dates', dedupe: key, contractKey: c.issue_key, detail: problems.join(' ') });
      if (fresh) {
        await tell(env, { kind: 'contract-dates', dedupe: `contract-dates:${key}`, subject: `The dates on ${c.issue_key} look wrong`,
          body: `${c.customer}'s service contract ${c.issue_key}:\n\n${problems.join('\n')}\n\nStart ${fmtDate(c.start_date)}, renewal ${fmtDate(c.renewal_date)}, end ${fmtDate(c.end_date)}.\n\nThe hub won't change its status until the dates are fixed in Jira, or the alert is marked resolved in Service contracts.` });
      }
      hold = !(await isResolved(env, key));
    } else {
      await clearFlags(env, 'dates', 'contract_key = ?', [c.issue_key]);
    }

    // Still not accepted once it should have started.
    if ([STATUS.sent, STATUS.chasing].includes(c.status) && c.start_date && c.start_date < today) {
      const key = `start-passed:${c.issue_key}:${c.start_date}`;
      if (await flag(env, { kind: 'start-passed', dedupe: key, contractKey: c.issue_key,
        detail: `Its start date (${fmtDate(c.start_date)}) has passed and the contract hasn't been accepted.` })) {
        await tell(env, { kind: 'contract-start', dedupe: `contract-start:${key}`, subject: `${c.customer}'s contract should have started`,
          body: `${c.issue_key} was due to start on ${fmtDate(c.start_date)} and hasn't been accepted yet. It stays in Needs Chasing.\n\nOnce there's a plan, mark the alert resolved in Service contracts.` });
      }
    } else if (![STATUS.sent, STATUS.chasing].includes(c.status)) {
      await clearFlags(env, 'start-passed', 'contract_key = ?', [c.issue_key], 'Accepted');
    }

    const target = hold ? null : nextStatus(c, today);
    if (!target) continue;
    try {
      await moveTo(b, c.issue_key, target);
    } catch (err) {
      if (err instanceof OutOfCalls) throw err;
      await writeProblem(env, c.issue_key, `status-${target}`, `Moving ${c.issue_key} to ${target}: ${err.message}`);
      continue;
    }
    const was = c.status;
    c.status = target;
    await env.DB.prepare('UPDATE contracts SET status = ? WHERE issue_key = ?').bind(target, c.issue_key).run();
    await clearFlags(env, 'write', 'contract_key = ? AND dedupe LIKE ?', [c.issue_key, `write:${c.issue_key}:status-%`], 'Done');
    await event(env, c.issue_key, `Moved from ${was} to ${target}`);
    if (target === STATUS.renewal) {
      const tokens = st.items.filter((i) => i.contract_key === c.issue_key && i.kind === 'token');
      const n = tokenCounts(tokens);
      const visits = (k) => st.items.filter((i) => i.contract_key === c.issue_key && i.kind === k);
      const line = (k, label) => { const v = visits(k); return v.length ? `\n${label}: ${v.filter((x) => x.done).length} of ${v.length} done` : ''; };
      await tell(env, { kind: 'contract-renewal', dedupe: `contract-renewal:${c.issue_key}:${c.end_date}`,
        subject: `${c.customer}'s service contract is due for renewal`,
        body: `${c.issue_key} (${c.tier || 'no tier'}) ends on ${fmtDate(c.end_date)}.\n\nTokens: ${n.spent} used, ${n.allocated} set aside for jobs, ${n.free} free, of ${n.total}${line('visit', 'Service visits')}${line('calibration', 'Calibration visits')}${line('obsolescence', 'Obsolescence survey')}\n\nOpen Service contracts in the hub for the full picture.` });
    }
  }
}

// Tokens still Available when a contract has ended are expired, once the clock's last token is in.
async function expireTokens(env, b, st, clockStart) {
  for (const c of st.contracts) {
    if (c.status !== STATUS.expired || !c.end_date || c.end_date < addDays(clockStart, -1)) continue;
    const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM contract_charges WHERE contract_key = ? AND step < 3').bind(c.issue_key).first();
    if (pending?.n) continue;
    const left = st.items.filter((i) => i.contract_key === c.issue_key && i.kind === 'token' && i.status === TOKEN.available && !i.done);
    for (const t of left) {
      if (b.left() < 4) return;
      try {
        await moveTo(b, t.issue_key, TOKEN.expired, [TOKEN.admin]);
      } catch (err) {
        if (err instanceof OutOfCalls) throw err;
        await writeProblem(env, c.issue_key, `expire-${t.issue_key}`, `Expiring ${t.issue_key}: ${err.message}`);
        continue;
      }
      t.status = TOKEN.expired; t.done = 1;
      await env.DB.prepare('UPDATE contract_items SET status = ?, done = 1 WHERE issue_id = ?').bind(TOKEN.expired, t.issue_id).run();
      await event(env, c.issue_key, `${t.issue_key} expired with the contract`);
    }
  }
}

export function tokenCounts(items) {
  const tokens = items.filter((i) => i.kind === 'token');
  const done = tokens.filter((t) => t.done).length;
  const allocated = tokens.filter((t) => !t.done && t.status === TOKEN.allocated).length;
  return {
    total: tokens.length,
    // What Jira's fields show: tokens set aside for a job count as used there, so
    // nobody spends them on something else. The hub keeps the two apart.
    available: tokens.length - done - allocated,
    used: done + allocated,
    overdraft: tokens.filter((t) => String(t.summary || '').toUpperCase().includes(OVERDRAFT)).length,
    free: tokens.filter((t) => !t.done && t.status === TOKEN.available).length,
    allocated,
    spent: tokens.filter((t) => t.done && t.status !== TOKEN.expired).length,
    expired: tokens.filter((t) => t.status === TOKEN.expired).length,
  };
}

async function updateCounts(env, b, st, clockStart) {
  for (const c of st.contracts) {
    if (!LIVE.includes(c.status)) continue;
    if (c.status === STATUS.expired && (!c.end_date || c.end_date < addDays(clockStart, -1))) continue;  // finished before the hub took over
    const items = st.items.filter((i) => i.contract_key === c.issue_key);
    if (!items.some((i) => i.kind === 'token')) continue;
    const n = tokenCounts(items);
    if (c.f_available === n.available && c.f_used === n.used && c.f_overdraft === n.overdraft) continue;
    if (b.left() < 2) return;
    try {
      await b.call(`/rest/api/3/issue/${c.issue_key}`, { method: 'PUT', body: JSON.stringify({ fields: {
        [FIELDS.available]: n.available, [FIELDS.used]: n.used, [FIELDS.overdraft]: n.overdraft } }) });
    } catch (err) {
      if (err instanceof OutOfCalls) throw err;
      await writeProblem(env, c.issue_key, 'counts', `Updating the token counts on ${c.issue_key}: ${err.message}`);
      continue;
    }
    await env.DB.prepare('UPDATE contracts SET f_available = ?, f_used = ?, f_overdraft = ? WHERE issue_key = ?')
      .bind(n.available, n.used, n.overdraft, c.issue_key).run();
    c.f_available = n.available; c.f_used = n.used; c.f_overdraft = n.overdraft;
  }
}

// Time logged to a PSC item with no Organization: the person who logged it and the contract people hear once a day.
async function orgReminders(env, st, since) {
  const { results } = await env.DB.prepare(
    `SELECT l.issue_id, l.account_id, e.email, e.name FROM xp_ledger l LEFT JOIN employees e ON e.account_id = l.account_id
      WHERE l.created_at > ?`
  ).bind(since).all();
  const day = londonDate();
  const seen = new Set();
  for (const w of results) {
    const p = placeWorklog({ issue_id: w.issue_id, work_date: day }, st);
    if (p.skip === 'no-org') {
      const key = p.issue.issue_key;
      await flag(env, { kind: 'psc-org', dedupe: `psc-org:${key}`, refKey: key, detail: `${key} ${p.issue.summary || ''} has time logged but no Organization, so its time can't count towards a contract.`.trim() });
      if (seen.has(`${key}:${w.email}`)) continue;
      seen.add(`${key}:${w.email}`);
      await tell(env, { kind: 'psc-org', dedupe: `psc-org:${key}:${day}`, also: w.email ? [w.email] : [],
        subject: `Add the customer to ${key}`,
        body: `${w.name || 'Someone'} logged time to ${key} (${p.issue.summary || 'no summary'}), which has no Organization set.\n\nAdd the customer's Organization in Jira so the time counts towards their service contract. Nothing is lost in the meantime: the time joins the contract's clock as soon as the Organization is filled in.` });
    } else if (p.skip === 'unmatched') {
      await flag(env, { kind: 'org-map', dedupe: `org-map:${p.org.toLowerCase()}`, refKey: p.issue.issue_key,
        detail: `The Organization "${p.org}" on ${p.issue.issue_key} doesn't match a customer with a service contract. If it should, match it under the tile's settings.` });
    }
  }
  // Fixed since: an Organization filled in, or a match made.
  const { results: open } = await env.DB.prepare("SELECT id, kind, ref_key, dedupe FROM contract_flags WHERE kind IN ('psc-org', 'org-map') AND resolved_at IS NULL").all();
  for (const f of open) {
    const issue = [...st.issues.values()].find((i) => i.issue_key === f.ref_key);
    if (!issue) continue;
    const p = placeWorklog({ issue_id: issue.issue_id, work_date: day }, st);
    if ((f.kind === 'psc-org' && p.skip !== 'no-org') || (f.kind === 'org-map' && p.skip !== 'unmatched')) {
      await env.DB.prepare('UPDATE contract_flags SET resolved_at = ?, resolved_by = ? WHERE id = ?').bind(new Date().toISOString(), 'Fixed in Jira', f.id).run();
    }
  }
}

// ---------- the background job ----------

export async function run(env, { force = false } = {}) {
  const last = Number((await getState(env, 'contracts_sync_at')) || 0);
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM contract_charges WHERE step < 3 AND attempts < ?').bind(MAX_ATTEMPTS).first();
  if (!force && Date.now() - last < SYNC_EVERY_MS && !pending?.n) return { idle: true };

  const b = budget(env, RUN_CALLS);
  const started = await getState(env, 'contracts_started');
  const clockStart = await getState(env, 'contracts_clock_start');
  const today = londonDate();
  const out = { calls: 0 };
  try {
    if (force || Date.now() - last >= SYNC_EVERY_MS) {
      await refreshHolidays(env);
      out.contracts = await syncContracts(env, b);
      const fullAt = Number((await getState(env, 'contracts_full_at')) || 0);
      const cursor = Number((await getState(env, 'contracts_full_cursor')) || 0);
      out.items = await syncItems(env, b, { full: Date.now() - fullAt >= FULL_EVERY_MS || cursor > 0 });
      const windowStart = [clockStart || today, addDays(today, -LOOKBACK_DAYS)].sort()[0];
      out.looked = await lookupIssues(env, b, windowStart);
      await setState(env, 'contracts_sync_at', Date.now());
    }
    if (started && clockStart) {
      let st = await loadState(env);
      await applyStatuses(env, b, st, today);
      const clocks = buildClocks(await worklogsSince(env, clockStart), st, clockStart);
      await noteClockChanges(env, clocks);
      await queueCharges(env, st, clocks, clockStart);
      out.charged = await processCharges(env, b);
      st = await loadState(env);
      await expireTokens(env, b, st, clockStart);
      await updateCounts(env, b, st, clockStart);
      const since = (await getState(env, 'contracts_org_check')) || started;
      await orgReminders(env, st, since);
      await setState(env, 'contracts_org_check', new Date().toISOString());
    }
    await setState(env, 'contracts_error', '');
  } catch (err) {
    if (!(err instanceof OutOfCalls)) {
      await setState(env, 'contracts_error', `${new Date().toISOString()} ${err.message}`);
      throw err;
    }
    out.partial = true;
  }
  out.calls = b.used;
  return out;
}

async function noteClockChanges(env, clocks) {
  const now = Object.fromEntries([...clocks].map(([k, c]) => [k, c.seconds]));
  const before = (await getState(env, 'contracts_clock_totals')) || '{}';
  if (JSON.stringify(now) !== before) {
    await setState(env, 'contracts_clock_totals', JSON.stringify(now));
    await setState(env, 'contracts_clock_changed', new Date().toISOString());
  }
}

// ---------- what people see ----------

export function canSee(viewer) {
  return Boolean(viewer.isAdmin || viewer.can?.oversight || viewer.teams?.includes('Service'));
}
export function canInsights(viewer) {
  return Boolean(viewer.isAdmin || viewer.groups?.includes('management') || viewer.leads?.includes('Service'));
}
const refuse = (message, status = 403) => { const err = new Error(message); err.status = status; return err; };
const mustAdmin = (viewer) => { if (!viewer.isAdmin) throw refuse('Admin only.'); };

function mustSee(viewer, insights = false) {
  if (!(insights ? canInsights(viewer) : canSee(viewer))) {
    const err = new Error('Service contracts are for the Service team.'); err.status = 403; throw err;
  }
}

async function header(env) {
  const [started, clockStart, changed, syncAt, error] = await Promise.all(
    ['contracts_started', 'contracts_clock_start', 'contracts_clock_changed', 'contracts_sync_at', 'contracts_error'].map((k) => getState(env, k)));
  return { started, clockStart, clockChanged: changed, syncedAt: syncAt ? new Date(Number(syncAt)).toISOString() : null, error: error || null };
}

function summarise(c, items, clock, charges, clockStart) {
  const mine = items.filter((i) => i.contract_key === c.issue_key);
  const count = (k) => { const v = mine.filter((i) => i.kind === k); return v.length ? { done: v.filter((x) => x.done).length, total: v.length } : null; };
  const live = LIVE.includes(c.status);
  const dues = clockStart ? tokensDue(clock, c, clockStart) : null;
  return {
    key: c.issue_key, customer: c.customer, project: c.project_key, summary: c.summary, status: c.status, tier: c.tier,
    bankHoliday: Boolean(c.bank_holiday), start: c.start_date, renewal: c.renewal_date || (c.end_date ? minusMonth(c.end_date) : null),
    renewalSet: Boolean(c.renewal_date), end: c.end_date, live,
    visits: live ? count('visit') : null, calibration: live ? count('calibration') : null, obsolescence: live ? count('obsolescence') : null,
    tokens: live ? tokenCounts(mine) : null,
    clock: clockStart && CLOCKED.includes(c.status) ? { seconds: clock?.seconds || 0, towardsNext: (clock?.seconds || 0) % TOKEN_SECONDS, charged: charges || 0, due: dues.due } : null,
  };
}

export async function overview(env, viewer) {
  mustSee(viewer);
  const head = await header(env);
  const st = await loadState(env);
  const clocks = head.clockStart ? buildClocks(await worklogsSince(env, head.clockStart), st, head.clockStart) : new Map();
  const { results: ch } = await env.DB.prepare('SELECT contract_key, COUNT(*) AS n FROM contract_charges GROUP BY contract_key').all();
  const charged = new Map(ch.map((r) => [r.contract_key, r.n]));
  const contracts = st.contracts.filter((c) => !MANUAL.includes(c.status))
    .map((c) => summarise(c, st.items, clocks.get(c.issue_key), charged.get(c.issue_key), head.clockStart))
    .sort((a, b) => String(a.end || '9999').localeCompare(String(b.end || '9999')));
  const { results: flags } = await env.DB.prepare(
    `SELECT f.*, c.customer FROM contract_flags f LEFT JOIN contracts c ON c.issue_key = f.contract_key
      WHERE f.resolved_at IS NULL ORDER BY f.id DESC LIMIT 100`
  ).all();
  const today = londonDate();
  const holidays = await holidaysFor(env);
  const bankHoliday = { today: holidays.find((h) => h.date === today) || null, next: holidays.find((h) => h.date > today) || null };
  return { ...head, contracts, flags, canInsights: canInsights(viewer), isAdmin: Boolean(viewer.isAdmin), today, bankHoliday };
}

export async function detail(env, viewer, key) {
  mustSee(viewer);
  const head = await header(env);
  const st = await loadState(env);
  const c = st.contracts.find((x) => x.issue_key === key);
  if (!c) throw new Error('That contract is no longer in the list.');
  const clocks = head.clockStart ? buildClocks(await worklogsSince(env, head.clockStart), st, head.clockStart) : new Map();
  const clock = clocks.get(key);
  const [{ results: charges }, { results: events }] = await Promise.all([
    env.DB.prepare('SELECT * FROM contract_charges WHERE contract_key = ? ORDER BY seq DESC').bind(key).all(),
    env.DB.prepare('SELECT * FROM contract_events WHERE contract_key = ? ORDER BY id DESC LIMIT 50').bind(key).all(),
  ]);
  const byIssue = new Map();
  for (const l of clock?.logs || []) {
    const issue = st.issues.get(String(l.issue_id)) || st.psc?.get(String(l.issue_id));
    const label = issue?.issue_key || (l.via === 'contract' ? c.issue_key : st.items.find((i) => i.issue_id === String(l.issue_id))?.issue_key) || '';
    const row = byIssue.get(label) || { key: label, summary: issue?.summary || (l.via === 'contract' ? 'Time on the contract' : 'Time on a token'), seconds: 0 };
    row.seconds += l.seconds;
    byIssue.set(label, row);
  }
  const items = st.items.filter((i) => i.contract_key === key).sort((a, b) => issueNum(a.issue_key) - issueNum(b.issue_key))
    .map((i) => ({ key: i.issue_key, kind: i.kind, summary: i.summary, status: i.status, done: Boolean(i.done) }));
  return {
    ...head,
    contract: summarise(c, st.items, clock, charges.length, head.clockStart),
    items,
    contributions: [...byIssue.values()].sort((a, b) => b.seconds - a.seconds),
    charges: charges.map((x) => ({ seq: x.seq, token: x.token_key, trigger: x.trigger_key, reason: x.reason, overdraft: Boolean(x.overdraft),
      done: x.step >= 3, at: x.done_at || x.created_at, error: x.step < 3 ? x.error : null })),
    events,
    problems: checkDates(c),
  };
}

export async function resolveFlag(env, viewer, id) {
  mustSee(viewer);
  const f = await env.DB.prepare('SELECT * FROM contract_flags WHERE id = ?').bind(Number(id)).first();
  if (!f) throw new Error('That alert has gone.');
  await env.DB.prepare('UPDATE contract_flags SET resolved_at = ?, resolved_by = ? WHERE id = ?')
    .bind(new Date().toISOString(), viewer.employee?.name || viewer.email, f.id).run();
  // Marking a Jira problem resolved means it's been sorted: try the waiting changes again.
  if (f.kind === 'write' && f.contract_key) {
    await env.DB.prepare('UPDATE contract_charges SET attempts = 0 WHERE contract_key = ? AND step < 3').bind(f.contract_key).run();
  }
  return { ok: true, flag: f };
}

// When someone picks a Service Contract item to log time to, the visits they may have meant instead.
export async function check(env, viewer, issueId) {
  const c = await env.DB.prepare('SELECT * FROM contracts WHERE issue_id = ?').bind(String(issueId)).first();
  if (!c) return { contract: null };
  const { results } = await env.DB.prepare(
    `SELECT i.* FROM contract_items i JOIN contracts c ON c.issue_key = i.contract_key
      WHERE c.project_key = ? AND i.kind IN ('visit', 'calibration', 'obsolescence') AND c.status IN (?, ?, ?)`
  ).bind(c.project_key, STATUS.confirmed, STATUS.inContract, STATUS.renewal).all();
  const label = { visit: 'Service visit', calibration: 'Calibration visit', obsolescence: 'Obsolescence survey' };
  const visits = results.sort((a, b) => a.done - b.done || issueNum(a.issue_key) - issueNum(b.issue_key)).map((i) => ({
    issueId: i.issue_id, key: i.issue_key, label: i.issue_key, title: i.summary,
    sublabel: `${label[i.kind]}, ${i.done ? 'done' : 'to do'}`, done: Boolean(i.done), rate: 1,
  }));
  return { contract: { key: c.issue_key, customer: c.customer }, visits };
}

// ---------- settings ----------

export async function settings(env, viewer) {
  mustAdmin(viewer);
  const head = await header(env);
  let extra = [];
  try { extra = JSON.parse((await getState(env, 'contracts_recipients')) || '[]'); } catch { /* none */ }
  const { results: people } = await env.DB.prepare('SELECT * FROM employees WHERE active = 1 AND email IS NOT NULL ORDER BY name').all();
  const leads = (await leadsOfTeam(env, 'Service')).map((e) => e.email?.toLowerCase());
  const st = await loadState(env);
  const { results: mapped } = await env.DB.prepare('SELECT * FROM contract_org_map ORDER BY org').all();
  const orgs = new Map();
  for (const i of st.issues.values()) {
    if (!/^PSC-/i.test(i.issue_key || '')) continue;
    for (const o of String(i.org || '').split(' | ').filter(Boolean)) {
      if (!orgs.has(o)) orgs.set(o, { org: o, project: st.match(o), manual: mapped.find((m) => m.org.toLowerCase() === o.toLowerCase())?.project_key || null });
    }
  }
  for (const m of mapped) if (![...orgs.keys()].some((o) => o.toLowerCase() === m.org.toLowerCase())) orgs.set(m.org, { org: m.org, project: m.project_key, manual: m.project_key });
  const projects = st.projects.map((p) => ({ key: p.key, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const { results: counts } = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(step < 3) AS waiting FROM contract_charges').all();
  return {
    ...head,
    people: people.map((p) => ({ email: p.email.toLowerCase(), name: p.name, lead: leads.includes(p.email.toLowerCase()), groups: groupsOf(p) })),
    extra: extra.map((e) => e.toLowerCase()),
    orgs: [...orgs.values()].sort((a, b) => Number(Boolean(a.project)) - Number(Boolean(b.project)) || a.org.localeCompare(b.org)),
    projects,
    tokens: { used: counts[0]?.n || 0, waiting: counts[0]?.waiting || 0 },
    contracts: st.contracts.length,
  };
}

export async function saveRecipients(env, viewer, emails) {
  mustAdmin(viewer);
  const clean = [...new Set((Array.isArray(emails) ? emails : []).map((e) => String(e).trim().toLowerCase()).filter((e) => /@/.test(e)))].slice(0, 30);
  const before = await getState(env, 'contracts_recipients');
  await setState(env, 'contracts_recipients', JSON.stringify(clean));
  return { ok: true, before: before ? JSON.parse(before) : [], after: clean };
}

export async function saveOrgMatch(env, viewer, { org, projectKey }) {
  mustAdmin(viewer);
  const o = String(org || '').trim().slice(0, 200);
  if (!o) throw new Error('Which Organization?');
  if (projectKey) {
    await env.DB.prepare('INSERT INTO contract_org_map (org, project_key) VALUES (?, ?) ON CONFLICT(org) DO UPDATE SET project_key = excluded.project_key')
      .bind(o, String(projectKey).slice(0, 40)).run();
  } else {
    await env.DB.prepare('DELETE FROM contract_org_map WHERE org = ?').bind(o).run();
  }
  return { ok: true };
}

export async function start(env, viewer) {
  mustAdmin(viewer);
  if (await getState(env, 'contracts_started')) throw refuse('Tracking has already started.', 400);
  const now = new Date().toISOString();
  await setState(env, 'contracts_started', now);
  await setState(env, 'contracts_clock_start', londonDate());
  await setState(env, 'contracts_org_check', now);
  return { ok: true, started: now };
}

// ---------- insights for the service lead ----------

// Bank holidays in England and Wales, worked out rather than fetched.
export function bankHolidays(year) {
  const d = (m, day) => new Date(Date.UTC(year, m - 1, day));
  const out = [];
  const weekdayOn = (date) => { while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1); return date; };
  out.push(['New Year\'s Day', weekdayOn(d(1, 1))]);
  // Easter (anonymous Gregorian algorithm).
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = d(month, day);
  out.push(['Good Friday', new Date(easter.getTime() - 2 * dayMs)], ['Easter Monday', new Date(easter.getTime() + dayMs)]);
  const firstMonday = (mo) => { const x = d(mo, 1); while (x.getUTCDay() !== 1) x.setUTCDate(x.getUTCDate() + 1); return x; };
  const lastMonday = (mo) => { const x = new Date(Date.UTC(year, mo, 0)); while (x.getUTCDay() !== 1) x.setUTCDate(x.getUTCDate() - 1); return x; };
  out.push(['Early May bank holiday', firstMonday(5)], ['Spring bank holiday', lastMonday(5)], ['Summer bank holiday', lastMonday(8)]);
  const xmas = d(12, 25), boxing = d(12, 26);
  const xd = xmas.getUTCDay();
  if (xd === 6) { out.push(['Christmas Day', d(12, 27)], ['Boxing Day', d(12, 28)]); }
  else if (xd === 0) { out.push(['Christmas Day', d(12, 27)], ['Boxing Day', d(12, 26)]); }
  else if (xd === 5) { out.push(['Christmas Day', xmas], ['Boxing Day', d(12, 28)]); }
  else out.push(['Christmas Day', xmas], ['Boxing Day', boxing]);
  return out.map(([name, date]) => ({ name, date: iso(date.getTime()) })).sort((x, y) => x.date.localeCompare(y.date));
}

// England's bank holidays: gov.uk's list (fetched weekly, so one-off holidays are
// included), with the regular ones worked out for any year it doesn't cover.
async function refreshHolidays(env) {
  const at = Number((await getState(env, 'bank_holidays_at')) || 0);
  if (Date.now() - at < 7 * FULL_EVERY_MS) return;
  await setState(env, 'bank_holidays_at', Date.now());
  try {
    const res = await fetch('https://www.gov.uk/bank-holidays.json');
    if (!res.ok) return;
    const data = await res.json();
    const events = (data['england-and-wales']?.events || []).map((e) => ({ name: e.title, date: e.date })).filter((e) => isDate(e.date));
    if (events.length) await setState(env, 'bank_holidays', JSON.stringify(events));
  } catch { /* the worked-out list does */ }
}

export async function holidaysFor(env) {
  let listed = [];
  try { listed = JSON.parse((await getState(env, 'bank_holidays')) || '[]'); } catch { /* none */ }
  const years = new Set(listed.map((h) => h.date.slice(0, 4)));
  const y = Number(londonDate().slice(0, 4));
  const worked = [y - 1, y, y + 1, y + 2].filter((yr) => !years.has(String(yr))).flatMap((yr) => bankHolidays(yr));
  return [...listed, ...worked].sort((a, b) => a.date.localeCompare(b.date));
}

export async function insights(env, viewer) {
  mustSee(viewer, true);
  const today = londonDate();
  const st = await loadState(env);
  const year = Number(today.slice(0, 4));
  const active = st.contracts.filter((c) => [STATUS.inContract, STATUS.renewal].includes(c.status) && c.start_date && c.end_date);

  // Renewals
  const horizon = addDays(today, 90);
  const upcoming = st.contracts.filter((c) => [STATUS.inContract, STATUS.renewal].includes(c.status) && c.end_date && c.end_date <= horizon)
    .sort((a, b) => a.end_date.localeCompare(b.end_date))
    .map((c) => ({ key: c.issue_key, customer: c.customer, status: c.status, end: c.end_date, days: daysBetween(today, c.end_date) }));
  const chasing = st.contracts.filter((c) => [STATUS.sent, STATUS.chasing].includes(c.status))
    .map((c) => ({ key: c.issue_key, customer: c.customer, status: c.status, start: c.start_date, late: Boolean(c.start_date && c.start_date < today) }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const yearAgo = addDays(today, -365);
  const finished = st.contracts.filter((c) => c.end_date && c.end_date >= yearAgo && c.end_date < today);
  const renewed = finished.filter((c) => c.status === STATUS.archived).length;
  const lost = finished.filter((c) => c.status === STATUS.lost).length;
  const undecided = finished.filter((c) => c.status === STATUS.expired).length;

  // Token pace
  const pace = active.map((c) => {
    const n = tokenCounts(st.items.filter((i) => i.contract_key === c.issue_key));
    const length = Math.max(1, daysBetween(c.start_date, c.end_date));
    const elapsed = Math.min(length, Math.max(1, daysBetween(c.start_date, today)));
    const perDay = n.spent / elapsed;                               // the rate tokens are actually being used
    const left = n.total - n.used;                                  // what's not used or set aside
    const runsOut = perDay > 0 && left > 0 ? addDays(today, Math.floor(left / perDay)) : null;
    return { key: c.issue_key, customer: c.customer, end: c.end_date, total: n.total, used: n.spent, allocated: n.allocated, overdraft: n.overdraft,
      timeShare: elapsed / length, tokenShare: n.total ? n.used / n.total : 0, runsOut, left, early: Boolean(runsOut && runsOut < c.end_date) };
  }).filter((p) => p.total > 0).sort((a, b) => (b.overdraft - a.overdraft) || (Number(b.early) - Number(a.early)) || (b.tokenShare - b.timeShare) - (a.tokenShare - a.timeShare));

  // Visits falling behind
  const behind = [];
  for (const c of active) {
    const length = Math.max(1, daysBetween(c.start_date, c.end_date));
    const share = Math.min(1, Math.max(0, daysBetween(c.start_date, today) / length));
    for (const [kind, label] of [['visit', 'Service visits'], ['calibration', 'Calibration visits'], ['obsolescence', 'Obsolescence survey']]) {
      const v = st.items.filter((i) => i.contract_key === c.issue_key && i.kind === kind);
      if (!v.length) continue;
      const done = v.filter((x) => x.done).length;
      const expected = Math.floor(v.length * share);
      if (done < expected || (done < v.length && daysBetween(today, c.end_date) <= 60)) {
        behind.push({ key: c.issue_key, customer: c.customer, label, done, total: v.length, weeksLeft: Math.max(0, Math.floor(daysBetween(today, c.end_date) / 7)) });
      }
    }
  }
  behind.sort((a, b) => a.weeksLeft - b.weeksLeft);

  // Time that isn't reaching a contract (last 90 days), and where service time went (last 30)
  const from = addDays(today, -LOOKBACK_DAYS);
  const recent = addDays(today, -TIME_DAYS);
  const logs = await worklogsSince(env, from);
  const { results: emps } = await env.DB.prepare('SELECT account_id, name FROM employees').all();
  const names = new Map(emps.map((e) => [e.account_id, e.name]));
  const noOrg = new Map(), noContract = new Map(), unmatched = new Map(), byCustomer = new Map(), byPerson = new Map();
  const line = (w, p) => {
    const issue = p.issue || st.issues.get(String(w.issue_id));
    const item = st.items.find((i) => i.issue_id === String(w.issue_id));
    const key = issue?.issue_key || item?.issue_key || p.contract?.issue_key || '';
    const summary = issue?.summary || item?.summary || (p.via === 'contract' ? 'Time on the service contract' : '');
    return { date: w.work_date, key, summary, customer: p.contract?.customer || null, who: names.get(w.account_id) || 'Someone without a profile', seconds: w.seconds };
  };
  const add = (m, k, w, p, extra = {}) => {
    const r = m.get(k) || { ...extra, seconds: 0, logs: [] };
    r.seconds += w.seconds;
    r.logs.push(line(w, p));
    m.set(k, r);
  };
  const customerName = new Map(st.projects.map((p) => [p.key, p.name]));
  for (const w of logs) {
    const p = placeWorklog(w, st);
    if (p.contract) {
      if (w.work_date < recent) continue;
      add(byCustomer, p.contract.project_key, w, p, { customer: p.contract.customer });
      add(byPerson, w.account_id, w, p, { name: names.get(w.account_id) || 'Someone without a profile' });
    } else if (p.skip === 'no-org') add(noOrg, p.issue.issue_key, w, p, { key: p.issue.issue_key, summary: p.issue.summary });
    else if (p.skip === 'no-contract') add(noContract, p.project, w, p, { customer: customerName.get(p.project) || p.project });
    else if (p.skip === 'unmatched') add(unmatched, p.org, w, p, { org: p.org });
  }
  const top = (m, n = 10) => [...m.values()].sort((a, b) => b.seconds - a.seconds).slice(0, n)
    .map((r) => ({ ...r, logs: r.logs.sort((a, b) => b.date.localeCompare(a.date) || b.seconds - a.seconds).slice(0, 300) }));

  const holidays = (await holidaysFor(env)).filter((h) => h.date >= today).slice(0, 3);

  return {
    today,
    renewals: { upcoming, chasing, renewed, lost, undecided },
    pace,
    behind,
    leaks: { noOrg: top(noOrg, 15), noContract: top(noContract), unmatched: top(unmatched) },
    time: { days: TIME_DAYS, customers: top(byCustomer), people: top(byPerson) },
    holidays,
  };
}
