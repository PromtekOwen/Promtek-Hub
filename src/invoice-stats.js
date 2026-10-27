// Insights into invoicing: whether milestones are invoiced by their Target End, whether
// customers pay by the Invoice Due Date, what's owed and by whom, and how both move
// month to month.
//
// When each invoice was drafted, sent, went overdue and was paid comes from its Jira
// history, read in the background a hundred invoices a call, and read again whenever its
// status or dates change. Marking one in the hub writes its dates straight away.
import { londonDate } from './sync.js';
import { canTile } from './permissions.js';
import {
  expectedPayment, F, REGIONS, OutOfCalls, budget, isInvoice, isTokenInvoice, invoiceState, overridesAndSeeds, rowFor, contractsIn, isActiveContract, refuse,
  contractSchedule, paymentTerms, paymentDue, chunk, marks, IN, lower, regionArg, runAll, shiftMonth,
} from './wip.js';

const RUN_CALLS = 20;
const PER_CALL = 100;
const IDLE_RECHECK_MS = 60 * 60 * 1000;

const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(ms));
const msOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : NaN; };
const isDay = (v) => /^\d{4}-\d{2}-\d{2}/.test(String(v || ''));
const daysBetween = (a, b) => Math.round((Date.parse(`${b.slice(0, 10)}T12:00:00Z`) - Date.parse(`${a.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
const addDays = (day, n) => new Date(Date.parse(`${day.slice(0, 10)}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monthEndDay = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const avg = (xs) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null);

// ---------- reading each invoice's history ----------

// What one invoice's changes say: the first day it was drafted, sent and went overdue, the
// last day it was paid, and the first Target End and Invoice Due Date it was given.
export function fromChanges(changes, now) {
  const list = [...changes].sort((a, b) => a.t - b.t);
  const out = { ready_at: null, invoiced_at: null, overdue_at: null, paid_at: null, first_due: null, due_moves: 0, first_date: null, date_moves: 0 };
  for (const c of list) {
    if (c.f !== 's') continue;
    const st = invoiceState({ status: c.b || '' });
    const day = dayOf(c.t);
    if (st.ready && !out.ready_at) out.ready_at = day;
    if (st.invoiced && !st.paid && !out.invoiced_at) out.invoiced_at = day;
    if (st.overdue && !out.overdue_at) out.overdue_at = day;
    if (st.paid) out.paid_at = day;
    // Moved back from Paid: not paid after all.
    if (!st.paid && out.paid_at) out.paid_at = null;
  }
  const firstOf = (kind, current) => {
    const ev = list.filter((c) => c.f === kind);
    if (!ev.length) return [isDay(current) ? current.slice(0, 10) : null, 0];
    const first = isDay(ev[0].a) ? ev[0].a.slice(0, 10) : isDay(ev.find((c) => isDay(c.b))?.b) ? ev.find((c) => isDay(c.b)).b.slice(0, 10) : null;
    return [first, ev.filter((c) => isDay(c.a) && isDay(c.b) && c.a.slice(0, 10) !== c.b.slice(0, 10)).length];
  };
  [out.first_due, out.due_moves] = firstOf('d', now.inv_due);
  [out.first_date, out.date_moves] = firstOf('i', now.inv_date);
  return out;
}

async function changesFor(b, ids, state) {
  const out = new Map(ids.map((id) => [String(id), []]));
  const add = (issueId, histories) => {
    const list = out.get(String(issueId)) || [];
    for (const h of histories || []) {
      const t = msOf(h.created);
      if (!Number.isFinite(t)) continue;
      for (const it of h.items || []) {
        const field = it.fieldId || it.field;
        if (field === 'status') list.push({ t, f: 's', a: it.fromString ?? null, b: it.toString ?? null });
        else if (field === F.due) list.push({ t, f: 'd', a: it.from ?? null, b: it.to ?? null });
        else if (field === F.invoiceDate) list.push({ t, f: 'i', a: it.from ?? null, b: it.to ?? null });
      }
    }
    out.set(String(issueId), list);
  };
  if (!state.noBulk) {
    try {
      let token = null;
      do {
        const body = { issueIdsOrKeys: ids.map(String), maxResults: 1000, fieldIds: ['status', F.due, F.invoiceDate] };
        if (token) body.nextPageToken = token;
        const data = await b.call('/rest/api/3/changelog/bulkfetch', { method: 'POST', body: JSON.stringify(body) });
        for (const log of data?.issueChangeLogs || data?.values || []) add(log.issueId ?? log.id, log.changeHistories || log.histories);
        token = data?.nextPageToken || null;
      } while (token);
      return out;
    } catch (err) {
      if (err instanceof OutOfCalls || ![400, 404, 405].includes(err.status)) throw err;
      // One invoice deleted in Jira spoils the whole read: halve until it's found, rather than giving up on reading in bulk.
      if (err.status !== 405 && ids.length > 1) {
        const half = Math.ceil(ids.length / 2);
        const [a, c] = [await changesFor(b, ids.slice(0, half), state), await changesFor(b, ids.slice(half), state)];
        return new Map([...a, ...c]);
      }
      if (err.status !== 405) { out.set(String(ids[0]), null); return out; }
      state.noBulk = true;
    }
  }
  for (const id of ids) {
    let startAt = 0;
    for (;;) {
      let data;
      try { data = await b.call(`/rest/api/3/issue/${id}/changelog?startAt=${startAt}&maxResults=100`); } catch (err) {
        if (err instanceof OutOfCalls || ![400, 404].includes(err.status)) throw err;
        out.set(String(id), null);   // deleted in Jira
        break;
      }
      add(id, data?.values);
      if (data?.isLast !== false || !data?.values?.length) break;
      startAt += data.values.length;
    }
  }
  return out;
}

// Invoices on orders and contracts still in Jira: one whose order or contract was deleted is left alone.
const STALE = `SELECT w.issue_id, w.issue_key, w.status, w.inv_due, w.inv_date FROM wip_items w LEFT JOIN invoice_history h ON h.issue_id = w.issue_id
  WHERE w.level = 1 AND lower(w.issuetype) LIKE '%invoice%'
    AND (EXISTS (SELECT 1 FROM wip_orders o WHERE o.issue_id = w.order_id AND o.gone = 0) OR EXISTS (SELECT 1 FROM wip_contracts c WHERE c.issue_id = w.order_id AND c.gone = 0))
    AND (h.issue_id IS NULL OR h.read_status IS NOT w.status OR h.read_due IS NOT w.inv_due OR h.read_date IS NOT w.inv_date) LIMIT ${PER_CALL}`;

// One turn of the background read. Idle for an hour once everything is read.
export async function step(env) {
  const { getState, setState } = await import('./sync.js');
  const idleAt = Number(await getState(env, 'invoice_history_idle')) || 0;
  if (idleAt && Date.now() - idleAt < IDLE_RECHECK_MS) return { idle: true };
  let state = {};
  try { state = JSON.parse((await getState(env, 'invoice_history_state')) || '{}'); } catch { state = {}; }
  const b = budget(env, RUN_CALLS);
  let read = 0;
  try {
    for (;;) {
      const { results } = await env.DB.prepare(STALE).all();
      if (!results.length) { await setState(env, 'invoice_history_idle', String(Date.now())); break; }
      const logs = await changesFor(b, results.map((r) => r.issue_id), state);
      const now = new Date().toISOString();
      // Deleted in Jira since the WIP last read it: gone from the hub too.
      const deleted = results.filter((r) => logs.get(String(r.issue_id)) === null).map((r) => r.issue_id);
      if (deleted.length) await env.DB.prepare(`DELETE FROM wip_items WHERE issue_id IN (${marks(deleted.length)})`).bind(...deleted).run();
      await runAll(env, results.filter((r) => !deleted.includes(r.issue_id)).map((r) => {
        const d = fromChanges(logs.get(String(r.issue_id)) || [], r);
        return env.DB.prepare(
          `INSERT INTO invoice_history (issue_id, issue_key, read_status, read_due, read_date, read_at, ready_at, invoiced_at, overdue_at, paid_at, first_due, due_moves, first_date, date_moves)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(issue_id) DO UPDATE SET issue_key = excluded.issue_key, read_status = excluded.read_status, read_due = excluded.read_due, read_date = excluded.read_date,
             read_at = excluded.read_at, ready_at = COALESCE(excluded.ready_at, invoice_history.ready_at), invoiced_at = COALESCE(excluded.invoiced_at, invoice_history.invoiced_at),
             overdue_at = COALESCE(excluded.overdue_at, invoice_history.overdue_at), paid_at = excluded.paid_at, first_due = COALESCE(invoice_history.first_due, excluded.first_due),
             due_moves = excluded.due_moves, first_date = COALESCE(invoice_history.first_date, excluded.first_date), date_moves = excluded.date_moves`
        ).bind(r.issue_id, r.issue_key, r.status, r.inv_due, r.inv_date, now, d.ready_at, d.invoiced_at, d.overdue_at, d.paid_at, d.first_due, d.due_moves, d.first_date, d.date_moves);
      }));
      read += results.length;
      await setState(env, 'invoice_history_idle', '0');
    }
  } catch (err) {
    if (!(err instanceof OutOfCalls)) throw err;
  } finally {
    await setState(env, 'invoice_history_state', JSON.stringify(state));
  }
  return read ? { read, calls: b.used } : { idle: true };
}

// What the hub itself just did to an invoice, so the insights don't wait for the next read.
// Only for invoices whose history has been read once already, so nothing earlier is lost.
export async function noteAction(env, item, action, after, today) {
  const h = await env.DB.prepare('SELECT issue_id FROM invoice_history WHERE issue_id = ?').bind(item.issue_id).first();
  if (!h) return;
  const set = { targetEnd: null, draft: 'ready_at', sent: 'invoiced_at', paid: 'paid_at' }[action];
  const status = after.status ?? item.status;
  const due = after.inv_due !== undefined ? after.inv_due : item.inv_due;
  const date = after.inv_date !== undefined ? after.inv_date : item.inv_date;
  const bits = ['read_status = ?', 'read_due = ?', 'read_date = ?'];
  const vals = [status, due, date];
  if (set === 'paid_at') { bits.push('paid_at = ?'); vals.push(after.paid_at || today); }
  else if (set) { bits.push(`${set} = COALESCE(${set}, ?)`); vals.push(today); }
  if (action === 'targetEnd') { bits.push('first_due = COALESCE(first_due, ?)', `due_moves = due_moves + ${item.inv_due ? 1 : 0}`); vals.push(item.inv_due || due); }
  if (action === 'sent') bits.push('first_date = COALESCE(first_date, read_date)');
  if (action === 'dueDate') bits.push(`first_date = COALESCE(first_date, ?)`, `date_moves = date_moves + ${item.inv_date ? 1 : 0}`), vals.push(item.inv_date || date);
  await env.DB.prepare(`UPDATE invoice_history SET ${bits.join(', ')} WHERE issue_id = ?`).bind(...vals, item.issue_id).run();
}

// ---------- the insights ----------

async function itemsAndHistory(env, ids) {
  const items = [], hist = new Map();
  for (const part of chunk(ids, IN)) {
    items.push(...(await env.DB.prepare(`SELECT * FROM wip_items WHERE level = 1 AND order_id IN (${marks(part.length)})`).bind(...part).all()).results.filter(isInvoice));
  }
  for (const part of chunk(items.map((i) => i.issue_id), IN)) {
    for (const h of (await env.DB.prepare(`SELECT * FROM invoice_history WHERE issue_id IN (${marks(part.length)})`).bind(...part).all()).results) hist.set(h.issue_id, h);
  }
  return { items, hist };
}

// Every invoice in the region, on orders and service contracts, with the dates that matter.
async function invoiceRecords(env, region, today, terms) {
  const { results: orders } = await env.DB.prepare('SELECT * FROM wip_orders WHERE region = ? AND customer_item = 0 AND entity IS NOT NULL').bind(region).all();
  const contracts = await contractsIn(env, region);
  const { over, seed } = await overridesAndSeeds(env, [...orders.map((o) => o.issue_key), ...contracts.map((c) => c.issue_key)]);
  const rows = new Map();
  for (const o of orders) {
    if (over.get(o.issue_key)?.excluded) continue;
    const r = rowFor(o, over.get(o.issue_key), seed.get(o.issue_key), null, today.slice(0, 7));
    rows.set(o.issue_id, { kind: 'order', key: o.issue_key, account: String(o.project_key || o.issue_key.split('-')[0]).toUpperCase(), org: o.org, value: r.value,
      division: /service/i.test(r.division || '') ? 'Service' : /condor/i.test(r.division || '') ? 'Condor' : 'Projects', open: o.status_cat !== 'done' && !o.gone, gone: Boolean(o.gone) });
  }
  for (const c of contracts) {
    if (over.get(c.issue_key)?.excluded) continue;
    const s = seed.get(c.issue_key), o = over.get(c.issue_key);
    rows.set(c.issue_id, { kind: 'contract', key: c.issue_key, account: String(c.project_key || c.issue_key.split('-')[0]).toUpperCase(), org: c.tile_customer || c.org,
      value: o?.upfront ?? s?.upfront ?? c.total ?? null, division: /condor/i.test(c.summary || '') ? 'Condor' : 'Service', start: c.tile_start || c.start_date || s?.start_date || null,
      active: isActiveContract(c) });
  }
  const { items, hist } = await itemsAndHistory(env, [...rows.keys()]);
  const byParent = new Map();
  for (const i of items) { if (!byParent.has(i.order_id)) byParent.set(i.order_id, []); byParent.get(i.order_id).push(i); }
  const out = [];
  for (const [id, p] of rows) {
    const subs = (byParent.get(id) || []).sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')) || String(a.issue_key).localeCompare(String(b.issue_key), 'en', { numeric: true }));
    // Cancelled invoices aren't owed, and take no share of a contract.
    const live = subs.filter((i) => !invoiceState(i).cancelled);
    const plan = p.kind === 'contract' ? contractSchedule(p.start, live.length) : [];
    const t = terms[p.account] || null;
    live.forEach((i, n) => {
      if (p.kind === 'order' && isTokenInvoice(i)) return;
      const h = hist.get(i.issue_id) || null;
      const s = invoiceState(i);
      const value = p.value === null ? null : p.kind === 'contract' ? p.value / live.length : p.value * (Number(i.share) || 0);
      const target = i.inv_due || plan[n] || null;
      const firstTarget = h?.first_due || target;
      const paidAt = s.paid ? i.paid_at || h?.paid_at || null : null;
      const dueDate = i.inv_date || null;
      // Sent: from its history, or worked back from its due date and the customer's terms.
      let invoicedAt = s.invoiced ? h?.invoiced_at || null : null, sentGuessed = false;
      if (s.invoiced && !invoicedAt && dueDate) { invoicedAt = t?.type === 'Days After' ? addDays(dueDate, -t.days) : addDays(dueDate, -30); sentGuessed = true; }
      const doneAt = h?.ready_at || (s.invoiced ? invoicedAt : null) || (s.ready ? today : null);
      out.push({
        key: i.issue_key, parent: p.key, kind: p.kind, account: p.account, org: p.org, division: p.division, value,
        stage: s.paid ? 'paid' : s.overdue || (s.invoiced && dueDate && dueDate < today) ? 'overdue' : s.invoiced ? 'invoiced' : s.ready ? 'ready' : 'new',
        target, firstTarget, targetMoves: h?.due_moves || 0, readyAt: h?.ready_at || null, invoicedAt, sentGuessed, doneAt: s.ready || s.invoiced ? doneAt : null,
        overdueAt: h?.overdue_at || null, paidAt, dueDate, dueMoves: h?.date_moves || 0, read: Boolean(h),
        expected: expectedPayment(s, { targetEnd: target, invoiceDue: dueDate, invoicedAt: h?.invoiced_at || null, today, terms: t }),
      });
    });
  }
  return { records: out, rows: [...rows.values()] };
}

// Open orders and contracts at each month end, by customer, from the monthly snapshots.
async function openOrdersByMonth(env, region, months, rows) {
  const out = new Map(months.map((m) => [m, null]));
  if (!months.length) return out;
  const { results } = await env.DB.prepare(
    `SELECT month, issue_key, org, status FROM wip_snapshots WHERE region = ? AND month >= ? AND month <= ?`
  ).bind(region, months[0], months[months.length - 1]).all();
  for (const s of results) {
    if (['done', 'archive', 'archived'].includes(lower(s.status))) continue;
    if (!out.get(s.month)) out.set(s.month, new Map());
    const account = String(s.issue_key.split('-')[0]).toUpperCase();
    const m = out.get(s.month);
    m.set(account, (m.get(account) || 0) + 1);
  }
  // This month: what's open now.
  const now = months[months.length - 1];
  const live = new Map();
  for (const r of rows) if ((r.kind === 'order' && r.open) || (r.kind === 'contract' && r.active)) live.set(r.account, (live.get(r.account) || 0) + 1);
  out.set(now, live);
  return out;
}

const AGE = [['notDue', 'Not yet due'], ['d30', '1 to 30 days'], ['d60', '31 to 60 days'], ['d90', '61 to 90 days'], ['d90plus', 'Over 90 days']];
const ageOf = (r, today) => {
  const late = r.dueDate ? daysBetween(r.dueDate, today) : 0;
  return late <= 0 ? 'notDue' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'd90plus';
};

export async function insights(env, viewer, { region, months: span } = {}) {
  if (!canTile(viewer, 'invoicing')) throw refuse('Invoicing isn\'t open to you.');
  region = regionArg(region);
  const today = londonDate();
  const thisMonth = today.slice(0, 7);
  const n = [6, 12, 24].includes(Number(span)) ? Number(span) : 12;
  const terms = await paymentTerms(env);
  const { records, rows } = await invoiceRecords(env, region, today, terms);
  const money = records.filter((r) => r.value !== null && r.value > 0);
  const months = Array.from({ length: n }, (_, i) => shiftMonth(thisMonth, i - n + 1));
  const ahead = Array.from({ length: 6 }, (_, i) => shiftMonth(thisMonth, i + 1));
  const from = `${months[0]}-01`;
  const inWindow = (d) => d && d >= from && d <= today;
  const sum = (list) => list.reduce((t, r) => t + (r.value || 0), 0);
  const names = new Map();
  for (const r of [...rows, ...records]) if (r.org && !names.has(r.account)) names.set(r.account, r.org);

  // Owed now, and how late.
  const owed = money.filter((r) => r.stage === 'invoiced' || r.stage === 'overdue');
  const overdue = owed.filter((r) => r.dueDate && r.dueDate < today);
  const sent90 = money.filter((r) => r.invoicedAt && r.invoicedAt > addDays(today, -90) && r.invoicedAt <= today);
  const dso = sent90.length && sum(sent90) > 0 ? (sum(owed) / sum(sent90)) * 90 : null;

  // Payments due in the window: on time, late, or still not paid.
  const dueIn = money.filter((r) => inWindow(r.dueDate) && r.dueDate < today);
  const paidOnTime = dueIn.filter((r) => r.paidAt && r.paidAt <= r.dueDate);
  const paidLate = dueIn.filter((r) => r.paidAt && r.paidAt > r.dueDate);
  const stillOwed = dueIn.filter((r) => !r.paidAt);
  const daysLate = paidLate.map((r) => daysBetween(r.dueDate, r.paidAt));
  const paidIn = money.filter((r) => inWindow(r.paidAt));
  const toPay = paidIn.filter((r) => r.invoicedAt && !r.sentGuessed).map((r) => daysBetween(r.invoicedAt, r.paidAt));

  // Milestones due in the window, against the first Target End they were given.
  const ms = records.filter((r) => inWindow(r.firstTarget) && r.firstTarget < today);
  const msOnTime = ms.filter((r) => r.doneAt && r.doneAt <= r.firstTarget);
  const msLate = ms.filter((r) => r.doneAt && r.doneAt > r.firstTarget);
  const msOpen = ms.filter((r) => !r.doneAt);
  const msDaysLate = [...msLate.map((r) => daysBetween(r.firstTarget, r.doneAt)), ...msOpen.map((r) => daysBetween(r.firstTarget, today))];
  const draftToSent = money.filter((r) => inWindow(r.invoicedAt) && r.readyAt && !r.sentGuessed && r.invoicedAt >= r.readyAt).map((r) => daysBetween(r.readyAt, r.invoicedAt));
  const readyNow = records.filter((r) => r.stage === 'ready');

  // Month by month.
  const monthly = [...months, ...ahead].map((m) => {
    const end = monthEndDay(m);
    const past = m <= thisMonth;
    const owedAt = past ? money.filter((r) => r.invoicedAt && r.invoicedAt <= end && (!r.paidAt || r.paidAt > end)) : [];
    const msDue = records.filter((r) => r.firstTarget && r.firstTarget.slice(0, 7) === m && r.firstTarget < today);
    return {
      month: m, future: !past, live: m === thisMonth,
      expected: sum(money.filter((r) => (r.paidAt ? r.dueDate : r.expected) && (r.paidAt ? r.dueDate : r.expected).slice(0, 7) === m)),
      paid: past ? sum(money.filter((r) => r.paidAt && r.paidAt.slice(0, 7) === m)) : null,
      invoiced: past ? sum(money.filter((r) => r.invoicedAt && r.invoicedAt.slice(0, 7) === m)) : null,
      owed: past ? sum(owedAt) : null,
      overdue: past ? sum(owedAt.filter((r) => r.dueDate && r.dueDate < (m === thisMonth ? today : end))) : null,
      onTime: past ? msDue.filter((r) => r.doneAt && r.doneAt <= r.firstTarget).length : null,
      late: past ? msDue.filter((r) => !r.doneAt || r.doneAt > r.firstTarget).length : null,
      owedBy: past ? Object.fromEntries([...owedAt.reduce((acc, r) => acc.set(r.account, (acc.get(r.account) || 0) + r.value), new Map())]) : null,
    };
  });
  const pastMonths = monthly.filter((m) => !m.future && !m.live);
  const exp = pastMonths.map((m) => m.expected);
  const paidM = pastMonths.map((m) => m.paid);

  // By customer: what they owe, how old it is, and how they pay.
  const customers = new Map();
  const cust = (a) => {
    if (!customers.has(a)) customers.set(a, { account: a, org: names.get(a) || null, owed: 0, overdue: 0, ages: Object.fromEntries(AGE.map(([k]) => [k, 0])),
      due: 0, onTime: 0, late: 0, unpaid: 0, lateDays: [], payDays: [], wentOverdue: 0, invoiced: 0, milestones: 0, msOnTime: 0, msLate: 0, msDays: [], moved: 0,
      firstHalf: [], secondHalf: [], terms: terms[a] || null });
    return customers.get(a);
  };
  for (const r of owed) { const c = cust(r.account); c.owed += r.value; c.ages[ageOf(r, today)] += r.value; if (r.dueDate && r.dueDate < today) c.overdue += r.value; }
  const mid = `${shiftMonth(months[0], Math.floor(n / 2))}-01`;
  for (const r of dueIn) {
    const c = cust(r.account);
    c.due++;
    const late = r.paidAt ? Math.max(0, daysBetween(r.dueDate, r.paidAt)) : daysBetween(r.dueDate, today);
    if (r.paidAt && r.paidAt <= r.dueDate) c.onTime++; else if (r.paidAt) { c.late++; c.lateDays.push(late); } else { c.unpaid++; c.lateDays.push(late); }
    if (r.overdueAt || late > 0) c.wentOverdue++;
    (r.dueDate < mid ? c.firstHalf : c.secondHalf).push(late);
  }
  for (const r of paidIn) if (r.invoicedAt && !r.sentGuessed) cust(r.account).payDays.push(daysBetween(r.invoicedAt, r.paidAt));
  for (const r of money) if (inWindow(r.invoicedAt)) cust(r.account).invoiced += r.value;
  for (const r of ms) {
    const c = cust(r.account);
    c.milestones++;
    if (r.doneAt && r.doneAt <= r.firstTarget) c.msOnTime++; else { c.msLate++; c.msDays.push(daysBetween(r.firstTarget, r.doneAt || today)); }
    if (r.targetMoves) c.moved++;
  }
  const custList = [...customers.values()].map((c) => {
    const a = avg(c.firstHalf), b = avg(c.secondHalf);
    const trend = c.firstHalf.length >= 2 && c.secondHalf.length >= 2 && Math.abs(b - a) >= 5 ? (b > a ? 'slower' : 'faster') : null;
    return {
      account: c.account, org: c.org, owed: c.owed, overdue: c.overdue, ages: c.ages, due: c.due, onTime: c.onTime, late: c.late, unpaid: c.unpaid,
      lateRate: c.due ? (c.late + c.unpaid) / c.due : null, avgDaysLate: avg(c.lateDays), avgDaysToPay: avg(c.payDays), wentOverdue: c.wentOverdue,
      invoiced: c.invoiced, milestones: c.milestones, msOnTime: c.msOnTime, msLate: c.msLate, msAvgLate: avg(c.msDays), moved: c.moved, trend,
      terms: c.terms,
    };
  });

  // Milestones by division.
  const divisions = ['Projects', 'Service', 'Condor'].map((d) => {
    const list = ms.filter((r) => r.division === d);
    const late = list.filter((r) => !(r.doneAt && r.doneAt <= r.firstTarget));
    return { division: d, due: list.length, onTime: list.length - late.length, late: late.length, avgLate: avg(late.map((r) => daysBetween(r.firstTarget, r.doneAt || today))),
      moved: list.filter((r) => r.targetMoves).length };
  }).filter((d) => d.due);

  const openOrders = await openOrdersByMonth(env, region, months, rows);
  const totalInvoiced = sum(money.filter((r) => inWindow(r.invoicedAt)));
  const read = records.filter((r) => r.read).length;

  return {
    region, regions: REGIONS, today, month: thisMonth, span: n, months, ahead,
    kpis: {
      owed: sum(owed), owedCount: owed.length, overdue: sum(overdue), overdueCount: overdue.length,
      over90: sum(owed.filter((r) => ageOf(r, today) === 'd90plus')), dso,
      contractsOwed: sum(owed.filter((r) => r.kind === 'contract')),
      paidOnTimeRate: dueIn.length ? paidOnTime.length / dueIn.length : null, paidOnTimeValue: sum(dueIn) ? sum(paidOnTime) / sum(dueIn) : null,
      dueCount: dueIn.length, paidLateCount: paidLate.length, stillOwedCount: stillOwed.length,
      avgDaysLate: avg(daysLate), avgDaysToPay: avg(toPay),
      avgTerms: avg([...new Set(money.filter((r) => inWindow(r.paidAt)).map((r) => r.account))].map((a) => terms[a]).filter((t) => t && t.type === 'Days After').map((t) => t.days)),
      msDue: ms.length, msOnTime: msOnTime.length, msLate: msLate.length, msOpen: msOpen.length, msOnTimeRate: ms.length ? msOnTime.length / ms.length : null,
      msAvgLate: avg(msDaysLate), msMoved: ms.filter((r) => r.targetMoves).length,
      draftToSent: avg(draftToSent), readyNow: readyNow.length, readyValue: sum(readyNow.filter((r) => r.value)),
      readyOldest: readyNow.filter((r) => r.readyAt).reduce((m, r) => Math.max(m, daysBetween(r.readyAt, today)), 0) || null,
      invoiced: totalInvoiced, paid: sum(paidIn),
      avgExpected: avg(exp), avgPaid: avg(paidM),
      bestMonth: pastMonths.length ? pastMonths.reduce((a, b) => (b.paid > a.paid ? b : a)).month : null,
      worstMonth: pastMonths.length ? pastMonths.reduce((a, b) => (b.paid < a.paid ? b : a)).month : null,
    },
    monthly,
    customers: custList,
    divisions,
    openOrders: Object.fromEntries([...openOrders].map(([m, map]) => [m, map ? Object.fromEntries(map) : null])),
    names: Object.fromEntries(names),
    ages: AGE,
    coverage: { invoices: records.length, read, guessedSent: money.filter((r) => r.sentGuessed).length },
  };
}
