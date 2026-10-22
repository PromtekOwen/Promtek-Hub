// Past months of the WIP, rebuilt from Jira's own history. The old sheets say which orders
// were on the WIP each month, and their value and division; everything else (the order's
// status, how many of its items were done, which invoices were invoiced and paid) is worked
// out from each item's change history as it stood at the end of that month.
//
// It reads every order on the old sheets, everything under them and all their change
// history, once, a few dozen calls at a time on its own turn. What it reads is kept, so
// reading a sheet in again only reads what's new.
import { jira } from './jira.js';
import { getState, setState, londonDate } from './sync.js';
import {
  F, OutOfCalls, budget, search, CATEGORY_TYPES, ADMIN_TYPES, isInvoice, isTokenInvoice, invoiceState, snapshotRows, historyRow, metrics, historyFrom,
  shiftMonth, chunk, marks, lower, floorPct, round4, runAll, IN, mustSee, mustEdit,
} from './wip.js';

const RUN_CALLS = 30;
const KEYS_PER_SEARCH = 40;
const PARENTS_PER_SEARCH = 25;
const LOG_IDS = 100;
const FIELDS = ['summary', 'status', 'issuetype', 'parent', 'created', F.share];
const LOG_FIELDS = ['status', F.share];
const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

const isAdminType = (t) => ADMIN_TYPES.includes(lower(t));
const isCategory = (t) => CATEGORY_TYPES.includes(lower(t));

async function readState(env) {
  try { return JSON.parse((await getState(env, 'wip_rebuild')) || 'null'); } catch { return null; }
}
const saveState = (env, s) => setState(env, 'wip_rebuild', JSON.stringify(s));

// Asked for after every sheet is read in, and from the settings.
export async function queue(env) {
  const s = (await readState(env)) || {};
  await saveState(env, { ...s, pending: true, phase: 'statuses', queuedAt: new Date().toISOString(), error: null });
}

export async function pending(env) {
  return Boolean((await readState(env))?.pending);
}

function pastStatement(env, i, orderId, level) {
  const f = i.fields || {};
  return env.DB.prepare(
    `INSERT INTO wip_past_items (issue_id, issue_key, order_id, parent_id, level, issuetype, subtask, created, status_id, status_name, status_cat, share, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, order_id = excluded.order_id, parent_id = excluded.parent_id, level = excluded.level,
       issuetype = excluded.issuetype, subtask = excluded.subtask, created = excluded.created, status_id = excluded.status_id, status_name = excluded.status_name,
       status_cat = excluded.status_cat, share = excluded.share, summary = excluded.summary`
  ).bind(String(i.id), i.key, String(orderId), f.parent?.id ? String(f.parent.id) : null, level, f.issuetype?.name || '', f.issuetype?.subtask ? 1 : 0,
    f.created || null, f.status?.id ? String(f.status.id) : null, f.status?.name || null, f.status?.statusCategory?.key || null,
    f[F.share] === null || f[F.share] === undefined || f[F.share] === '' ? null : Number(f[F.share]), f.summary || '');
}

// Every order key on an imported month.
async function wantedKeys(env) {
  const { results } = await env.DB.prepare("SELECT DISTINCT issue_key FROM wip_snapshots WHERE source LIKE 'import:%' OR source LIKE 'jira:%'").all();
  return results.map((r) => r.issue_key).filter((k) => KEY.test(k));
}

// One step of the read, within this turn's calls. Returns idle when there's nothing to do.
export async function step(env) {
  const s = await readState(env);
  if (!s?.pending) return { idle: true };
  const b = budget(env, RUN_CALLS);
  const out = { phase: s.phase };
  try {
    if (s.phase === 'statuses') {
      const list = await b.call('/rest/api/3/status');
      const map = {};
      for (const st of list || []) map[String(st.id)] = { name: st.name, cat: st.statusCategory?.key || null };
      await setState(env, 'wip_status_map', JSON.stringify(map));
      s.phase = 'keys'; s.missing = s.missing || [];
      await saveState(env, s);
    }
    if (s.phase === 'keys') {
      const wanted = await wantedKeys(env);
      const known = new Set();
      for (const part of chunk(wanted, IN)) {
        for (const r of (await env.DB.prepare(`SELECT issue_key FROM wip_past_items WHERE level = 0 AND issue_key IN (${marks(part.length)})`).bind(...part).all()).results) known.add(r.issue_key);
      }
      const missing = new Set(s.missing || []);
      let todo = wanted.filter((k) => !known.has(k) && !missing.has(k));
      s.total = wanted.length;
      while (todo.length) {
        let part = todo.slice(0, KEYS_PER_SEARCH);
        // A key Jira doesn't know makes the whole search fail; those are noted and left out.
        for (let tries = 0; tries < 4 && part.length; tries++) {
          try {
            const { issues } = await search(b, `key in (${part.join(',')})`, FIELDS);
            await runAll(env, issues.map((i) => pastStatement(env, i, i.id, 0)));
            const found = new Set(issues.map((i) => i.key));
            for (const k of part) if (!found.has(k)) missing.add(k);
            part = [];
          } catch (err) {
            if (err instanceof OutOfCalls || err.status !== 400) throw err;
            const bad = [...String(err.message).matchAll(/'([A-Z][A-Z0-9_]*-\d+)'/g)].map((m) => m[1]).filter((k) => part.includes(k));
            if (!bad.length) { for (const k of part) missing.add(k); part = []; break; }
            for (const k of bad) missing.add(k);
            part = part.filter((k) => !bad.includes(k));
          }
        }
        todo = todo.slice(KEYS_PER_SEARCH);
        s.missing = [...missing];
        await saveState(env, s);
      }
      s.phase = 'children';
      await saveState(env, s);
    }
    if (s.phase === 'children' || s.phase === 'subs') {
      for (;;) {
        const level = s.phase === 'children' ? 0 : 1;
        const { results } = await env.DB.prepare(`SELECT issue_id, order_id, issuetype FROM wip_past_items WHERE level = ? AND kids_read = 0 LIMIT 200`).bind(level).all();
        const parents = results.filter((r) => level === 0 || !isAdminType(r.issuetype));
        const skip = results.filter((r) => !parents.includes(r));
        if (skip.length) for (const part of chunk(skip.map((r) => r.issue_id), IN)) await env.DB.prepare(`UPDATE wip_past_items SET kids_read = 1 WHERE issue_id IN (${marks(part.length)})`).bind(...part).run();
        if (!parents.length && !skip.length) {
          if (s.phase === 'children') { s.phase = 'subs'; await saveState(env, s); continue; }
          s.phase = 'logs'; await saveState(env, s); break;
        }
        for (const part of chunk(parents, PARENTS_PER_SEARCH)) {
          const { issues } = await search(b, `parent in (${part.map((r) => r.issue_id).join(',')})`, FIELDS);
          const orderOf = new Map(part.map((r) => [r.issue_id, r.order_id]));
          await runAll(env, [
            ...issues.map((i) => pastStatement(env, i, orderOf.get(String(i.fields?.parent?.id)) || String(i.fields?.parent?.id), level + 1)),
            ...chunk(part.map((r) => r.issue_id), IN).map((ids) => env.DB.prepare(`UPDATE wip_past_items SET kids_read = 1 WHERE issue_id IN (${marks(ids.length)})`).bind(...ids)),
          ]);
        }
      }
    }
    if (s.phase === 'logs') {
      for (;;) {
        const { results } = await env.DB.prepare(`SELECT issue_id FROM wip_past_items WHERE events IS NULL LIMIT ${LOG_IDS}`).all();
        if (!results.length) { s.phase = 'compute'; await saveState(env, s); break; }
        const logs = await changelogs(b, results.map((r) => r.issue_id), s);
        await runAll(env, results.map((r) => env.DB.prepare('UPDATE wip_past_items SET events = ? WHERE issue_id = ?').bind(JSON.stringify(logs.get(r.issue_id) || []), r.issue_id)));
        s.logsRead = (s.logsRead || 0) + results.length;
        await saveState(env, s);
      }
    }
    if (s.phase === 'compute') {
      out.result = await compute(env);
      Object.assign(s, { pending: false, phase: null, doneAt: new Date().toISOString(), result: out.result, error: null });
      await saveState(env, s);
    }
  } catch (err) {
    if (!(err instanceof OutOfCalls)) {
      s.error = `${new Date().toISOString()} ${err.message}`;
      await saveState(env, s);
      throw err;
    }
    out.partial = true;
  }
  out.calls = b.used;
  return out;
}

// Status and Invoice Decimal changes for these items, by bulk where Jira allows it.
async function changelogs(b, ids, s) {
  const out = new Map(ids.map((id) => [String(id), []]));
  const add = (issueId, histories) => {
    const list = out.get(String(issueId)) || [];
    for (const h of histories || []) {
      const t = Date.parse(h.created);
      for (const it of h.items || []) {
        const field = it.fieldId || it.field;
        if (field === 'status') list.push({ t, f: 's', a: it.from ?? null, b: it.to ?? null });
        else if (field === F.share || it.field === 'Invoice Decimal') list.push({ t, f: 'v', a: it.fromString ?? it.from ?? null, b: it.toString ?? it.to ?? null });
      }
    }
    out.set(String(issueId), list);
  };
  if (!s.noBulk) {
    try {
      let token = null;
      do {
        const body = { issueIdsOrKeys: ids.map(String), maxResults: 1000 };
        if (!s.allFields) body.fieldIds = LOG_FIELDS;
        if (token) body.nextPageToken = token;
        const data = await b.call('/rest/api/3/changelog/bulkfetch', { method: 'POST', body: JSON.stringify(body) });
        for (const log of data?.issueChangeLogs || data?.values || []) add(log.issueId ?? log.id, log.changeHistories || log.histories);
        token = data?.nextPageToken || null;
      } while (token);
      return out;
    } catch (err) {
      // Where Jira doesn't offer the bulk read, each item's history is read on its own, which takes longer.
      if (err instanceof OutOfCalls || ![400, 404, 405].includes(err.status)) throw err;
      // A refused field list is tried once without it before giving up on the bulk read.
      if (err.status === 400 && !s.allFields) { s.allFields = true; return changelogs(b, ids, s); }
      s.noBulk = true;
    }
  }
  for (const id of ids) {
    let startAt = 0;
    for (;;) {
      const data = await b.call(`/rest/api/3/issue/${id}/changelog?startAt=${startAt}&maxResults=100`);
      add(id, data?.values);
      if (data?.isLast !== false || !data?.values?.length) break;
      startAt += data.values.length;
    }
  }
  return out;
}

// Midnight in London at the start of a day, as a moment.
function londonMidnight(day) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date(guess)));
  return guess - h * 3600 * 1000;
}
const monthEnd = (month) => londonMidnight(`${shiftMonth(month, 1)}-01`);

function sortedEvents(item) {
  let ev = [];
  try { ev = JSON.parse(item.events || '[]'); } catch { /* none */ }
  return ev.sort((x, y) => x.t - y.t);
}
// What a value was at a moment: the last change before it, or what it was before the first change after it.
function valueAt(events, kind, at, now) {
  const list = events.filter((e) => e.f === kind);
  if (!list.length) return now;
  let last = null;
  for (const e of list) if (e.t <= at) last = e;
  return last ? last.b : list[0].a;
}

export function stateAt(order, items, at, statuses) {
  const exists = (i) => i.created && Date.parse(i.created) <= at;
  const statusOf = (i) => {
    const id = valueAt(i.ev, 's', at, i.status_id);
    const known = statuses[String(id)];
    if (known) return known;
    return String(id) === String(i.status_id) ? { name: i.status_name, cat: i.status_cat } : { name: null, cat: null };
  };
  const done = (i) => statusOf(i).cat === 'done';
  const level1 = items.filter((i) => i.level === 1 && exists(i));
  const ids1 = new Set(level1.map((i) => i.issue_id));
  const level2 = items.filter((i) => i.level === 2 && exists(i) && ids1.has(i.parent_id));
  const legacy = !level1.some((i) => isCategory(i.issuetype));
  const subs = level2.filter((i) => i.subtask);
  const work = legacy ? level1.filter((i) => !isAdminType(i.issuetype)) : subs;
  const money = level1.filter((i) => isInvoice(i) && !isTokenInvoice(i));
  let invoiced = 0, paid = 0;
  for (const i of money) {
    const share = Number(valueAt(i.ev, 'v', at, i.share)) || 0;
    const st = statusOf(i);
    const state = invoiceState({ status: st.name || '', status_cat: st.cat });
    if (state.invoiced) invoiced += share;
    if (state.paid) paid += share;
  }
  const os = statusOf(order);
  let doneAt = null;
  if (os.cat === 'done') {
    const moves = order.ev.filter((e) => e.f === 's' && e.t <= at && statuses[String(e.b)]?.cat === 'done' && statuses[String(e.a)]?.cat !== 'done');
    if (moves.length) doneAt = londonDate(moves[moves.length - 1].t);
  }
  return {
    status: os.name, progress: floorPct(level1.filter(done).length, level1.length) ?? 0, nonAdmin: floorPct(work.filter(done).length, work.length),
    invoiced: round4(invoiced), paid: round4(paid), doneAt, items: level1.length,
  };
}

// Each imported month's orders, as Jira says they stood at the end of that month.
async function compute(env) {
  let statuses = {};
  try { statuses = JSON.parse((await getState(env, 'wip_status_map')) || '{}'); } catch { /* names as read */ }
  const { results: snaps } = await env.DB.prepare(
    "SELECT month, issue_key, region FROM wip_snapshots WHERE source LIKE 'import:%' OR source LIKE 'jira:%' ORDER BY month"
  ).all();
  const keys = [...new Set(snaps.map((r) => r.issue_key))];
  const orders = new Map();
  for (const part of chunk(keys, IN)) {
    for (const o of (await env.DB.prepare(`SELECT * FROM wip_past_items WHERE level = 0 AND issue_key IN (${marks(part.length)})`).bind(...part).all()).results) orders.set(o.issue_key, { ...o, ev: sortedEvents(o), items: [] });
  }
  const byId = new Map([...orders.values()].map((o) => [o.issue_id, o]));
  for (const part of chunk([...byId.keys()], IN)) {
    for (const i of (await env.DB.prepare(`SELECT * FROM wip_past_items WHERE level > 0 AND order_id IN (${marks(part.length)})`).bind(...part).all()).results) {
      byId.get(i.order_id)?.items.push({ ...i, ev: sortedEvents(i) });
    }
  }
  const stmts = [];
  const touched = new Map();
  let rebuilt = 0, notFound = 0;
  for (const r of snaps) {
    const o = orders.get(r.issue_key);
    if (!o) { notFound++; continue; }
    const st = stateAt(o, o.items, monthEnd(r.month), statuses);
    stmts.push(env.DB.prepare(
      `UPDATE wip_snapshots SET
         sheet_status = CASE WHEN source LIKE 'import:%' THEN status ELSE sheet_status END,
         sheet_progress = CASE WHEN source LIKE 'import:%' THEN progress ELSE sheet_progress END,
         sheet_non_admin = CASE WHEN source LIKE 'import:%' THEN non_admin ELSE sheet_non_admin END,
         sheet_invoiced = CASE WHEN source LIKE 'import:%' THEN invoiced ELSE sheet_invoiced END,
         sheet_paid = CASE WHEN source LIKE 'import:%' THEN paid ELSE sheet_paid END,
         status = COALESCE(?, status), progress = ?, non_admin = ?, invoiced = ?, paid = ?, done_at = COALESCE(?, done_at),
         source = 'jira:' || substr(source, instr(source, ':') + 1)
       WHERE month = ? AND issue_key = ? AND source IS NOT 'hub'`
    ).bind(st.status, st.progress, st.nonAdmin, st.invoiced, st.paid, st.doneAt, r.month, r.issue_key));
    rebuilt++;
    if (!touched.has(r.region)) touched.set(r.region, new Set());
    touched.get(r.region).add(r.month);
  }
  await runAll(env, stmts);
  // Each rebuilt month's figures, worked out again from its rebuilt orders.
  for (const [region, set] of touched) {
    for (const month of [...set].sort()) {
      const has = await env.DB.prepare('SELECT data, source FROM wip_history WHERE month = ? AND region = ?').bind(month, region).first();
      if (has?.source === 'hub') continue;
      let before = {};
      try { before = has ? JSON.parse(has.data) : {}; } catch { /* replaced */ }
      const rows = await snapshotRows(env, region, month);
      const prev = await historyRow(env, region, shiftMonth(month, -1));
      const data = { ...before, ...historyFrom(metrics(rows, month), prev) };
      const book = String(has?.source || '').split(':')[1] || month;
      await env.DB.prepare(
        `INSERT INTO wip_history (month, region, data, source) VALUES (?, ?, ?, ?)
         ON CONFLICT(month, region) DO UPDATE SET data = excluded.data, source = excluded.source`
      ).bind(month, region, JSON.stringify(data), `jira:${book}`).run();
    }
  }
  return { rows: rebuilt, notFound, months: [...touched.values()].reduce((t, s) => t + s.size, 0) };
}

// ---------- what management sees ----------

export async function status(env) {
  const s = await readState(env);
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM wip_past_items WHERE level = 0) AS orders, (SELECT COUNT(*) FROM wip_past_items) AS items,
            (SELECT COUNT(*) FROM wip_past_items WHERE events IS NOT NULL) AS logs`
  ).first();
  return { ...(s || {}), missing: (s?.missing || []).slice(0, 200), missingCount: (s?.missing || []).length, counts };
}

// Month by month, how far Jira's history and the old sheet differ.
export async function compare(env, viewer, { region } = {}) {
  mustSee(viewer);
  const r = region === 'sa' ? 'sa' : 'uk';
  const { results } = await env.DB.prepare(
    `SELECT month, issue_key, title, org, upfront, token, status, sheet_status, progress, sheet_progress, invoiced, sheet_invoiced, paid, sheet_paid
       FROM wip_snapshots WHERE region = ? AND source LIKE 'jira:%' ORDER BY month DESC, issue_key`
  ).bind(r).all();
  const far = (a, b) => a !== null && b !== null && a !== undefined && b !== undefined && Math.abs(a - b) >= 0.05;
  const months = new Map();
  for (const x of results) {
    const m = months.get(x.month) || { month: x.month, orders: 0, differ: 0, rows: [] };
    m.orders++;
    const what = [];
    if (far(x.progress, x.sheet_progress)) what.push('progress');
    if (far(x.invoiced, x.sheet_invoiced)) what.push('invoiced');
    if (far(x.paid, x.sheet_paid)) what.push('paid');
    if (x.sheet_status && x.status && lower(x.sheet_status) !== lower(x.status)) what.push('status');
    if (what.length) { m.differ++; m.rows.push({ ...x, what }); }
    months.set(x.month, m);
  }
  return { region: r, months: [...months.values()] };
}

export async function start(env, viewer) {
  mustEdit(viewer);
  await queue(env);
  return { ok: true };
}
