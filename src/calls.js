// 8x8 Work calls: fetched only when someone asks for them, matched to the
// engineer who took them, and turned into time logs or service items.
import { searchJql } from './jira.js';
import { londonDate } from './sync.js';

const PSC_TYPES = ['Snag', 'Incident', 'Further Investigation', 'PSC', 'Problem', 'Change', 'Service Request'];
const PSC_CLOSED = ['Resolved [Promtek]', 'Verified [Customer]'];
const SHARED_LINES = ['+27875509066', '+27875509067', '+441782375600', '+441782375601'];

// Numbers are stored and compared without spaces or punctuation, with UK and
// South African numbers reduced to a common form.
export function normalisePhone(value) {
  let digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (digits.startsWith('0') && digits.length >= 10) digits = `+44${digits.slice(1)}`;
  if (!digits.startsWith('+') && digits.length >= 11) digits = `+${digits}`;
  return digits;
}

const isExtension = (value) => /^\d{1,6}$/.test(String(value || ''));
export const base = (env) => env.EIGHT8_BASE_URL || 'https://api.8x8.com/analytics/work';

let cachedToken = { value: null, expires: 0 };

export async function accessToken(env) {
  if (cachedToken.value && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  if (!env.EIGHT8_API_KEY || !env.EIGHT8_USERNAME || !env.EIGHT8_PASSWORD) {
    throw new Error('8x8 is not set up yet. An admin needs to add the API key and account details.');
  }
  const res = await fetch(`${base(env)}/v1/oauth/token`, {
    method: 'POST',
    headers: { '8x8-apikey': env.EIGHT8_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: env.EIGHT8_USERNAME, password: env.EIGHT8_PASSWORD }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(res.status === 401
      ? `8x8 refused the sign-in. Check the account details, and that the account has opened Analytics in a browser at least once. (${detail})`
      : `8x8 sign-in failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 1800) * 1000 };
  return cachedToken.value;
}

// One day of calls for the whole company; filtering happens below.
async function fetchDay(env, date) {
  const token = await accessToken(env);
  const calls = [];
  let scrollId = null;

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      pbxId: env.EIGHT8_PBX_ID || 'allpbxes',
      startTime: `${date} 00:00:00`,
      endTime: `${date} 23:59:59`,
      timeZone: 'Europe/London',
      pageSize: '100',
    });
    if (scrollId) params.set('scrollId', scrollId);

    const res = await fetch(`${base(env)}/v2/call-records?${params}`, {
      headers: { Authorization: `Bearer ${token}`, '8x8-apikey': env.EIGHT8_API_KEY, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`8x8 call records failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    calls.push(...(data.data || []));
    scrollId = data.meta?.scrollId;
    if (!scrollId || scrollId === 'No Data' || !(data.data || []).length) break;
  }
  return calls;
}

// Works out who the other party was, and whether this call was the engineer's.
function shape(record, employee) {
  const incoming = String(record.direction || '').toLowerCase().startsWith('in');
  const otherRaw = incoming ? record.caller : (record.callee || record.dnis);
  const otherName = incoming ? record.callerName : record.calleeName;
  const mineRaw = incoming ? record.callee : record.caller;
  const mineName = incoming ? record.calleeName : record.callerName;

  const name = String(employee?.name || '').toLowerCase();
  const extension = String(employee?.extension || '');
  const matchesName = name && [mineName, record.calleeName, record.callerName]
    .some((value) => String(value || '').toLowerCase() === name);
  const matchesExtension = extension && [mineRaw, record.callee, record.caller]
    .some((value) => String(value || '') === extension);

  return {
    callId: String(record.callId),
    direction: incoming ? 'in' : 'out',
    started: record.startTime || '',
    startedAt: record.startTimeUTC || 0,
    seconds: Math.round((Number(record.talkTimeMS) || Number(record.callTime) || 0) / 1000),
    talkTime: record.talkTime && record.talkTime !== '00:00:00' ? record.talkTime : null,
    answered: record.missed !== 'Missed',
    other: normalisePhone(otherRaw),
    otherRaw: String(otherRaw || ''),
    otherName: otherName && otherName !== otherRaw ? otherName : null,
    // Who dealt with it, which matters on the everyone view.
    handledBy: (incoming ? record.calleeName : record.callerName) || null,
    sharedLine: [record.callee, record.caller, record.dnis].some((value) => SHARED_LINES.includes(normalisePhone(value)))
      || [record.calleeName, record.callerName].some((value) => String(value || '').toLowerCase().includes('queue')),
    mine: Boolean(matchesName || matchesExtension),
  };
}

export async function myCalls(env, viewer, { date, all = false } = {}) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : londonDate();
  const raw = await fetchDay(env, day);
  const calls = raw
    .map((record) => shape(record, viewer.employee))
    .filter((call) => !isExtension(call.otherRaw))         // internal calls aren't customers
    // Missed incoming calls are noise here; outgoing ones always count.
    .filter((call) => call.direction === 'out' || call.answered);

  const mine = all ? calls : calls.filter((call) => call.mine);
  const numbers = [...new Set(mine.map((c) => c.other).filter(Boolean))];
  const known = new Map();
  if (numbers.length) {
    const { results } = await env.DB.prepare(
      `SELECT phone, project_key, label, kind FROM call_customers WHERE phone IN (${numbers.map(() => '?').join(',')})`
    ).bind(...numbers).all();
    results.forEach((row) => known.set(row.phone, row));
  }

  const { results: actions } = await env.DB.prepare(
    'SELECT call_id, action, issue_key FROM call_actions WHERE account_id = ?'
  ).bind(viewer.accountId).all();
  const handled = new Map(actions.map((a) => [a.call_id, a]));

  return {
    date: day,
    total: calls.length,
    matched: calls.filter((c) => c.mine).length,
    showingAll: all,
    calls: mine
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((call) => ({
        ...call,
        customer: known.get(call.other) || null,
        handled: handled.get(call.callId) || null,
      })),
  };
}

// Remembers which customer a number belongs to, so it's known next time.
export async function linkNumber(env, viewer, { phone, projectKey, label, kind = 'customer' }) {
  const number = normalisePhone(phone);
  if (!number) throw new Error('No number to link.');
  if (kind === 'customer' && !projectKey) throw new Error('Pick the customer.');
  await env.DB.prepare(
    `INSERT INTO call_customers (phone, project_key, label, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET project_key = excluded.project_key, label = excluded.label, kind = excluded.kind`
  ).bind(number, projectKey || '', label || null, kind, viewer.accountId, new Date().toISOString()).run();
  return { phone: number };
}

export async function forgetNumber(env, phone) {
  await env.DB.prepare('DELETE FROM call_customers WHERE phone = ?').bind(normalisePhone(phone)).run();
  return { ok: true };
}

export async function markHandled(env, viewer, { callId, action, issueKey, worklogId }) {
  await env.DB.prepare(
    `INSERT INTO call_actions (call_id, account_id, action, issue_key, worklog_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(call_id, account_id) DO UPDATE SET action = excluded.action, issue_key = excluded.issue_key,
       worklog_id = excluded.worklog_id, created_at = excluded.created_at`
  ).bind(String(callId), viewer.accountId, action, issueKey || null, worklogId || null, new Date().toISOString()).run();
  // A call the tracker timed is done once its details are in.
  await env.DB.prepare("UPDATE tracker_stretches SET status = 'logged', worklog_id = COALESCE(?, worklog_id) WHERE call_id = ? AND account_id = ? AND status = 'needs details'")
    .bind(worklogId || null, String(callId), viewer.accountId).run().catch(() => {});
  return { ok: true };
}

// The open service items for a customer, plus their contract, for the
// "does this call relate to one of these?" step.
export async function openPscs(env, projectKey) {
  const [open, contracts] = await Promise.all([
    searchJql(env,
      `project = "${projectKey}" AND issuetype in (${PSC_TYPES.map((t) => `"${t}"`).join(', ')})`
      + ` AND status not in (${PSC_CLOSED.map((s) => `"${s}"`).join(', ')}) ORDER BY updated DESC`,
      ['summary', 'issuetype', 'status'], { limit: 25 }),
    searchJql(env, `project = "${projectKey}" AND issuetype = "Service Contract" ORDER BY created DESC`,
      ['summary', 'issuetype', 'status'], { limit: 3 }),
  ]);
  return {
    options: [...open, ...contracts].map((issue) => ({
      id: issue.key,
      issueId: String(issue.id),
      label: issue.key,
      title: issue.fields?.summary || '',
      sublabel: [issue.fields?.issuetype?.name, issue.fields?.status?.name].filter(Boolean).join(', '),
      loggable: true,
    })),
  };
}

// Customer projects, for picking who an unknown number belongs to.
export async function customerList(env) {
  const projects = [];
  for (const categoryId of ['10333', '10300']) {
    let startAt = 0;
    for (let page = 0; page < 10; page++) {
      const { jira } = await import('./jira.js');
      const data = await jira(env, `/rest/api/3/project/search?categoryId=${categoryId}&status=live&orderBy=name&maxResults=50&startAt=${startAt}`);
      projects.push(...(data.values || []).map((p) => ({ key: p.key, name: p.name })));
      if (data.isLast || !data.values?.length) break;
      startAt += data.values.length;
    }
  }
  const seen = new Set();
  return { customers: projects.filter((p) => (seen.has(p.key) ? false : seen.add(p.key))) };
}

// A quick connection test for the Admin page.
export async function testConnection(env) {
  const day = londonDate();
  const calls = await fetchDay(env, day);
  return {
    ok: true,
    date: day,
    records: calls.length,
    sample: calls.slice(0, 2).map((c) => ({
      direction: c.direction, caller: c.caller, callerName: c.callerName,
      callee: c.callee, calleeName: c.calleeName, talkTime: c.talkTime, startTime: c.startTime,
    })),
  };
}

// Calls in progress across the phone system, for spotting a call as it happens.
// Each call's caller and callee are searched for extensions, since the order and
// names of 8x8's fields aren't relied on.
export async function activeCalls(env) {
  if (!env.EIGHT8_PBX_ID) throw new Error('Live calls need EIGHT8_PBX_ID set to your PBX name.');
  const token = await accessToken(env);
  const res = await fetch(`${base(env)}/v2/pbxes/${encodeURIComponent(env.EIGHT8_PBX_ID)}/calls/active?paging=0,100&sorting=startTime,desc`, {
    headers: { Authorization: `Bearer ${token}`, '8x8-apikey': env.EIGHT8_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`8x8 live calls ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.calls || data.content || [];
  const values = (o, out = []) => {
    if (o == null) return out;
    if (typeof o !== 'object') { out.push(String(o)); return out; }
    for (const v of Object.values(o)) values(v, out);
    return out;
  };
  return list.map((c) => {
    const parties = [c.caller, c.latestCallee, c.callee].filter(Boolean);
    const seen = parties.flatMap((p) => values(p));
    const other = parties.flatMap((p) => values(p)).find((v) => normalisePhone(v).length > 7) || null;
    return {
      callId: String(c.callId ?? c.id ?? ''),
      startedAt: Date.parse(c.startTime || c.startTimeUTC || '') || (Number(c.startTimeUTC) || Date.now()),
      parties: seen.map(String),
      other: other ? normalisePhone(other) : null,
      otherName: c.caller?.name || c.callerName || null,
    };
  }).filter((c) => c.callId);
}
