// XP Rates on Jira items, set from the hub. An item's XP Rate scales the XP its time earns:
// 0 for none, 0.5 for half, 1.5 for half as much again. Set here, it's written to the item's
// XP Rate field in Jira and noted with the day it starts, so time already logged keeps the
// rate it earned unless the change is meant to cover that too. Items paying extra are shown
// to everyone on Log time, as a nudge towards the jobs that need doing.
import { jira, searchJql, getIssue, blockedForLookup } from './jira.js';
import { getState, setState, londonDate, recalcIssues } from './sync.js';
import { record } from './audit.js';

export const xpRateField = (env) => env.FIELD_XP_OVERRIDE || 'customfield_16566';
const cfOf = (env) => `cf[${xpRateField(env).replace('customfield_', '')}]`;
const MAX_PERCENT = 500;
const BONUS_CACHE_MS = 10 * 60 * 1000;
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const placeholders = (n) => Array(n).fill('?').join(',');

// The rate a piece of time on an item earns, from the day it was logged. Before the first change
// made in the hub, the rate the item had then; between changes, the one in force; since the
// latest, Jira's own (the same, unless someone has changed it in Jira since).
export function rateFor(history, date, jiraRate) {
  if (!history?.length) return jiraRate;
  const sorted = [...history].sort((a, b) => (a.from_date === b.from_date ? a.id - b.id : a.from_date.localeCompare(b.from_date)));
  if (date < sorted[0].from_date) return sorted[0].previous ?? jiraRate;
  for (let i = 0; i < sorted.length - 1; i++) if (date >= sorted[i].from_date && date < sorted[i + 1].from_date) return sorted[i].rate;
  return jiraRate;
}

export async function historyFor(env, issueIds) {
  const ids = [...new Set(issueIds.map(String))];
  const map = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT * FROM xp_rate_history WHERE issue_id IN (${placeholders(part.length)})`).bind(...part).all()
      .catch(() => ({ results: [] }));
    for (const r of results) (map.get(r.issue_id) || map.set(r.issue_id, []).get(r.issue_id)).push(r);
  }
  return map;
}

const shape = (issue, env) => {
  const rate = num(issue.fields?.[xpRateField(env)]);
  return { issueId: String(issue.id), key: issue.key, summary: issue.fields?.summary || '', type: issue.fields?.issuetype?.name || '',
    status: issue.fields?.status?.name || '', rate: rate ?? 1, done: issue.fields?.status?.statusCategory?.key === 'done' };
};

// Every open item whose XP Rate isn't the usual, and the hub's changes to them.
export async function list(env) {
  const fields = ['summary', 'issuetype', 'status', xpRateField(env)];
  let issues = [];
  try { issues = await searchJql(env, `${cfOf(env)} is not EMPTY AND ${cfOf(env)} != 1 AND statusCategory != Done ORDER BY ${cfOf(env)} DESC`, fields, { limit: 200 }); }
  catch (err) { return { items: [], recent: await recentChanges(env), error: `Jira wouldn't list them: ${err.message}` }; }
  return { items: issues.filter((i) => !blockedForLookup(i.key.split('-')[0])).map((i) => shape(i, env)), recent: await recentChanges(env) };
}

async function recentChanges(env) {
  const { results } = await env.DB.prepare('SELECT * FROM xp_rate_history ORDER BY id DESC LIMIT 30').all().catch(() => ({ results: [] }));
  return results.map((r) => ({ key: r.issue_key, summary: r.summary, rate: r.rate, previous: r.previous, from: r.from_date, by: r.set_by_name, at: r.set_at, note: r.note }));
}

export async function lookup(env, query) {
  const q = String(query || '').trim();
  if (q.length < 2) return { items: [] };
  const fields = ['summary', 'issuetype', 'status', xpRateField(env)];
  const jql = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(q) ? `key = "${q.toUpperCase()}"` : `summary ~ "${q.replace(/["\\]/g, '')}" ORDER BY updated DESC`;
  try {
    const issues = await searchJql(env, jql, fields, { limit: 20 });
    return { items: issues.filter((i) => !blockedForLookup(i.key.split('-')[0])).map((i) => shape(i, env)) };
  } catch { return { items: [], error: 'No match for that. Check the key, or try a word from the summary.' }; }
}

export async function setRate(env, viewer, { issueId, percent, note, past }) {
  const id = String(issueId || '');
  if (!/^\d{1,20}$/.test(id)) throw refuse('Choose an item first.');
  const p = Number(percent);
  if (!Number.isFinite(p) || p < 0 || p > MAX_PERCENT) throw refuse(`Give a rate from 0% to ${MAX_PERCENT}%.`);
  const rate = Math.round(p) / 100;
  const issue = await getIssue(env, id, ['summary', 'issuetype', 'status', xpRateField(env)]);
  if (!issue) throw refuse('That item has gone from Jira.', 404);
  if (blockedForLookup(issue.key.split('-')[0])) throw refuse('That project isn\'t used by the hub.');
  const before = num(issue.fields?.[xpRateField(env)]) ?? 1;
  if (before === rate) return { ok: true, unchanged: true, rate };
  // 100% clears the field, so the item is back to normal rather than set to it.
  await jira(env, `/rest/api/3/issue/${encodeURIComponent(issue.key)}`, {
    method: 'PUT', body: JSON.stringify({ fields: { [xpRateField(env)]: rate === 1 ? null : rate } }),
  });
  const today = londonDate();
  const from = past ? '0000-01-01' : today;
  const text = String(note || '').trim().slice(0, 300) || null;
  const stmts = [];
  // Covering time already logged replaces the item's history: one rate for all of it.
  if (past) stmts.push(env.DB.prepare('DELETE FROM xp_rate_history WHERE issue_id = ?').bind(id));
  stmts.push(env.DB.prepare(
    `INSERT INTO xp_rate_history (issue_id, issue_key, summary, rate, previous, from_date, note, set_by, set_by_name, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, issue.key, issue.fields?.summary || '', rate, before, from, text, viewer.email, viewer.employee?.name || viewer.email, new Date().toISOString()));
  stmts.push(env.DB.prepare('UPDATE jobs SET xp_override = ?, fetched_at = ? WHERE issue_id = ?').bind(rate === 1 ? null : rate, Date.now(), id));
  await env.DB.batch(stmts);
  await setState(env, 'xp_bonus_cache', '');
  await record(env, viewer, { area: 'XP rates', action: past ? 'changed an XP rate, including time already logged' : 'changed an XP rate',
    subjectType: 'jira', subjectId: issue.key, label: `${issue.key} ${issue.fields?.summary || ''}`.trim(),
    changes: [{ label: 'XP rate', before: `${Math.round(before * 100)}%`, after: `${Math.round(rate * 100)}%` }], note: text }).catch(() => {});
  let recalculated = 0;
  if (past) recalculated = (await recalcIssues(env, [id])).changed;
  return { ok: true, key: issue.key, rate, previous: before, from, recalculated };
}

// Open items paying more than usual, for Log time. Kept for a few minutes so it's one Jira search, not one a view.
export async function bonusItems(env) {
  try {
    const saved = JSON.parse((await getState(env, 'xp_bonus_cache')) || 'null');
    if (saved && Date.now() - saved.at < BONUS_CACHE_MS) return { items: saved.items };
  } catch { /* looked up again */ }
  const fields = ['summary', 'issuetype', 'status', 'project', xpRateField(env), 'customfield_14562', 'customfield_15378', 'parent', 'assignee'];
  let items = [];
  try {
    const issues = await searchJql(env, `${cfOf(env)} > 1 AND statusCategory != Done ORDER BY ${cfOf(env)} DESC`, fields, { limit: 20 });
    items = issues.filter((i) => !blockedForLookup(i.key.split('-')[0])).map((i) => {
      const s = shape(i, env);
      return { id: i.key, issueId: s.issueId, label: i.key, title: s.summary, sublabel: [s.type, s.status].filter(Boolean).join(', '),
        note: `${Math.round(s.rate * 100)}% XP`, bonus: true, rate: s.rate, jobElo: num(i.fields?.customfield_15378), loggable: true, next: null };
    });
  } catch { return { items: [] }; }
  await setState(env, 'xp_bonus_cache', JSON.stringify({ at: Date.now(), items })).catch(() => {});
  return { items };
}
