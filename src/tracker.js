// The active time tracker. Every stretch between starting and pausing is its own
// Tempo worklog with its real start time, sent the moment the stretch ends.
// The timer lives in the hub, so it carries on across tabs and devices.
import { createWorklog } from './logging.js';
import { getIssue } from './jira.js';
import { getState, setState, londonDate, raiseAlert } from './sync.js';

export const ASSIST = {
  team: { key: 'PMB-37', label: 'Assisting the team' },
  apprentice: { key: 'PMB-39', label: 'Assisting an apprentice' },
};
const MIN_SECONDS = 60;
const LIVE_CACHE_MS = 15_000;          // one check of 8x8 every 15 seconds, shared by everyone
const LIVE_BACKOFF_MS = 5 * 60_000;    // after 8x8 refuses, wait before asking again
const RECORDS_EVERY_MS = 3 * 60_000;   // the after-the-call check, per person

function londonParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
// The start of the next London day after a moment, for splitting at midnight.
function nextLondonMidnight(ms) {
  const { day } = londonParts(ms);
  let t = Date.parse(`${day}T00:00:00Z`) + 86_400_000 - 3 * 3600_000;
  while (londonParts(t).day === day) t += 15 * 60_000;
  while (londonParts(t - 60_000).day !== day) t -= 60_000;
  return t;
}

async function load(env, accountId) {
  const row = await env.DB.prepare('SELECT * FROM active_timers WHERE account_id = ?').bind(accountId).first();
  if (!row) return null;
  return { ...row, job: JSON.parse(row.job || 'null'), current: JSON.parse(row.current || 'null'), dismissed: JSON.parse(row.dismissed || '[]') };
}

async function save(env, accountId, t) {
  if (!t) { await env.DB.prepare('DELETE FROM active_timers WHERE account_id = ?').bind(accountId).run(); return; }
  await env.DB.prepare(
    `INSERT INTO active_timers (account_id, job, current, state, dismissed, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET job = excluded.job, current = excluded.current, state = excluded.state,
       dismissed = excluded.dismissed, updated_at = excluded.updated_at`
  ).bind(accountId, JSON.stringify(t.job || null), JSON.stringify(t.current || null), t.state, JSON.stringify((t.dismissed || []).slice(-50)),
    new Date().toISOString()).run();
}

const issueCache = new Map();
async function issueFor(env, key) {
  if (issueCache.has(key)) return issueCache.get(key);
  const i = await getIssue(env, key, ['summary']);
  if (!i) throw new Error(`${key} couldn't be found in Jira.`);
  const v = { issueId: String(i.id), issueKey: i.key, summary: i.fields?.summary || key };
  issueCache.set(key, v);
  return v;
}

function describe(cur) {
  if (cur.kind === 'team' || cur.kind === 'apprentice') {
    const who = cur.whoName ? ` ${cur.whoName}` : '';
    return `${ASSIST[cur.kind].label}${who}${cur.theirKey ? ` on ${cur.theirKey}` : ''}${cur.callId ? ' (8x8 call)' : ''}. Tracked in Promtek Hub.`;
  }
  return 'Tracked in Promtek Hub.';
}

// Ends the running stretch at `at` and sends it to Tempo, split at midnight if it
// crossed one. A call's stretch waits for its details instead.
async function endStretch(env, viewer, cur, at) {
  const out = [];
  let from = Date.parse(cur.startedAt);
  const to = Math.min(at, Date.now());
  while (from < to) {
    const cut = Math.min(to, nextLondonMidnight(from));
    out.push([from, cut]);
    from = cut;
  }
  const saved = [];
  for (const [a, b] of out) {
    const seconds = Math.round((b - a) / 1000);
    const { day, time } = londonParts(a);
    const base = [viewer.accountId, cur.issueId || null, cur.issueKey || null, cur.kind, new Date(a).toISOString(), new Date(b).toISOString(), seconds, describe(cur), cur.callId || null];
    if (seconds < MIN_SECONDS) {
      await env.DB.prepare(`INSERT INTO tracker_stretches (account_id, issue_id, issue_key, kind, started_at, ended_at, seconds, description, call_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'too short', ?)`).bind(...base, new Date().toISOString()).run();
      continue;
    }
    if (cur.kind === 'call') {
      const r = await env.DB.prepare(`INSERT INTO tracker_stretches (account_id, issue_id, issue_key, kind, started_at, ended_at, seconds, description, call_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs details', ?)`).bind(...base, new Date().toISOString()).run();
      saved.push({ id: r.meta?.last_row_id, status: 'needs details', seconds });
      continue;
    }
    let status = 'logged', worklogId = null, error = null;
    try {
      worklogId = (await createWorklog(env, viewer, { issueId: cur.issueId, issueKey: cur.issueKey, seconds, date: day, startTime: time, description: describe(cur) })).worklogId;
    } catch (err) { status = 'waiting'; error = err.message.slice(0, 300); }
    await env.DB.prepare(`INSERT INTO tracker_stretches (account_id, issue_id, issue_key, kind, started_at, ended_at, seconds, description, call_id, status, worklog_id, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...base, status, worklogId, error, new Date().toISOString()).run();
    saved.push({ status, seconds, error });
  }
  return saved;
}

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

export async function status(env, viewer) {
  if (!viewer.accountId) return { timer: null, today: [] };
  const t = await load(env, viewer.accountId);
  const { results } = await env.DB.prepare(
    `SELECT id, issue_key, kind, started_at, ended_at, seconds, status, error, call_id FROM tracker_stretches
      WHERE account_id = ? AND (started_at >= ? OR status IN ('waiting', 'needs details')) ORDER BY started_at DESC LIMIT 60`
  ).bind(viewer.accountId, iso(Date.parse(`${londonDate()}T00:00:00Z`) - 3600_000)).all();
  const running = t?.current ? { ...t.current, seconds: Math.round((now() - Date.parse(t.current.startedAt)) / 1000) } : null;
  return { timer: t ? { job: t.job, current: running, state: t.state } : null, today: results, assist: ASSIST, serverNow: iso(now()) };
}

export async function start(env, viewer, { issueId, issueKey, summary }) {
  if (!viewer.accountId) throw new Error("Your account isn't linked to a profile yet.");
  if (!issueId || !issueKey) throw new Error('Choose the job first.');
  const t = (await load(env, viewer.accountId)) || { dismissed: [] };
  if (t.current) await endStretch(env, viewer, t.current, now());
  const job = { issueId: String(issueId), issueKey, summary: summary || issueKey };
  await save(env, viewer.accountId, { ...t, job, current: { kind: 'job', ...job, startedAt: iso(now()) }, state: 'running' });
  return status(env, viewer);
}

export async function pause(env, viewer) {
  const t = await load(env, viewer.accountId);
  if (!t?.current) return status(env, viewer);
  const saved = await endStretch(env, viewer, t.current, now());
  await save(env, viewer.accountId, { ...t, current: null, state: 'paused' });
  return { ...(await status(env, viewer)), saved };
}

export async function resume(env, viewer) {
  const t = await load(env, viewer.accountId);
  if (!t?.job) throw new Error('There is nothing to carry on with.');
  if (t.current) await endStretch(env, viewer, t.current, now());
  await save(env, viewer.accountId, { ...t, current: { kind: 'job', ...t.job, startedAt: iso(now()) }, state: 'running' });
  return status(env, viewer);
}

// Stopping can take an earlier end time, for a timer left running by mistake.
export async function stop(env, viewer, { endedAt } = {}) {
  const t = await load(env, viewer.accountId);
  let saved = [];
  if (t?.current) {
    const at = endedAt ? Date.parse(endedAt) : now();
    if (Number.isNaN(at) || at < Date.parse(t.current.startedAt)) throw new Error('The end time needs to be after the timer started.');
    saved = await endStretch(env, viewer, t.current, at);
  }
  await save(env, viewer.accountId, null);
  return { ...(await status(env, viewer)), saved };
}

// Assisting a colleague: the job pauses and the assist is timed on its own item.
export async function assist(env, viewer, { kind, whoId, whoName, theirKey, at, callId } = {}) {
  if (!ASSIST[kind]) throw new Error('Choose assisting the team or an apprentice.');
  const t = (await load(env, viewer.accountId)) || { dismissed: [] };
  const from = at ? Math.min(Date.parse(at), now()) : now();
  if (t.current) await endStretch(env, viewer, t.current, from);
  const item = await issueFor(env, ASSIST[kind].key);
  await save(env, viewer.accountId, { ...t, current: { kind, ...item, whoId: whoId || null, whoName: whoName || null, theirKey: theirKey || null,
    callId: callId || null, startedAt: iso(from) }, state: 'running' });
  return status(env, viewer);
}

// The end of an assist or a call: it's logged, then the job carries on or waits.
export async function endInterruption(env, viewer, { resume: carryOn = false, at } = {}) {
  const t = await load(env, viewer.accountId);
  if (!t?.current || t.current.kind === 'job') return status(env, viewer);
  const end = at ? Math.min(Date.parse(at), now()) : now();
  const saved = await endStretch(env, viewer, t.current, end);
  const next = carryOn && t.job ? { kind: 'job', ...t.job, startedAt: iso(end) } : null;
  await save(env, viewer.accountId, t.job ? { ...t, current: next, state: next ? 'running' : 'paused' } : null);
  return { ...(await status(env, viewer)), saved };
}

// ---------- 8x8 ----------

// One look at 8x8's live calls, shared by everyone for 15 seconds.
async function liveCalls(env) {
  const cached = JSON.parse((await getState(env, 'eight8_live')) || '{}');
  if (cached.error && now() - cached.at < LIVE_BACKOFF_MS) return { ok: false, error: cached.error };
  if (cached.at && now() - cached.at < LIVE_CACHE_MS) return { ok: true, calls: cached.calls || [] };
  try {
    const { activeCalls } = await import('./calls.js');
    const calls = await activeCalls(env);
    await setState(env, 'eight8_live', JSON.stringify({ at: now(), calls }));
    return { ok: true, calls };
  } catch (err) {
    await setState(env, 'eight8_live', JSON.stringify({ at: now(), error: err.message.slice(0, 300) }));
    return { ok: false, error: err.message };
  }
}

// Asked by the open hub every 20 seconds or so: is this person on a call?
export async function poll(env, viewer) {
  const base = await status(env, viewer);
  const ext = String(viewer.employee?.extension || '');
  if (!ext || !viewer.accountId) return { ...base, call: null };
  const t = (await load(env, viewer.accountId)) || null;
  const dismissed = new Set(t?.dismissed || []);
  const live = await liveCalls(env);
  if (live.ok) {
    const mine = live.calls.find((c) => c.parties.includes(ext));
    // A timed call that's no longer live has ended.
    if (t?.current?.callId && !live.calls.some((c) => c.callId === t.current.callId)) {
      const ended = await endInterruption(env, viewer, { resume: false });
      return { ...ended, call: null, callEnded: { kind: t.current.kind, job: t.job } };
    }
    if (mine && !dismissed.has(mine.callId) && t?.current?.callId !== mine.callId) {
      return { ...base, call: { ...mine, live: true } };
    }
    return { ...base, call: null };
  }
  // No live view from 8x8: look for finished calls inside the stretch that's running.
  if (!t?.current || t.current.kind !== 'job') return { ...base, call: null, live: false };
  const last = Number(await getState(env, `eight8_records:${viewer.accountId}`)) || 0;
  if (now() - last < RECORDS_EVERY_MS) return { ...base, call: null, live: false };
  await setState(env, `eight8_records:${viewer.accountId}`, String(now()));
  try {
    const { myCalls } = await import('./calls.js');
    const { calls } = await myCalls(env, viewer, { date: londonDate() });
    const since = Date.parse(t.current.startedAt);
    const past = calls.find((c) => c.startedAt >= since && c.seconds >= MIN_SECONDS && !dismissed.has(String(c.callId)) && !c.handled);
    return { ...base, live: false, call: past ? { callId: String(past.callId), startedAt: past.startedAt, endedAt: past.startedAt + past.seconds * 1000,
      other: past.other, otherName: past.otherName || past.customer?.label || null, live: false } : null };
  } catch { return { ...base, call: null, live: false }; }
}

// The engineer's answer to "you're on a call". A finished call is cut out of the
// running job stretch, so the two never overlap.
export async function answerCall(env, viewer, { callId, choice, startedAt, endedAt, whoName, theirKey }) {
  const t = (await load(env, viewer.accountId)) || { dismissed: [], state: 'paused' };
  if (choice === 'ignore') {
    await save(env, viewer.accountId, t.job || t.current ? { ...t, dismissed: [...(t.dismissed || []), String(callId)] } : { ...t, dismissed: [...(t.dismissed || []), String(callId)], state: 'paused' });
    return status(env, viewer);
  }
  if (!['call', 'team', 'apprentice'].includes(choice)) throw new Error('Choose what the call was.');
  const callStart = Math.min(Number(startedAt) || Date.parse(startedAt) || now(), now());
  const callEnd = endedAt ? Math.min(Number(endedAt) || Date.parse(endedAt), now()) : null;
  const dismissed = [...(t.dismissed || []), String(callId)];
  if (t.current) await endStretch(env, viewer, t.current, Math.max(callStart, Date.parse(t.current.startedAt)));
  const item = choice === 'call' ? { kind: 'call' } : { kind: choice, ...(await issueFor(env, ASSIST[choice].key)), whoName: whoName || null, theirKey: theirKey || null };
  const cur = { ...item, callId: String(callId), startedAt: iso(callStart) };
  if (callEnd) {
    // Already over: log it now and carry on with the job from when the call ended.
    const saved = await endStretch(env, viewer, cur, callEnd);
    const wasRunningJob = t.current?.kind === 'job';
    await save(env, viewer.accountId, { ...t, dismissed, current: wasRunningJob ? { kind: 'job', ...t.job, startedAt: iso(callEnd) } : null,
      state: wasRunningJob ? 'running' : 'paused' });
    return { ...(await status(env, viewer)), saved };
  }
  await save(env, viewer.accountId, { ...t, dismissed, current: cur, state: 'running' });
  return status(env, viewer);
}

// A call's time goes to Tempo through the 8x8 calls flow, once its details are in.
export async function callLogged(env, viewer, { stretchId, worklogId }) {
  await env.DB.prepare("UPDATE tracker_stretches SET status = 'logged', worklog_id = ? WHERE id = ? AND account_id = ?")
    .bind(worklogId || null, Number(stretchId), viewer.accountId).run();
  return { ok: true };
}

// Stretches Tempo turned down are tried again, a few at a time.
export async function retry(env) {
  const { results } = await env.DB.prepare("SELECT * FROM tracker_stretches WHERE status = 'waiting' ORDER BY id LIMIT 10").all();
  if (!results.length) return { idle: true };
  for (const s of results) {
    const { day, time } = londonParts(Date.parse(s.started_at));
    try {
      const w = await createWorklog(env, { accountId: s.account_id }, { issueId: s.issue_id, issueKey: s.issue_key, seconds: s.seconds, date: day, startTime: time, description: s.description });
      await env.DB.prepare("UPDATE tracker_stretches SET status = 'logged', worklog_id = ?, error = NULL WHERE id = ?").bind(w.worklogId, s.id).run();
    } catch (err) {
      await env.DB.prepare('UPDATE tracker_stretches SET error = ? WHERE id = ?').bind(err.message.slice(0, 300), s.id).run();
    }
  }
  return { tried: results.length };
}

// 5pm: anyone whose timer is still running gets a reminder.
export async function eveningReminder(env) {
  const { time, day } = londonParts(now());
  if (time < '17:00:00' || time >= '18:00:00') return { idle: true };
  const { results } = await env.DB.prepare(
    `SELECT t.account_id, t.current, e.email, e.name FROM active_timers t JOIN employees e ON e.account_id = t.account_id
      WHERE t.state = 'running' AND e.email IS NOT NULL`
  ).all();
  for (const r of results) {
    const cur = JSON.parse(r.current || 'null');
    if (!cur) continue;
    await raiseAlert(env, { kind: 'tracker', dedupe: `tracker:${r.account_id}:${day}`, recipient: r.email,
      subject: 'Your timer is still running',
      body: `${(r.name || '').split(' ')[0] || 'Hi'}, your timer on ${cur.issueKey || 'a call'} has been running since ${londonParts(Date.parse(cur.startedAt)).time.slice(0, 5)}. If you've finished, open the hub to stop it; you can set the time you actually stopped.` });
  }
  return { reminded: results.length };
}
