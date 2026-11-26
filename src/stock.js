// Stock: the workshop's parts, where they are, and which job they're for.
// Every change to a unit of stock is written together with a line in the movement
// ledger (stock_moves), so any unit's history can be read back in full.
import { searchJql, jira, getIssue } from './jira.js';
import { getState, setState, raiseAlert, londonDate } from './sync.js';

export const MODES = ['serial', 'batch', 'bin'];
export const WEIGHTS = ['heavy', 'moderate', 'light'];
export const LEVELS = ['low', 'mid', 'high'];
export const PRIORITIES = ['Emergency', 'High', 'Standard', 'Low'];
const RANK = { Emergency: 0, High: 1, Standard: 2, Low: 3 };
const IN_HOUSE = ['available', 'reserved', 'picked', 'quarantine'];
const STUCK_HOURS = 4;
const EXPIRY_WARN_DAYS = 30;

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const addDays = (iso, n) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
const num = (v, d = null) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const qtyOf = (v) => { const x = num(v); if (x == null || x <= 0) throw bad('Enter a quantity above zero.'); return Math.round(x * 1000) / 1000; };
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max) || null;
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const teamKey = (t) => (t === 'Condor' ? 'Projecting' : t || null);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
export const unitLabel = (id) => `S${String(id).padStart(6, '0')}`;

// D1 refuses LIKE patterns over 50 bytes, so what's searched for is kept well under that.
const likeTerm = (v) => String(v ?? '').toLowerCase().replace(/[%_\\]/g, '').trim().slice(0, 40);
function bad(message, status = 400, extra = {}) { const e = new Error(message); e.status = status; Object.assign(e, extra); return e; }
export const canManage = (v) => Boolean(v?.isAdmin || v?.can?.stockManage);
export const canLead = (v) => Boolean(v?.isAdmin || v?.can?.stockLead);
const whoOf = (v) => ({ id: v.accountId || v.email, name: v.employee?.name || v.email });
const needManage = (v) => { if (!canManage(v)) throw bad('A team lead, management or a developer does that.', 403); };
const needLead = (v) => { if (!canLead(v)) throw bad('A team lead does that.', 403); };

// One line in the ledger, as a statement to batch with the change it records.
// unitId 'last' means the unit just inserted in the same batch.
function move(env, viewer, m) {
  const w = whoOf(viewer);
  const unitSql = m.unitId === 'last' ? 'last_insert_rowid()' : '?';
  const binds = [m.at || nowIso(), w.id, w.name, m.action, m.itemId ?? null];
  if (m.unitId !== 'last') binds.push(m.unitId ?? null);
  binds.push(m.unitCode ?? null, m.lot ?? null, m.qty ?? null, m.from ?? null, m.to ?? null, m.orderId ?? null, m.orderKey ?? null, m.fromStatus ?? null, m.toStatus ?? null, m.note ?? null);
  return env.DB.prepare(`INSERT INTO stock_moves (at, account_id, name, action, item_id, unit_id, unit_code, lot, qty, from_location, to_location, order_id, order_key, from_status, to_status, note)
    VALUES (?, ?, ?, ?, ?, ${unitSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...binds);
}

const UNIT_COLS = ['code', 'item_id', 'lot', 'supplier_lot', 'serial', 'qty', 'location_id', 'status', 'order_id', 'team', 'received_at', 'received_by', 'expiry', 'supplier', 'po_ref', 'po_date', 'unit_cost', 'expected_id', 'picked_at', 'picked_by', 'consumed_at', 'note'];
function insertUnit(env, u) {
  return env.DB.prepare(`INSERT INTO stock_units (${UNIT_COLS.join(', ')}) VALUES (${UNIT_COLS.map(() => '?').join(', ')})`).bind(...UNIT_COLS.map((c) => u[c] ?? null));
}
const labelNew = (env) => env.DB.prepare("UPDATE stock_units SET code = 'S' || substr('000000' || id, -6, 6) WHERE code IS NULL");

// Part of a unit taking on a change: the part moved keeps the unit's row when it's all of it,
// otherwise the rest stays behind and the part becomes a new row (same label, lot and history).
function changePart(env, viewer, unit, qty, changes, m) {
  const stmts = [];
  if (qty >= unit.qty - 1e-9) {
    const cols = Object.keys(changes);
    stmts.push(env.DB.prepare(`UPDATE stock_units SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).bind(...cols.map((c) => changes[c]), unit.id));
    stmts.push(move(env, viewer, { ...m, itemId: unit.item_id, unitId: unit.id, unitCode: unit.code, lot: unit.lot, qty: unit.qty, fromStatus: unit.status, toStatus: changes.status ?? unit.status, from: m.from ?? unit.location_id }));
  } else {
    stmts.push(env.DB.prepare('UPDATE stock_units SET qty = qty - ? WHERE id = ?').bind(qty, unit.id));
    stmts.push(insertUnit(env, { ...unit, ...changes, qty }));
    stmts.push(move(env, viewer, { ...m, itemId: unit.item_id, unitId: 'last', unitCode: unit.code, lot: unit.lot, qty, fromStatus: unit.status, toStatus: changes.status ?? unit.status, from: m.from ?? unit.location_id, note: [m.note, `Split from ${unit.code || unitLabel(unit.id)}`].filter(Boolean).join(' · ') }));
  }
  return stmts;
}

async function unitById(env, id) {
  const u = await env.DB.prepare('SELECT * FROM stock_units WHERE id = ?').bind(Number(id)).first();
  if (!u) throw bad('That stock isn\'t on record.', 404);
  return u;
}
async function orderById(env, id) {
  const o = await env.DB.prepare('SELECT * FROM stock_orders WHERE id = ?').bind(Number(id)).first();
  if (!o) throw bad('That work order isn\'t on record.', 404);
  return o;
}
async function itemById(env, id) {
  const i = await env.DB.prepare('SELECT * FROM stock_items WHERE id = ?').bind(Number(id)).first();
  if (!i) throw bad('That stock item isn\'t on record.', 404);
  return i;
}
async function locationByCode(env, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  return env.DB.prepare('SELECT * FROM stock_locations WHERE UPPER(code) = ? AND active = 1').bind(c).first();
}

// ---------- priority ----------

// From the dates: the Build's start, or failing that the earliest date on the hardware.
export function autoPriority(order, day = today()) {
  const date = order.needed_by;
  if (!date) return 'Standard';
  const d = daysBetween(day, date);
  if (d <= 7) return 'High';
  if (d <= 30) return 'Standard';
  return 'Low';
}
export const priorityOf = (o, day) => o.priority_override || autoPriority(o, day);
const rankOrders = (orders, day) => [...orders].sort((a, b) =>
  RANK[priorityOf(a, day)] - RANK[priorityOf(b, day)] || String(a.needed_by || '9999').localeCompare(String(b.needed_by || '9999')) || a.id - b.id);

// ---------- reading Jira ----------

function adfPlain(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'tableRow') return `${(node.content || []).map((c) => adfPlain(c).replace(/\n+/g, ' ').trim()).join(' | ')}\n`;
  const inner = (node.content || []).map(adfPlain).join('');
  return ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(node.type) ? `${inner}\n` : inner;
}

const isPo = (i) => /purchase order/i.test(`${i.fields?.issuetype?.name || ''} ${i.fields?.summary || ''}`);
const isBuild = (i) => /\bbuild\b/i.test(i.fields?.issuetype?.name || '') || /^(new )?build\b/i.test(i.fields?.summary || '');
const isTest = (i) => /config|test/i.test(i.fields?.issuetype?.name || '') || /config.*test|test.*config/i.test(i.fields?.summary || '');

async function startField(env) {
  const cached = await getState(env, 'jira_start_field');
  if (cached) return cached === 'none' ? null : cached;
  const fields = await jira(env, '/rest/api/3/field').catch(() => null);
  const f = (fields || []).find((x) => x.custom && String(x.name).toLowerCase() === 'start date');
  await setState(env, 'jira_start_field', f?.id || 'none');
  return f?.id || null;
}

// The parts list in a Purchase Order item's description, a line at a time. Lines that read
// like "2 x ABC-123 Contactor", "Contactor x2", "Qty 2 - Contactor" or a table row with a number
// in it are kept; headings and blank lines are left out.
// Bumped whenever the reading below changes, so parts lists already read are read again.
const PARSER_VERSION = '2';
export function parsePartsList(raw) {
  const out = [];
  for (let line of String(raw || '').split(/\n/)) {
    line = line.replace(/^\s*(?:[-*•·▪]|\d+[.)])\s+/, '').trim();
    // The paperwork the order needs comes after the parts, and isn't hardware.
    if (/^documents?\s+required\b/i.test(line)) break;
    if (/order\s+acknowledg|delivery\s+notes?\b/i.test(line)) continue;
    if (!line || line.length < 2) continue;
    if (/^(configuration options?|options?|notes?)\s*:/i.test(line) || /\.(pdf|docx?|xlsx?)\b/i.test(line)) continue;
    let qty = null; let what = null;
    if (line.includes('|')) {
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      const qi = cells.findIndex((c) => /^\d+(?:\.\d+)?$/.test(c));
      if (qi < 0) continue;
      qty = Number(cells[qi]);
      what = cells.filter((_, i) => i !== qi).join(' ').trim();
    } else {
      let m;
      if ((m = line.match(/^(\d+(?:\.\d+)?)\s*(?:x|×|off|no\.?|pcs?|nr)?\s*[-:–]?\s+(.+)$/i))) { qty = Number(m[1]); what = m[2]; }
      else if ((m = line.match(/^(?:qty|quantity)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*[-:–,]?\s*(.+)$/i))) { qty = Number(m[1]); what = m[2]; }
      else if ((m = line.match(/^(.+?)\s*[-–,(]?\s*(?:x|×)\s*(\d+(?:\.\d+)?)\)?$/i))) { qty = Number(m[2]); what = m[1]; }
      else if ((m = line.match(/^(.+?)\s*[-–,(]?\s*\b(?:qty|quantity)\s*[:=]?\s*(\d+(?:\.\d+)?)\)?(?:\s*[-–,]?\s*£\s*[\d,]+(?:\.\d+)?)?$/i))) { qty = Number(m[2]); what = m[1]; }
      else if (/[a-z]/i.test(line) && !/:$/.test(line) && line.split(/\s+/).length <= 14 && !/^(hardware|parts?|items?|bill of materials|bom|notes?)\b/i.test(line)) { qty = 1; what = line; }
    }
    what = String(what || '').replace(/^[-:–,\s]+|[-:–,\s]+$/g, '').trim();
    if (!what || !qty || qty <= 0 || qty > 100000) continue;
    out.push({ qty, text: what.slice(0, 300) });
  }
  return out;
}

// Which stock item a parts-list line means: a code, barcode or part number in it, or the name.
async function matchItem(env, line) {
  const words = String(line || '').toUpperCase().split(/[\s,;()]+/).filter((w) => w.length >= 3);
  if (words.length) {
    for (const part of chunk(words.slice(0, 40), 40)) {
      const hit = await env.DB.prepare(`SELECT a.item_id FROM stock_aliases a JOIN stock_items i ON i.id = a.item_id WHERE i.active = 1 AND UPPER(a.code) IN (${part.map(() => '?').join(',')}) LIMIT 1`).bind(...part).first();
      if (hit) return hit.item_id;
      const byCode = await env.DB.prepare(`SELECT id FROM stock_items WHERE active = 1 AND (UPPER(code) IN (${part.map(() => '?').join(',')}) OR UPPER(mpn) IN (${part.map(() => '?').join(',')}) OR UPPER(supplier_part) IN (${part.map(() => '?').join(',')})) LIMIT 1`).bind(...part, ...part, ...part).first();
      if (byCode) return byCode.id;
    }
  }
  const byName = await env.DB.prepare('SELECT id FROM stock_items WHERE active = 1 AND LOWER(name) = LOWER(?) LIMIT 1').bind(String(line || '').trim()).first();
  if (byName) return byName.id;
  // A quote line that starts with an item's name and adds to it ("Moxa DE-311 Configured"): the longest such name.
  // Compared here rather than in SQL: D1 refuses LIKE patterns longer than 50 bytes, and item names can be longer.
  const l = String(line || '').trim().toLowerCase();
  const names = (await env.DB.prepare('SELECT id, name FROM stock_items WHERE active = 1').all()).results || [];
  const within = names.filter((n) => n.name.length >= 4 && l.startsWith(n.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
  return within?.id || null;
}

// The open hardware on customer orders becomes work orders: one per Hardware category.
// Kept to once every ten minutes unless asked for.
export async function syncOrders(env, { force = false } = {}) {
  const last = await getState(env, 'stock_sync_at');
  if (!force && last && Date.now() - new Date(last).getTime() < 10 * 60000) return { skipped: true, at: last };
  const { activeJobs } = await import('./disputes.js');
  const { categories, legacy = [] } = await activeJobs(env);
  const hardware = categories.filter((c) => c.discipline === 'hardware' && !c.done);
  const sf = await startField(env);
  const fields = ['summary', 'issuetype', 'status', 'parent', 'description', 'duedate', ...(sf ? [sf] : [])];
  const byCat = new Map(hardware.map((c) => [c.issue_key, { cat: c, self: null, subs: [] }]));
  for (const part of chunk([...byCat.keys()], 40)) {
    const list = part.join(',');
    const issues = await searchJql(env, `key in (${list}) OR parent in (${list})`, fields, { limit: 1000 });
    for (const i of issues) {
      if (byCat.has(i.key)) { byCat.get(i.key).self = i; continue; }
      const parentKey = i.fields?.parent?.key;
      if (byCat.has(parentKey)) byCat.get(parentKey).subs.push(i);
    }
  }
  // Orders from before categories: the Purchase Order Phase item sits straight under the order,
  // with its Build and Testing items beside it. Each open one is a work order of its own.
  const isPoRow = (x) => /purchase order/i.test(`${x.type || ''} ${x.summary || ''}`);
  const legacyPo = legacy.filter((l) => !l.done && isPoRow(l));
  if (legacyPo.length) {
    const want = new Set();
    const groups = legacyPo.map((p) => {
      const sib = legacy.filter((x) => x.epic_key === p.epic_key && x.issue_key !== p.issue_key && !isPoRow(x));
      [p, ...sib].forEach((x) => want.add(x.issue_key));
      return { p, sib };
    });
    const got = new Map();
    for (const part of chunk([...want], 40)) for (const i of await searchJql(env, `key in (${part.join(',')})`, fields, { limit: 1000 })) got.set(i.key, i);
    for (const { p, sib } of groups) {
      const poIssue = got.get(p.issue_key);
      if (!poIssue) continue;
      byCat.set(p.issue_key, { cat: { epic_key: p.epic_key, summary: p.summary, order_summary: p.order_summary, project_name: p.project_name, team: p.team },
        self: poIssue, subs: [poIssue, ...sib.map((x) => got.get(x.issue_key)).filter(Boolean)] });
    }
  }
  const existing = new Map(((await env.DB.prepare("SELECT * FROM stock_orders WHERE kind = 'job'").all()).results || []).map((o) => [o.key, o]));
  const reread = (await getState(env, 'stock_parser_version')) !== PARSER_VERSION;
  const at = nowIso();
  const fresh = [];
  for (const [key, { cat, self, subs }] of byCat) {
    const po = subs.find(isPo);
    const build = subs.find(isBuild);
    const test = subs.find(isTest);
    const dates = (i) => (i ? [i.fields?.[sf] || null, i.fields?.duedate || null] : [null, null]);
    const [bStart, bDue] = dates(build);
    const [cStart, cDue] = dates(self);
    const [, poDue] = dates(po);
    const start = bStart || cStart || null;
    const end = cDue || bDue || null;
    const neededBy = bStart || [cStart, bDue, poDue, cDue].filter(Boolean).sort()[0] || null;
    const subtasks = JSON.stringify(subs.map((s) => ({ key: s.key, id: String(s.id), summary: s.fields?.summary || '', type: s.fields?.issuetype?.name || '', status: s.fields?.status?.name || '',
      cat: s.fields?.status?.statusCategory?.key || null, role: s === po ? 'po' : s === build ? 'build' : s === test ? 'test' : null })));
    const poText = po ? adfPlain(po.fields?.description).trim().slice(0, 20000) : '';
    const was = existing.get(key);
    const vals = [cat.epic_key, cat.summary, cat.order_summary, cat.project_name, cat.team, start, end, neededBy, subtasks, po?.key || null, poText];
    if (was) {
      await env.DB.prepare(`UPDATE stock_orders SET epic_key = ?, summary = ?, order_summary = ?, customer = ?, team = ?, start_date = ?, end_date = ?, needed_by = ?, subtasks = ?, po_key = ?, po_text = ?, jira_done = 0,
        status = CASE WHEN status = 'closed' THEN 'open' ELSE status END WHERE id = ?`).bind(...vals, was.id).run();
      if (poText !== (was.po_text || '') || reread) await importNeeds(env, was.id, poText);
    } else {
      const row = await env.DB.prepare(`INSERT INTO stock_orders (kind, key, epic_key, summary, order_summary, customer, team, start_date, end_date, needed_by, subtasks, po_key, po_text, status, created_at, created_by)
        VALUES ('job', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 'Jira') RETURNING id`).bind(key, ...vals, at).first();
      await importNeeds(env, row.id, poText);
      fresh.push(row.id);
    }
  }
  // Hardware finished or gone in Jira: kept for its history, out of the open list.
  for (const [key, o] of existing) {
    if (!byCat.has(key) && o.status !== 'complete') await env.DB.prepare("UPDATE stock_orders SET jira_done = 1, status = CASE WHEN status IN ('open', 'paused') THEN 'closed' ELSE status END WHERE id = ?").bind(o.id).run();
  }
  await setState(env, 'stock_sync_at', at);
  if (reread) await setState(env, 'stock_parser_version', PARSER_VERSION);
  if (fresh.length) await allocate(env, { orderIds: fresh, viewer: SYSTEM });
  return { ok: true, at, orders: byCat.size, added: fresh.length };
}

const SYSTEM = { accountId: 'hub', email: 'Hub', employee: { name: 'Hub' } };

// The parts list as read from Jira replaces what was read before; lines added by hand,
// or from panel defaults, are left alone. The first read is the "initial assignment".
async function importNeeds(env, orderId, poText) {
  const lines = parsePartsList(poText);
  const at = nowIso();
  const stmts = [env.DB.prepare("DELETE FROM stock_needs WHERE order_id = ? AND source = 'jira'").bind(orderId)];
  // Lines changed or removed in the hub stay as they were left.
  const kept = new Set(((await env.DB.prepare("SELECT text FROM stock_needs WHERE order_id = ? AND source IN ('jira-edited', 'jira-removed')").bind(orderId).all()).results || []).map((r) => String(r.text || '').toLowerCase()));
  for (const l of lines.slice(0, 300)) {
    if (kept.has(l.text.toLowerCase())) continue;
    stmts.push(env.DB.prepare("INSERT INTO stock_needs (order_id, item_id, text, qty, source, created_at, created_by) VALUES (?, ?, ?, ?, 'jira', ?, 'Jira')")
      .bind(orderId, await matchItem(env, l.text), l.text, l.qty, at));
  }
  stmts.push(env.DB.prepare('UPDATE stock_orders SET imported = 1 WHERE id = ?').bind(orderId));
  await env.DB.batch(stmts);
}

// ---------- what each work order needs, and has ----------

async function loadAll(env) {
  const [orders, needs, units, expected, items] = await Promise.all([
    env.DB.prepare("SELECT * FROM stock_orders WHERE status IN ('open', 'paused', 'complete', 'closed', 'cancelled')").all(),
    env.DB.prepare('SELECT * FROM stock_needs WHERE deleted_at IS NULL').all(),
    env.DB.prepare("SELECT * FROM stock_units WHERE status IN ('available', 'reserved', 'picked', 'consumed', 'quarantine')").all(),
    env.DB.prepare("SELECT * FROM stock_expected WHERE status = 'open'").all(),
    env.DB.prepare('SELECT * FROM stock_items').all(),
  ]);
  return { orders: orders.results || [], needs: needs.results || [], units: units.results || [], expected: expected.results || [], items: new Map((items.results || []).map((i) => [i.id, i])) };
}

const stillDue = (e) => Math.max(0, (e.qty || 0) - (e.received_qty || 0) - (e.issue_qty || 0));

// Each need on an order: how much is held for it, out on the bench, used, on its way, and still to buy.
function needLines(order, all, day = today()) {
  const needs = all.needs.filter((n) => n.order_id === order.id && n.source !== 'jira-removed');
  const byItem = new Map();
  for (const n of needs) {
    if (!n.item_id) continue;
    byItem.set(n.item_id, (byItem.get(n.item_id) || 0) + n.qty);
  }
  const mine = all.units.filter((u) => u.order_id === order.id);
  const lines = [];
  const seen = new Set();
  for (const n of needs) {
    const item = n.item_id ? all.items.get(n.item_id) : null;
    if (!item) { lines.push({ needId: n.id, text: n.text, qty: n.qty, source: n.source, item: null, state: 'unknown' }); continue; }
    if (seen.has(item.id)) { lines.push({ needId: n.id, text: n.text, qty: n.qty, source: n.source, item: itemBrief(item), merged: true }); continue; }
    seen.add(item.id);
    const req = byItem.get(item.id);
    const sum = (status) => mine.filter((u) => u.item_id === item.id && u.status === status).reduce((s, u) => s + u.qty, 0);
    const reserved = sum('reserved'); const picked = sum('picked'); const consumed = sum('consumed');
    const onWay = all.expected.filter((e) => e.order_id === order.id && e.item_id === item.id).reduce((s, e) => s + stillDue(e), 0);
    const team = teamKey(order.team);
    const free = all.units.filter((u) => u.item_id === item.id && u.status === 'available' && !u.order_id && (!u.team || !team || teamKey(u.team) === team) && !(u.expiry && u.expiry < day)).reduce((s, u) => s + u.qty, 0);
    const have = reserved + picked + consumed;
    let toOrder; let state;
    if (item.mode === 'bin') {
      // Bins aren't held for anyone: what's in them is for whoever takes it.
      const left = Math.max(0, req - picked - consumed);
      toOrder = Math.max(0, left - free - onWay);
      state = left <= free ? 'in' : left <= free + onWay ? 'transit' : 'order';
    } else {
      toOrder = Math.max(0, req - have - onWay);
      state = have >= req ? 'in' : have + onWay >= req ? 'transit' : 'order';
    }
    const held = mine.filter((u) => u.item_id === item.id && (u.status === 'reserved' || u.status === 'picked'));
    const expired = held.some((u) => u.expiry && u.expiry < day);
    const expiring = !expired && held.some((u) => u.expiry && u.expiry <= addDays(day, EXPIRY_WARN_DAYS));
    lines.push({ needId: n.id, text: n.text, qty: req, source: n.source, item: itemBrief(item), reserved, picked, consumed, onWay, free, toOrder, state, expired, expiring,
      cost: mine.filter((u) => u.item_id === item.id && (u.status === 'picked' || u.status === 'consumed')).reduce((s, u) => s + u.qty * (u.unit_cost || item.unit_cost || 0), 0) });
  }
  return lines;
}

const itemBrief = (i) => ({ id: i.id, code: i.code, name: i.name, mode: i.mode, unit: i.unit, weight: i.weight, supplier: i.supplier, unit_cost: i.unit_cost });

function orderState(lines) {
  const real = lines.filter((l) => !l.merged);
  if (!real.length) return 'empty';
  if (real.some((l) => l.state === 'order' || l.state === 'unknown')) return 'order';
  if (real.some((l) => l.state === 'transit')) return 'transit';
  return 'in';
}
const allOut = (lines) => lines.filter((l) => !l.merged && l.item).every((l) => l.picked + l.consumed >= l.qty - 1e-9) && !lines.some((l) => l.state === 'unknown');

function orderBrief(o, lines, day) {
  const subs = JSON.parse(o.subtasks || '[]');
  return {
    id: o.id, kind: o.kind, key: o.key, epicKey: o.epic_key, summary: o.summary, orderSummary: o.order_summary, customer: o.customer, team: o.team,
    start: o.start_date, end: o.end_date, neededBy: o.needed_by, priority: priorityOf(o, day), auto: autoPriority(o, day), override: o.priority_override || null, overrideBy: o.priority_by,
    status: o.status, jiraDone: Boolean(o.jira_done), state: orderState(lines), lines: lines.filter((l) => !l.merged).length,
    toOrder: lines.filter((l) => l.state === 'order' || l.state === 'unknown').length, ready: allOut(lines) && lines.length > 0,
    expired: lines.some((l) => l.expired), expiring: lines.some((l) => l.expiring), poKey: o.po_key, subtasks: subs,
    cost: Math.round(lines.reduce((s, l) => s + (l.cost || 0), 0) * 100) / 100, completedAt: o.completed_at, completedBy: o.completed_by, note: o.note,
  };
}

export async function orders(env, viewer, { status = 'open', sync = true } = {}) {
  let synced = null;
  if (sync) synced = await syncOrders(env).catch((err) => ({ error: err.message }));
  const all = await loadAll(env);
  const day = today();
  const want = status === 'all' ? null : status === 'done' ? ['complete', 'closed', 'cancelled'] : ['open', 'paused'];
  const list = rankOrders(all.orders.filter((o) => !want || want.includes(o.status)), day).map((o) => orderBrief(o, needLines(o, all, day), day));
  return { orders: list, synced, lastSync: await getState(env, 'stock_sync_at'), canLead: canLead(viewer), canManage: canManage(viewer) };
}

export async function orderDetail(env, viewer, id) {
  const all = await loadAll(env);
  const o = all.orders.find((x) => x.id === Number(id));
  if (!o) throw bad('That work order isn\'t on record.', 404);
  const day = today();
  const lines = needLines(o, all, day);
  const units = all.units.filter((u) => u.order_id === o.id);
  const locs = await locationMap(env);
  const pick = units.filter((u) => u.status === 'reserved').map((u) => unitBrief(u, all.items, locs));
  // Bins: where to take each one from.
  const bins = [];
  for (const l of lines) {
    if (l.item?.mode !== 'bin' || l.merged) continue;
    const left = Math.max(0, l.qty - l.picked - l.consumed);
    if (!left) continue;
    const at = all.units.filter((u) => u.item_id === l.item.id && u.status === 'available' && !u.order_id).map((u) => locs.get(u.location_id)).filter(Boolean);
    bins.push({ item: l.item, qty: left, locations: [...new Map(at.map((x) => [x.id, x])).values()].map((x) => ({ code: x.code, area: x.area })) });
  }
  const out = units.filter((u) => u.status === 'picked' || u.status === 'consumed').map((u) => unitBrief(u, all.items, locs));
  const panels = (await env.DB.prepare('SELECT id, name FROM stock_panels ORDER BY name').all()).results || [];
  return { order: orderBrief(o, lines, day), lines, pick, bins, out, panels, poText: o.po_text || '', canLead: canLead(viewer), canManage: canManage(viewer),
    jiraMoves: (await getState(env, 'stock_jira_moves')) === 'on' };
}

async function locationMap(env) {
  return new Map(((await env.DB.prepare('SELECT * FROM stock_locations').all()).results || []).map((l) => [l.id, l]));
}
function unitBrief(u, items, locs) {
  const i = items.get(u.item_id) || {};
  const l = locs.get(u.location_id);
  return { id: u.id, code: u.code, item: { id: i.id, name: i.name, code: i.code, mode: i.mode, unit: i.unit }, lot: u.lot, supplierLot: u.supplier_lot || null, serial: u.serial, qty: u.qty, status: u.status,
    location: l ? { id: l.id, code: l.code, area: l.area, level: l.level } : null, orderId: u.order_id, team: u.team, expiry: u.expiry,
    receivedAt: u.received_at, pickedAt: u.picked_at, pickedBy: u.picked_by, unitCost: u.unit_cost ?? i.unit_cost ?? null, supplier: u.supplier, poRef: u.po_ref };
}

// ---------- automatic assignment ----------

// Free stock is held for the work orders that need it, highest priority first. This only
// hands out free stock; anything already held for a job stays where it is. Bins are never held.
export async function allocate(env, { orderIds = null, itemIds = null, viewer = SYSTEM } = {}) {
  const all = await loadAll(env);
  const day = today();
  const open = rankOrders(all.orders.filter((o) => o.status === 'open' && (!orderIds || orderIds.includes(o.id))), day);
  const free = all.units.filter((u) => u.status === 'available' && !u.order_id && !(u.expiry && u.expiry < day) && (!itemIds || itemIds.includes(u.item_id)))
    .sort((a, b) => String(a.expiry || '9999').localeCompare(String(b.expiry || '9999')) || String(a.received_at || '').localeCompare(String(b.received_at || '')));
  const quarantine = new Set(((await env.DB.prepare('SELECT id FROM stock_locations WHERE quarantine = 1').all()).results || []).map((l) => l.id));
  const stmts = [];
  let held = 0;
  for (const o of open) {
    const team = teamKey(o.team);
    for (const l of needLines(o, all, day)) {
      if (!l.item || l.merged || l.item.mode === 'bin' || (itemIds && !itemIds.includes(l.item.id))) continue;
      let short = l.qty - l.reserved - l.picked - l.consumed;
      for (const u of free) {
        if (short <= 1e-9) break;
        if (u.item_id !== l.item.id || u.qty <= 1e-9 || quarantine.has(u.location_id)) continue;
        if (u.team && team && teamKey(u.team) !== team) continue;
        const take = Math.min(short, u.qty);
        stmts.push(...changePart(env, viewer, u, take, { status: 'reserved', order_id: o.id }, { action: 'reserve', orderId: o.id, orderKey: o.key, to: u.location_id, note: 'Assigned automatically' }));
        u.qty -= take; short -= take; held += take;
        all.units.push({ ...u, qty: take, status: 'reserved', order_id: o.id });
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { held };
}

// Something on its way is for the highest-priority work order of the team that ordered it
// that it would still be short for.
async function assignExpected(env, itemId, team) {
  const all = await loadAll(env);
  const day = today();
  for (const o of rankOrders(all.orders.filter((x) => x.status === 'open' && (!team || teamKey(x.team) === teamKey(team))), day)) {
    const l = needLines(o, all, day).find((x) => x.item?.id === itemId && !x.merged);
    if (l && l.toOrder > 0) return o;
  }
  return null;
}


// ---------- reading what's on a supplier's label ----------

// 2D codes on component labels carry the details themselves, in one of two standard layouts:
//  - ISO/IEC 15434 with ANSI MH10.8.2 data identifiers ("[)>" RS "06" GS ... ), used by DigiKey,
//    Mouser, Würth, TME and component makers: 1P manufacturer part, P/30P distributor part, Q
//    quantity, 1T lot, 9D/10D date code, 14D expiry, S serial, K purchase order, 1V maker.
//  - GS1 application identifiers, used on many manufacturer labels: (01) GTIN, (10) lot,
//    (17) expiry, (21) serial, (30)/(37) count, (240) part number, (400) purchase order.
// Group separators can come through as the control character, or as the text "<GS>" or "~029".
const GS = '\x1d'; const RS = '\x1e';
const GS1_FIXED = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
const GS1_VAR = ['10', '21', '22', '30', '37', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99', '240', '241', '242', '250', '251', '400', '401', '402', '403', '410', '411', '412', '413', '414', '420', '421', '422', '7003', '7240'];
const ymd = (v) => {
  const m = String(v || '').match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const y = 2000 + Number(m[1]); const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const d = Number(m[3]) || new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

export function parseLabel(raw) {
  let s = String(raw || '').replace(/<GS>|~029|\{GS\}/gi, GS).replace(/<RS>|~030|\{RS\}/gi, RS).replace(/<EOT>|~004/gi, '\x04').replace(/\x1c/g, '');
  s = s.replace(/^\][A-Za-z]\d/, '');
  if (s.length < 6) return null;
  const out = { format: null };
  const put = (k, v) => { const t = String(v ?? '').trim(); if (t && out[k] == null) out[k] = t.slice(0, 120); };

  // ISO 15434 with data identifiers.
  if (/^\[\)>/.test(s) || /^\[\)>\s*06/.test(s)) {
    out.format = 'mh10';
    const body = s.replace(/^\[\)>\s*\x1e?\s*(06|DD)?\s*\x1d?/, '').replace(/[\x1e\x04]+$/g, '');
    for (const f of body.split(/[\x1d\x1e]/)) {
      const m = f.match(/^(\d{0,3})([A-Z])(.*)$/);
      if (!m) continue;
      const id = `${m[1]}${m[2]}`; const v = m[3];
      if (id === '1P') put('mpn', v);
      else if (id === '30P' || id === 'P') put('supplierPart', v);
      else if (id === 'Q') { const q = Number(v); if (q > 0) out.qty ??= q; }
      else if (id === '1T' || id === 'T') put('lot', v);
      else if (id === '9D' || id === '10D') put('dateCode', v);
      else if (id === '14D') { const d = v.match(/^(\d{4})(\d{2})(\d{2})$/); if (d) out.expiry ??= `${d[1]}-${d[2]}-${d[3]}`; }
      else if (id === 'S' || id === '1S') put('serial', v);
      else if (id === 'K') put('po', v);
      else if (id === '1V') put('manufacturer', v);
      else if (id === '4L') put('country', v);
    }
    return out.mpn || out.supplierPart ? out : null;
  }

  // GS1, written with brackets: (01)05012345678900(10)ABC(17)271231
  if (/^\(\d{2,4}\)/.test(s)) {
    out.format = 'gs1';
    for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) gs1Field(out, put, m[1], m[2].trim());
    return out.gtin || out.mpn ? out : null;
  }

  // GS1 as scanned: no brackets, variable fields ended by a group separator.
  const g = s.replace(/^\x1d+/, '');
  if (/^(01|02)\d{14}/.test(g) && (g.length > 16 || s.startsWith(GS))) {
    out.format = 'gs1';
    let i = 0; let guard = 0;
    while (i < g.length && guard++ < 30) {
      if (g[i] === GS) { i++; continue; }
      const ai2 = g.slice(i, i + 2); const ai3 = g.slice(i, i + 3); const ai4 = g.slice(i, i + 4);
      let ai; let len = null;
      if (GS1_FIXED[ai2]) { ai = ai2; len = GS1_FIXED[ai2]; }
      else if (/^3[1-6]\d\d$/.test(ai4)) { ai = ai4; len = 6; }
      else if (GS1_VAR.includes(ai4)) ai = ai4;
      else if (GS1_VAR.includes(ai3)) ai = ai3;
      else if (GS1_VAR.includes(ai2)) ai = ai2;
      else break;
      i += ai.length;
      let v;
      if (len) { v = g.slice(i, i + len); i += len; }
      else { const end = g.indexOf(GS, i); v = g.slice(i, end < 0 ? g.length : end); i = end < 0 ? g.length : end + 1; }
      gs1Field(out, put, ai, v);
    }
    return out.gtin ? out : null;
  }
  return null;
}

function gs1Field(out, put, ai, v) {
  if (ai === '01' || ai === '02') {
    // A 14-digit GTIN starting 0 is the same product as the 13-digit barcode on it.
    if (/^\d{14}$/.test(v)) out.gtin ??= v.startsWith('0') ? v.slice(1) : v;
  } else if (ai === '10') put('lot', v);
  else if (ai === '17' || ai === '15') { if (!out.expiry) out.expiry = ymd(v); }
  else if (ai === '11') put('madeOn', ymd(v));
  else if (ai === '21') put('serial', v);
  else if (ai === '30' || ai === '37') { const q = Number(v); if (q > 0) out.qty ??= q; }
  else if (ai === '240') put('mpn', v);
  else if (ai === '241') put('supplierPart', v);
  else if (ai === '400') put('po', v);
}

// The stock item a label (or any scanned code) is for: by barcode, code, part number or supplier part.
async function itemForCodes(env, codes) {
  for (const raw of codes.filter(Boolean)) {
    const up = String(raw).toUpperCase();
    const variants = [up, ...(/^\d{13}$/.test(up) ? [`0${up}`] : /^0\d{13}$/.test(up) ? [up.slice(1)] : [])];
    for (const v of variants) {
      const alias = await env.DB.prepare('SELECT a.item_id FROM stock_aliases a JOIN stock_items i ON i.id = a.item_id WHERE i.active = 1 AND UPPER(a.code) = ?').bind(v).first();
      if (alias) return alias.item_id;
      const hit = await env.DB.prepare('SELECT id FROM stock_items WHERE active = 1 AND (UPPER(code) = ? OR UPPER(mpn) = ? OR UPPER(supplier_part) = ?)').bind(v, v, v).first();
      if (hit) return hit.id;
    }
  }
  return null;
}

// ---------- items, aliases and locations ----------

export async function lookup(env, viewer, code) {
  const c = String(code || '').trim();
  if (!c) throw bad('Scan or type a code.');
  const up = c.toUpperCase();
  const items = await itemMap(env);
  const locs = await locationMap(env);
  const loc = [...locs.values()].find((l) => l.code.toUpperCase() === up && l.active);
  if (loc) {
    const here = (await env.DB.prepare("SELECT * FROM stock_units WHERE location_id = ? AND status IN ('available', 'reserved', 'quarantine') ORDER BY item_id").bind(loc.id).all()).results || [];
    return { type: 'location', location: loc, units: here.map((u) => unitBrief(u, items, locs)) };
  }
  const units = (await env.DB.prepare("SELECT * FROM stock_units WHERE (UPPER(code) = ? OR UPPER(serial) = ?) AND status != 'gone' ORDER BY id").bind(up, up).all()).results || [];
  if (units.length) return { type: 'unit', units: units.map((u) => unitBrief(u, items, locs)), item: items.get(units[0].item_id) || null };
  // A supplier's 2D label: what it says, and the stock item it's for if there is one.
  const label = parseLabel(c);
  const itemId = label ? await itemForCodes(env, [label.mpn, label.supplierPart, label.gtin]) : await itemForCodes(env, [c]);
  if (itemId) {
    const item = items.get(itemId);
    const expected = (await env.DB.prepare("SELECT e.*, o.key AS order_key FROM stock_expected e LEFT JOIN stock_orders o ON o.id = e.order_id WHERE e.item_id = ? AND e.status = 'open' ORDER BY e.expected_date").bind(itemId).all()).results || [];
    return { type: 'item', item, expected, stock: await itemStock(env, itemId, items, locs), label };
  }
  return { type: 'unknown', code: label ? (label.gtin || null) : c, label, suggestions: await suggest(env, label ? label.mpn || label.supplierPart || '' : c) };
}

async function itemMap(env) {
  return new Map(((await env.DB.prepare('SELECT * FROM stock_items').all()).results || []).map((i) => [i.id, i]));
}
async function itemStock(env, itemId, items, locs) {
  const units = (await env.DB.prepare("SELECT * FROM stock_units WHERE item_id = ? AND status IN ('available', 'reserved', 'picked', 'quarantine') ORDER BY location_id").bind(itemId).all()).results || [];
  return units.map((u) => unitBrief(u, items, locs));
}

// Items whose name, code or part numbers start with or contain what's typed.
export async function suggest(env, q) {
  const s = String(q || '').trim().toLowerCase();
  if (s.length < 2) return [];
  const like = `%${likeTerm(s)}%`;
  const rows = (await env.DB.prepare(`SELECT DISTINCT i.* FROM stock_items i LEFT JOIN stock_aliases a ON a.item_id = i.id
    WHERE i.active = 1 AND (LOWER(i.name) LIKE ? OR LOWER(COALESCE(i.code, '')) LIKE ? OR LOWER(COALESCE(i.mpn, '')) LIKE ? OR LOWER(COALESCE(i.supplier_part, '')) LIKE ? OR LOWER(COALESCE(i.description, '')) LIKE ? OR LOWER(COALESCE(a.code, '')) LIKE ?)
    ORDER BY CASE WHEN LOWER(i.name) LIKE ? THEN 0 ELSE 1 END, i.name LIMIT 12`).bind(like, like, like, like, like, like, `${likeTerm(s)}%`).all()).results || [];
  return rows.map(itemBrief);
}

const ITEM_FIELDS = ['code', 'name', 'description', 'category', 'mode', 'unit', 'weight', 'usual_location', 'supplier', 'supplier_part', 'manufacturer', 'mpn', 'unit_cost', 'lead_days', 'two_bin', 'reorder_qty', 'min_qty', 'shelf_life_days'];
function cleanItem(input) {
  const out = {
    code: text(input.code, 60), name: text(input.name, 160), description: text(input.description, 1000), category: text(input.category, 80),
    mode: MODES.includes(input.mode) ? input.mode : 'batch', unit: text(input.unit, 20) || 'each', weight: WEIGHTS.includes(input.weight) ? input.weight : 'light',
    usual_location: num(input.usual_location), supplier: text(input.supplier, 120), supplier_part: text(input.supplier_part, 80), manufacturer: text(input.manufacturer, 120), mpn: text(input.mpn, 80),
    unit_cost: num(input.unit_cost), lead_days: num(input.lead_days), two_bin: input.two_bin ? 1 : 0, reorder_qty: num(input.reorder_qty), min_qty: num(input.min_qty), shelf_life_days: num(input.shelf_life_days),
  };
  if (!out.name) throw bad('Give the item a name.');
  return out;
}

export async function itemSave(env, viewer, input) {
  const v = cleanItem(input);
  const aliases = [...new Set((Array.isArray(input.aliases) ? input.aliases : String(input.aliases || '').split(/[\n,]/)).map((a) => String(a).trim()).filter((a) => a.length >= 2))].slice(0, 30);
  let id = num(input.id);
  if (id) {
    // Anyone can add a new item while taking stock in; changing one already on record is for managers.
    needManage(viewer);
    const was = await itemById(env, id);
    if (!v.code) v.code = was.code;
    if (await env.DB.prepare('SELECT id FROM stock_items WHERE UPPER(code) = UPPER(?) AND id != ?').bind(v.code, id).first()) throw bad(`An item already has the code ${v.code}.`);
    await env.DB.prepare(`UPDATE stock_items SET ${ITEM_FIELDS.map((f) => `${f} = ?`).join(', ')}, edited_at = ? WHERE id = ?`).bind(...ITEM_FIELDS.map((f) => v[f]), nowIso(), id).run();
  } else {
    if (v.code && await env.DB.prepare('SELECT id FROM stock_items WHERE UPPER(code) = UPPER(?)').bind(v.code).first()) throw bad(`An item already has the code ${v.code}.`);
    id = (await env.DB.prepare(`INSERT INTO stock_items (${ITEM_FIELDS.join(', ')}, active, created_at, created_by) VALUES (${ITEM_FIELDS.map(() => '?').join(', ')}, 1, ?, ?) RETURNING id`)
      .bind(...ITEM_FIELDS.map((f) => v[f]), nowIso(), whoOf(viewer).name).first()).id;
    // Every item has a code to print on its bin or shelf label.
    if (!v.code) await env.DB.prepare('UPDATE stock_items SET code = ? WHERE id = ?').bind(`I${String(id).padStart(5, '0')}`, id).run();
  }
  for (const a of aliases) {
    const taken = await env.DB.prepare('SELECT item_id FROM stock_aliases WHERE UPPER(code) = UPPER(?)').bind(a).first();
    if (taken && taken.item_id !== id) throw bad(`The code ${a} already belongs to another item.`);
  }
  if (Array.isArray(input.aliases) || typeof input.aliases === 'string') {
    await env.DB.batch([env.DB.prepare('DELETE FROM stock_aliases WHERE item_id = ?').bind(id),
      ...aliases.map((a) => env.DB.prepare('INSERT OR REPLACE INTO stock_aliases (code, item_id, kind) VALUES (?, ?, ?)').bind(a, id, 'barcode'))]);
  }
  // Parts lists read before the item existed pick it up now.
  const unmatched = (await env.DB.prepare('SELECT id, text FROM stock_needs WHERE item_id IS NULL').all()).results || [];
  for (const n of unmatched) if ((await matchItem(env, n.text)) === id) await env.DB.prepare('UPDATE stock_needs SET item_id = ? WHERE id = ?').bind(id, n.id).run();
  return { ok: true, id };
}

export async function itemRemove(env, viewer, { id }) {
  needManage(viewer);
  const held = await env.DB.prepare("SELECT COUNT(*) AS n FROM stock_units WHERE item_id = ? AND status IN ('available', 'reserved', 'picked', 'quarantine')").bind(Number(id)).first();
  if (held?.n) throw bad('There\'s still some of this in stock. Count it out or write it off first.');
  await env.DB.prepare('UPDATE stock_items SET active = 0 WHERE id = ?').bind(Number(id)).run();
  return { ok: true };
}

export async function addAlias(env, viewer, { itemId, code }) {
  const c = text(code, 120);
  if (!c) throw bad('Scan the barcode to add.');
  await itemById(env, itemId);
  const taken = await env.DB.prepare('SELECT item_id FROM stock_aliases WHERE UPPER(code) = UPPER(?)').bind(c).first();
  if (taken && taken.item_id !== Number(itemId)) throw bad('That barcode already belongs to another item.');
  await env.DB.prepare('INSERT OR REPLACE INTO stock_aliases (code, item_id, kind) VALUES (?, ?, ?)').bind(c, Number(itemId), 'barcode').run();
  return { ok: true };
}

export async function itemsList(env, viewer, { q = '' } = {}) {
  const items = (await env.DB.prepare('SELECT * FROM stock_items WHERE active = 1 ORDER BY name').all()).results || [];
  const aliases = (await env.DB.prepare('SELECT * FROM stock_aliases').all()).results || [];
  const all = await loadAll(env);
  const day = today();
  const short = new Map();
  for (const o of all.orders.filter((x) => x.status === 'open')) for (const l of needLines(o, all, day)) if (l.item && !l.merged) short.set(l.item.id, (short.get(l.item.id) || 0) + l.toOrder);
  const s = String(q || '').trim().toLowerCase();
  const list = items.map((i) => {
    const us = all.units.filter((u) => u.item_id === i.id);
    const sum = (st) => us.filter((u) => u.status === st).reduce((a, u) => a + u.qty, 0);
    const available = sum('available'); const reserved = sum('reserved'); const picked = sum('picked'); const quarantine = sum('quarantine');
    const transit = all.expected.filter((e) => e.item_id === i.id).reduce((a, e) => a + stillDue(e), 0);
    return { ...i, aliases: aliases.filter((a) => a.item_id === i.id).map((a) => a.code), total: available + reserved + picked + quarantine, available, reserved, picked, quarantine, transit, toOrder: short.get(i.id) || 0,
      low: i.min_qty != null && available + transit <= i.min_qty };
  }).filter((i) => !s || [i.name, i.code, i.mpn, i.supplier_part, i.supplier, i.category, ...i.aliases].some((x) => String(x || '').toLowerCase().includes(s)));
  return { items: list, canManage: canManage(viewer) };
}

export async function locations(env) {
  const locs = (await env.DB.prepare('SELECT * FROM stock_locations WHERE active = 1 ORDER BY area, code').all()).results || [];
  const counts = (await env.DB.prepare("SELECT location_id, COUNT(DISTINCT item_id) AS items, SUM(qty) AS qty FROM stock_units WHERE status IN ('available', 'reserved', 'quarantine') GROUP BY location_id").all()).results || [];
  const by = new Map(counts.map((c) => [c.location_id, c]));
  return { locations: locs.map((l) => ({ ...l, items: by.get(l.id)?.items || 0 })) };
}

export async function locationSave(env, viewer, input) {
  needManage(viewer);
  const level = LEVELS.includes(input.level) ? input.level : 'mid';
  const area = text(input.area, 60);
  // Several at once: a prefix and how many, such as A-01 to A-12.
  if (num(input.count) > 1 && input.prefix) {
    const n = Math.min(200, num(input.count));
    const start = num(input.start, 1);
    const stmts = [];
    for (let k = 0; k < n; k++) {
      const code = `${String(input.prefix).trim().toUpperCase()}${String(start + k).padStart(2, '0')}`;
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO stock_locations (code, area, name, level, quarantine, active) VALUES (?, ?, ?, ?, 0, 1)').bind(code, area, null, level));
    }
    await env.DB.batch(stmts);
    return { ok: true, added: n };
  }
  const code = text(input.code, 40)?.toUpperCase();
  if (!code) throw bad('Give the location a code, such as A-01.');
  const vals = [code, area, text(input.name, 80), level, input.quarantine ? 1 : 0];
  if (num(input.id)) await env.DB.prepare('UPDATE stock_locations SET code = ?, area = ?, name = ?, level = ?, quarantine = ? WHERE id = ?').bind(...vals, num(input.id)).run();
  else {
    if (await locationByCode(env, code)) throw bad(`There's already a location ${code}.`);
    await env.DB.prepare('INSERT INTO stock_locations (code, area, name, level, quarantine, active) VALUES (?, ?, ?, ?, ?, 1)').bind(...vals).run();
  }
  return { ok: true };
}

export async function locationRemove(env, viewer, { id }) {
  needManage(viewer);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM stock_units WHERE location_id = ? AND status IN ('available', 'reserved', 'quarantine')").bind(Number(id)).first();
  if (n?.n) throw bad('Move the stock out of this location first.');
  await env.DB.prepare('UPDATE stock_locations SET active = 0 WHERE id = ?').bind(Number(id)).run();
  return { ok: true };
}

// Where to put something away: where it usually lives or where it already is, then empty
// places on a suitable shelf near similar things. Heavy goes low; light can go anywhere.
export async function putaway(env, viewer, itemId) {
  const item = await itemById(env, itemId);
  const locs = ((await env.DB.prepare('SELECT * FROM stock_locations WHERE active = 1 AND quarantine = 0').all()).results || []);
  const used = (await env.DB.prepare("SELECT location_id, item_id FROM stock_units WHERE status IN ('available', 'reserved') AND location_id IS NOT NULL").all()).results || [];
  const items = await itemMap(env);
  const levelOk = (l) => (item.weight === 'heavy' ? l.level === 'low' : item.weight === 'moderate' ? l.level !== 'high' : true);
  const levelScore = (l) => (item.weight === 'light' ? { high: 0, mid: 1, low: 2 } : { low: 0, mid: 1, high: 2 })[l.level] ?? 1;
  const out = [];
  const add = (l, why) => { if (l && !out.some((x) => x.id === l.id)) out.push({ id: l.id, code: l.code, area: l.area, level: l.level, why }); };
  if (item.usual_location) add(locs.find((l) => l.id === item.usual_location), 'Where it usually goes');
  for (const u of used.filter((x) => x.item_id === item.id)) add(locs.find((l) => l.id === u.location_id), 'Where some already is');
  const occupied = new Set(used.map((u) => u.location_id));
  const similarAreas = new Set(used.filter((u) => item.category && items.get(u.item_id)?.category === item.category && u.item_id !== item.id).map((u) => locs.find((l) => l.id === u.location_id)?.area).filter(Boolean));
  const empty = locs.filter((l) => !occupied.has(l.id) && levelOk(l))
    .sort((a, b) => (similarAreas.has(b.area) - similarAreas.has(a.area)) || levelScore(a) - levelScore(b) || a.code.localeCompare(b.code));
  for (const l of empty.slice(0, 4)) add(l, similarAreas.has(l.area) ? `Empty, near other ${item.category}` : `Empty ${l.level} shelf`);
  if (!empty.length) for (const l of locs.filter(levelOk).slice(0, 3)) add(l, `${l.level[0].toUpperCase()}${l.level.slice(1)} shelf, shared`);
  return { suggestions: out.slice(0, 6), weight: item.weight };
}

// ---------- taking stock in ----------

// One delivery line into stock: against what was expected if it was, held for the job it was
// bought for if that job still needs it, otherwise handed to the next job of that team that does.
export async function intake(env, viewer, input) {
  const item = await itemById(env, input.itemId);
  const loc = await locationByCode(env, input.location);
  if (!loc) throw bad('Scan the location it\'s going into.');
  const exp = num(input.expectedId) ? await env.DB.prepare('SELECT * FROM stock_expected WHERE id = ?').bind(num(input.expectedId)).first() : null;
  if (exp && exp.item_id !== item.id) throw bad('That delivery was for a different item.');
  const serials = item.mode === 'serial' ? [...new Set((Array.isArray(input.serials) ? input.serials : String(input.serials || '').split(/[\n,]/)).map((s) => String(s ?? '').trim()).filter(Boolean))] : [];
  // One-at-a-time items: each one scanned is a unit, with its serial number if it has one.
  const qty = item.mode === 'serial' ? Math.max(serials.length, Math.round(num(input.qty, 0))) : qtyOf(input.qty);
  if (qty <= 0) throw bad(item.mode === 'serial' ? 'Scan each one in.' : 'Enter a quantity above zero.');
  if (item.mode === 'serial' && qty > 500) throw bad('That\'s more than 500 at once.');
  const at = nowIso();
  // Every delivery line gets our own batch number, so it can be traced whatever the supplier printed.
  const lot = item.mode === 'bin' ? null : await nextBatch(env);
  const expiry = isoDay(input.expiry) || (item.shelf_life_days ? addDays(today(), item.shelf_life_days) : null);
  const base = {
    item_id: item.id, lot, supplier_lot: text(input.lot, 80), location_id: loc.id, status: 'available', order_id: null, team: text(input.team, 40) || exp?.team || null,
    received_at: at, received_by: whoOf(viewer).name, expiry, supplier: text(input.supplier, 120) || exp?.supplier || item.supplier, po_ref: text(input.poRef, 80) || exp?.po_ref || null,
    po_date: exp?.po_date || isoDay(input.poDate), unit_cost: (canManage(viewer) ? num(input.unitCost) : null) ?? exp?.unit_cost ?? item.unit_cost, expected_id: exp?.id || null, note: text(input.note, 300),
  };
  const stmts = [];
  // Bins hold one running quantity per place: topping one up adds to it.
  if (item.mode === 'bin') {
    const binUnit = await env.DB.prepare("SELECT * FROM stock_units WHERE item_id = ? AND location_id = ? AND status = 'available' AND order_id IS NULL ORDER BY id LIMIT 1").bind(item.id, loc.id).first();
    if (binUnit) {
      stmts.push(env.DB.prepare('UPDATE stock_units SET qty = qty + ?, received_at = ?, unit_cost = COALESCE(?, unit_cost) WHERE id = ?').bind(qty, at, base.unit_cost, binUnit.id));
      stmts.push(move(env, viewer, { action: 'receive', itemId: item.id, unitId: binUnit.id, unitCode: binUnit.code, qty, to: loc.id, toStatus: 'available', note: `Bin topped up${base.po_ref ? ` · ${base.po_ref}` : ''}` }));
    } else {
      stmts.push(insertUnit(env, { ...base, qty }));
      stmts.push(move(env, viewer, { action: 'receive', itemId: item.id, unitId: 'last', qty, to: loc.id, toStatus: 'available', note: base.po_ref }));
    }
  } else if (item.mode === 'serial') {
    const list = [...serials, ...Array.from({ length: Math.round(qty) - serials.length }, () => null)];
    for (const s of list) {
      if (s && await env.DB.prepare("SELECT id FROM stock_units WHERE item_id = ? AND UPPER(serial) = UPPER(?) AND status != 'gone'").bind(item.id, s).first()) throw bad(`Serial ${s} is already in stock.`);
      stmts.push(insertUnit(env, { ...base, serial: s, qty: 1 }));
      stmts.push(move(env, viewer, { action: 'receive', itemId: item.id, unitId: 'last', lot: base.lot, qty: 1, to: loc.id, toStatus: 'available', note: [s && `Serial ${s}`, base.po_ref].filter(Boolean).join(' · ') || null }));
    }
  } else {
    stmts.push(insertUnit(env, { ...base, qty }));
    stmts.push(move(env, viewer, { action: 'receive', itemId: item.id, unitId: 'last', lot: base.lot, qty, to: loc.id, toStatus: 'available', note: base.po_ref }));
  }
  stmts.push(labelNew(env));
  stmts.push(env.DB.prepare("UPDATE stock_moves SET unit_code = (SELECT code FROM stock_units WHERE id = stock_moves.unit_id) WHERE unit_code IS NULL AND unit_id IS NOT NULL AND action = 'receive'"));
  if (exp) stmts.push(env.DB.prepare("UPDATE stock_expected SET received_qty = received_qty + ?, status = CASE WHEN received_qty + ? + issue_qty >= qty THEN 'received' ELSE status END WHERE id = ?").bind(qty, qty, exp.id));
  if (input.barcode && !item.code?.toUpperCase().includes(String(input.barcode).toUpperCase())) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO stock_aliases (code, item_id, kind) VALUES (?, ?, ?)').bind(String(input.barcode).trim().slice(0, 120), item.id, 'barcode'));
  }
  if (input.makeUsual && !item.usual_location) stmts.push(env.DB.prepare('UPDATE stock_items SET usual_location = ? WHERE id = ?').bind(loc.id, item.id));
  if (num(input.unitCost) != null && canManage(viewer)) stmts.push(env.DB.prepare('UPDATE stock_items SET unit_cost = ? WHERE id = ?').bind(num(input.unitCost), item.id));
  await env.DB.batch(stmts);
  const made = (await env.DB.prepare('SELECT * FROM stock_units WHERE item_id = ? AND received_at = ? ORDER BY id').bind(item.id, at).all()).results || [];
  // Held for the job it was bought for first, then the rest by priority within the team.
  if (exp?.order_id && item.mode !== 'bin') await allocate(env, { orderIds: [exp.order_id], itemIds: [item.id], viewer: SYSTEM });
  await allocate(env, { itemIds: [item.id], viewer: SYSTEM });
  const after = made.length ? (await env.DB.prepare(`SELECT u.*, o.key AS order_key FROM stock_units u LEFT JOIN stock_orders o ON o.id = u.order_id WHERE u.item_id = ? AND u.received_at = ? ORDER BY u.id`).bind(item.id, at).all()).results : [];
  return { ok: true, lot, poRef: base.po_ref, units: after.map((u) => ({ id: u.id, code: u.code, qty: u.qty, serial: u.serial, lot: u.lot, orderKey: u.order_key || null, status: u.status })), item: itemBrief(item), location: loc.code };
}

// Our batch numbers: B, the date, and a running number for the day (B251125-03).
async function nextBatch(env) {
  const d = londonDate().replace(/-/g, '').slice(2);
  const key = `stock_batch_${d}`;
  const n = (Number(await getState(env, key)) || 0) + 1;
  await setState(env, key, String(n));
  return `B${d}-${String(n).padStart(2, '0')}`;
}

// A delivery that's damaged, wrong or not coming: taken off what's expected (and out of stock,
// if it was already in) so the job it was for shows it as needing ordering again.
export async function intakeIssue(env, viewer, input) {
  const reason = text(input.reason, 60) || 'Damaged';
  const note = text(input.note, 500);
  const qty = qtyOf(input.qty);
  const stmts = [];
  let orderKey = null;
  if (num(input.expectedId)) {
    const e = await env.DB.prepare('SELECT e.*, o.key AS order_key FROM stock_expected e LEFT JOIN stock_orders o ON o.id = e.order_id WHERE e.id = ?').bind(num(input.expectedId)).first();
    if (!e) throw bad('That delivery isn\'t on record.', 404);
    orderKey = e.order_key;
    stmts.push(env.DB.prepare("UPDATE stock_expected SET issue_qty = issue_qty + ?, issue_note = ?, status = CASE WHEN received_qty + issue_qty + ? >= qty THEN 'received' ELSE status END WHERE id = ?")
      .bind(qty, [reason, note].filter(Boolean).join(': '), qty, e.id));
    stmts.push(move(env, viewer, { action: 'issue', itemId: e.item_id, qty, orderId: e.order_id, orderKey: e.order_key, note: [reason, note, e.po_ref].filter(Boolean).join(' · ') }));
  } else if (num(input.unitId)) {
    const u = await unitById(env, input.unitId);
    if (!['available', 'reserved', 'quarantine'].includes(u.status)) throw bad('Only stock still on the shelf can be reported like this.');
    const o = u.order_id ? await orderById(env, u.order_id) : null;
    orderKey = o?.key || null;
    stmts.push(...changePart(env, viewer, u, Math.min(qty, u.qty), { status: 'gone', order_id: null }, { action: 'issue', orderId: o?.id, orderKey, note: [reason, note].filter(Boolean).join(': ') }));
  } else throw bad('Choose the delivery or the stock with the problem.');
  await env.DB.batch(stmts);
  return { ok: true, reorderFor: orderKey };
}

// ---------- deliveries expected ----------

export async function expectedList(env) {
  const rows = (await env.DB.prepare(`SELECT e.*, i.name AS item_name, i.code AS item_code, o.key AS order_key FROM stock_expected e JOIN stock_items i ON i.id = e.item_id
    LEFT JOIN stock_orders o ON o.id = e.order_id WHERE e.status = 'open' ORDER BY COALESCE(e.expected_date, '9999'), e.id`).all()).results || [];
  return { expected: rows.map((e) => ({ ...e, due: stillDue(e), late: Boolean(e.expected_date && e.expected_date < today()) })) };
}

export async function expectedSave(env, viewer, input) {
  const item = await itemById(env, input.itemId);
  const qty = qtyOf(input.qty);
  const team = text(input.team, 40);
  let orderId = num(input.orderId);
  if (!orderId && input.autoAssign !== false) orderId = (await assignExpected(env, item.id, team))?.id || null;
  const vals = [item.id, qty, text(input.supplier, 120) || item.supplier, text(input.poRef, 80), isoDay(input.poDate) || today(), isoDay(input.expectedDate) || (item.lead_days ? addDays(today(), item.lead_days) : null),
    team, orderId, num(input.unitCost) ?? item.unit_cost, text(input.note, 300)];
  if (num(input.id)) {
    await env.DB.prepare('UPDATE stock_expected SET item_id = ?, qty = ?, supplier = ?, po_ref = ?, po_date = ?, expected_date = ?, team = ?, order_id = ?, unit_cost = ?, note = ? WHERE id = ?').bind(...vals, num(input.id)).run();
    return { ok: true, id: num(input.id) };
  }
  const row = await env.DB.prepare("INSERT INTO stock_expected (item_id, qty, supplier, po_ref, po_date, expected_date, team, order_id, unit_cost, note, status, received_qty, issue_qty, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, 0, ?, ?) RETURNING id")
    .bind(...vals, nowIso(), whoOf(viewer).name).first();
  await env.DB.batch([move(env, viewer, { action: 'ordered', itemId: item.id, qty, orderId, orderKey: orderId ? (await orderById(env, orderId)).key : null, note: [vals[2], vals[3]].filter(Boolean).join(' · ') || null })]);
  return { ok: true, id: row.id, orderId };
}

export async function expectedRemove(env, viewer, { id }) {
  await env.DB.prepare("UPDATE stock_expected SET status = 'cancelled' WHERE id = ?").bind(Number(id)).run();
  return { ok: true };
}

// What to buy, by supplier: each job's shortfall that isn't already on its way, plus items
// running low against their minimum or their usage over the time they take to arrive.
export async function buyList(env, viewer) {
  const all = await loadAll(env);
  const day = today();
  const lines = new Map();
  const add = (item, qty, why, orderRow = null) => {
    const key = `${item.id}|${orderRow ? teamKey(orderRow.team) || '' : ''}`;
    if (!lines.has(key)) lines.set(key, { item: itemBrief(item), team: orderRow ? teamKey(orderRow.team) : null, qty: 0, orders: [], reasons: [], priority: 'Low' });
    const l = lines.get(key);
    l.qty += qty;
    if (orderRow) {
      const p = priorityOf(orderRow, day);
      l.orders.push({ id: orderRow.id, key: orderRow.key, qty, priority: p });
      if (RANK[p] < RANK[l.priority]) l.priority = p;
    }
    if (why && !l.reasons.includes(why)) l.reasons.push(why);
  };
  for (const o of rankOrders(all.orders.filter((x) => x.status === 'open'), day)) {
    for (const l of needLines(o, all, day)) if (l.item && !l.merged && l.toOrder > 0) add(all.items.get(l.item.id), l.toOrder, null, o);
  }
  const unknown = [];
  for (const o of all.orders.filter((x) => x.status === 'open')) for (const l of needLines(o, all, day)) if (l.state === 'unknown') unknown.push({ orderId: o.id, key: o.key, text: l.text, qty: l.qty });
  // Usage over the last 90 days, for reorder points.
  const since = addDays(day, -90);
  const used = new Map(((await env.DB.prepare("SELECT item_id, SUM(qty) AS q FROM stock_moves WHERE action IN ('consume', 'bin-take') AND at >= ? GROUP BY item_id").bind(since).all()).results || []).map((r) => [r.item_id, r.q || 0]));
  for (const item of all.items.values()) {
    if (!item.active) continue;
    const avail = all.units.filter((u) => u.item_id === item.id && u.status === 'available' && !u.order_id).reduce((s, u) => s + u.qty, 0);
    const coming = all.expected.filter((e) => e.item_id === item.id && !e.order_id).reduce((s, e) => s + stillDue(e), 0);
    const daily = (used.get(item.id) || 0) / 90;
    const point = (item.min_qty || 0) + daily * (item.lead_days || 7);
    const already = [...lines.values()].filter((l) => l.item.id === item.id).reduce((s, l) => s + l.qty, 0);
    if ((item.two_bin || item.min_qty != null || daily > 0) && avail + coming - already <= point && (point > 0 || item.two_bin)) {
      const suggested = Math.max(item.reorder_qty || 0, Math.ceil(point * 2 - (avail + coming)), 1);
      add(item, suggested, item.two_bin ? 'Bin running low' : daily > 0 ? `Usual use is about ${Math.round(daily * 7 * 10) / 10} a week` : 'Below its minimum');
    }
  }
  const bySupplier = new Map();
  for (const l of lines.values()) {
    const s = l.item.supplier || 'No supplier set';
    if (!bySupplier.has(s)) bySupplier.set(s, []);
    l.qty = Math.round(l.qty * 1000) / 1000;
    l.cost = l.item.unit_cost != null ? Math.round(l.qty * l.item.unit_cost * 100) / 100 : null;
    bySupplier.get(s).push(l);
  }
  const suppliers = [...bySupplier].map(([supplier, ls]) => ({ supplier, lines: ls.sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.item.name.localeCompare(b.item.name)),
    cost: ls.every((l) => l.cost != null) ? Math.round(ls.reduce((s, l) => s + l.cost, 0) * 100) / 100 : null }))
    .sort((a, b) => Math.min(...a.lines.map((l) => RANK[l.priority])) - Math.min(...b.lines.map((l) => RANK[l.priority])) || a.supplier.localeCompare(b.supplier));
  return { suppliers, unknown };
}

// Ordering what's on the list: each job's share becomes an expected delivery held for that job.
export async function markOrdered(env, viewer, input) {
  const lines = Array.isArray(input.lines) ? input.lines.slice(0, 200) : [];
  if (!lines.length) throw bad('Choose what was ordered.');
  const made = [];
  for (const l of lines) {
    const base = { itemId: l.itemId, supplier: input.supplier, poRef: input.poRef, expectedDate: input.expectedDate, unitCost: l.unitCost, autoAssign: false };
    let left = qtyOf(l.qty);
    for (const o of Array.isArray(l.orders) ? l.orders : []) {
      if (left <= 0) break;
      const q = Math.min(left, num(o.qty, 0));
      if (q <= 0) continue;
      const ord = await orderById(env, o.id);
      made.push(await expectedSave(env, viewer, { ...base, qty: q, orderId: ord.id, team: ord.team }));
      left -= q;
    }
    if (left > 1e-9) made.push(await expectedSave(env, viewer, { ...base, qty: left, team: l.team || null }));
  }
  return { ok: true, made: made.length };
}

// ---------- work order requirements ----------

async function openOrder(env, id) {
  const o = await orderById(env, id);
  if (o.status === 'complete') throw bad('That work order is Hardware complete. A team lead can reopen it.');
  return o;
}

export async function needAdd(env, viewer, input) {
  const o = await openOrder(env, input.orderId);
  const itemId = num(input.itemId);
  if (itemId) await itemById(env, itemId);
  const t = text(input.text, 300);
  if (!itemId && !t) throw bad('Choose a stock item.');
  await env.DB.prepare('INSERT INTO stock_needs (order_id, item_id, text, qty, source, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(o.id, itemId || await matchItem(env, t), t, qtyOf(input.qty ?? 1), 'manual', nowIso(), whoOf(viewer).name).run();
  if (o.status === 'open') await allocate(env, { orderIds: [o.id], viewer });
  return { ok: true };
}

export async function needSet(env, viewer, input) {
  const n = await env.DB.prepare('SELECT * FROM stock_needs WHERE id = ? AND deleted_at IS NULL').bind(num(input.id)).first();
  if (!n) throw bad('That line isn\'t on record.', 404);
  const o = await openOrder(env, n.order_id);
  // Deleting keeps the line, with who, when and why, so it can be put back. A line read from Jira
  // stays deleted when Jira is read again.
  if (input.remove) {
    const reason = text(input.reason, 500);
    if (!reason) throw bad('Say why this stock is no longer required for the order.');
    await env.DB.batch([env.DB.prepare("UPDATE stock_needs SET deleted_at = ?, deleted_by = ?, delete_reason = ?, source = CASE WHEN source = 'jira' THEN 'jira-edited' ELSE source END WHERE id = ?")
      .bind(nowIso(), whoOf(viewer).name, reason, n.id),
      move(env, viewer, { action: 'need-deleted', itemId: n.item_id, qty: n.qty, orderId: o.id, orderKey: o.key, note: `${n.text || ''}: ${reason}` })]);
  }
  else {
    const itemId = input.itemId === undefined ? n.item_id : num(input.itemId);
    if (itemId) await itemById(env, itemId);
    // A line read from Jira and then changed here is kept as changed, rather than read again.
    await env.DB.prepare("UPDATE stock_needs SET qty = ?, item_id = ?, source = CASE WHEN source = 'jira' THEN 'jira-edited' ELSE source END WHERE id = ?")
      .bind(input.qty === undefined ? n.qty : qtyOf(input.qty), itemId, n.id).run();
  }
  if (n.item_id) await releaseExcess(env, o, n.item_id);
  if (o.status === 'open') await allocate(env, { orderIds: [o.id], viewer });
  return { ok: true };
}

// Requirements deleted from work orders, newest first, to put back if deleted by mistake.
export async function needsDeleted(env, viewer) {
  needManage(viewer);
  const rows = (await env.DB.prepare(`SELECT n.*, o.key AS order_key, o.summary AS order_summary, o.customer, i.name AS item_name FROM stock_needs n JOIN stock_orders o ON o.id = n.order_id
    LEFT JOIN stock_items i ON i.id = n.item_id WHERE n.deleted_at IS NOT NULL OR n.source = 'jira-removed' ORDER BY COALESCE(n.deleted_at, n.created_at) DESC LIMIT 200`).all()).results || [];
  return { deleted: rows.map((r) => ({ id: r.id, orderKey: r.order_key, orderSummary: r.order_summary, customer: r.customer, item: r.item_name || r.text, qty: r.qty, by: r.deleted_by, at: r.deleted_at, reason: r.delete_reason })) };
}

export async function needRestore(env, viewer, { id }) {
  needManage(viewer);
  const n = await env.DB.prepare('SELECT * FROM stock_needs WHERE id = ?').bind(Number(id)).first();
  if (!n || (!n.deleted_at && n.source !== 'jira-removed')) throw bad('That line isn\'t deleted.');
  const o = await orderById(env, n.order_id);
  await env.DB.batch([env.DB.prepare("UPDATE stock_needs SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, source = CASE WHEN source = 'jira-removed' THEN 'jira-edited' ELSE source END, qty = CASE WHEN qty = 0 THEN 1 ELSE qty END WHERE id = ?").bind(n.id),
    move(env, viewer, { action: 'need-restored', itemId: n.item_id, qty: n.qty, orderId: o.id, orderKey: o.key, note: n.text })]);
  if (o.status === 'open') await allocate(env, { orderIds: [o.id], viewer });
  return { ok: true };
}

// Extra items for site visits, spares and the like, held against any Jira item.
export async function addManualOrder(env, viewer, { key }) {
  const k = String(key || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(k)) throw bad('Enter a Jira key, such as WYNNL-704.');
  const was = await env.DB.prepare('SELECT id FROM stock_orders WHERE key = ?').bind(k).first();
  if (was) return { ok: true, id: was.id };
  const issue = await getIssue(env, k, ['summary', 'project', 'customfield_14562', 'duedate', 'parent']).catch(() => null);
  if (!issue) throw bad(`${k} wasn't found in Jira.`);
  const { BLOCKED_PROJECTS } = await import('./jira.js');
  if ((BLOCKED_PROJECTS || []).includes(k.split('-')[0])) throw bad('The hub doesn\'t use that project.');
  const f = issue.fields || {};
  const team = Array.isArray(f.customfield_14562) ? f.customfield_14562[0]?.value : f.customfield_14562?.value;
  const row = await env.DB.prepare("INSERT INTO stock_orders (kind, key, epic_key, summary, customer, team, end_date, needed_by, status, subtasks, created_at, created_by) VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, 'open', '[]', ?, ?) RETURNING id")
    .bind(k, f.parent?.key || null, f.summary || '', f.project?.name || null, team || null, f.duedate || null, f.duedate || null, nowIso(), whoOf(viewer).name).first();
  return { ok: true, id: row.id };
}

// ---------- panel defaults ----------

export async function panels(env) {
  const list = (await env.DB.prepare('SELECT * FROM stock_panels ORDER BY name').all()).results || [];
  const rows = (await env.DB.prepare('SELECT p.*, i.name, i.code, i.unit FROM stock_panel_items p JOIN stock_items i ON i.id = p.item_id').all()).results || [];
  return { panels: list.map((p) => ({ ...p, items: rows.filter((r) => r.panel_id === p.id).map((r) => ({ itemId: r.item_id, qty: r.qty, name: r.name, code: r.code, unit: r.unit })) })) };
}

export async function panelSave(env, viewer, input) {
  needManage(viewer);
  const name = text(input.name, 120);
  if (!name) throw bad('Give the panel type a name.');
  const items = (Array.isArray(input.items) ? input.items : []).map((i) => ({ itemId: num(i.itemId), qty: num(i.qty) })).filter((i) => i.itemId && i.qty > 0);
  let id = num(input.id);
  const at = nowIso();
  if (id) await env.DB.prepare('UPDATE stock_panels SET name = ?, notes = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(name, text(input.notes, 1000), at, whoOf(viewer).name, id).run();
  else id = (await env.DB.prepare('INSERT INTO stock_panels (name, notes, updated_at, updated_by) VALUES (?, ?, ?, ?) RETURNING id').bind(name, text(input.notes, 1000), at, whoOf(viewer).name).first()).id;
  await env.DB.batch([env.DB.prepare('DELETE FROM stock_panel_items WHERE panel_id = ?').bind(id),
    ...items.map((i) => env.DB.prepare('INSERT OR REPLACE INTO stock_panel_items (panel_id, item_id, qty) VALUES (?, ?, ?)').bind(id, i.itemId, i.qty))]);
  return { ok: true, id };
}

export async function panelRemove(env, viewer, { id }) {
  needManage(viewer);
  await env.DB.batch([env.DB.prepare('DELETE FROM stock_panel_items WHERE panel_id = ?').bind(Number(id)), env.DB.prepare('DELETE FROM stock_panels WHERE id = ?').bind(Number(id))]);
  return { ok: true };
}

// A panel's usual parts added to a work order, times how many panels; then they're edited like any line.
export async function panelApply(env, viewer, { orderId, panelId, count = 1 }) {
  const o = await openOrder(env, orderId);
  const p = (await panels(env)).panels.find((x) => x.id === Number(panelId));
  if (!p) throw bad('That panel type isn\'t on record.', 404);
  const n = Math.max(1, Math.min(50, Math.round(num(count, 1))));
  const at = nowIso();
  await env.DB.batch(p.items.map((i) => env.DB.prepare('INSERT INTO stock_needs (order_id, item_id, text, qty, source, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(o.id, i.itemId, i.name, i.qty * n, `panel:${p.name}`, at, whoOf(viewer).name)));
  if (o.status === 'open') await allocate(env, { orderIds: [o.id], viewer });
  return { ok: true, added: p.items.length };
}

// ---------- priority, holding and moving stock between jobs ----------

export async function setPriority(env, viewer, { orderId, priority }) {
  needLead(viewer);
  const o = await orderById(env, orderId);
  const p = PRIORITIES.includes(priority) ? priority : null;
  await env.DB.prepare('UPDATE stock_orders SET priority_override = ?, priority_by = ? WHERE id = ?').bind(p, p ? whoOf(viewer).name : null, o.id).run();
  await env.DB.batch([move(env, viewer, { action: 'priority', orderId: o.id, orderKey: o.key, note: p ? `Priority set to ${p}` : 'Priority back to the dates' })]);
  return { ok: true, takeFrom: p === 'Emergency' ? (await takeFromPreview(env, o.id)).from : [] };
}

// For an Emergency: stock held for lower-priority jobs of the same team that would cover what's short.
export async function takeFromPreview(env, orderId) {
  const all = await loadAll(env);
  const day = today();
  const o = all.orders.find((x) => x.id === Number(orderId));
  if (!o) throw bad('That work order isn\'t on record.', 404);
  const rank = (x) => RANK[priorityOf(x, day)];
  const from = [];
  for (const l of needLines(o, all, day)) {
    if (!l.item || l.merged || l.item.mode === 'bin') continue;
    let short = l.qty - l.reserved - l.picked - l.consumed - l.free;
    if (short <= 0) continue;
    const donors = rankOrders(all.orders.filter((x) => x.id !== o.id && x.status !== 'complete' && rank(x) >= rank(o) && (!o.team || !x.team || teamKey(x.team) === teamKey(o.team))), day).reverse();
    for (const d of donors) {
      if (short <= 0) break;
      const held = all.units.filter((u) => u.order_id === d.id && u.item_id === l.item.id && u.status === 'reserved');
      const q = Math.min(short, held.reduce((s, u) => s + u.qty, 0));
      if (q > 0) { from.push({ itemId: l.item.id, item: l.item.name, qty: q, fromId: d.id, fromKey: d.key, fromPriority: priorityOf(d, day) }); short -= q; }
    }
  }
  return { from, order: { id: o.id, key: o.key } };
}

export async function takeFrom(env, viewer, { orderId }) {
  needLead(viewer);
  const o = await orderById(env, orderId);
  const { from } = await takeFromPreview(env, o.id);
  // Free stock first, then what's held elsewhere.
  await allocate(env, { orderIds: [o.id], viewer });
  const stmts = [];
  for (const f of from) {
    let left = f.qty;
    const held = (await env.DB.prepare("SELECT * FROM stock_units WHERE order_id = ? AND item_id = ? AND status = 'reserved' ORDER BY qty").bind(f.fromId, f.itemId).all()).results || [];
    for (const u of held) {
      if (left <= 0) break;
      const q = Math.min(left, u.qty);
      stmts.push(...changePart(env, viewer, u, q, { order_id: o.id }, { action: 'reassign', orderId: o.id, orderKey: o.key, to: u.location_id, note: `Taken from ${f.fromKey} for an emergency` }));
      left -= q;
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, moved: from.length };
}

// Moving held stock by hand: to another job, or back to free stock.
export async function reassign(env, viewer, { unitId, qty, toOrderId }) {
  needLead(viewer);
  const u = await unitById(env, unitId);
  if (!['available', 'reserved'].includes(u.status)) throw bad('Only stock on the shelf can be moved to another job.');
  const to = num(toOrderId) ? await openOrder(env, toOrderId) : null;
  const was = u.order_id ? await orderById(env, u.order_id) : null;
  const q = Math.min(u.qty, qty == null ? u.qty : qtyOf(qty));
  await env.DB.batch(changePart(env, viewer, u, q, { order_id: to?.id || null, status: to ? 'reserved' : 'available' },
    { action: 'reassign', orderId: to?.id || null, orderKey: to?.key || null, to: u.location_id, note: was ? `From ${was.key}` : 'From free stock' }));
  if (was?.status === 'open' && !to) await allocate(env, { orderIds: [], viewer });
  return { ok: true };
}

// Holding free stock for an order by hand (consumables or spares for a site visit).
export async function hold(env, viewer, { orderId, itemId, qty }) {
  const o = await openOrder(env, orderId);
  const item = await itemById(env, itemId);
  if (item.mode === 'bin') throw bad('Bins aren\'t held for anyone; take what\'s needed when it\'s needed.');
  let left = qtyOf(qty);
  const team = teamKey(o.team);
  const free = ((await env.DB.prepare("SELECT * FROM stock_units WHERE item_id = ? AND status = 'available' AND order_id IS NULL ORDER BY COALESCE(expiry, '9999'), received_at").bind(item.id).all()).results || [])
    .filter((u) => !u.team || !team || teamKey(u.team) === team);
  const stmts = [];
  for (const u of free) {
    if (left <= 0) break;
    const q = Math.min(left, u.qty);
    stmts.push(...changePart(env, viewer, u, q, { status: 'reserved', order_id: o.id }, { action: 'reserve', orderId: o.id, orderKey: o.key, to: u.location_id, note: 'Held by hand' }));
    left -= q;
  }
  if (!stmts.length) throw bad('There\'s none of that free to hold.');
  await env.DB.batch(stmts);
  const have = (await env.DB.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_needs WHERE order_id = ? AND item_id = ? AND deleted_at IS NULL').bind(o.id, item.id).first()).q;
  const held = (await env.DB.prepare("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_units WHERE order_id = ? AND item_id = ? AND status IN ('reserved', 'picked', 'consumed')").bind(o.id, item.id).first()).q;
  if (held > have) await env.DB.prepare("INSERT INTO stock_needs (order_id, item_id, text, qty, source, created_at, created_by) VALUES (?, ?, ?, ?, 'manual', ?, ?)").bind(o.id, item.id, item.name, held - have, nowIso(), whoOf(viewer).name).run();
  return { ok: true, short: left > 0 ? left : 0 };
}

export async function setOrderStatus(env, viewer, { orderId, status, note }) {
  needLead(viewer);
  const o = await orderById(env, orderId);
  if (!['open', 'paused', 'cancelled'].includes(status)) throw bad('Choose open, paused or cancelled.');
  if (o.status === 'complete') throw bad('Reopen it first.');
  const stmts = [env.DB.prepare('UPDATE stock_orders SET status = ?, note = ? WHERE id = ?').bind(status, text(note, 300), o.id),
    move(env, viewer, { action: 'order-status', orderId: o.id, orderKey: o.key, note: `${status[0].toUpperCase()}${status.slice(1)}${note ? `: ${note}` : ''}` })];
  // Cancelled: what was held goes back to free stock. Anything out on the bench is listed to bring back.
  if (status === 'cancelled') {
    const held = (await env.DB.prepare("SELECT * FROM stock_units WHERE order_id = ? AND status = 'reserved'").bind(o.id).all()).results || [];
    for (const u of held) stmts.push(...changePart(env, viewer, u, u.qty, { status: 'available', order_id: null }, { action: 'release', orderId: o.id, orderKey: o.key, to: u.location_id, note: 'Work order cancelled' }));
  }
  await env.DB.batch(stmts);
  if (status === 'cancelled') await allocate(env, { viewer: SYSTEM });
  if (status === 'open') await allocate(env, { orderIds: [o.id], viewer: SYSTEM });
  return { ok: true };
}

// ---------- picking, bins, returns and quarantine ----------

// A scan on a work order's pick screen. It works out what was scanned: a label on held stock,
// a product barcode, a serial number, or a bin's location.
export async function pick(env, viewer, input) {
  const o = await openOrder(env, input.orderId);
  if (o.status !== 'open') throw bad('That work order is paused or closed.');
  const code = String(input.code || '').trim();
  if (!code) throw bad('Scan a label.');
  const up = code.toUpperCase();
  const at = cleanAt(input.at);
  const items = await itemMap(env);
  const all = await loadAll(env);
  const lines = needLines(o, all);
  const needOf = (itemId) => lines.find((l) => l.item?.id === itemId && !l.merged);

  // A bin, by its location's label or the item's own barcode.
  const loc = await locationByCode(env, code);
  let binItemId = null; let binLoc = loc;
  if (loc) {
    const there = (await env.DB.prepare("SELECT u.* FROM stock_units u JOIN stock_items i ON i.id = u.item_id WHERE u.location_id = ? AND i.mode = 'bin' AND u.status = 'available' AND u.order_id IS NULL").bind(loc.id).all()).results || [];
    const wanted = there.find((u) => needOf(u.item_id)) || there[0];
    if (!wanted) throw bad(`Nothing in ${loc.code} is a bin item. Scan the stock's own label.`);
    binItemId = wanted.item_id;
  }
  let units = [];
  if (!binItemId) {
    units = (await env.DB.prepare("SELECT * FROM stock_units WHERE (UPPER(code) = ? OR UPPER(serial) = ?) AND status IN ('available', 'reserved', 'picked') ORDER BY id").bind(up, up).all()).results || [];
    if (!units.length) {
      const label = parseLabel(code);
      const itemId = label ? await itemForCodes(env, [label.mpn, label.supplierPart, label.gtin]) : await itemForCodes(env, [code]);
      if (!itemId) throw bad(label ? `${label.mpn || label.supplierPart || label.gtin} isn't a stock item yet.` : `${code} isn't a label, barcode or location on record.`, 404);
      if (label?.serial && !input.qty) {
        const bySerial = await env.DB.prepare("SELECT * FROM stock_units WHERE item_id = ? AND UPPER(serial) = UPPER(?) AND status IN ('available', 'reserved', 'picked')").bind(itemId, label.serial).first();
        if (bySerial) units = [bySerial];
      }
      if (items.get(itemId)?.mode === 'bin') binItemId = itemId;
      else if (!units.length) {
        units = (await env.DB.prepare("SELECT * FROM stock_units WHERE item_id = ? AND status IN ('available', 'reserved') ORDER BY CASE WHEN order_id = ? THEN 0 WHEN order_id IS NULL THEN 1 ELSE 2 END, COALESCE(expiry, '9999')").bind(itemId, o.id).all()).results || [];
        if (!units.length) throw bad(`There's no ${items.get(itemId)?.name || 'stock of that'} on the shelf.`);
      }
    }
  }
  if (binItemId) return binScan(env, viewer, o, items.get(binItemId), binLoc, input, needOf(binItemId), at);

  const item = items.get(units[0].item_id);
  if (item.mode === 'bin') return binScan(env, viewer, o, item, null, input, needOf(item.id), at);
  const need = needOf(item.id);
  if (!need) throw bad(`${item.name} isn't on this work order. Add it to the requirements first if it's needed.`, 409);
  const left = need.qty - need.picked - need.consumed;
  if (left <= 1e-9) throw bad(`All the ${item.name} needed is already out.`, 409);
  const mineHeld = units.filter((u) => u.status === 'reserved' && u.order_id === o.id);
  const freeOnes = units.filter((u) => u.status === 'available' && !u.order_id);
  const elsewhere = units.filter((u) => u.status === 'reserved' && u.order_id !== o.id);
  const already = units.filter((u) => u.status === 'picked' && u.order_id === o.id);
  let unit = mineHeld[0] || freeOnes[0];
  if (!unit && already.length && !elsewhere.length) throw bad('That\'s already been picked for this work order.', 409);
  if (!unit && elsewhere.length) {
    const other = await orderById(env, elsewhere[0].order_id);
    if (!input.takeOver) throw bad(`Stock required will take stock from ${other.key}, would you like to continue?`, 409, { confirm: 'takeOver', fromKey: other.key });
    needLead(viewer);
    unit = elsewhere[0];
  }
  if (unit.expiry && unit.expiry < today() && !input.expiredOk) throw bad(`This ran out of date on ${unit.expiry}. Use it anyway?`, 409, { confirm: 'expiredOk' });
  const q = Math.min(unit.qty, left, input.qty != null ? qtyOf(input.qty) : unit.qty);
  const from = unit.order_id && unit.order_id !== o.id ? await orderById(env, unit.order_id) : null;
  await env.DB.batch(changePart(env, viewer, unit, q, { status: 'picked', order_id: o.id, picked_at: at, picked_by: whoOf(viewer).name },
    { action: 'pick', at, orderId: o.id, orderKey: o.key, note: from ? `Taken from ${from.key}` : unit.order_id ? null : 'Was free stock' }));
  // Something else picked in place of what was held: what was held and isn't needed now goes back.
  await releaseExcess(env, o, item.id);
  if (from) await allocate(env, { orderIds: [from.id], viewer: SYSTEM });
  return { ok: true, picked: { item: item.name, qty: q, unit: item.unit, code: unit.code, serial: unit.serial }, remaining: Math.max(0, left - q) };
}

async function releaseExcess(env, o, itemId) {
  const need = (await env.DB.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_needs WHERE order_id = ? AND item_id = ? AND deleted_at IS NULL').bind(o.id, itemId).first()).q;
  const units = (await env.DB.prepare("SELECT * FROM stock_units WHERE order_id = ? AND item_id = ? AND status IN ('reserved', 'picked', 'consumed') ORDER BY CASE status WHEN 'reserved' THEN 1 ELSE 0 END, id").bind(o.id, itemId).all()).results || [];
  let extra = units.reduce((s, u) => s + u.qty, 0) - need;
  const stmts = [];
  for (const u of units.filter((x) => x.status === 'reserved').reverse()) {
    if (extra <= 1e-9) break;
    const q = Math.min(extra, u.qty);
    stmts.push(...changePart(env, SYSTEM, u, q, { status: 'available', order_id: null }, { action: 'release', orderId: o.id, orderKey: o.key, to: u.location_id, note: 'No longer needed: something else was picked' }));
    extra -= q;
  }
  if (stmts.length) { await env.DB.batch(stmts); await allocate(env, { itemIds: [itemId], viewer: SYSTEM }); }
}

const cleanAt = (v) => {
  const t = Date.parse(v || '');
  // Scans made offline keep when they were made, within the last day.
  return Number.isFinite(t) && t <= Date.now() + 60000 && t >= Date.now() - 86400000 ? new Date(t).toISOString() : nowIso();
};

// Bins: a quantity taken for the job; scanned again for the same job, it's either more taken
// ("Required") or some brought back ("Returning").
async function binScan(env, viewer, o, item, loc, input, need, at) {
  const outFor = (await env.DB.prepare("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_units WHERE order_id = ? AND item_id = ? AND status = 'picked'").bind(o.id, item.id).first()).q;
  if (outFor > 0 && !input.binAction) return { ok: true, bin: true, again: true, item: itemBrief(item), out: outFor, location: loc?.code || null };
  if (input.qty == null) return { ok: true, bin: true, askQty: true, item: itemBrief(item), suggested: need ? Math.max(0, need.qty - need.picked - need.consumed) : null, location: loc?.code || null };
  const q = qtyOf(input.qty);
  if (input.binAction === 'return') return binReturn(env, viewer, o, item, loc, q, at);
  const sources = ((await env.DB.prepare("SELECT * FROM stock_units WHERE item_id = ? AND status = 'available' AND order_id IS NULL ORDER BY CASE WHEN location_id = ? THEN 0 ELSE 1 END, qty DESC").bind(item.id, loc?.id ?? -1).all()).results || []);
  const have = sources.reduce((s, u) => s + u.qty, 0);
  if (have < q - 1e-9 && !input.shortOk) throw bad(`The bins show only ${have} ${item.unit}. Take ${q} anyway?`, 409, { confirm: 'shortOk' });
  const stmts = [];
  let left = q;
  for (const u of sources) {
    if (left <= 0) break;
    const take = Math.min(left, u.qty);
    stmts.push(...changePart(env, viewer, u, take, { status: 'picked', order_id: o.id, picked_at: at, picked_by: whoOf(viewer).name }, { action: 'bin-take', at, orderId: o.id, orderKey: o.key }));
    left -= take;
  }
  // More taken than the records showed: the extra is recorded so the bin can be counted.
  if (left > 1e-9) {
    stmts.push(insertUnit(env, { item_id: item.id, qty: left, location_id: loc?.id || null, status: 'picked', order_id: o.id, picked_at: at, picked_by: whoOf(viewer).name, received_at: at, note: 'Taken beyond what the bin showed' }));
    stmts.push(move(env, viewer, { action: 'bin-take', at, itemId: item.id, unitId: 'last', qty: left, orderId: o.id, orderKey: o.key, toStatus: 'picked', note: 'More than the bin showed; count this bin' }));
    stmts.push(labelNew(env));
  }
  await env.DB.batch(stmts);
  return { ok: true, picked: { item: item.name, qty: q, unit: item.unit } };
}

async function binReturn(env, viewer, o, item, loc, q, at) {
  const out = (await env.DB.prepare("SELECT * FROM stock_units WHERE order_id = ? AND item_id = ? AND status = 'picked' ORDER BY id DESC").bind(o.id, item.id).all()).results || [];
  const total = out.reduce((s, u) => s + u.qty, 0);
  if (q > total + 1e-9) throw bad(`Only ${total} ${item.unit} went out for this work order.`);
  const target = loc || (await env.DB.prepare("SELECT location_id AS id FROM stock_units WHERE item_id = ? AND status = 'available' AND location_id IS NOT NULL LIMIT 1").bind(item.id).first());
  const stmts = [];
  let left = q;
  for (const u of out) {
    if (left <= 0) break;
    const back = Math.min(left, u.qty);
    stmts.push(...changePart(env, viewer, u, back, { status: 'available', order_id: null, location_id: target?.id || u.location_id, picked_at: null, picked_by: null }, { action: 'bin-return', at, orderId: o.id, orderKey: o.key, to: target?.id || u.location_id }));
    left -= back;
  }
  await env.DB.batch(stmts);
  return { ok: true, returned: { item: item.name, qty: q, unit: item.unit } };
}

// Bringing picked stock back to a shelf. Back to being held for the job, unless the job's been
// cancelled (or it's asked for), when it goes back to free stock. After Hardware complete only a
// team lead can bring something back.
export async function giveBack(env, viewer, input) {
  const u = await unitById(env, input.unitId);
  const loc = input.location ? await locationByCode(env, input.location) : null;
  if (input.location && !loc) throw bad('That location isn\'t on record.');
  const o = u.order_id ? await orderById(env, u.order_id) : null;
  const q = Math.min(u.qty, input.qty == null ? u.qty : qtyOf(input.qty));
  if (u.status === 'consumed') {
    needLead(viewer);
    const reason = text(input.reason, 300);
    if (!reason) throw bad('Say why it\'s coming back after Hardware complete.');
    await env.DB.batch(changePart(env, viewer, u, q, { status: 'available', order_id: null, location_id: loc?.id || u.location_id, consumed_at: null },
      { action: 'return-override', orderId: o?.id, orderKey: o?.key, to: loc?.id || u.location_id, note: reason }));
    await allocate(env, { itemIds: [u.item_id], viewer: SYSTEM });
    return { ok: true };
  }
  if (u.status !== 'picked') throw bad('That isn\'t out on a job.');
  const free = input.release || !o || o.status === 'cancelled' || o.status === 'closed';
  await env.DB.batch(changePart(env, viewer, u, q, { status: free ? 'available' : 'reserved', order_id: free ? null : o.id, location_id: loc?.id || u.location_id, picked_at: null, picked_by: null },
    { action: 'return', at: cleanAt(input.at), orderId: o?.id, orderKey: o?.key, to: loc?.id || u.location_id, note: free ? 'Back to free stock' : 'Still held for the job' }));
  if (free) await allocate(env, { itemIds: [u.item_id], viewer: SYSTEM });
  return { ok: true };
}

// Damaged or suspect: put aside, and no longer counted for the job, which then needs it again.
export async function quarantine(env, viewer, input) {
  const u = await unitById(env, input.unitId);
  if (!['available', 'reserved', 'picked'].includes(u.status)) throw bad('Only stock on the shelf or out on a job can be put aside.');
  const reason = text(input.reason, 300);
  if (!reason) throw bad('Say what\'s wrong with it.');
  const loc = input.location ? await locationByCode(env, input.location) : await env.DB.prepare('SELECT * FROM stock_locations WHERE quarantine = 1 AND active = 1 LIMIT 1').first();
  const o = u.order_id ? await orderById(env, u.order_id) : null;
  const q = Math.min(u.qty, input.qty == null ? u.qty : qtyOf(input.qty));
  await env.DB.batch(changePart(env, viewer, u, q, { status: 'quarantine', order_id: null, location_id: loc?.id || u.location_id, picked_at: null, picked_by: null },
    { action: 'quarantine', orderId: o?.id, orderKey: o?.key, to: loc?.id || u.location_id, note: reason }));
  if (o?.status === 'open') await allocate(env, { orderIds: [o.id], viewer: SYSTEM });
  return { ok: true, reorderFor: o?.key || null };
}

export async function releaseQuarantine(env, viewer, { unitId, to, note }) {
  needManage(viewer);
  const u = await unitById(env, unitId);
  if (u.status !== 'quarantine') throw bad('That isn\'t in quarantine.');
  const ok = to === 'available';
  await env.DB.batch(changePart(env, viewer, u, u.qty, { status: ok ? 'available' : 'gone' }, { action: ok ? 'release' : 'write-off', to: u.location_id, note: text(note, 300) || (ok ? 'Checked and fine' : 'Written off') }));
  if (ok) await allocate(env, { itemIds: [u.item_id], viewer: SYSTEM });
  return { ok: true };
}

// Moving stock from one place to another, with nothing else about it changing.
export async function relocate(env, viewer, { unitId, qty, location }) {
  const u = await unitById(env, unitId);
  if (!['available', 'reserved', 'quarantine'].includes(u.status)) throw bad('Only stock on a shelf can be moved.');
  const loc = await locationByCode(env, location);
  if (!loc) throw bad('Scan where it\'s going.');
  const q = Math.min(u.qty, qty == null ? u.qty : qtyOf(qty));
  await env.DB.batch(changePart(env, viewer, u, q, { location_id: loc.id }, { action: 'relocate', orderId: u.order_id, from: u.location_id, to: loc.id }));
  return { ok: true };
}

// ---------- Hardware complete ----------

// Everything out on the bench for the job is used. With Jira moves on, the Purchase Order and
// Build items are closed and Testing & Configuration started.
export async function complete(env, viewer, { orderId, force = false, reason = '' }) {
  const all = await loadAll(env);
  const o = all.orders.find((x) => x.id === Number(orderId));
  if (!o) throw bad('That work order isn\'t on record.', 404);
  if (o.status === 'complete') throw bad('It\'s already Hardware complete.');
  const lines = needLines(o, all);
  if (!allOut(lines)) {
    if (!force) throw bad('Not everything needed has been scanned out yet.', 409);
    needLead(viewer);
    if (!text(reason)) throw bad('Say why it\'s complete without everything scanned out.');
  }
  const at = nowIso();
  const picked = all.units.filter((u) => u.order_id === o.id && u.status === 'picked');
  const stmts = [];
  for (const u of picked) stmts.push(...changePart(env, viewer, u, u.qty, { status: 'consumed', consumed_at: at }, { action: 'consume', orderId: o.id, orderKey: o.key }));
  // Held but never picked goes back to free stock.
  for (const u of all.units.filter((x) => x.order_id === o.id && x.status === 'reserved')) stmts.push(...changePart(env, viewer, u, u.qty, { status: 'available', order_id: null }, { action: 'release', orderId: o.id, orderKey: o.key, note: 'Not used by the job' }));
  stmts.push(env.DB.prepare("UPDATE stock_orders SET status = 'complete', completed_at = ?, completed_by = ?, note = ? WHERE id = ?").bind(at, whoOf(viewer).name, force ? text(reason) : o.note, o.id));
  stmts.push(move(env, viewer, { action: 'complete', orderId: o.id, orderKey: o.key, note: force ? `Hardware complete without everything scanned out: ${text(reason)}` : 'Hardware complete' }));
  await env.DB.batch(stmts);
  await allocate(env, { viewer: SYSTEM });
  const jiraOn = (await getState(env, 'stock_jira_moves')) === 'on';
  const plan = jiraPlan(o);
  const results = jiraOn ? await moveInJira(env, plan) : plan.map((p) => ({ ...p, done: false, skipped: 'Jira moves are off' }));
  return { ok: true, consumed: picked.length, jira: { on: jiraOn, moves: results } };
}

function jiraPlan(o) {
  const subs = JSON.parse(o.subtasks || '[]');
  const out = [];
  for (const s of subs) {
    if ((s.role === 'po' || s.role === 'build') && s.cat !== 'done') out.push({ key: s.key, summary: s.summary, to: 'Done' });
  }
  const test = subs.find((s) => s.role === 'test');
  if (test && test.cat === 'new') out.push({ key: test.key, summary: test.summary, to: 'In Progress' });
  return out;
}

async function moveInJira(env, plan) {
  const out = [];
  for (const p of plan) {
    try {
      const { transitions = [] } = (await jira(env, `/rest/api/3/issue/${encodeURIComponent(p.key)}/transitions`)) || {};
      const t = p.to === 'Done' ? transitions.find((x) => x.to?.statusCategory?.key === 'done' && /done|complete|closed/i.test(x.to?.name || x.name)) || transitions.find((x) => x.to?.statusCategory?.key === 'done')
        : transitions.find((x) => /in progress/i.test(x.to?.name || x.name)) || transitions.find((x) => x.to?.statusCategory?.key === 'indeterminate');
      if (!t) { out.push({ ...p, done: false, skipped: 'Jira doesn\'t offer that move from where it is' }); continue; }
      if (t.to?.statusCategory?.key === 'done') await (await import('./docs.js')).mustAllowDone(env, p.key);
      await jira(env, `/rest/api/3/issue/${encodeURIComponent(p.key)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: String(t.id) } }) });
      out.push({ ...p, done: true, status: t.to?.name || t.name });
    } catch (err) { out.push({ ...p, done: false, skipped: err.message }); }
  }
  return out;
}

export async function reopen(env, viewer, { orderId }) {
  needLead(viewer);
  const o = await orderById(env, orderId);
  if (o.status !== 'complete') throw bad('It isn\'t Hardware complete.');
  await env.DB.batch([env.DB.prepare("UPDATE stock_orders SET status = 'open', completed_at = NULL, completed_by = NULL WHERE id = ?").bind(o.id),
    move(env, viewer, { action: 'reopen', orderId: o.id, orderKey: o.key, note: 'Reopened; used stock stays used until brought back' })]);
  return { ok: true };
}

// ---------- stock checks ----------

export async function plans(env) {
  const list = (await env.DB.prepare('SELECT * FROM stock_plans WHERE active = 1 ORDER BY COALESCE(next_due, \'9999\'), name').all()).results || [];
  return { plans: list.map((p) => ({ ...p, areas: JSON.parse(p.areas || '[]'), due: Boolean(p.next_due && p.next_due <= today()) })) };
}

export async function planSave(env, viewer, input) {
  needManage(viewer);
  const name = text(input.name, 120);
  if (!name) throw bad('Give the check a name, such as "Shelves A weekly".');
  const areas = (Array.isArray(input.areas) ? input.areas : []).map((a) => String(a).trim()).filter(Boolean).slice(0, 50);
  const every = Math.max(1, Math.min(365, Math.round(num(input.every_days, 30))));
  const next = isoDay(input.next_due) || today();
  if (num(input.id)) await env.DB.prepare('UPDATE stock_plans SET name = ?, areas = ?, every_days = ?, next_due = ? WHERE id = ?').bind(name, JSON.stringify(areas), every, next, num(input.id)).run();
  else await env.DB.prepare('INSERT INTO stock_plans (name, areas, every_days, next_due, active) VALUES (?, ?, ?, ?, 1)').bind(name, JSON.stringify(areas), every, next).run();
  return { ok: true };
}

export async function planRemove(env, viewer, { id }) {
  needManage(viewer);
  await env.DB.prepare('UPDATE stock_plans SET active = 0 WHERE id = ?').bind(Number(id)).run();
  return { ok: true };
}

export async function checks(env) {
  const list = (await env.DB.prepare('SELECT * FROM stock_checks ORDER BY id DESC LIMIT 40').all()).results || [];
  const prog = (await env.DB.prepare('SELECT check_id, COUNT(*) AS n, SUM(CASE WHEN done_at IS NOT NULL THEN 1 ELSE 0 END) AS done FROM stock_check_locations GROUP BY check_id').all()).results || [];
  const by = new Map(prog.map((p) => [p.check_id, p]));
  return { checks: list.map((c) => ({ ...c, areas: JSON.parse(c.areas || '[]'), locations: by.get(c.id)?.n || 0, done: by.get(c.id)?.done || 0 })), ...(await plans(env)) };
}

// A count across some areas (or all of them). Everyone counting sees which places are done.
export async function checkStart(env, viewer, input) {
  const plan = num(input.planId) ? await env.DB.prepare('SELECT * FROM stock_plans WHERE id = ?').bind(num(input.planId)).first() : null;
  const areas = plan ? JSON.parse(plan.areas || '[]') : (Array.isArray(input.areas) ? input.areas : []).filter(Boolean);
  const locs = ((await env.DB.prepare('SELECT id, area FROM stock_locations WHERE active = 1').all()).results || []).filter((l) => !areas.length || areas.includes(l.area));
  if (!locs.length) throw bad('There are no locations in those areas.');
  const open = await env.DB.prepare("SELECT id FROM stock_checks WHERE status = 'open' AND COALESCE(plan_id, 0) = ? AND areas = ?").bind(plan?.id || 0, JSON.stringify(areas)).first();
  if (open) return { ok: true, id: open.id };
  const at = nowIso();
  const id = (await env.DB.prepare("INSERT INTO stock_checks (plan_id, name, areas, status, started_at, started_by) VALUES (?, ?, ?, 'open', ?, ?) RETURNING id")
    .bind(plan?.id || null, text(input.name, 120) || plan?.name || (areas.length ? `Count of ${areas.join(', ')}` : 'Full count'), JSON.stringify(areas), at, whoOf(viewer).name).first()).id;
  await env.DB.batch(locs.map((l) => env.DB.prepare('INSERT INTO stock_check_locations (check_id, location_id) VALUES (?, ?)').bind(id, l.id)));
  if (plan) await env.DB.prepare('UPDATE stock_plans SET next_due = ? WHERE id = ?').bind(addDays(today(), plan.every_days), plan.id).run();
  return { ok: true, id };
}

// What's expected at each place, from the records: stock on the shelf, held or not.
async function expectedAt(env, locationId) {
  return (await env.DB.prepare("SELECT item_id, SUM(qty) AS qty FROM stock_units WHERE location_id = ? AND status IN ('available', 'reserved', 'quarantine') GROUP BY item_id").bind(locationId).all()).results || [];
}

export async function checkView(env, viewer, id, { withExpected = false } = {}) {
  const c = await env.DB.prepare('SELECT * FROM stock_checks WHERE id = ?').bind(Number(id)).first();
  if (!c) throw bad('That stock check isn\'t on record.', 404);
  const locs = (await env.DB.prepare('SELECT cl.*, l.code, l.area, l.level FROM stock_check_locations cl JOIN stock_locations l ON l.id = cl.location_id WHERE cl.check_id = ? ORDER BY l.area, l.code').bind(c.id).all()).results || [];
  const counts = (await env.DB.prepare('SELECT sc.*, i.name, i.code, i.unit, i.unit_cost FROM stock_counts sc JOIN stock_items i ON i.id = sc.item_id WHERE sc.check_id = ?').bind(c.id).all()).results || [];
  // Counts are blind while the check is open: the expected numbers only show once it's finished.
  const reveal = c.status !== 'open' || withExpected;
  const rows = counts.map((r) => ({ locationId: r.location_id, itemId: r.item_id, name: r.name, code: r.code, unit: r.unit, counted: r.counted, countedBy: r.counted_by, countedAt: r.counted_at,
    ...(reveal ? { expected: r.expected, variance: Math.round(((r.counted || 0) - (r.expected || 0)) * 1000) / 1000, value: r.unit_cost != null ? Math.round(((r.counted || 0) - (r.expected || 0)) * r.unit_cost * 100) / 100 : null } : {}) }));
  const byLoc = locs.map((l) => {
    const mine = rows.filter((r) => r.locationId === l.location_id);
    return { id: l.location_id, code: l.code, area: l.area, doneBy: l.done_by, doneAt: l.done_at, items: mine.length,
      ...(reveal ? { variance: Math.round(mine.reduce((s, r) => s + Math.abs(r.variance || 0), 0) * 1000) / 1000, off: mine.filter((r) => Math.abs(r.variance || 0) > 1e-9).length } : {}) };
  });
  return { check: { ...c, areas: JSON.parse(c.areas || '[]') }, locations: byLoc, counts: rows, revealed: reveal,
    totals: reveal ? { lines: rows.length, off: rows.filter((r) => Math.abs(r.variance) > 1e-9).length, units: Math.round(rows.reduce((s, r) => s + (r.variance || 0), 0) * 1000) / 1000,
      value: Math.round(rows.reduce((s, r) => s + (r.value || 0), 0) * 100) / 100 } : null, canManage: canManage(viewer) };
}

// Counting one place: what the records say is there, by name only (no quantities).
export async function checkLocation(env, viewer, { checkId, location }) {
  const c = await env.DB.prepare('SELECT * FROM stock_checks WHERE id = ?').bind(Number(checkId)).first();
  if (!c || c.status !== 'open') throw bad('That stock check isn\'t open.');
  const loc = await locationByCode(env, location);
  if (!loc) throw bad('That location isn\'t on record.');
  const inCheck = await env.DB.prepare('SELECT * FROM stock_check_locations WHERE check_id = ? AND location_id = ?').bind(c.id, loc.id).first();
  if (!inCheck) throw bad(`${loc.code} isn't part of this check.`);
  const items = await itemMap(env);
  const there = await expectedAt(env, loc.id);
  const counted = (await env.DB.prepare('SELECT item_id, counted FROM stock_counts WHERE check_id = ? AND location_id = ?').bind(c.id, loc.id).all()).results || [];
  const ids = [...new Set([...there.map((t) => t.item_id), ...counted.map((x) => x.item_id)])];
  return { location: { id: loc.id, code: loc.code, area: loc.area }, done: Boolean(inCheck.done_at), doneBy: inCheck.done_by,
    items: ids.map((id) => ({ id, name: items.get(id)?.name, code: items.get(id)?.code, unit: items.get(id)?.unit, counted: counted.find((x) => x.item_id === id)?.counted ?? null })) };
}

export async function checkCount(env, viewer, input) {
  const c = await env.DB.prepare('SELECT * FROM stock_checks WHERE id = ?').bind(num(input.checkId)).first();
  if (!c || c.status !== 'open') throw bad('That stock check isn\'t open.');
  const locId = num(input.locationId);
  const inCheck = await env.DB.prepare('SELECT * FROM stock_check_locations WHERE check_id = ? AND location_id = ?').bind(c.id, locId).first();
  if (!inCheck) throw bad('That place isn\'t part of this check.');
  const there = new Map((await expectedAt(env, locId)).map((t) => [t.item_id, t.qty]));
  const at = cleanAt(input.at);
  const w = whoOf(viewer).name;
  const stmts = [];
  for (const r of (Array.isArray(input.counts) ? input.counts : []).slice(0, 200)) {
    const itemId = num(r.itemId);
    const counted = num(r.counted);
    if (!itemId || counted == null || counted < 0) continue;
    stmts.push(env.DB.prepare(`INSERT INTO stock_counts (check_id, location_id, item_id, expected, counted, counted_by, counted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(check_id, location_id, item_id) DO UPDATE SET expected = excluded.expected, counted = excluded.counted, counted_by = excluded.counted_by, counted_at = excluded.counted_at`)
      .bind(c.id, locId, itemId, there.get(itemId) || 0, counted, w, at));
  }
  // Anything the records have here that wasn't counted is counted as none.
  if (input.done) {
    const sent = new Set((input.counts || []).map((r) => num(r.itemId)));
    for (const [itemId, q] of there) if (!sent.has(itemId)) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO stock_counts (check_id, location_id, item_id, expected, counted, counted_by, counted_at) VALUES (?, ?, ?, ?, 0, ?, ?)').bind(c.id, locId, itemId, q, w, at));
    stmts.push(env.DB.prepare('UPDATE stock_check_locations SET done_by = ?, done_at = ? WHERE check_id = ? AND location_id = ?').bind(w, at, c.id, locId));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true };
}

export async function checkFinish(env, viewer, { id }) {
  const c = await env.DB.prepare('SELECT * FROM stock_checks WHERE id = ?').bind(Number(id)).first();
  if (!c || c.status !== 'open') throw bad('That stock check isn\'t open.');
  await env.DB.prepare("UPDATE stock_checks SET status = 'finished', finished_at = ? WHERE id = ?").bind(nowIso(), c.id).run();
  return { ok: true };
}

// The counts become the records: shortfalls come off free stock first, then held stock; extra is
// added as free stock found in the count.
export async function checkApply(env, viewer, { id }) {
  needManage(viewer);
  const c = await env.DB.prepare('SELECT * FROM stock_checks WHERE id = ?').bind(Number(id)).first();
  if (!c || c.status !== 'finished') throw bad('Finish the check before applying it.');
  const counts = (await env.DB.prepare('SELECT * FROM stock_counts WHERE check_id = ?').bind(c.id).all()).results || [];
  const at = nowIso();
  const stmts = [];
  let changed = 0;
  for (const r of counts) {
    const now = (await env.DB.prepare("SELECT * FROM stock_units WHERE location_id = ? AND item_id = ? AND status IN ('available', 'reserved', 'quarantine') ORDER BY CASE status WHEN 'available' THEN 0 WHEN 'quarantine' THEN 1 ELSE 2 END, received_at DESC").bind(r.location_id, r.item_id).all()).results || [];
    const have = now.reduce((s, u) => s + u.qty, 0);
    let diff = r.counted - have;
    if (Math.abs(diff) < 1e-9) continue;
    changed++;
    if (diff > 0) {
      const ref = now[0] || {};
      stmts.push(insertUnit(env, { item_id: r.item_id, qty: diff, location_id: r.location_id, status: 'available', received_at: at, received_by: whoOf(viewer).name, unit_cost: ref.unit_cost ?? null, lot: ref.lot ?? null, note: `Found in ${c.name}` }));
      stmts.push(move(env, viewer, { action: 'count-adjust', itemId: r.item_id, unitId: 'last', qty: diff, to: r.location_id, toStatus: 'available', note: `${c.name}: counted ${r.counted}, records had ${have}` }));
      stmts.push(labelNew(env));
    } else {
      for (const u of now) {
        if (diff >= -1e-9) break;
        const off = Math.min(-diff, u.qty);
        stmts.push(...changePart(env, viewer, u, off, { status: 'gone', order_id: null }, { action: 'count-adjust', orderId: u.order_id, note: `${c.name}: counted ${r.counted}, records had ${have}` }));
        diff += off;
      }
    }
  }
  stmts.push(env.DB.prepare("UPDATE stock_checks SET status = 'applied', applied_at = ?, applied_by = ? WHERE id = ?").bind(at, whoOf(viewer).name, c.id));
  await env.DB.batch(stmts);
  await allocate(env, { viewer: SYSTEM });
  return { ok: true, changed };
}

// Reminders for counts that are due, once a day, to whoever manages stock.
export async function checkReminders(env) {
  const due = (await plans(env)).plans.filter((p) => p.due);
  if (!due.length) return { due: 0 };
  const { results } = await env.DB.prepare("SELECT email, groups FROM employees WHERE active = 1 AND email IS NOT NULL").all();
  const devs = (results || []).filter((e) => /"developer"/.test(e.groups || ''));
  for (const e of devs) {
    await raiseAlert(env, { kind: 'stock-check', dedupe: `stock-check:${today()}:${e.email}`, recipient: e.email, link: '#/stock?tab=checks',
      subject: due.length === 1 ? `Stock check due: ${due[0].name}` : `${due.length} stock checks due`,
      body: `${due.map((p) => `• ${p.name}${p.areas.length ? ` (${p.areas.join(', ')})` : ''}, due ${p.next_due}`).join('\n')}\n\nStart them from Stock → Checks.` });
  }
  return { due: due.length };
}

// ---------- tracing ----------

export async function trace(env, viewer, input = {}) {
  const where = ['1 = 1']; const binds = [];
  const q = String(input.q || '').trim();
  if (q) {
    const like = `%${likeTerm(q)}%`;
    where.push(`(LOWER(COALESCE(u.code, '')) LIKE ? OR LOWER(COALESCE(u.serial, '')) LIKE ? OR LOWER(COALESCE(u.lot, '')) LIKE ? OR LOWER(COALESCE(u.supplier_lot, '')) LIKE ? OR LOWER(i.name) LIKE ? OR LOWER(COALESCE(i.code, '')) LIKE ? OR LOWER(COALESCE(u.po_ref, '')) LIKE ?
      OR u.id IN (SELECT m.unit_id FROM stock_moves m WHERE LOWER(COALESCE(m.order_key, '')) LIKE ?))`);
    binds.push(like, like, like, like, like, like, like, like);
  }
  if (num(input.itemId)) { where.push('u.item_id = ?'); binds.push(num(input.itemId)); }
  if (input.lot) { where.push('(LOWER(COALESCE(u.lot, \'\')) = LOWER(?) OR LOWER(COALESCE(u.supplier_lot, \'\')) = LOWER(?))'); binds.push(String(input.lot), String(input.lot)); }
  if (input.status) { where.push('u.status = ?'); binds.push(String(input.status)); }
  if (input.supplier) { where.push('LOWER(COALESCE(u.supplier, \'\')) LIKE ?'); binds.push(`%${likeTerm(input.supplier)}%`); }
  if (input.customer) { where.push('u.id IN (SELECT m.unit_id FROM stock_moves m JOIN stock_orders o ON o.id = m.order_id WHERE LOWER(COALESCE(o.customer, \'\')) LIKE ?)'); binds.push(`%${likeTerm(input.customer)}%`); }
  if (input.orderKey) { where.push('u.id IN (SELECT m.unit_id FROM stock_moves m WHERE UPPER(m.order_key) = UPPER(?))'); binds.push(String(input.orderKey)); }
  if (isoDay(input.from)) { where.push('u.received_at >= ?'); binds.push(isoDay(input.from)); }
  if (isoDay(input.to)) { where.push('u.received_at <= ?'); binds.push(`${isoDay(input.to)}T23:59:59`); }
  if (input.expiring) { where.push("u.expiry IS NOT NULL AND u.expiry <= ? AND u.status IN ('available', 'reserved')"); binds.push(addDays(today(), EXPIRY_WARN_DAYS)); }
  const rows = (await env.DB.prepare(`SELECT u.*, o.key AS order_key, o.customer FROM stock_units u JOIN stock_items i ON i.id = u.item_id LEFT JOIN stock_orders o ON o.id = u.order_id
    WHERE ${where.join(' AND ')} ORDER BY u.id DESC LIMIT 300`).bind(...binds).all()).results || [];
  const items = await itemMap(env); const locs = await locationMap(env);
  return { units: rows.map((u) => ({ ...unitBrief(u, items, locs), orderKey: u.order_key, customer: u.customer })) };
}

export async function unitHistory(env, viewer, id) {
  const u = await unitById(env, id);
  const items = await itemMap(env); const locs = await locationMap(env);
  // Its own moves, and those of the unit it was split from (same label) before the split.
  const moves = (await env.DB.prepare('SELECT * FROM stock_moves WHERE unit_id = ? OR (unit_code = ? AND unit_code IS NOT NULL AND at <= (SELECT MIN(at) FROM stock_moves WHERE unit_id = ?)) ORDER BY at, id').bind(u.id, u.code, u.id).all()).results || [];
  const orders = (await env.DB.prepare('SELECT DISTINCT o.key, o.summary, o.customer FROM stock_moves m JOIN stock_orders o ON o.id = m.order_id WHERE m.unit_id = ?').bind(u.id).all()).results || [];
  const loc = (id2) => (id2 ? locs.get(id2)?.code || null : null);
  return { unit: { ...unitBrief(u, items, locs), poDate: u.po_date, receivedBy: u.received_by, note: u.note }, orders,
    moves: moves.map((m) => ({ at: m.at, who: m.name, action: m.action, qty: m.qty, from: loc(m.from_location), to: loc(m.to_location), orderKey: m.order_key, fromStatus: m.from_status, toStatus: m.to_status, note: m.note })) };
}

// A recall: everything from a lot (or an item from a supplier), where it is now, and which jobs and customers it went to.
export async function recall(env, viewer, { lot, itemId, supplier }) {
  if (!lot && !num(itemId)) throw bad('Enter the lot or batch, or choose the item.');
  const where = []; const binds = [];
  if (lot) { where.push('(LOWER(COALESCE(u.lot, \'\')) = LOWER(?) OR LOWER(COALESCE(u.supplier_lot, \'\')) = LOWER(?))'); binds.push(String(lot), String(lot)); }
  if (num(itemId)) { where.push('u.item_id = ?'); binds.push(num(itemId)); }
  if (supplier) { where.push('LOWER(COALESCE(u.supplier, \'\')) LIKE ?'); binds.push(`%${likeTerm(supplier)}%`); }
  const units = (await env.DB.prepare(`SELECT u.* FROM stock_units u WHERE ${where.join(' AND ')}`).bind(...binds).all()).results || [];
  const items = await itemMap(env); const locs = await locationMap(env);
  const ids = units.map((u) => u.id);
  const orderRows = [];
  for (const part of chunk(ids, 80)) {
    orderRows.push(...((await env.DB.prepare(`SELECT DISTINCT m.unit_id, o.key, o.summary, o.customer, o.status FROM stock_moves m JOIN stock_orders o ON o.id = m.order_id WHERE m.unit_id IN (${part.map(() => '?').join(',')}) AND m.action IN ('pick', 'bin-take', 'consume')`).bind(...part).all()).results || []));
  }
  const jobs = [...new Map(orderRows.map((r) => [r.key, r])).values()];
  return {
    units: units.map((u) => unitBrief(u, items, locs)),
    onShelf: units.filter((u) => ['available', 'reserved', 'quarantine'].includes(u.status)).reduce((s, u) => s + u.qty, 0),
    used: units.filter((u) => ['picked', 'consumed'].includes(u.status)).reduce((s, u) => s + u.qty, 0),
    jobs: jobs.map((j) => ({ key: j.key, summary: j.summary, customer: j.customer, status: j.status })),
    customers: [...new Set(jobs.map((j) => j.customer).filter(Boolean))].sort(),
  };
}

// ---------- the dashboard ----------

export async function dashboard(env, viewer) {
  await syncOrders(env).catch(() => null);
  const all = await loadAll(env);
  const day = today();
  const open = rankOrders(all.orders.filter((o) => o.status === 'open'), day).map((o) => orderBrief(o, needLines(o, all, day), day));
  const items = all.items; const locs = await locationMap(env);
  const stuckBefore = new Date(Date.now() - STUCK_HOURS * 3600000).toISOString();
  const stuck = all.units.filter((u) => u.status === 'picked' && u.picked_at && u.picked_at < stuckBefore).map((u) => ({ ...unitBrief(u, items, locs), orderKey: all.orders.find((o) => o.id === u.order_id)?.key }));
  const expiring = all.units.filter((u) => u.status === 'available' && !u.order_id && u.expiry && u.expiry <= addDays(day, EXPIRY_WARN_DAYS)).map((u) => unitBrief(u, items, locs));
  const exp = await expectedList(env);
  const deliveries = exp.expected.filter((e) => e.expected_date && e.expected_date <= day);
  const since = addDays(day, -30);
  const use = (await env.DB.prepare(`SELECT m.item_id, i.name, i.unit, SUM(m.qty) AS qty, SUM(m.qty * COALESCE(u.unit_cost, i.unit_cost, 0)) AS value FROM stock_moves m JOIN stock_items i ON i.id = m.item_id LEFT JOIN stock_units u ON u.id = m.unit_id
    WHERE m.action IN ('consume') AND m.at >= ? GROUP BY m.item_id ORDER BY qty DESC LIMIT 10`).bind(since).all()).results || [];
  const binsLow = [...items.values()].filter((i) => i.active && i.mode === 'bin' && i.min_qty != null)
    .map((i) => ({ ...itemBrief(i), qty: all.units.filter((u) => u.item_id === i.id && u.status === 'available').reduce((s, u) => s + u.qty, 0), min: i.min_qty }))
    .filter((i) => i.qty <= i.min);
  const due = (await plans(env)).plans.filter((p) => p.due);
  const value = all.units.filter((u) => IN_HOUSE.includes(u.status)).reduce((s, u) => s + u.qty * (u.unit_cost ?? items.get(u.item_id)?.unit_cost ?? 0), 0);
  return {
    toOrder: open.filter((o) => o.state === 'order'), high: open.filter((o) => o.priority === 'Emergency' || o.priority === 'High'), ready: open.filter((o) => o.ready),
    stuck, expiring, deliveries, use, binsLow, checksDue: due, stockValue: Math.round(value * 100) / 100, openCount: open.length,
  };
}

// ---------- time from scans ----------

// Rough blocks of time from someone's scans on a day, per job: from a little before their first
// scan to a little after their last, split where there's a long gap. Hardware time goes to the
// job's Build item, or its Testing & Configuration item where there's no Build.
export async function timeSuggest(env, viewer, date) {
  const day = isoDay(date) || londonDate();
  const moves = (await env.DB.prepare(`SELECT m.at, m.order_id, m.order_key FROM stock_moves m WHERE m.account_id = ? AND m.at >= ? AND m.at < ? AND m.order_id IS NOT NULL
    AND m.action IN ('pick', 'bin-take', 'bin-return', 'return', 'consume', 'complete', 'quarantine') ORDER BY m.at`).bind(viewer.accountId || viewer.email, `${day}T00:00:00`, `${addDays(day, 1)}T00:00:00`).all()).results || [];
  const hidden = new Set(((await env.DB.prepare('SELECT order_key FROM stock_time_hidden WHERE account_id = ? AND day = ?').bind(viewer.accountId || viewer.email, day).all()).results || []).map((r) => r.order_key));
  const blocks = [];
  const GAP = 30 * 60000; const PAD = 5 * 60000;
  for (const m of moves) {
    if (hidden.has(m.order_key)) continue;
    const t = new Date(m.at).getTime();
    const last = blocks.findLast((b) => b.orderId === m.order_id);
    if (last && t - last.end <= GAP) { last.end = t; last.scans++; } else blocks.push({ orderId: m.order_id, orderKey: m.order_key, start: t, end: t, scans: 1 });
  }
  if (!blocks.length) return { day, suggestions: [] };
  const orderRows = new Map();
  for (const b of blocks) if (!orderRows.has(b.orderId)) orderRows.set(b.orderId, await env.DB.prepare('SELECT * FROM stock_orders WHERE id = ?').bind(b.orderId).first());
  const targetOf = (o) => {
    const subs = JSON.parse(o?.subtasks || '[]');
    return subs.find((s) => s.role === 'build') || subs.find((s) => s.role === 'test') || null;
  };
  const keys = [...new Set([...orderRows.values()].map((o) => targetOf(o)?.key || (o?.kind === 'manual' ? o.key : null)).filter(Boolean))];
  let options = [];
  try { options = (await (await import('./logging.js')).itemsByKey(env, keys.join(','))).options || []; } catch { options = []; }
  const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  return {
    day,
    suggestions: blocks.map((b) => {
      const o = orderRows.get(b.orderId);
      const target = targetOf(o);
      const key = target?.key || (o?.kind === 'manual' ? o.key : null);
      const start = b.start - PAD; const end = b.end + PAD;
      return { orderKey: b.orderKey, orderSummary: o?.order_summary || o?.summary || '', target: key ? { key, summary: target?.summary || o?.summary || '', option: options.find((x) => x.label === key) || null } : null,
        start: clock(start), end: clock(end), minutes: Math.max(15, Math.round((end - start) / 60000 / 5) * 5), scans: b.scans };
    }),
  };
}

export async function timeHide(env, viewer, { orderKey, date }) {
  const day = isoDay(date) || londonDate();
  await env.DB.prepare('INSERT OR IGNORE INTO stock_time_hidden (account_id, order_key, day) VALUES (?, ?, ?)').bind(viewer.accountId || viewer.email, String(orderKey || ''), day).run();
  return { ok: true };
}

// ---------- settings ----------

export async function settings(env, viewer) {
  return { jiraMoves: (await getState(env, 'stock_jira_moves')) === 'on', lastSync: await getState(env, 'stock_sync_at'), canManage: canManage(viewer), canLead: canLead(viewer), xero: false };
}

export async function setSettings(env, viewer, input) {
  needManage(viewer);
  if (input.jiraMoves !== undefined) await setState(env, 'stock_jira_moves', input.jiraMoves ? 'on' : 'off');
  return settings(env, viewer);
}

// Purchase orders come from Xero once it's linked; until then this says so.
export async function recheckOrders(env, viewer) {
  needManage(viewer);
  return { ok: false, xero: false, message: 'Xero isn\'t linked yet, so stock orders are entered here by hand for now.' };
}

// Labels to print: units, locations or items.
export async function labels(env, viewer, { units = [], locations = [], items = [] }) {
  const list = [];
  const ids = (a) => (Array.isArray(a) ? a : String(a || '').split(',')).map(Number).filter(Boolean).slice(0, 200);
  const it = await itemMap(env); const lm = await locationMap(env);
  for (const id of ids(units)) {
    const u = await env.DB.prepare('SELECT * FROM stock_units WHERE id = ?').bind(id).first();
    if (u) list.push({ code: u.code || unitLabel(u.id), title: it.get(u.item_id)?.name || '', lines: [u.serial && `SN ${u.serial}`, u.lot && `Lot ${u.lot}`, u.expiry && `Use by ${u.expiry}`, lm.get(u.location_id)?.code].filter(Boolean) });
  }
  for (const id of ids(locations)) { const l = lm.get(id); if (l) list.push({ code: l.code, title: l.area || 'Location', lines: [l.name, `${l.level} shelf`].filter(Boolean) }); }
  for (const id of ids(items)) { const i = it.get(id); if (i) list.push({ code: i.code, title: i.name, lines: [i.mode === 'bin' ? 'Bin item' : null, i.supplier_part].filter(Boolean) }); }
  return { labels: list };
}

// ---------- importing items from Quoter ----------

// A CSV the way Quoter exports it: quoted fields can hold commas, doubled quotes and line breaks.
export function parseCsv(textIn) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  const s = String(textIn || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const plainText = (html) => String(html || '').replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, '. ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s*\.\s*(\.\s*)+/g, '. ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').trim();

// Quoter's codes carry shop labels ("SKU: …", "Mfr# : … Quick : 25166") and sometimes two codes at once.
function quoterCodes(v) {
  let s = String(v || '').trim();
  if (!s) return [];
  s = s.replace(/\bQuick(find Code)?\s*:\s*\d+/gi, ' ').replace(/(\bSKU|Mfr#|\bPart No)\s*:\s*/gi, ' ').replace(/\bHS\s*\d{6,}/gi, ' ');
  // Codes are the words with a digit in them made only of code characters; numbers alone need six digits or more.
  return s.split(/[\s|,;]+/).map((x) => x.trim()).filter((x) => x.length >= 3 && /\d/.test(x) && /^[A-Z0-9][A-Z0-9\-_./#]*$/i.test(x) && (!/^\d+$/.test(x) || x.length >= 6));
}

const SKIP_RULES = [
  [(r) => /placeholder/i.test(r.code) || /^blank /i.test(r.name), 'Placeholder'],
  [(r) => /not this one/i.test(r.name), 'Marked "not this one" in Quoter'],
  [(r) => /sprint allocation/i.test(r.name), 'Labour, not stock'],
  [(r) => /please put details|details here please/i.test(r.desc) || /components$|sundries$/i.test(r.name), 'A lump sum, not one item'],
  [(r) => /licen[cs]e|\bCAL\b|windows server|step 7/i.test(r.name), 'Software licence'],
];

const CATEGORY_WORDS = [
  [/router|nport|firewall|network|\bswitch\b/i, 'Networking'],
  [/cable|adapter/i, 'Cables and adapters'],
  [/load ?cell|loading assembly|anti-vibration|silentblock|base plate/i, 'Load cells'],
  [/enclosure|rack\b|pedestal|rails|brackets/i, 'Enclosures'],
  [/weigh|amplifier|indicator|sw600|scale|balance/i, 'Weighing'],
  [/compactlogix|compact logix|slc 500|plc|input (card|module)|output (card|module)|analogue|brainbox|1769-|1746-|1747-/i, 'PLC and I/O'],
  [/hard drive|hdd|memory|server|desktop pc|panel pc|nas\b|proliant/i, 'PCs and servers'],
  [/tesys|contactor|safety relay|variable speed drive/i, 'Motor control'],
  [/\bmonitor\b|display|tft|keyboard|trackball|barcode|printer/i, 'Displays and HMI'],
  [/power supply|psu|\bups\b|uninterrupt|battery/i, 'Power'],
];
const LIGHT = /hard drive|hdd|memory|power supply|psu|rails|card|module|brackets|cable/i;
const HEAVY = /rack enclosure|\bups\b|uninterruptable|server|proliant|platform scale|bench scale|defender|pedestal|battery/i;
const MODERATE = /enclosure|panel pc|monitor|nas\b|vdu|switch 24|monitoring unit/i;

// Hardware (and critical spares) from a Quoter item export, as stock items. A preview first,
// then the same file applied. Items already here are matched by name, then by code, and updated.
export async function importQuoter(env, viewer, { csv, apply = false }) {
  needManage(viewer);
  const rows = parseCsv(csv);
  if (rows.length < 2) throw bad('That file has no items in it.');
  const head = rows[0].map((h) => h.replace(/^\*/, '').toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const C = { name: col(/^item name/), cat: col(/^category/), sub: col(/^subcategory/), desc: col(/^description/), maker: col(/^manufacturer/), code: col(/^code$/), supplier: col(/^supplier$/),
    sku: col(/^supplier sku/), cost: col(/^gbp cost \(/), level: col(/^item level/) };
  if (C.name < 0 || C.cat < 0) throw bad('That doesn\'t look like a Quoter item export (no Item Name or Category column).');
  const existing = (await env.DB.prepare('SELECT * FROM stock_items').all()).results || [];
  // Items the import added that have never had stock and haven't been edited by hand can still take the import's view of them.
  const everStocked = new Set(((await env.DB.prepare('SELECT DISTINCT item_id FROM stock_units').all()).results || []).map((r) => r.item_id));
  const freshQuoter = (i) => /\(Quoter\)$/.test(i.created_by || '') && !everStocked.has(i.id) && !i.edited_at;
  const byName = new Map(existing.map((i) => [i.name.toLowerCase(), i]));
  const byCode = new Map(existing.filter((i) => i.code).map((i) => [i.code.toUpperCase(), i]));
  const aliasOwner = new Map(((await env.DB.prepare('SELECT code, item_id FROM stock_aliases').all()).results || []).map((a) => [a.code.toUpperCase(), a.item_id]));
  const out = { added: [], updated: [], skipped: [], shared: [] };
  const seenNames = new Set(); const usedCodes = new Set(byCode.keys());
  for (const r of rows.slice(1)) {
    const g = (k) => (C[k] >= 0 ? String(r[C[k]] ?? '').trim() : '');
    const item = { name: g('name'), cat: g('cat'), sub: g('sub'), desc: plainText(g('desc')), maker: g('maker'), code: g('code'), supplier: g('supplier'), sku: g('sku'), cost: num(g('cost')) };
    if (!item.name) continue;
    if (!/^hardware$/i.test(item.cat) && !/critical spares/i.test(item.sub)) continue;
    const skip = SKIP_RULES.find(([test]) => test(item));
    if (skip) { out.skipped.push({ name: item.name, why: skip[1] }); continue; }
    if (seenNames.has(item.name.toLowerCase())) { out.skipped.push({ name: item.name, why: 'In the file twice' }); continue; }
    seenNames.add(item.name.toLowerCase());
    const codes = [...new Set([...quoterCodes(item.code), ...quoterCodes(item.sku)].map((c) => c.slice(0, 80)))];
    const was = byName.get(item.name.toLowerCase()) || codes.map((c) => byCode.get(c.toUpperCase())).find((x) => x && !seenNames.has(`#${x.id}`)) || null;
    if (was) seenNames.add(`#${was.id}`);
    // Our code: Quoter's first code, unless another item already has it.
    let code = was?.code || null;
    if (!was) {
      const first = codes.find((c) => !usedCodes.has(c.toUpperCase()) && !aliasOwner.has(c.toUpperCase()));
      if (first) { code = first; usedCodes.add(first.toUpperCase()); }
      else if (codes.length) out.shared.push({ name: item.name, code: codes[0] });
    }
    const supplier = /\bteam$/i.test(item.supplier) ? null : item.supplier || null;
    const values = {
      name: item.name, code, description: item.desc ? item.desc.slice(0, 600) : null, category: was?.category || CATEGORY_WORDS.find(([re]) => re.test(item.name))?.[1] || (/critical spares/i.test(item.sub) ? 'Critical spares' : null),
      // Things worth £20 or more usually come one to a box, so each is scanned and labelled; cheaper parts come by the box or bag.
      mode: was && !freshQuoter(was) ? was.mode : (item.cost ?? 0) >= 20 ? 'serial' : 'batch', unit: was?.unit || 'each', weight: was?.weight || (/uninterrupt|\bups\b.*battery|battery/i.test(item.name) ? 'heavy' : LIGHT.test(item.name) ? 'light' : HEAVY.test(item.name) ? 'heavy' : MODERATE.test(item.name) ? 'moderate' : 'light'),
      supplier, supplier_part: quoterCodes(item.sku)[0] || (item.sku && !/^(SCE|n\/a)$/i.test(item.sku) ? item.sku.slice(0, 80) : null), manufacturer: /^(OEM)$/i.test(item.maker) ? null : item.maker || null,
      mpn: quoterCodes(item.code)[0] || null, unit_cost: item.cost ?? was?.unit_cost ?? null,
    };
    const aliases = codes.filter((c) => c.toUpperCase() !== String(code || '').toUpperCase());
    (was ? out.updated : out.added).push({ name: item.name, code, supplier, cost: values.unit_cost, weight: values.weight, category: values.category, mode: values.mode });
    if (!apply) continue;
    let id = was?.id;
    if (was) {
      await env.DB.prepare('UPDATE stock_items SET description = COALESCE(?, description), category = ?, supplier = ?, supplier_part = ?, manufacturer = ?, mpn = COALESCE(?, mpn), unit_cost = ?, mode = ?, active = 1 WHERE id = ?')
        .bind(values.description, values.category, values.supplier, values.supplier_part, values.manufacturer, values.mpn, values.unit_cost, values.mode, id).run();
    } else {
      id = (await env.DB.prepare(`INSERT INTO stock_items (code, name, description, category, mode, unit, weight, supplier, supplier_part, manufacturer, mpn, unit_cost, two_bin, active, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?) RETURNING id`).bind(values.code, values.name, values.description, values.category, values.mode, values.unit, values.weight, values.supplier,
        values.supplier_part, values.manufacturer, values.mpn, values.unit_cost, nowIso(), `${whoOf(viewer).name} (Quoter)`).first()).id;
      if (!values.code) await env.DB.prepare('UPDATE stock_items SET code = ? WHERE id = ?').bind(`I${String(id).padStart(5, '0')}`, id).run();
    }
    for (const a of aliases) {
      const owner = aliasOwner.get(a.toUpperCase());
      if ((owner && owner !== id) || (usedCodes.has(a.toUpperCase()) && a.toUpperCase() !== String(code || '').toUpperCase())) continue;
      aliasOwner.set(a.toUpperCase(), id);
      await env.DB.prepare('INSERT OR IGNORE INTO stock_aliases (code, item_id, kind) VALUES (?, ?, ?)').bind(a, id, 'quoter').run();
    }
  }
  if (apply) {
    // Parts lists already read that weren't stock items yet pick up the new items now.
    const unmatched = (await env.DB.prepare('SELECT id, text FROM stock_needs WHERE item_id IS NULL').all()).results || [];
    let linked = 0;
    for (const n of unmatched) { const id = await matchItem(env, n.text); if (id) { await env.DB.prepare('UPDATE stock_needs SET item_id = ? WHERE id = ?').bind(id, n.id).run(); linked++; } }
    out.linked = linked;
    await allocate(env, { viewer: SYSTEM });
  }
  return { ok: true, applied: apply, ...out };
}

// ---------- looking up product barcodes ----------

// Shop barcodes (EAN-13, UPC-A, EAN-8, GTIN-14) are only a number; what the product is comes from
// a lookup service. UPCitemdb's free plan needs no sign-up and allows 100 lookups a day, a few a
// minute; with a UPCITEMDB_KEY secret the paid plan is used instead. Answers are kept, so each
// barcode is only looked up once (ones not found are tried again after 30 days).
const UPC_DAILY = 95;
export function isGtin(code) {
  const c = String(code || '').trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(c)) return false;
  const digits = [...c].map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export async function barcodeLookup(env, viewer, code) {
  const c = String(code || '').trim();
  if (!isGtin(c)) return { code: c, checked: false, reason: 'not-a-product-barcode', items: [], existing: [] };
  const cached = await env.DB.prepare('SELECT * FROM stock_barcode_cache WHERE code = ?').bind(c).first();
  const fresh = cached && (cached.found || Date.now() - new Date(cached.looked_at).getTime() < 30 * 86400000);
  let items = [];
  let reason = null;
  if (fresh) items = JSON.parse(cached.data || '[]');
  else {
    const day = today();
    const used = Number(await getState(env, `stock_upc_${day}`)) || 0;
    if (!env.UPCITEMDB_KEY && used >= UPC_DAILY) reason = 'limit';
    else {
      await setState(env, `stock_upc_${day}`, String(used + 1));
      try {
        const paid = Boolean(env.UPCITEMDB_KEY);
        const res = await fetch(`https://api.upcitemdb.com/prod/${paid ? 'v1' : 'trial'}/lookup?upc=${encodeURIComponent(c)}`, {
          headers: { Accept: 'application/json', ...(paid ? { user_key: env.UPCITEMDB_KEY, key_type: '3scale' } : {}) },
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 429 || /TOO_FAST|EXCEED_LIMIT/i.test(data.code || '')) reason = /EXCEED/i.test(data.code || '') ? 'limit' : 'busy';
        else if (!res.ok && res.status !== 404 && data.code !== 'INVALID_UPC') reason = 'error';
        else {
          items = (data.items || []).slice(0, 5).map((i) => ({
            title: text(i.title, 160), brand: text(i.brand, 120), model: text(i.model, 80), description: text(plainText(i.description), 600),
            category: text(String(i.category || '').split('>').pop(), 80), image: (i.images || []).find((u) => /^https:\/\//.test(u)) || null, ean: i.ean || c,
          })).filter((i) => i.title);
          await env.DB.prepare('INSERT OR REPLACE INTO stock_barcode_cache (code, found, data, looked_at) VALUES (?, ?, ?, ?)').bind(c, items.length ? 1 : 0, JSON.stringify(items), nowIso()).run();
        }
      } catch { reason = 'error'; }
    }
  }
  // Stock items that might be the same thing under another name (as Quoter names it, say).
  const existing = [];
  for (const i of items) {
    for (const q of [i.model, i.brand && i.model ? `${i.brand} ${i.model}` : null, i.title?.split(/\s+/).slice(0, 3).join(' ')].filter((x) => x && x.length >= 3)) {
      for (const hit of await suggest(env, q)) if (!existing.some((e) => e.id === hit.id)) existing.push(hit);
      if (existing.length >= 5) break;
    }
  }
  return { code: c, checked: !reason, reason, items, existing: existing.slice(0, 5), cached: Boolean(fresh) };
}

// What things cost is for managers: everyone else gets the same answers without the money in them.
const MONEY_KEYS = new Set(['cost', 'unit_cost', 'unitCost', 'value', 'stockValue']);
export function forViewer(viewer, data) {
  if (canManage(viewer)) return data;
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !MONEY_KEYS.has(k)).map(([k, x]) => [k, strip(x)]));
    return v;
  };
  return strip(data);
}
