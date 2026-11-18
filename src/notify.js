// Notifications. Everyone chooses, tile by tile, what they hear about and how: in the hub
// (the bell at the top of every page) and by email, at once or as one email each morning.
// Every alert the hub sends to a person comes through here, so their choices always apply;
// alerts for the hub's own address (things for an admin to fix) go out as before.
import { access, loadAccessConfig } from './permissions.js';

// What each tile can tell you about. app and email are the starting choices; scope is
// whether it's about every item or only those assigned to you, where that applies.
export const EVENTS = {
  psc: [
    { id: 'psc-new', label: 'New PSC', about: 'A PSC is raised for a customer', app: true, email: false, scope: 'all', scopes: ['all'] },
    { id: 'psc-assigned', label: 'Assigned to me', about: 'A PSC is given to you', app: true, email: true },
    { id: 'psc-customer-comment', label: 'Customer comment added', about: 'The customer replies or adds a comment', app: true, email: false, scope: 'mine' },
    { id: 'psc-team-comment', label: 'Team comment added', about: 'Someone in the team comments or adds an internal note', app: false, email: false, scope: 'mine' },
    { id: 'psc-updated', label: 'PSC updated', about: 'Its status or owner changes', app: true, email: false, scope: 'mine' },
    { id: 'psc-resolved', label: 'PSC resolved', about: 'It is resolved or closed', app: false, email: false, scope: 'mine' },
    { id: 'psc-response', label: 'First look overdue', about: 'Nobody has looked at a PSC by the time its contract asks', app: true, email: true },
    { id: 'psc-waiting', label: 'Customer waiting on us', about: 'A customer replied and nobody has answered in time', app: true, email: true },
  ],
  training: [
    { id: 'talk-new', label: 'Tool box talk arranged', about: 'You\'re asked to a tool box talk or training', app: true, email: true },
    { id: 'talk-upcoming', label: 'Tool box talk countdown', about: 'Each morning until a talk you\'re asked to, with the link to join', app: true, email: false },
    { id: 'talk-ack', label: 'Tool box talk to acknowledge', about: 'A talk you were asked to has finished: the link to acknowledge it', app: true, email: true },
    { id: 'policy-new', label: 'Policy to acknowledge', about: 'A policy is published that you need to read and acknowledge', app: true, email: true },
    { id: 'policy-reminder', label: 'Policy reminders', about: 'Each Monday, for policies you haven\'t acknowledged yet', app: true, email: false },
  ],
  ims: [
    { id: 'ims-new', label: 'New IMS item', about: 'An item is raised in an area (copies of it are not counted again)', app: false, email: false, scope: 'all', scopes: ['all'] },
    { id: 'ims-assigned', label: 'Assigned to me', about: 'An IMS item, or a copy of one, is given to you', app: true, email: true },
    { id: 'gap-assessment', label: 'Skill assessments', about: 'You\'re asked to assess someone for a gap analysis', app: true, email: true },
  ],
  quotes: [
    { id: 'quote-request', label: 'Asked for an estimate', about: 'Someone wants your view on a quote', app: true, email: true },
  ],
  jobs: [
    { id: 'order-new', label: 'New order', about: 'A new order comes in for a team you lead', app: true, email: true },
    { id: 'estimate', label: 'Job near or past its estimate', about: 'A job in your team reaches 90% or passes its estimate', app: true, email: true },
    { id: 'modifier', label: 'Something to take into account', about: 'Someone you manage asks for something to be taken into account', app: true, email: true },
    { id: 'missing-stage', label: 'Possible missing stage', about: 'Time is logged to a job because no stage matched the work', app: true, email: true },
  ],
  xp: [
    { id: 'dispute', label: 'XP dispute raised', about: 'Someone in your team disputes the XP for a job', app: true, email: true },
  ],
  time: [
    { id: 'tracker', label: 'Timer still running', about: 'Your timer is still going in the evening', app: true, email: true },
    { id: 'overtime', label: 'Over contracted hours', about: 'Someone in your team logs more than their contracted hours in a week', app: true, email: true },
  ],
  condor: [
    { id: 'dev-day', label: 'Day ready to log', about: 'Bitbucket shows a day of work waiting to be logged', app: true, email: true },
  ],
  contracts: [
    { id: 'contract-overdraft', label: 'Contract overdrawn', about: 'A customer uses more time than their contract holds', app: true, email: true },
    { id: 'contract-renewal', label: 'Renewal coming up', about: 'A contract is near its end', app: true, email: true },
    { id: 'contract-start', label: 'Contract should have started', about: 'A contract is still waiting to begin after its start date', app: true, email: true },
    { id: 'contract-dates', label: 'Dates look wrong', about: 'A contract\'s dates don\'t add up', app: true, email: true },
    { id: 'contract-write', label: 'Jira not updated', about: 'The hub couldn\'t write a contract change to Jira', app: true, email: true },
    { id: 'psc-org', label: 'Time with no customer', about: 'Time is logged to a ticket that has no Organization', app: true, email: true },
  ],
  nearmiss: [{ id: 'near-miss', label: 'Near miss reported', about: 'Someone reports a near miss', app: true, email: true }],
  feedback: [{ id: 'feedback', label: 'Feedback to read', about: 'Feedback is waiting to be read or posted', app: true, email: true }],
  vehicles: [{ id: 'vehicle-expiry', label: 'MOT, tax or insurance due', about: 'A vehicle date is coming up or has passed', app: true, email: true }],
  requests: [{ id: 'request', label: 'Hub requests', about: 'A request is made, or yours moves on', app: true, email: true }],
  hub: [
    { id: 'home-message', label: 'Messages for everyone', about: 'Management post a message on the home screen and email it', app: true, email: true },
    { id: 'birthday', label: 'Birthdays', about: 'Whose birthday it is, so you can wish them a happy birthday', app: true, email: false },
    { id: 'other', label: 'Anything else', about: 'Other alerts the hub sends you', app: true, email: true },
  ],
};
export const TILE_NAMES = { hub: 'Everything else' };
const KIND_TILE = Object.fromEntries(Object.entries(EVENTS).flatMap(([tile, list]) => list.map((e) => [e.id, tile])));
const eventOf = (tile, kind) => EVENTS[tile]?.find((e) => e.id === kind);
// The tiles a choice for PSC applies to: which customers and priorities.
const FILTERED = { psc: ['customers', 'priorities'], ims: ['areas'] };

// Someone's choices for a tile, with the starting choices filled in.
export function withDefaults(tile, saved = {}) {
  const events = {};
  for (const e of EVENTS[tile] || []) {
    const s = saved.events?.[e.id] || {};
    events[e.id] = { app: s.app ?? e.app, email: s.email ?? e.email, ...(e.scope ? { scope: (e.scopes || ['all', 'mine']).includes(s.scope) ? s.scope : e.scope } : {}) };
  }
  return {
    events,
    emailMode: saved.emailMode === 'digest' ? 'digest' : 'instant',
    workingHours: Boolean(saved.workingHours),
    exclude: Array.isArray(saved.exclude) ? saved.exclude.map(String).slice(0, 500) : [],
    priorities: Array.isArray(saved.priorities) ? saved.priorities.map(String).slice(0, 20) : [],
  };
}

async function savedPrefs(env, accountId, tile) {
  const row = await env.DB.prepare('SELECT prefs FROM notify_prefs WHERE account_id = ? AND tile = ?').bind(accountId, tile).first();
  try { return row ? JSON.parse(row.prefs) : {}; } catch { return {}; }
}

// ---------- the people they go to ----------

let staffKept = null;
async function staff(env) {
  if (staffKept && Date.now() - staffKept.at < 5 * 60 * 1000) return staffKept.list;
  const { results } = await env.DB.prepare("SELECT * FROM employees WHERE active = 1 AND email IS NOT NULL AND account_id NOT LIKE 'pending%'").all();
  staffKept = { at: Date.now(), list: results };
  return results;
}
const byEmail = async (env, email) => (await staff(env)).find((e) => String(e.email).toLowerCase() === String(email).toLowerCase()) || null;

// ---------- sending ----------

// The next weekday morning at 8, London time, when an email is held outside working hours.
function londonNow(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: p.weekday, hour: Number(p.hour), date: `${p.year}-${p.month}-${p.day}` };
}
export function heldUntil(ms = Date.now()) {
  const n = londonNow(ms);
  const weekend = n.day === 'Sat' || n.day === 'Sun';
  if (!weekend && n.hour >= 8 && n.hour < 18) return null;
  // Step forward an hour at a time to the next weekday 8:00 (at most a weekend and a night).
  let t = Math.ceil(ms / 3600000) * 3600000;
  for (let i = 0; i < 80; i++, t += 3600000) {
    const x = londonNow(t);
    if (x.day !== 'Sat' && x.day !== 'Sun' && x.hour === 8) return new Date(t).toISOString();
  }
  return null;
}

async function insertAlert(env, { kind, dedupe, subject, body, recipient, notBefore = null }) {
  const now = new Date().toISOString();
  if (notBefore) {
    const ok = await env.DB.prepare(`INSERT INTO alerts (kind, dedupe, subject, body, recipient, created_at, not_before) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe) DO NOTHING`).bind(kind, dedupe, subject, body, recipient, now, notBefore).run().then(() => true, () => false);
    if (ok) return;
  }
  await env.DB.prepare(`INSERT INTO alerts (kind, dedupe, subject, body, recipient, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe) DO NOTHING`).bind(kind, dedupe, subject, body, recipient, now).run();
}

// One notification to one person, as they've chosen. app/email are already decided.
async function deliver(env, emp, { tile, kind, dedupe, subject, body, link = null, refKey = null }, { app, email, prefs }) {
  if (!app && !email) return false;
  const digest = email && prefs.emailMode === 'digest';
  if (app || digest) {
    await env.DB.prepare(`INSERT INTO notifications (account_id, tile, kind, subject, body, link, ref_key, dedupe, created_at, in_app, digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe) DO NOTHING`)
      .bind(emp.account_id, tile, kind, subject, String(body || '').slice(0, 4000), link, refKey, `${dedupe}|${emp.account_id}`, new Date().toISOString(), app ? 1 : 0, digest ? 1 : 0).run();
  }
  if (email && !digest) await insertAlert(env, { kind, dedupe: `${dedupe}|mail|${emp.account_id}`, subject, body, recipient: emp.email, notBefore: prefs.workingHours ? heldUntil() : null });
  return true;
}

// Whether one item passes someone's filters for a tile.
function passes(prefs, ev, ref, emp) {
  const choice = prefs.events[ev.id] || {};
  if (choice.scope === 'mine' && ref.assigneeId !== undefined && ref.assigneeId !== emp.account_id) return false;
  if (ref.customer && prefs.exclude.includes(String(ref.customer))) return false;
  if (ref.area && prefs.exclude.includes(String(ref.area))) return false;
  if (ref.priority && prefs.priorities.length && !prefs.priorities.includes(String(ref.priority))) return false;
  // Nobody hears about what they did themselves.
  if (ref.notTo && ref.notTo === emp.account_id) return false;
  if (ref.actor && emp.name && String(ref.actor).toLowerCase() === String(emp.name).toLowerCase()) return false;
  return true;
}

// An alert the hub raised for one person: true when it's been dealt with here.
export async function routeAlert(env, { kind, dedupe, subject, body, recipient, link = null, ref = {} }) {
  const emp = await byEmail(env, recipient);
  if (!emp) return false;
  const tile = KIND_TILE[kind] || 'hub';
  const ev = eventOf(tile, kind) || eventOf('hub', 'other');
  const prefs = withDefaults(tile, await savedPrefs(env, emp.account_id, tile));
  const choice = prefs.events[ev.id] || { app: true, email: true };
  // An alert meant for this person isn't narrowed to "assigned to me": it's theirs already.
  if (!passes(prefs, ev, { ...ref, assigneeId: undefined }, emp)) return true;
  await deliver(env, emp, { tile, kind, dedupe, subject, body, link: link || defaultLink(tile), refKey: ref.key || null }, { app: choice.app, email: choice.email, prefs });
  return true;
}

const defaultLink = (tile) => (tile === 'hub' ? '#/' : `#/${tile}`);

// Something everyone who can open a tile may want to hear about: each hears as they've chosen.
export async function fanOut(env, { tile, kind, dedupe, subject, body, link = null, ref = {} }) {
  const ev = eventOf(tile, kind);
  if (!ev) return 0;
  const people = await staff(env);
  if (!people.length) return 0;
  const config = await loadAccessConfig(env);
  const admins = (env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const { results } = await env.DB.prepare('SELECT account_id, prefs FROM notify_prefs WHERE tile = ?').bind(tile).all();
  const saved = new Map(results.map((r) => { try { return [r.account_id, JSON.parse(r.prefs)]; } catch { return [r.account_id, {}]; } }));
  let sent = 0;
  for (const emp of people) {
    if (!access(emp, { config, fallbackAdmin: admins.includes(String(emp.email).toLowerCase()) }).tiles[tile]) continue;
    const prefs = withDefaults(tile, saved.get(emp.account_id));
    const choice = prefs.events[kind];
    if (!choice || (!choice.app && !choice.email)) continue;
    if (!passes(prefs, ev, ref, emp)) continue;
    if (await deliver(env, emp, { tile, kind, dedupe, subject, body, link: link || defaultLink(tile), refKey: ref.key || null }, { app: choice.app, email: choice.email, prefs })) sent++;
  }
  return sent;
}

// To one person, by account, as they've chosen (an item given to them, say).
export async function toPerson(env, accountId, { tile, kind, dedupe, subject, body, link = null, ref = {} }) {
  const emp = (await staff(env)).find((e) => e.account_id === accountId);
  const ev = eventOf(tile, kind);
  if (!emp || !ev) return false;
  const prefs = withDefaults(tile, await savedPrefs(env, emp.account_id, tile));
  const choice = prefs.events[kind];
  if (!passes(prefs, ev, { ...ref, assigneeId: undefined }, emp)) return false;
  return deliver(env, emp, { tile, kind, dedupe, subject, body, link: link || defaultLink(tile), refKey: ref.key || null }, { app: choice.app, email: choice.email, prefs });
}

// ---------- PSC: what changed since it was last read ----------

const HOUR = 3600000;
const recent = (iso, within = 24 * HOUR) => iso && Date.now() - Date.parse(iso) < within;
function savedProjectNames(list) { return new Map((list || []).map((p) => [String(p.name).toLowerCase(), p.key])); }

// prev: the rows as they were (by issue_id); rows: as they are now.
export async function pscChanges(env, prev, rows) {
  const out = [];
  let projects = null;
  const customerOf = async (r) => {
    if (r.project_key !== 'PSC') return r.project_key;
    if (!r.org) return null;
    if (!projects) {
      const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'customer_projects'").first().catch(() => null);
      try { projects = savedProjectNames(JSON.parse(row?.value || '{}').list); } catch { projects = new Map(); }
    }
    return projects.get(String(r.org).split(' | ')[0].toLowerCase()) || null;
  };
  for (const r of rows) {
    // A customer's copy of a PSC ticket is the same ticket: it's heard about once, from the PSC board.
    const links = (() => { try { return JSON.parse(r.links || '[]'); } catch { return []; } })();
    if (r.project_key !== 'PSC' && links.some((k) => /^PSC-\d+$/.test(k))) continue;
    const was = prev.get(r.issue_id);
    const customer = await customerOf(r);
    const who = r.org || customer || 'a customer';
    const ref = { key: r.issue_key, customer, priority: r.priority, assigneeId: r.assignee_id || null };
    const link = `#/psc?open=${encodeURIComponent(r.issue_key)}`;
    const head = `${r.issue_key}: ${r.summary}`;
    if (!was) {
      if (recent(r.created_at)) out.push({ kind: 'psc-new', dedupe: `psc-new:${r.issue_key}`, subject: `New PSC for ${who}: ${r.issue_key}`, body: `${head}\nRaised by ${r.reporter_name || 'unknown'}.`, link, ref: { ...ref, actor: r.reporter_name } });
      if (r.assignee_id && recent(r.created_at)) out.push({ kind: 'psc-assigned', to: r.assignee_id, dedupe: `psc-assigned:${r.issue_key}:${r.assignee_id}`, subject: `${r.issue_key} is assigned to you`, body: `${head}\nCustomer: ${who}.`, link, ref });
      continue;
    }
    let tl = [];
    try { tl = JSON.parse(r.timeline || '[]'); } catch { /* none */ }
    const lastOf = (kind) => tl.find((e) => e.kind === kind);
    if (r.assignee_id && r.assignee_id !== was.assignee_id) {
      const by = lastOf('assignee')?.by;
      out.push({ kind: 'psc-assigned', to: r.assignee_id, dedupe: `psc-assigned:${r.issue_key}:${r.assignee_id}:${r.updated_at}`, subject: `${r.issue_key} is assigned to you`, body: `${head}\nCustomer: ${who}.${by ? `\nAssigned by ${by}.` : ''}`, link, ref: { ...ref, actor: by } });
    }
    const statusMoved = r.status !== was.status;
    if (r.done && !was.done) {
      out.push({ kind: 'psc-resolved', dedupe: `psc-resolved:${r.issue_key}:${r.resolved_at || r.updated_at}`, subject: `${r.issue_key} for ${who} is ${r.status || 'resolved'}`, body: head, link, ref: { ...ref, actor: lastOf('status')?.by } });
    } else if (statusMoved || (r.assignee_name || '') !== (was.assignee_name || '')) {
      const by = statusMoved ? lastOf('status')?.by : lastOf('assignee')?.by;
      const what = [statusMoved ? `moved from ${was.status || '?'} to ${r.status}` : '', (r.assignee_name || '') !== (was.assignee_name || '') ? (r.assignee_name ? `now with ${r.assignee_name}` : 'now unassigned') : ''].filter(Boolean).join(', ');
      // Whoever it's just been given to hears that instead.
      const notTo = !statusMoved && r.assignee_id !== was.assignee_id ? r.assignee_id : null;
      out.push({ kind: 'psc-updated', dedupe: `psc-updated:${r.issue_key}:${r.updated_at}`, subject: `${r.issue_key} for ${who}: ${what}`, body: `${head}${by ? `\nBy ${by}.` : ''}`, link, ref: { ...ref, actor: by, notTo } });
    }
    // Comments since it was last read.
    let before = [];
    try { before = JSON.parse(was.timeline || '[]'); } catch { /* none */ }
    const lastSeen = Math.max(0, ...before.filter((e) => e.kind === 'comment').map((e) => Date.parse(e.at) || 0));
    for (const c of tl.filter((e) => e.kind === 'comment' && Date.parse(e.at) > lastSeen && recent(e.at)).reverse()) {
      const kind = c.team ? 'psc-team-comment' : 'psc-customer-comment';
      out.push({ kind, dedupe: `${kind}:${r.issue_key}:${c.at}`, subject: `${c.by} ${c.internal ? 'added an internal note to' : 'commented on'} ${r.issue_key} (${who})`,
        body: `${head}\n\n${c.text || ''}`, link, ref: { ...ref, actor: c.by } });
    }
  }
  for (const e of out) {
    try {
      if (e.to) await toPerson(env, e.to, { tile: 'psc', ...e });
      else await fanOut(env, { tile: 'psc', ...e });
    } catch (err) { console.warn('PSC notification:', err.message); }
  }
  return out.length;
}

// ---------- IMS ----------

export async function imsChanges(env, prev, rows) {
  let n = 0;
  for (const r of rows) {
    const was = prev.get(r.issue_id);
    const link = `#/ims?open=${encodeURIComponent(r.issue_key)}`;
    const head = `${r.issue_key}: ${r.summary}`;
    try {
      if (!was && recent(r.created_at) && (!r.origin_key || r.origin_key === r.issue_key)) {
        await fanOut(env, { tile: 'ims', kind: 'ims-new', dedupe: `ims-new:${r.issue_key}`, subject: `New IMS item ${r.issue_key}`, body: `${head}\n${r.issuetype || ''}`.trim(), link, ref: { key: r.issue_key, area: r.project_key } });
        n++;
      }
      if (r.assignee_id && r.assignee_id !== (was?.assignee_id || null) && (was || recent(r.created_at))) {
        await toPerson(env, r.assignee_id, { tile: 'ims', kind: 'ims-assigned', dedupe: `ims-assigned:${r.issue_key}:${r.assignee_id}:${r.updated_at}`, subject: `${r.issue_key} is assigned to you`, body: head, link, ref: { key: r.issue_key, area: r.project_key } });
        n++;
      }
    } catch (err) { console.warn('IMS notification:', err.message); }
  }
  return n;
}

// ---------- the bell ----------

export async function list(env, viewer, { before = null } = {}) {
  if (!viewer.accountId) return { items: [], unread: 0 };
  const { results } = await env.DB.prepare(`SELECT id, tile, kind, subject, body, link, ref_key, created_at, read_at FROM notifications
    WHERE account_id = ? AND in_app = 1${before ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT 40`).bind(...[viewer.accountId, ...(before ? [Number(before)] : [])]).all();
  const unread = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND in_app = 1 AND read_at IS NULL').bind(viewer.accountId).first();
  return { items: results, unread: unread?.n || 0 };
}

export async function count(env, viewer) {
  if (!viewer.accountId) return { unread: 0, latest: 0 };
  const r = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(id) AS latest FROM notifications WHERE account_id = ? AND in_app = 1 AND read_at IS NULL').bind(viewer.accountId).first();
  return { unread: r?.n || 0, latest: r?.latest || 0 };
}

export async function markRead(env, viewer, { ids = null, all = false } = {}) {
  if (!viewer.accountId) return { ok: true };
  const now = new Date().toISOString();
  if (all) await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL').bind(now, viewer.accountId).run();
  else {
    const list = (ids || []).map(Number).filter(Boolean).slice(0, 90);
    if (list.length) await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL AND id IN (${list.map(() => '?').join(', ')})`).bind(now, viewer.accountId, ...list).run();
  }
  return count(env, viewer);
}

// ---------- choosing ----------

export function tilesFor(viewer) {
  return Object.keys(EVENTS).filter((t) => t === 'hub' || viewer.isAdmin || viewer.tiles?.[t]);
}

export async function getPrefs(env, viewer, tile) {
  if (!EVENTS[tile]) throw Object.assign(new Error('That tile has no notifications.'), { status: 404 });
  const prefs = withDefaults(tile, viewer.accountId ? await savedPrefs(env, viewer.accountId, tile) : {});
  const out = { tile, events: EVENTS[tile], prefs, filters: FILTERED[tile] || [], emailOn: Boolean(env.ALERT_WEBHOOK_URL), email: viewer.email || null };
  if (tile === 'psc') {
    const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'customer_projects'").first().catch(() => null);
    let list = [];
    try { list = JSON.parse(row?.value || '{}').list || []; } catch { /* none */ }
    out.customers = list.map((p) => ({ key: p.key, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
    const { results } = await env.DB.prepare('SELECT DISTINCT priority FROM psc_items WHERE priority IS NOT NULL').all().catch(() => ({ results: [] }));
    const order = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
    out.priorities = results.map((r) => r.priority).sort((a, b) => (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9) || a.localeCompare(b));
  }
  if (tile === 'ims') {
    const { AREAS } = await import('./ims.js');
    out.areas = AREAS.map((a) => ({ key: a.key, name: a.name }));
  }
  return out;
}

export async function savePrefs(env, viewer, tile, input = {}) {
  if (!EVENTS[tile]) throw Object.assign(new Error('That tile has no notifications.'), { status: 404 });
  if (!viewer.accountId) throw Object.assign(new Error('Your account isn\'t linked to Jira yet, so there\'s nothing to save against.'), { status: 400 });
  const prefs = withDefaults(tile, input);
  await env.DB.prepare(`INSERT INTO notify_prefs (account_id, tile, prefs, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, tile) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`)
    .bind(viewer.accountId, tile, JSON.stringify(prefs), new Date().toISOString()).run();
  return getPrefs(env, viewer, tile);
}

// ---------- the morning email ----------

// Once a day from 8am: everyone who asked for a daily email gets one with what came in.
export async function digest(env) {
  const now = londonNow();
  if (now.hour < 8) return { idle: true };
  const done = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'notify_digest_day'").first().catch(() => null);
  if (done?.value === now.date) return { idle: true };
  const { results } = await env.DB.prepare('SELECT id, account_id, tile, subject, body, created_at FROM notifications WHERE digest = 1 ORDER BY id LIMIT 2000').all();
  const byPerson = new Map();
  for (const r of results) (byPerson.get(r.account_id) || byPerson.set(r.account_id, []).get(r.account_id)).push(r);
  const people = await staff(env);
  let sent = 0;
  for (const [accountId, items] of byPerson) {
    const emp = people.find((e) => e.account_id === accountId);
    if (emp?.email) {
      const names = { ...Object.fromEntries(Object.keys(EVENTS).map((t) => [t, t.toUpperCase()])), ...TILE_NAMES };
      const body = items.map((i) => `${names[i.tile] || i.tile}: ${i.subject}\n${String(i.body || '').split('\n')[0]}`).join('\n\n');
      await insertAlert(env, { kind: 'notify-digest', dedupe: `notify-digest:${accountId}:${now.date}`, recipient: emp.email,
        subject: `${items.length} ${items.length === 1 ? 'update' : 'updates'} from the hub`,
        body: `${(emp.name || '').split(' ')[0] || 'Hi'}, here's what came in since yesterday's email.\n\n${body}\n\nOpen the hub and press the bell to see them all.` });
      sent++;
    }
    for (let i = 0; i < items.length; i += 90) {
      const part = items.slice(i, i + 90).map((x) => x.id);
      await env.DB.prepare(`UPDATE notifications SET digest = 2 WHERE id IN (${part.map(() => '?').join(', ')})`).bind(...part).run();
    }
  }
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('notify_digest_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(now.date).run();
  // Old notifications are cleared after two months.
  await env.DB.prepare('DELETE FROM notifications WHERE created_at < ?').bind(new Date(Date.now() - 60 * 86400000).toISOString()).run();
  return { sent };
}
