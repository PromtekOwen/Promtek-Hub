// The Stock tile: work orders, taking stock in, picking, counts and tracing.
// Built for phones and the workshop tablet: every screen with a scan box takes a
// keyboard-wedge scanner or the camera, and scans made with no signal are kept
// and sent once it's back.

let H = null; // helpers from the hub: api, esc, toast, saveFile, me, render
const view = document.getElementById('view');

const S = {
  tab: 'orders', orders: null, orderFilter: 'open', orderQuery: '', order: null, orderId: null,
  intake: null, intakeStep: null, lastIntake: null, expected: null,
  stockSub: 'items', items: null, itemQuery: '', item: null, buy: null, buyPick: {},
  checks: null, check: null, counting: null, countRows: [],
  trace: null, traceQ: {}, unit: null, recall: null,
  dash: null, time: null,
  setupSub: 'items', locations: null, panels: null, editItem: null, editPanel: null, settings: null, labelPick: { units: [], locations: [], items: [] },
  binAsk: null, busy: false,
};
const QUEUE_KEY = 'hub.stock.queue';

export function init(helpers) {
  if (H) { H = helpers; return; }
  H = helpers;
  view.addEventListener('click', (e) => { if (here()) onClick(e); });
  view.addEventListener('submit', (e) => { if (here()) onSubmit(e); });
  view.addEventListener('input', (e) => { if (here()) onInput(e); });
  view.addEventListener('change', (e) => { if (here()) onChange(e); });
  window.addEventListener('online', () => flushQueue());
  // A scanner ends each scan with Enter: in the scan-each box that's one more, not the whole form sent.
  view.addEventListener('keydown', (e) => {
    if (!here() || e.key !== 'Enter' || e.target.id !== 'st-each-scan') return;
    e.preventDefault();
    const v = e.target.value.trim(); e.target.value = '';
    if (v) addEach(v);
  });
  // Tables become stacked cards on a phone: each cell is labelled with its column.
  new MutationObserver(() => { if (here()) labelTables(); }).observe(view, { childList: true, subtree: true });
}
function labelTables() {
  for (const table of view.querySelectorAll('table.st-table:not([data-labelled])')) {
    table.dataset.labelled = '1';
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const tr of table.querySelectorAll('tbody tr')) {
      let col = 0;
      for (const td of tr.children) { if (heads[col] && !td.hasAttribute('colspan')) td.dataset.l = heads[col]; col += Number(td.getAttribute('colspan') || 1); }
    }
  }
}
const here = () => location.hash.startsWith('#/stock');
const esc = (s) => H.esc(s);
const get = (path) => H.api(`/api/stock/${path}`);
const post = (path, body) => H.api(`/api/stock/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
const qty = (v) => (v == null ? '—' : Number(Math.round(v * 1000) / 1000).toLocaleString('en-GB'));
const money = (v) => (v == null ? '—' : `£${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const jiraLink = (key) => (key ? `<a href="${esc(H.me().jiraBaseUrl)}/browse/${esc(key)}" target="_blank" rel="noopener">${esc(key)}</a>` : '');
const STATE = { in: ['✅', 'All in house'], transit: ['➡️', 'Some on the way'], order: ['‼️', 'Needs ordering'], unknown: ['‼️', 'Not a stock item yet'], empty: ['—', 'No parts listed'] };
const stateTag = (s) => `<span class="st-state ${s}" title="${STATE[s]?.[1] || ''}">${STATE[s]?.[0] || ''} <span>${STATE[s]?.[1] || ''}</span></span>`;
const prio = (p) => `<span class="st-prio ${String(p || '').toLowerCase()}">${esc(p)}</span>`;
const ACTIONS = { receive: 'Taken in', reserve: 'Held for a job', pick: 'Picked', 'bin-take': 'Taken from bin', 'bin-return': 'Returned to bin', return: 'Brought back', consume: 'Used (Hardware complete)',
  release: 'Released', reassign: 'Moved to another job', quarantine: 'Quarantined', 'write-off': 'Written off', issue: 'Problem reported', relocate: 'Moved', 'count-adjust': 'Count adjusted',
  'return-override': 'Brought back after Hardware complete', ordered: 'Ordered', priority: 'Priority', complete: 'Hardware complete', reopen: 'Reopened', 'order-status': 'Work order status' };
const STATUS = { available: 'Free', reserved: 'Held', picked: 'Picked', consumed: 'Used', quarantine: 'Quarantine', gone: 'Gone' };

const TABS = [['orders', 'Work orders'], ['intake', 'Intake'], ['stock', 'Stock'], ['checks', 'Checks'], ['trace', 'Trace'], ['dash', 'Dashboard']];

// ---------- drawing ----------

export async function render() {
  if (S.inSettings) { S.inSettings = false; S.tab = S.tabBefore || 'orders'; }
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  if (p.get('tab') && TABS.some(([k]) => k === p.get('tab'))) { S.tab = p.get('tab'); history.replaceState(null, '', '#/stock'); }
  await load();
  return html();
}

// The tile's settings (the cog): items, locations, panel defaults, labels, deleted lines and Jira/Xero.
export async function settingsRender() {
  if (!S.inSettings) S.tabBefore = S.tab;
  S.inSettings = true;
  S.tab = 'setup';
  await load();
  return `<div id="st-settings-root">${html()}</div>`;
}

async function load() {
  const t = S.tab;
  try {
    if (!S.me) S.me = await get('settings').catch(() => ({}));
    if (t === 'orders') {
      if (S.orderId) S.order = await get(`order?id=${S.orderId}`);
      else S.orders = await get(`orders?status=${S.orderFilter}`);
    }
    if (t === 'intake') S.expected = await get('expected');
    if (t === 'stock') {
      if (S.stockSub === 'items') { S.items = await get(`items?q=${encodeURIComponent(S.itemQuery)}`); if (S.item) S.item = await itemDetail(S.item.id); }
      if (S.stockSub === 'buy') S.buy = await get('buy');
      if (S.stockSub === 'deliveries') S.expected = await get('expected');
    }
    if (t === 'checks') { S.checks = await get('checks'); if (S.check) S.check = await get(`check?id=${S.check.check.id}`); }
    if (t === 'trace' && S.unit) S.unit = await get(`unit?id=${S.unit.unit.id}`);
    if (t === 'dash') { [S.dash, S.time] = await Promise.all([get('dashboard'), get('time')]); }
    if (t === 'setup') {
      [S.settings, S.locations, S.panels] = await Promise.all([get('settings'), get('locations'), get('panels')]);
      if (S.setupSub === 'items' || S.setupSub === 'panels') S.items = await get('items');
      if (S.setupSub === 'deleted') S.deleted = await get('needs-deleted');
    }
  } catch (err) { S.error = err.message; }
}

function html() {
  const err = S.error ? `<div class="card notice"><p style="margin:0">${esc(S.error)}</p></div>` : '';
  S.error = null;
  const q = queue();
  if (S.inSettings) return `<div class="st">${err}${setupHtml()}</div>`;
  return `<div class="st">
    <nav class="st-tabs" aria-label="Stock">${TABS.map(([k, l]) => `<button class="st-tab${S.tab === k ? ' on' : ''}" data-st-tab="${k}">${l}</button>`).join('')}</nav>
    ${q.length ? `<div class="card notice st-queue"><p style="margin:0"><strong>${q.length} scan${q.length === 1 ? '' : 's'} waiting to send.</strong> They go as soon as there's signal. <button class="linklike" data-st-flush>Send now</button></p></div>` : ''}
    ${err}
    ${({ orders: ordersHtml, intake: intakeHtml, stock: stockHtml, checks: checksHtml, trace: traceHtml, dash: dashHtml, setup: setupHtml })[S.tab]()}
  </div>`;
}

function redraw() {
  const focus = document.activeElement?.id;
  const pos = document.activeElement?.selectionStart;
  const root = S.inSettings ? document.getElementById('st-settings-root') : view;
  if (!root) return;
  root.innerHTML = html();
  if (focus) { const el = document.getElementById(focus); if (el) { el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch { /* not text */ } } }
  else focusScan();
}
async function refresh() { await load(); redraw(); }
function focusScan() {
  // A scan box on screen takes the scanner's typing straight away, but not on a phone,
  // where it would pop the keyboard up.
  const box = view.querySelector('[data-st-scanbox]');
  if (box && !matchMedia('(pointer: coarse)').matches) box.focus();
}

const scanBox = (id, placeholder, extra = '') => `<form class="st-scan" data-st-form="${id}">
    <input id="st-scan-${id}" data-st-scanbox name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${esc(placeholder)}" ${extra}>
    <button class="btn" type="submit">Go</button>
    <button class="btn secondary st-cam" type="button" data-st-cam="${id}" aria-label="Scan with the camera">${CAM_ICON}</button>
  </form>`;
const CAM_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3M7 12h10"/></svg>';

// ---------- work orders ----------

function ordersHtml() {
  if (S.orderId && S.order) return orderHtml();
  const d = S.orders;
  if (!d) return '<p class="muted">Loading…</p>';
  const q = S.orderQuery.toLowerCase();
  const customers = [...new Set(d.orders.map((o) => o.customer).filter(Boolean))].sort();
  const teamOf = (o) => (o.team === 'Condor' ? 'Projecting' : o.team);
  const list = d.orders.filter((o) => (!q || [o.key, o.summary, o.orderSummary, o.customer, o.epicKey].some((x) => String(x || '').toLowerCase().includes(q)))
    && (!S.orderCustomer || o.customer === S.orderCustomer) && (!S.orderTeam || teamOf(o) === S.orderTeam));
  const counts = { order: d.orders.filter((o) => o.state === 'order').length, transit: d.orders.filter((o) => o.state === 'transit').length, in: d.orders.filter((o) => o.state === 'in').length };
  return `<div class="row st-tools">
      <span class="segment">${[['open', 'Open'], ['done', 'Finished']].map(([k, l]) => `<button class="seg${S.orderFilter === k ? ' on' : ''}" data-st-ofilter="${k}">${l}</button>`).join('')}</span>
      <input type="search" id="st-oq" placeholder="Search job or key" value="${esc(S.orderQuery)}">
      <select data-st-ocust aria-label="Customer"><option value="">Every customer</option>${customers.map((c) => `<option${S.orderCustomer === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select data-st-oteam aria-label="Team"><option value="">Both teams</option>${['Projecting', 'Service'].map((t) => `<option${S.orderTeam === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
      <button class="btn secondary small" data-st-sync>Refresh from Jira</button>
    </div>
    <p class="muted st-sub">${d.synced?.error ? `Couldn't read Jira just now: ${esc(d.synced.error)}` : `Read from Jira ${d.lastSync ? when(d.lastSync) : 'not yet'}`} · ${counts.order} need ordering · ${counts.transit} waiting on deliveries · ${counts.in} all in house</p>
    ${list.length ? `<div class="st-table-wrap"><table class="st-table st-orders"><thead><tr><th>ID</th><th>Job</th><th>Priority</th><th>Status</th><th>Needed by</th></tr></thead><tbody>
      ${list.map((o) => `<tr data-st-order="${o.id}" class="st-click">
        <td><strong>${esc(o.key)}</strong>${o.kind === 'manual' ? '<br><span class="muted small">Held by hand</span>' : ''}</td>
        <td>${esc(o.customer || '')}<br><span class="muted">${esc(o.orderSummary || o.summary || '')}</span>${o.team ? ` <span class="st-team">${esc(o.team)}</span>` : ''}</td>
        <td>${prio(o.priority)}${o.override ? '<span class="muted small"> set</span>' : ''}</td>
        <td>${stateTag(o.state)}${o.expired ? ' <span class="st-flag bad" title="Held stock is out of date">Out of date</span>' : o.expiring ? ' <span class="st-flag warn" title="Held stock runs out of date soon">Expiring</span>' : ''}${o.status === 'paused' ? ' <span class="st-flag">Paused</span>' : ''}${o.status === 'complete' ? ' <span class="st-flag ok">Hardware complete</span>' : ''}</td>
        <td>${day(o.neededBy)}</td></tr>`).join('')}
    </tbody></table></div>` : `<section class="card"><p class="muted">${d.orders.length ? 'Nothing matches.' : S.orderFilter === 'open' ? 'No open hardware on customer orders.' : 'Nothing finished yet.'}</p></section>`}
    <section class="card st-manual"><h3>Hold stock against any Jira item</h3>
      <p class="muted">For consumables and spares for a site visit: hold them so nobody else takes them.</p>
      <form class="row" data-st-form="manual"><input name="key" placeholder="Jira key, such as WYNNL-704" autocomplete="off" autocapitalize="characters"><button class="btn" type="submit">Open it</button></form>
    </section>`;
}

function orderHtml() {
  const d = S.order; const o = d.order;
  const locked = o.status === 'complete';
  const lineRow = (l) => {
    if (!l.item) return `<tr class="st-unknown"><td colspan="3"><strong>${esc(l.text)}</strong><br><span class="muted small">From ${esc(sourceName(l.source))} · not a stock item yet</span>
        ${locked ? '' : `<div class="st-link"><input data-st-linkq="${l.needId}" placeholder="Find the stock item it is" autocomplete="off"><div class="st-sugg" id="st-link-${l.needId}"></div></div>
        <button class="linklike" data-st-newfor="${l.needId}" data-text="${esc(l.text)}">Not in stock yet? Make it a new stock item</button>`}</td>
      <td>${qty(l.qty)}</td><td></td><td>${stateTag('unknown')}</td><td>${locked ? '' : `<button class="linklike danger" data-st-needdel="${l.needId}">Delete</button>`}</td></tr>`;
    if (l.merged) return '';
    const marks = `${l.expired ? ' <span class="st-flag bad">Out of date</span>' : l.expiring ? ' <span class="st-flag warn">Expiring soon</span>' : ''}`;
    const status = l.state === 'in' ? stateTag('in') : `${stateTag(l.state)}<br><span class="small">${l.toOrder > 0 ? `${qty(l.toOrder)} to order` : ''}${l.toOrder > 0 && l.onWay > 0 ? ' · ' : ''}${l.onWay > 0 ? `${qty(l.onWay)} on the way` : ''}</span>`;
    const avl = l.item.mode === 'bin' ? `${qty(l.free)} <span class="muted small">in bins</span>` : `${qty(l.reserved + l.picked)}${l.free > 0 && l.reserved + l.picked + l.consumed < l.qty ? ` <span class="muted small">+${qty(l.free)} free</span>` : ''}`;
    return `<tr><td><strong>${esc(l.item.name)}</strong>${marks}<br><span class="muted small">${esc(l.item.code || '')}${l.item.mode === 'bin' ? ' · bin' : ''} · from ${esc(sourceName(l.source))}</span></td>
      <td>${avl}</td><td>${qty(l.picked)} <span class="muted small">out</span><br>${qty(l.consumed)} <span class="muted small">used</span></td>
      <td>${locked ? '' : `<input class="st-qty" type="number" min="0" step="any" value="${l.qty}" data-st-needqty="${l.needId}" aria-label="Quantity needed">`}</td>
      <td>${locked ? qty(l.qty) : esc(l.item.unit || '')}</td><td>${status}</td><td>${locked ? '' : `<button class="linklike danger" data-st-needdel="${l.needId}">Delete</button>`}</td></tr>`;
  };
  const subs = o.subtasks || [];
  return `<button class="linklike" data-st-back>‹ All work orders</button>
    <section class="card st-head">
      <div class="st-head-top"><div><h2 style="margin:0">${jiraLink(o.key)} ${esc(o.orderSummary || o.summary || '')}</h2>
        <p class="muted" style="margin:.2rem 0 0">${esc(o.customer || '')}${o.epicKey ? ` · order ${jiraLink(o.epicKey)}` : ''}${o.team ? ` · ${esc(o.team)}` : ''}${o.kind === 'manual' ? ' · held by hand' : ''}</p></div>
        <div class="st-head-prio">${prio(o.priority)}${d.canLead && !locked ? `<select data-st-prio aria-label="Priority"><option value="">From the dates (${esc(o.auto)})</option>${['Emergency', 'High', 'Standard', 'Low'].map((p) => `<option${o.override === p ? ' selected' : ''}>${p}</option>`).join('')}</select>` : ''}
          ${o.override ? `<span class="muted small">Set by ${esc(o.overrideBy || 'a lead')}</span>` : ''}</div></div>
      <dl class="st-facts"><div><dt>Status</dt><dd>${stateTag(o.state)}</dd></div><div><dt>Needed by</dt><dd>${day(o.neededBy)}</dd></div><div><dt>Start</dt><dd>${day(o.start)}</dd></div><div><dt>End</dt><dd>${day(o.end)}</dd></div>
        ${o.cost !== undefined ? `<div><dt>Parts cost so far</dt><dd>${money(o.cost)}</dd></div>` : ''}<div><dt>Work order</dt><dd>${esc({ open: 'Open', paused: 'Paused', cancelled: 'Cancelled', complete: 'Hardware complete', closed: 'Closed in Jira' }[o.status] || o.status)}</dd></div></dl>
      ${subs.length ? `<div class="st-subs">${subs.map((s) => `<span class="st-sub-item ${s.cat || ''}">${jiraLink(s.key)} ${esc(s.summary)} <em>${esc(s.status)}</em></span>`).join('')}</div>` : ''}
      ${o.priority === 'Emergency' && d.canLead && !locked ? '<p style="margin:.75rem 0 0"><button class="btn small" data-st-takefrom>Take stock from lower-priority jobs</button></p>' : ''}
    </section>

    <section class="card"><h3>Required stock</h3>
      ${d.lines.length ? `<div class="st-table-wrap"><table class="st-table"><thead><tr><th>Item</th><th>Avl</th><th>Consumed</th><th>Qty req</th><th>Unit</th><th>Status</th><th></th></tr></thead><tbody>${d.lines.map(lineRow).join('')}</tbody></table></div>`
        : `<p class="muted">${o.poKey ? `Nothing could be read from ${jiraLink(o.poKey)}'s description.` : 'No Purchase Order item was found under this hardware, so nothing was read from Jira.'} Add what's needed below, or start from a panel's defaults.</p>`}
      ${locked ? '' : `<div class="st-add">
        <div class="st-link"><input id="st-addq" placeholder="Add a stock item" autocomplete="off"><div class="st-sugg" id="st-add-sugg"></div></div>
        ${d.panels.length ? `<form class="row" data-st-form="panel"><select name="panel">${d.panels.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
          <label class="st-inline">× <input name="count" type="number" min="1" max="50" value="1" class="st-qty"></label><button class="btn secondary small" type="submit">Add panel defaults</button></form>` : ''}
      </div>`}
      ${d.poText ? `<details class="st-po"><summary>What the Purchase Order item says</summary><pre>${esc(d.poText)}</pre></details>` : ''}
    </section>

    ${locked ? '' : `<section class="card"><h3>Take stock out</h3>
      ${o.status !== 'open' ? '<p class="muted">This work order is paused.</p>' : scanBox('pick', 'Scan a stock label, product barcode or bin')}
      ${S.binAsk ? binAskHtml() : ''}
      ${d.pick.length ? `<div class="st-table-wrap"><table class="st-table st-pick"><thead><tr><th>Lot</th><th>Item</th><th>Area</th><th>Location</th><th>Qty req</th><th></th></tr></thead><tbody>
        ${d.pick.map((u) => `<tr><td>${esc(u.lot || u.serial || u.code || '—')}</td><td>${esc(u.item.name)}${u.expiry ? `<br><span class="muted small">Use by ${day(u.expiry)}</span>` : ''}</td><td>${esc(u.location?.area || '')}</td><td><strong>${esc(u.location?.code || '—')}</strong></td><td>${qty(u.qty)} ${esc(u.item.unit || '')}</td>
          <td>${d.canLead ? `<button class="linklike" data-st-reassign="${u.id}">Move</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${d.bins.length ? `<h4>From the bins</h4><ul class="st-list">${d.bins.map((b) => `<li><strong>${esc(b.item.name)}</strong> · ${qty(b.qty)} ${esc(b.item.unit || '')} <span class="muted">from ${b.locations.map((l) => esc(l.code)).join(', ') || 'no bin on record'}</span></li>`).join('')}</ul>` : ''}
      ${!d.pick.length && !d.bins.length ? `<p class="muted">${o.ready ? 'Everything needed is out.' : 'Nothing held on the shelves for this yet.'}</p>` : ''}
      <details class="st-hold"><summary>Hold free stock for this job by hand</summary>
        <form class="row" data-st-form="hold"><div class="st-link"><input id="st-holdq" placeholder="Stock item" autocomplete="off"><input type="hidden" name="itemId" id="st-hold-id"><div class="st-sugg" id="st-hold-sugg"></div></div>
          <input name="qty" type="number" min="0" step="any" value="1" class="st-qty"><button class="btn secondary small" type="submit">Hold it</button></form></details>
    </section>`}

    ${d.out.length ? `<section class="card"><h3>${locked ? 'Used on this job' : 'Out on the bench'}</h3><div class="st-table-wrap"><table class="st-table"><thead><tr><th>Item</th><th>Label</th><th>Qty</th><th>When</th><th></th></tr></thead><tbody>
      ${d.out.map((u) => `<tr><td>${esc(u.item.name)}${u.serial ? `<br><span class="muted small">SN ${esc(u.serial)}</span>` : ''}</td><td>${esc(u.code || '')}</td><td>${qty(u.qty)} ${esc(u.item.unit || '')}</td><td>${when(u.pickedAt)}<br><span class="muted small">${esc(u.pickedBy || '')}</span></td>
        <td class="st-actions">${u.status === 'picked' ? `<button class="linklike" data-st-return="${u.id}">Bring back</button> <button class="linklike" data-st-quar="${u.id}">Damaged</button>`
          : d.canLead ? `<button class="linklike" data-st-override="${u.id}">Bring back</button>` : ''}</td></tr>`).join('')}</tbody></table></div></section>` : ''}

    <section class="card st-finish">
      ${locked ? `<p style="margin:0"><strong>Hardware complete</strong> ${when(o.completedAt)} by ${esc(o.completedBy || '')}.${o.note ? ` ${esc(o.note)}` : ''}</p>
          ${d.canLead ? '<p style="margin:.6rem 0 0"><button class="btn secondary small" data-st-reopen>Reopen</button></p>' : ''}`
        : `<button class="btn" data-st-complete ${o.ready ? '' : 'disabled'}>Hardware complete</button>
          <p class="muted small">${o.ready ? 'Locks what\'s out as used by this job.' : 'Once everything needed is scanned out.'} ${d.jiraMoves ? 'It also closes the Purchase Order and Build items in Jira and starts Testing & Configuration.' : 'Jira items stay as they are (Jira moves are off in the Stock settings).'}</p>
          ${d.canLead ? `<details><summary class="small">More</summary><div class="row" style="margin-top:.5rem">
            ${!o.ready ? '<button class="btn secondary small" data-st-force>Hardware complete anyway</button>' : ''}
            ${o.status === 'open' ? '<button class="btn secondary small" data-st-ostatus="paused">Pause</button>' : '<button class="btn secondary small" data-st-ostatus="open">Carry on</button>'}
            <button class="btn secondary small" data-st-ostatus="cancelled">Cancel</button></div></details>` : ''}`}
    </section>`;
}

const sourceName = (s) => (s === 'jira' ? 'the Purchase Order item' : s === 'jira-edited' ? 'Purchase Order, changed here' : String(s || '').startsWith('panel:') ? `${s.slice(6)} defaults` : 'added here');

function binAskHtml() {
  const b = S.binAsk;
  if (b.again) return `<div class="st-ask card"><p><strong>${esc(b.item.name)}</strong>: ${qty(b.out)} ${esc(b.item.unit)} already out for this job.</p>
    <div class="row"><button class="btn" data-st-binact="take">Required</button><button class="btn secondary" data-st-binact="return">Returning</button><button class="linklike" data-st-bincancel>Cancel</button></div></div>`;
  return `<form class="st-ask card" data-st-form="binqty"><p><strong>${esc(b.item.name)}</strong>${b.location ? ` from ${esc(b.location)}` : ''}: how many ${b.action === 'return' ? 'coming back' : 'taken'}?</p>
    <div class="row"><input name="qty" type="number" min="0" step="any" class="st-qty" value="${b.action === 'return' ? '' : b.suggested ?? ''}" autofocus inputmode="decimal"> <span>${esc(b.item.unit || '')}</span>
    <button class="btn" type="submit">${b.action === 'return' ? 'Return' : 'Take'}</button><button class="linklike" type="button" data-st-bincancel>Cancel</button></div></form>`;
}

// ---------- intake ----------

function intakeHtml() {
  const st = S.intakeStep;
  const exp = S.expected?.expected || [];
  const dueNow = exp.filter((e) => !e.expected_date || e.expected_date <= new Date().toISOString().slice(0, 10));
  let body = '';
  if (!st) {
    body = `${S.lastIntake ? lastIntakeHtml() : ''}
      <section class="card"><h3>Scan what's arrived</h3>${scanBox('intake', 'Scan the barcode on the item or its box')}
        <p class="muted small">No barcode? <button class="linklike" data-st-manual>Enter the item by hand</button></p></section>
      <section class="card"><h3>Expected ${dueNow.length ? 'now' : 'deliveries'}</h3>${expectedTable(dueNow.length ? dueNow : exp, true)}</section>`;
  } else if (st.kind === 'manual') body = manualHtml(st);
  else if (st.kind === 'item') body = receiveHtml(st);
  else if (st.kind === 'issue') body = issueHtml(st);
  else if (st.kind === 'unit' || st.kind === 'location') body = scannedHtml(st);
  return body;
}

function expectedTable(list, receive = false) {
  if (!list.length) return '<p class="muted">Nothing expected. Deliveries show here once they\'re marked as ordered in Stock → To buy.</p>';
  return `<div class="st-table-wrap"><table class="st-table"><thead><tr><th>Item</th><th>Due</th><th>Qty</th><th>For</th><th>PO</th><th></th></tr></thead><tbody>
    ${list.map((e) => `<tr><td><strong>${esc(e.item_name)}</strong><br><span class="muted small">${esc(e.supplier || '')}</span></td><td>${e.late ? `<span class="st-flag bad">Late</span> ` : ''}${day(e.expected_date)}</td>
      <td>${qty(e.due)}</td><td>${e.order_key ? esc(e.order_key) : `<span class="muted">${esc(e.team || 'Stock')}</span>`}</td><td>${esc(e.po_ref || '')}</td>
      <td class="st-actions">${receive ? `<button class="linklike" data-st-recv="${e.id}" data-item="${e.item_id}">Receive</button> <button class="linklike" data-st-issue="${e.id}">Problem</button>` : `<button class="linklike" data-st-expdel="${e.id}">Cancel</button>`}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function lastIntakeHtml() {
  const r = S.lastIntake;
  return `<section class="card st-done"><p style="margin:0"><strong>${qty(r.units.reduce((s, u) => s + u.qty, 0))} ${esc(r.item.unit)} of ${esc(r.item.name)}</strong> into ${esc(r.location)}${r.lot ? `, batch <strong>${esc(r.lot)}</strong>` : ''}${r.poRef ? ` from ${esc(r.poRef)}` : ''}.
    ${[...new Set(r.units.filter((u) => u.orderKey).map((u) => u.orderKey))].map((k) => `Held for ${esc(k)}.`).join(' ')}</p>
    <p style="margin:.5rem 0 0"><button class="btn secondary small" data-st-printunits="${r.units.map((u) => u.id).join(',')}">Print ${r.units.length === 1 ? 'its label' : `${r.units.length} labels`}</button>
    <button class="linklike" data-st-dismiss>Done</button></p></section>`;
}

const itemFields = (i = {}, { compact = false } = {}) => `
  <div class="st-grid">
    <label>Name <input name="name" value="${esc(i.name || '')}" required></label>
    <label>Our code <input name="code" value="${esc(i.code || '')}" placeholder="Made for you if left blank"></label>
    <label>Kind <select name="mode">${[['serial', 'One at a time (each scanned and labelled)'], ['batch', 'By quantity (boxes and packs)'], ['bin', 'Bin (screws and the like, quantity only)']].map(([k, l]) => `<option value="${k}"${(i.mode || 'batch') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Unit <input name="unit" value="${esc(i.unit || 'each')}" placeholder="each, m, box"></label>
    <label>Weight <select name="weight">${[['light', 'Light'], ['moderate', 'Moderate'], ['heavy', 'Heavy']].map(([k, l]) => `<option value="${k}"${(i.weight || 'light') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Category <input name="category" value="${esc(i.category || '')}" placeholder="Contactors, cable, PLCs" list="st-cats"></label>
    <label>Supplier <input name="supplier" value="${esc(i.supplier || '')}"></label>
    <label>Supplier part no. <input name="supplier_part" value="${esc(i.supplier_part || '')}"></label>
    <label>Manufacturer <input name="manufacturer" value="${esc(i.manufacturer || '')}"></label>
    <label>Manufacturer part no. <input name="mpn" value="${esc(i.mpn || '')}"></label>
    ${S.me?.canManage ? `<label>Unit cost (£) <input name="unit_cost" type="number" min="0" step="0.01" value="${i.unit_cost ?? ''}"></label>` : ''}
    <label>Days to arrive <input name="lead_days" type="number" min="0" value="${i.lead_days ?? ''}"></label>
    <label>Shelf life (days) <input name="shelf_life_days" type="number" min="0" value="${i.shelf_life_days ?? ''}" placeholder="Leave blank if it doesn't expire"></label>
    <label>Keep at least <input name="min_qty" type="number" min="0" step="any" value="${i.min_qty ?? ''}"></label>
    <label>Usually order <input name="reorder_qty" type="number" min="0" step="any" value="${i.reorder_qty ?? ''}"></label>
    <label class="st-check"><input type="checkbox" name="two_bin" ${i.two_bin ? 'checked' : ''}> Two-bin: reorder when the first bin empties</label>
  </div>
  <label>Description <input name="description" value="${esc(i.description || '')}"></label>
  ${compact ? '' : `<label>Barcodes and other codes <input name="aliases" value="${esc((i.aliases || []).join(', '))}" placeholder="Separate with commas"></label>`}`;

const labelSummary = (L) => [L.mpn && `part ${esc(L.mpn)}`, L.supplierPart && L.supplierPart !== L.mpn && `supplier part ${esc(L.supplierPart)}`, L.manufacturer && esc(L.manufacturer), L.qty && `qty ${qty(L.qty)}`,
  L.lot && `lot ${esc(L.lot)}`, L.dateCode && `date code ${esc(L.dateCode)}`, L.expiry && `use by ${day(L.expiry)}`, L.serial && `serial ${esc(L.serial)}`, L.po && `PO ${esc(L.po)}`, L.gtin && `barcode ${esc(L.gtin)}`].filter(Boolean).join(' · ');

function manualHtml(st) {
  const L = st.label || {};
  // A plain code that isn't a shop barcode is usually the maker's part number (as on RS and Farnell bags).
  const plainPart = !st.label && st.code && !/^\d{8}$|^\d{12,14}$/.test(st.code) ? st.code : null;
  const prefill = { name: st.q || [L.manufacturer, L.mpn].filter(Boolean).join(' '), mpn: L.mpn || plainPart || '', supplier_part: L.supplierPart || '', manufacturer: L.manufacturer || '' };
  return `<button class="linklike" data-st-cancel>‹ Back</button>
    <section class="card"><h3>${st.label ? `${esc(L.mpn || L.supplierPart || L.gtin)} isn't a stock item yet` : st.code ? `${esc(st.code)} isn't on record` : 'Enter the item by hand'}</h3>
      ${st.label ? `<p class="st-read small">Read from the label: ${labelSummary(L)}</p>` : ''}
      <p class="muted">Start typing: if it's already a stock item, choose it${st.code ? ' and the barcode is added to it' : ''}.</p>
      <div class="st-link"><input id="st-manq" placeholder="Name, part number or supplier code" autocomplete="off" value="${esc(st.q || '')}"><div class="st-sugg" id="st-man-sugg"></div></div>
    </section>
    ${st.code ? barcodeHtml(st) : ''}
    <form class="card" data-st-form="newitem"><h3>Or make it a new stock item</h3>${itemFields(prefill, { compact: true })}
      <input type="hidden" name="aliases" value="${esc(st.code || '')}">
      <button class="btn" type="submit">Add it and take it in</button></form>`;
}

// What a shop barcode says the product is, from the lookup service.
function barcodeHtml(st) {
  const b = st.barcode;
  if (!b) return '<section class="card st-bc"><p class="muted" style="margin:0">Looking the barcode up…</p></section>';
  if (!b.checked && b.reason === 'not-a-product-barcode') return '';
  const why = { limit: 'Today\'s barcode lookups have run out (the free plan allows 100 a day).', busy: 'The barcode lookup is busy. Try again in a minute.', error: 'The barcode lookup couldn\'t be reached.' }[b.reason];
  return `<section class="card st-bc"><h3 style="margin-top:0">This might be</h3>
    ${why ? `<p class="muted">${why} <button class="linklike" data-st-bcretry>Try again</button></p>` : ''}
    ${b.existing.length ? `<p class="small muted" style="margin-bottom:.3rem">Already a stock item?</p><div class="st-bc-list">${b.existing.map((i) => `<button type="button" class="st-chip" data-st-useitem="${i.id}"><strong>${esc(i.name)}</strong><span>${esc(i.code || '')}${i.supplier ? ` · ${esc(i.supplier)}` : ''}</span></button>`).join('')}</div>` : ''}
    ${b.items.length ? `<p class="small muted" style="margin-bottom:.3rem">From the barcode${b.existing.length ? ', as a new item' : ''}</p>${b.items.map((i, k) => `<div class="st-bc-item">${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        <div><strong>${esc(i.title)}</strong><br><span class="muted small">${[i.brand, i.model, i.category].filter(Boolean).map(esc).join(' · ')}</span></div>
        <button type="button" class="btn secondary small" data-st-bcuse="${k}">Use these details</button></div>`).join('')}`
      : !why ? '<p class="muted" style="margin:0">The barcode isn\'t in the lookup service. Enter the details below.</p>' : ''}
  </section>`;
}

async function loadBarcode(code) {
  try { S.intakeStep.barcode = await get(`barcode?code=${encodeURIComponent(code)}`); }
  catch { S.intakeStep.barcode = { checked: false, reason: 'error', items: [], existing: [] }; }
  // Only the suggestions are redrawn, so anything already typed into the form stays.
  if (S.intakeStep?.code !== code) return;
  const box = view.querySelector('.st-bc');
  if (box) box.outerHTML = barcodeHtml(S.intakeStep) || '';
  else redraw();
}

function receiveHtml(st) {
  const i = st.item;
  const exp = st.expected || [];
  const sugg = st.putaway?.suggestions || [];
  const L = st.label || {};
  const chosen = exp.find((e) => e.id === st.expectedId);
  const po = L.po || chosen?.po_ref || null;
  const each = st.each || [];
  return `<button class="linklike" data-st-cancel>‹ Back</button>
    <form class="card" data-st-form="receive"><h3>${esc(i.name)}</h3>
      ${st.label ? `<p class="st-read small">Read from the label: ${labelSummary(L)}</p>` : ''}
      <p class="muted">${esc(i.code || '')}${i.supplier ? ` · ${esc(i.supplier)}` : ''} · ${esc({ batch: 'By quantity', serial: 'One at a time', bin: 'Bin item' }[i.mode])}</p>
      ${exp.length ? `<label>Which delivery is it? <select name="expectedId" data-st-expsel>${exp.map((e) => `<option value="${e.id}"${st.expectedId === e.id ? ' selected' : ''}>${qty(e.qty - e.received_qty - (e.issue_qty || 0))} due${e.order_key ? ` for ${esc(e.order_key)}` : ''}${e.po_ref ? ` · ${esc(e.po_ref)}` : ''}${e.expected_date ? ` · ${day(e.expected_date)}` : ''}</option>`).join('')}<option value="">Not one of these</option></select></label>`
        : '<p class="muted small">Not expected: it goes into free stock, or to a job that needs it.</p>'}
      ${po ? `<p class="small">PO <strong>${esc(po)}</strong></p>` : ''}
      ${i.mode === 'serial' ? `<div class="st-each">
          <p style="margin:.3rem 0"><strong>Scan each one</strong> <span class="muted small">its barcode, or its serial number label if it has one</span></p>
          <div class="st-scan"><input id="st-each-scan" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Scan the next one" data-st-scanbox>
            <button class="btn secondary st-cam" type="button" data-st-cam="each" aria-label="Scan with the camera">${CAM_ICON}</button></div>
          ${each.length ? `<ol class="st-eachlist">${each.map((u, k) => `<li><span>${u.serial ? `Serial <strong>${esc(u.serial)}</strong>` : '<span class="muted">No serial number</span>'}</span><button type="button" class="linklike danger" data-st-eachdel="${k}">Take off</button></li>`).join('')}</ol>` : ''}
          <p class="row small"><strong>${each.length}</strong>&nbsp;scanned${chosen ? ` of ${qty(chosen.qty - chosen.received_qty - (chosen.issue_qty || 0))} due` : ''} <button type="button" class="linklike" data-st-eachadd>Add one with no barcode</button></p>
        </div>`
        : `<label>Quantity <input name="qty" type="number" min="0" step="any" required inputmode="decimal" value="${st.qty ?? L.qty ?? ''}"> <span class="muted small">${esc(i.unit)}</span></label>`}
      <h4>Where it goes</h4>
      ${sugg.length ? `<div class="st-putaway">${sugg.map((s, k) => `<button type="button" class="st-chip${st.location === s.code || (!st.location && k === 0) ? ' on' : ''}" data-st-loc="${esc(s.code)}"><strong>${esc(s.code)}</strong><span>${esc(s.why)}</span></button>`).join('')}</div>` : '<p class="muted small">No locations yet. They\'re added in the Stock settings.</p>'}
      <label for="st-recv-loc">Scan the location</label>
      <div class="st-scan"><input name="location" id="st-recv-loc" value="${esc(st.location || sugg[0]?.code || '')}" autocomplete="off" autocapitalize="characters">
        <button class="btn secondary st-cam" type="button" data-st-cam="loc" aria-label="Scan the location with the camera">${CAM_ICON}</button></div>
      <label class="st-check"><input type="checkbox" name="makeUsual" ${i.usual_location ? '' : 'checked'}> Make this where it usually goes</label>
      <div class="row"><button class="btn" type="submit">Confirm</button><button class="btn secondary" type="button" data-st-issue="${st.expectedId || ''}" data-item="${i.id}">Problem with it</button></div>
    </form>`;
}

// One more of a one-at-a-time item: its serial number if what was scanned was one, otherwise just counted.
function addEach(code) {
  const st = S.intakeStep;
  if (!st || st.kind !== 'item') return;
  const c = String(code || '').trim();
  st.each ||= [];
  let serial = null;
  if (c) {
    const label = parseLabelLite(c);
    const i = st.item;
    const known = [st.code, i.code, i.mpn, i.supplier_part, ...(i.aliases || [])].filter(Boolean).map((x) => String(x).toUpperCase());
    if (label) serial = label.serial || null;
    else if (!known.includes(c.toUpperCase()) && !/^\d{8}$|^\d{12,14}$/.test(c)) serial = c;
  }
  if (serial && st.each.some((u) => u.serial && u.serial.toUpperCase() === serial.toUpperCase())) { H.toast(`Serial ${serial} is already scanned.`); return; }
  st.each.push({ serial });
  beep(true);
  redraw();
  document.getElementById('st-each-scan')?.focus();
}

// Just enough of a supplier label to find a serial number in it (the server reads the rest).
function parseLabelLite(c) {
  if (/^\[\)>/.test(c)) { const m = c.split(/[\x1d\x1e]/).find((f) => /^1?S/.test(f) && !/^1?S\s*$/.test(f)); return { serial: m ? m.replace(/^1?S/, '') : null }; }
  const g = c.replace(/^\][A-Za-z]\d/, '').replace(/^\x1d/, '');
  if (/^\(01\)/.test(g)) { const m = g.match(/\(21\)([^(]+)/); return { serial: m ? m[1].trim() : null }; }
  if (/^01\d{14}/.test(g)) { const m = g.match(/(?:^01\d{14}|\x1d)21([^\x1d]+)/); return { serial: m ? m[1] : null }; }
  return null;
}

function issueHtml(st) {
  return `<button class="linklike" data-st-cancel>‹ Back</button>
    <form class="card" data-st-form="issue"><h3>Problem with a delivery</h3>
      <p class="muted">It's taken off what's expected, and the job it was for shows it as needing ordering again.</p>
      <label>What's wrong <select name="reason"><option>Damaged</option><option>Wrong item</option><option>Short delivered</option><option>Not coming</option><option>Faulty</option></select></label>
      <label>How many <input name="qty" type="number" min="0" step="any" required value="${st.qty ?? ''}"></label>
      <label>Note <input name="note" placeholder="Optional"></label>
      <button class="btn" type="submit">Report it</button></form>`;
}

function scannedHtml(st) {
  if (st.kind === 'location') {
    return `<button class="linklike" data-st-cancel>‹ Back</button><section class="card"><h3>${esc(st.location.code)}</h3><p class="muted">${esc(st.location.area || '')} · ${esc(st.location.level)} shelf</p>
      ${st.units.length ? unitTable(st.units) : '<p class="muted">Empty.</p>'}</section>`;
  }
  return `<button class="linklike" data-st-cancel>‹ Back</button><section class="card"><h3>Already in stock</h3><p class="muted">That label is on stock already taken in.</p>${unitTable(st.units)}
    <p><button class="btn secondary small" data-st-totrace="${st.units[0].id}">See its history</button></p></section>`;
}

function unitTable(units, { actions = false } = {}) {
  return `<div class="st-table-wrap"><table class="st-table"><thead><tr><th>Label</th><th>Item</th><th>Lot / SN</th><th>Qty</th><th>Where</th><th>Status</th>${actions ? '<th></th>' : ''}</tr></thead><tbody>
    ${units.map((u) => `<tr><td><button class="linklike" data-st-totrace="${u.id}">${esc(u.code || '—')}</button></td><td>${esc(u.item.name)}</td><td>${esc(u.serial || u.lot || '')}${u.expiry ? `<br><span class="muted small">Use by ${day(u.expiry)}</span>` : ''}</td>
      <td>${qty(u.qty)}</td><td>${esc(u.location?.code || '—')}</td><td>${esc(STATUS[u.status] || u.status)}${u.orderKey ? ` · ${esc(u.orderKey)}` : ''}</td>
      ${actions ? `<td class="st-actions">${['available', 'reserved', 'quarantine'].includes(u.status) ? `<button class="linklike" data-st-move="${u.id}">Move</button>` : ''}
        ${['available', 'reserved'].includes(u.status) ? ` <button class="linklike" data-st-quar="${u.id}">Damaged</button>` : ''}
        ${u.status === 'reserved' || u.status === 'available' ? ` <button class="linklike" data-st-reassign="${u.id}">Job</button>` : ''}
        ${u.status === 'quarantine' ? ` <button class="linklike" data-st-qrel="${u.id}">Release</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- stock ----------

function stockHtml() {
  const subs = [['items', 'Items'], ['buy', 'To buy'], ['deliveries', 'Deliveries']];
  return `<div class="row st-tools"><span class="segment">${subs.map(([k, l]) => `<button class="seg${S.stockSub === k ? ' on' : ''}" data-st-ssub="${k}">${l}</button>`).join('')}</span></div>
    ${({ items: itemsHtml, buy: buyHtml, deliveries: deliveriesHtml })[S.stockSub]()}`;
}

function itemsHtml() {
  if (S.item) return itemDetailHtml();
  const d = S.items;
  if (!d) return '<p class="muted">Loading…</p>';
  return `<input type="search" id="st-iq" placeholder="Search name, code, supplier or barcode" value="${esc(S.itemQuery)}" class="st-search">
    ${d.items.length ? `<div class="st-table-wrap"><table class="st-table"><thead><tr><th>Item</th><th>Total</th><th>Available</th><th>Held</th><th>Picked</th><th>On the way</th><th>To order</th></tr></thead><tbody>
      ${d.items.map((i) => `<tr class="st-click" data-st-item="${i.id}"><td><strong>${esc(i.name)}</strong>${i.low ? ' <span class="st-flag warn">Low</span>' : ''}<br><span class="muted small">${esc(i.code || '')}${i.mode === 'bin' ? ' · bin' : i.mode === 'serial' ? ' · serial' : ''}${i.supplier ? ` · ${esc(i.supplier)}` : ''}</span></td>
        <td>${qty(i.total)}</td><td>${qty(i.available)}</td><td>${qty(i.reserved)}</td><td>${qty(i.picked)}</td><td>${qty(i.transit)}</td><td>${i.toOrder ? `<strong>${qty(i.toOrder)}</strong>` : '0'}</td></tr>`).join('')}
    </tbody></table></div>` : '<section class="card"><p class="muted">No stock items yet. They\'re added as they arrive at Intake, or from Quoter in the Stock settings.</p></section>'}`;
}

async function itemDetail(id) {
  const items = (await get(`items`)).items;
  const item = items.find((i) => i.id === Number(id));
  const units = (await get(`trace?itemId=${id}`)).units.filter((u) => ['available', 'reserved', 'picked', 'quarantine'].includes(u.status));
  return { ...item, units };
}

function itemDetailHtml() {
  const i = S.item;
  if (!i) return '';
  return `<button class="linklike" data-st-itemback>‹ All items</button>
    <section class="card"><h3 style="margin-top:0">${esc(i.name)}</h3><p class="muted">${esc(i.code || '')}${i.supplier ? ` · ${esc(i.supplier)} ${esc(i.supplier_part || '')}` : ''}${S.me?.canManage && i.unit_cost != null ? ` · ${money(i.unit_cost)} each` : ''}</p>
      <dl class="st-facts"><div><dt>Total</dt><dd>${qty(i.total)}</dd></div><div><dt>Available</dt><dd>${qty(i.available)}</dd></div><div><dt>Held for jobs</dt><dd>${qty(i.reserved)}</dd></div>
        <div><dt>Picked</dt><dd>${qty(i.picked)}</dd></div><div><dt>Quarantine</dt><dd>${qty(i.quarantine)}</dd></div><div><dt>On the way</dt><dd>${qty(i.transit)}</dd></div><div><dt>To order</dt><dd>${qty(i.toOrder)}</dd></div></dl>
      ${i.units.length ? unitTable(i.units, { actions: true }) : '<p class="muted">None in stock.</p>'}
      <p class="row"><button class="btn secondary small" data-st-printitem="${i.id}">Print item label</button>${i.units.length ? `<button class="btn secondary small" data-st-printunits="${i.units.map((u) => u.id).join(',')}">Print stock labels</button>` : ''}
        <button class="btn secondary small" data-st-expnew="${i.id}">Expect a delivery</button></p>
    </section>`;
}

function buyHtml() {
  const d = S.buy;
  if (!d) return '<p class="muted">Loading…</p>';
  const pr = { Emergency: 0, High: 1, Standard: 2, Low: 3 };
  return `${d.unknown.length ? `<section class="card notice"><p style="margin:0"><strong>${d.unknown.length} line${d.unknown.length === 1 ? '' : 's'} on work orders aren't stock items yet</strong>, so they can't be added up here: ${d.unknown.slice(0, 6).map((u) => `${esc(u.key)} "${esc(u.text)}"`).join(', ')}${d.unknown.length > 6 ? '…' : ''}. Link them on each work order.</p></section>` : ''}
    ${d.suppliers.length ? d.suppliers.map((s, si) => `<form class="card" data-st-form="ordered" data-supplier="${esc(s.supplier)}"><h3 style="margin-top:0">${esc(s.supplier)}${s.cost != null ? ` <span class="muted small">${money(s.cost)}</span>` : ''}</h3>
      <div class="st-table-wrap"><table class="st-table"><thead><tr><th></th><th>Item</th><th>Qty</th><th>For</th><th>Why</th></tr></thead><tbody>
      ${s.lines.map((l, li) => `<tr><td><input type="checkbox" name="pick" value="${si}:${li}" checked></td><td><strong>${esc(l.item.name)}</strong><br><span class="muted small">${esc(l.item.code || '')} ${esc(l.item.supplier_part || '')}</span></td>
        <td><input class="st-qty" type="number" min="0" step="any" name="qty-${si}-${li}" value="${l.qty}"></td>
        <td>${l.orders.map((o) => `${esc(o.key)} ${prio(o.priority)}`).join('<br>') || `<span class="muted">Stock${l.team ? ` (${esc(l.team)})` : ''}</span>`}</td><td class="small">${esc(l.reasons.join('; ') || 'Short on jobs')}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="row"><input name="poRef" placeholder="PO number" autocomplete="off"><label class="st-inline">Expected <input type="date" name="expectedDate"></label><button class="btn" type="submit">Mark as ordered</button></div>
    </form>`).join('') : '<section class="card"><p class="muted">Nothing needs buying.</p></section>'}`;
}

function deliveriesHtml() {
  const exp = S.expected?.expected || [];
  return `<section class="card"><h3 style="margin-top:0">On the way</h3>${expectedTable(exp)}</section>
    <section class="card"><h3 style="margin-top:0">Stock orders</h3><p class="muted">Purchase orders come from Xero once it's linked. Until then, mark things as ordered from To buy, or from an item.</p>
      ${S.me?.canManage ? '<button class="btn secondary small" data-st-recheck>Re-check stock orders</button>' : ''}</section>`;
}

function expectedFormHtml(item) {
  return `<form class="card" data-st-form="expected"><h3 style="margin-top:0">Expect a delivery of ${esc(item.name)}</h3><input type="hidden" name="itemId" value="${item.id}">
    <div class="st-grid"><label>Quantity <input name="qty" type="number" min="0" step="any" required></label><label>Supplier <input name="supplier" value="${esc(item.supplier || '')}"></label>
      <label>PO number <input name="poRef"></label><label>Expected <input type="date" name="expectedDate"></label>
      <label>Ordered by <select name="team"><option value="">Stock (any team)</option><option>Projecting</option><option>Service</option></select></label></div>
    <button class="btn" type="submit">Save</button> <button class="linklike" type="button" data-st-cancelform>Cancel</button></form>`;
}

// ---------- checks ----------

function checksHtml() {
  if (S.counting) return countingHtml();
  if (S.check) return checkHtml();
  const d = S.checks;
  if (!d) return '<p class="muted">Loading…</p>';
  const open = d.checks.filter((c) => c.status === 'open');
  const past = d.checks.filter((c) => c.status !== 'open');
  return `${open.length ? `<section class="card"><h3 style="margin-top:0">Counting now</h3><ul class="st-list">${open.map((c) => `<li class="st-click" data-st-check="${c.id}"><strong>${esc(c.name)}</strong>
      <span class="st-bar"><span style="width:${c.locations ? Math.round((c.done / c.locations) * 100) : 0}%"></span></span><span class="muted small">${c.done} of ${c.locations} places · started by ${esc(c.started_by)} ${when(c.started_at)}</span></li>`).join('')}</ul></section>` : ''}
    <section class="card"><h3 style="margin-top:0">Schedules</h3>
      ${d.plans.length ? `<ul class="st-list">${d.plans.map((p) => `<li><strong>${esc(p.name)}</strong> ${p.due ? '<span class="st-flag warn">Due</span>' : ''}<br><span class="muted small">${p.areas.length ? esc(p.areas.join(', ')) : 'Every area'} · every ${p.every_days} days · next ${day(p.next_due)}</span>
        <span class="row"><button class="btn small" data-st-startplan="${p.id}">Start counting</button>${S.checks && S.me?.canManage ? `<button class="linklike" data-st-plandel="${p.id}">Remove</button>` : ''}</span></li>`).join('')}</ul>` : '<p class="muted">No schedules yet.</p>'}
      <details><summary>New schedule</summary><form data-st-form="plan" class="st-grid" style="margin-top:.6rem">
        <label>Name <input name="name" placeholder="Shelves A, monthly" required></label><label>Areas <input name="areas" placeholder="Separate with commas; blank for every area"></label>
        <label>Every (days) <input name="every_days" type="number" min="1" value="30"></label><label>First due <input name="next_due" type="date"></label>
        <button class="btn" type="submit">Save schedule</button></form></details>
      <p style="margin:.8rem 0 0"><button class="btn secondary small" data-st-startall>Count everything now</button></p></section>
    ${past.length ? `<section class="card"><h3 style="margin-top:0">Earlier counts</h3><ul class="st-list">${past.map((c) => `<li class="st-click" data-st-check="${c.id}"><strong>${esc(c.name)}</strong> <span class="muted small">${esc(c.status === 'applied' ? 'Applied' : 'Finished, not applied')} · ${when(c.finished_at || c.started_at)}</span></li>`).join('')}</ul></section>` : ''}`;
}

function checkHtml() {
  const d = S.check; const c = d.check;
  const done = d.locations.filter((l) => l.doneAt).length;
  return `<button class="linklike" data-st-checkback>‹ All checks</button>
    <section class="card"><h3 style="margin-top:0">${esc(c.name)}</h3>
      <p class="muted">${done} of ${d.locations.length} places counted${c.status === 'open' ? ' · updates as others count' : ''}</p>
      <span class="st-bar big"><span style="width:${d.locations.length ? Math.round((done / d.locations.length) * 100) : 0}%"></span></span>
      ${c.status === 'open' ? `${scanBox('countloc', 'Scan a location to count it')}` : ''}
      <div class="st-locgrid">${d.locations.map((l) => `<button class="st-loc${l.doneAt ? ' done' : ''}${d.revealed && l.off ? ' off' : ''}" ${c.status === 'open' ? `data-st-countloc="${esc(l.code)}"` : ''} title="${l.doneAt ? `Counted by ${esc(l.doneBy)}` : 'Not counted yet'}">
        <strong>${esc(l.code)}</strong><span>${l.doneAt ? esc(String(l.doneBy || '').split(' ')[0]) : esc(l.area || '')}</span>${d.revealed && l.off ? `<em>${l.off} off</em>` : ''}</button>`).join('')}</div>
      ${c.status === 'open' ? `<p class="row"><button class="btn" data-st-finish ${done ? '' : 'disabled'}>Finish counting</button><span class="muted small">Places not counted are left as they are.</span></p>` : ''}
    </section>
    ${d.revealed ? `<section class="card"><h3 style="margin-top:0">Variance</h3>
      <dl class="st-facts"><div><dt>Lines counted</dt><dd>${d.totals.lines}</dd></div><div><dt>Lines off</dt><dd>${d.totals.off}</dd></div><div><dt>Units</dt><dd>${d.totals.units > 0 ? '+' : ''}${qty(d.totals.units)}</dd></div>${d.totals.value !== undefined ? `<div><dt>Value</dt><dd>${money(d.totals.value)}</dd></div>` : ''}</dl>
      ${d.counts.length ? `<div class="st-table-wrap"><table class="st-table"><thead><tr><th>Location</th><th>Item</th><th>Expected</th><th>Counted</th><th>Variance</th>${S.me?.canManage ? '<th>Value</th>' : ''}</tr></thead><tbody>
        ${d.counts.map((r) => `<tr class="${Math.abs(r.variance) > 1e-9 ? 'st-off' : ''}"><td>${esc(d.locations.find((l) => l.id === r.locationId)?.code || '')}</td><td>${esc(r.name)}</td><td>${qty(r.expected)}</td><td>${qty(r.counted)}</td><td>${r.variance > 0 ? '+' : ''}${qty(r.variance)}</td>${S.me?.canManage ? `<td>${money(r.value)}</td>` : ''}</tr>`).join('')}</tbody></table></div>` : ''}
      <p class="row"><button class="btn secondary small" data-st-export>Download as Excel</button>
        ${c.status === 'finished' && d.canManage ? '<button class="btn small" data-st-apply>Make these the stock records</button>' : c.status === 'applied' ? `<span class="muted small">Applied by ${esc(c.applied_by)} ${when(c.applied_at)}</span>` : ''}</p></section>` : ''}`;
}

function countingHtml() {
  const c = S.counting;
  return `<button class="linklike" data-st-countback>‹ Back to the check</button>
    <form class="card" data-st-form="count"><h3 style="margin-top:0">Counting ${esc(c.location.code)}</h3>
      <p class="muted">${c.done ? `Already counted by ${esc(c.doneBy)}; saving replaces it.` : 'Count what\'s here and enter each number.'}</p>
      ${S.countRows.length ? `<ul class="st-count">${S.countRows.map((r, k) => `<li><span><strong>${esc(r.name)}</strong><br><span class="muted small">${esc(r.code || '')}</span></span>
        <input type="number" min="0" step="any" class="st-qty" data-st-countrow="${k}" value="${r.counted ?? ''}" inputmode="decimal" aria-label="Count of ${esc(r.name)}"> <span class="small">${esc(r.unit || '')}</span></li>`).join('')}</ul>` : '<p class="muted">The records have nothing here.</p>'}
      <div class="st-link"><input id="st-countq" placeholder="Something else is here: scan or type it" autocomplete="off"><div class="st-sugg" id="st-count-sugg"></div></div>
      <button class="btn" type="submit">Save count for ${esc(c.location.code)}</button></form>`;
}

// ---------- trace ----------

function traceHtml() {
  if (S.unit) return unitHtml();
  const q = S.traceQ;
  const rows = S.trace?.units || null;
  return `<form class="card" data-st-form="trace"><h3 style="margin-top:0">Find stock</h3>
      <div class="st-grid"><label>Anything <input name="q" value="${esc(q.q || '')}" placeholder="Label, serial, lot, item, PO or job"></label>
        <label>Status <select name="status"><option value="">Any</option>${Object.entries(STATUS).map(([k, l]) => `<option value="${k}"${q.status === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Supplier <input name="supplier" value="${esc(q.supplier || '')}"></label><label>Customer <input name="customer" value="${esc(q.customer || '')}"></label>
        <label>Job <input name="orderKey" value="${esc(q.orderKey || '')}" placeholder="Jira key"></label>
        <label>Taken in from <input type="date" name="from" value="${esc(q.from || '')}"></label><label>to <input type="date" name="to" value="${esc(q.to || '')}"></label>
        <label class="st-check"><input type="checkbox" name="expiring" ${q.expiring ? 'checked' : ''}> Expiring within 30 days</label></div>
      <button class="btn" type="submit">Search</button></form>
    ${rows ? `<section class="card">${rows.length ? unitTable(rows) : '<p class="muted">Nothing matches.</p>'}${rows.length >= 300 ? '<p class="muted small">The first 300 are shown.</p>' : ''}</section>` : ''}
    <form class="card" data-st-form="recall"><h3 style="margin-top:0">Recall</h3><p class="muted">Everything from a lot or batch: where it is now, and which jobs and customers it went to.</p>
      <div class="row"><input name="lot" placeholder="Lot or batch" autocomplete="off"><input name="supplier" placeholder="Supplier (optional)"><button class="btn" type="submit">Trace it</button></div></form>
    ${S.recall ? `<section class="card"><dl class="st-facts"><div><dt>On the shelf</dt><dd>${qty(S.recall.onShelf)}</dd></div><div><dt>Used or out</dt><dd>${qty(S.recall.used)}</dd></div><div><dt>Jobs</dt><dd>${S.recall.jobs.length}</dd></div><div><dt>Customers</dt><dd>${S.recall.customers.length}</dd></div></dl>
      ${S.recall.jobs.length ? `<ul class="st-list">${S.recall.jobs.map((j) => `<li>${jiraLink(j.key)} ${esc(j.summary || '')} <span class="muted">${esc(j.customer || '')}</span></li>`).join('')}</ul>` : ''}
      ${S.recall.units.length ? unitTable(S.recall.units) : '<p class="muted">Nothing from that lot.</p>'}</section>` : ''}`;
}

function unitHtml() {
  const { unit: u, moves, orders } = S.unit;
  return `<button class="linklike" data-st-unitback>‹ Back</button>
    <section class="card"><h3 style="margin-top:0">${esc(u.code || '')} · ${esc(u.item.name)}</h3>
      <dl class="st-facts"><div><dt>Status</dt><dd>${esc(STATUS[u.status] || u.status)}</dd></div><div><dt>Qty</dt><dd>${qty(u.qty)} ${esc(u.item.unit || '')}</dd></div><div><dt>Where</dt><dd>${esc(u.location?.code || '—')}</dd></div>
        <div><dt>Lot</dt><dd>${esc(u.lot || '—')}</dd></div><div><dt>Serial</dt><dd>${esc(u.serial || '—')}</dd></div><div><dt>Use by</dt><dd>${day(u.expiry)}</dd></div>
        <div><dt>Supplier</dt><dd>${esc(u.supplier || '—')}</dd></div><div><dt>PO</dt><dd>${esc(u.poRef || '—')} ${u.poDate ? day(u.poDate) : ''}</dd></div><div><dt>Taken in</dt><dd>${when(u.receivedAt)}<br><span class="muted small">${esc(u.receivedBy || '')}</span></dd></div>
        ${u.unitCost !== undefined ? `<div><dt>Cost</dt><dd>${money(u.unitCost)}</dd></div>` : ''}<div><dt>Jobs</dt><dd>${orders.map((o) => `${jiraLink(o.key)} <span class="muted small">${esc(o.customer || '')}</span>`).join('<br>') || '—'}</dd></div></dl>
      <p><button class="btn secondary small" data-st-printunits="${u.id}">Print label</button></p></section>
    <section class="card"><h3 style="margin-top:0">History</h3><ol class="st-history">${moves.map((m) => `<li><strong>${esc(ACTIONS[m.action] || m.action)}</strong>${m.qty != null ? ` · ${qty(m.qty)}` : ''}${m.orderKey ? ` · ${esc(m.orderKey)}` : ''}${m.to ? ` · ${m.from && m.from !== m.to ? `${esc(m.from)} → ` : ''}${esc(m.to)}` : ''}
      <br><span class="muted small">${when(m.at)} · ${esc(m.who || '')}${m.note ? ` · ${esc(m.note)}` : ''}</span></li>`).join('')}</ol></section>`;
}

// ---------- dashboard ----------

function dashHtml() {
  const d = S.dash;
  if (!d) return '<p class="muted">Loading…</p>';
  const orderList = (list, empty) => (list.length ? `<ul class="st-list">${list.slice(0, 8).map((o) => `<li class="st-click" data-st-order="${o.id}" data-st-gotab="orders"><strong>${esc(o.key)}</strong> ${prio(o.priority)} <span class="muted">${esc(o.customer || '')} · ${esc(o.orderSummary || o.summary || '')}</span>${o.toOrder ? ` <span class="small">${o.toOrder} to order</span>` : ''}</li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`);
  const t = S.time?.suggestions || [];
  return `<div class="st-dash">
    <div class="st-bubbles"><div class="st-bubble"><strong>${d.openCount}</strong><span>open work orders</span></div><div class="st-bubble${d.toOrder.length ? ' warn' : ''}"><strong>${d.toOrder.length}</strong><span>need stock ordering</span></div>
      <div class="st-bubble"><strong>${d.deliveries.length}</strong><span>deliveries due</span></div><div class="st-bubble${d.stuck.length ? ' warn' : ''}"><strong>${d.stuck.length}</strong><span>picked, not used for ${4}+ hours</span></div>${d.stockValue !== undefined ? `<div class="st-bubble"><strong>${money(d.stockValue)}</strong><span>stock value</span></div>` : ''}</div>
    ${t.length ? `<section class="card"><h3 style="margin-top:0">Your time from stock scans today</h3><p class="muted">Rough times from when you scanned. Correct them as you log.</p>
      <ul class="st-list">${t.map((s, k) => `<li><strong>${esc(s.start)}–${esc(s.end)}</strong> · ${esc(s.orderKey)} <span class="muted">${esc(s.orderSummary)}</span><br><span class="small">${s.target ? `Logs to ${esc(s.target.key)} ${esc(s.target.summary)}` : 'No Build or Testing & Configuration item to log to'}</span>
        <span class="row">${s.target?.option ? `<button class="btn small" data-st-logtime="${k}">Log ${s.minutes} min</button>` : ''}<button class="linklike" data-st-timehide="${esc(s.orderKey)}">Not this</button></span></li>`).join('')}</ul></section>` : ''}
    <div class="st-cols">
      <section class="card"><h3 style="margin-top:0">Need stock ordering</h3>${orderList(d.toOrder, 'Nothing.')}</section>
      <section class="card"><h3 style="margin-top:0">High priority</h3>${orderList(d.high, 'Nothing urgent.')}</section>
      <section class="card"><h3 style="margin-top:0">Ready for Hardware complete</h3>${orderList(d.ready, 'Nothing yet.')}</section>
      <section class="card"><h3 style="margin-top:0">Deliveries due</h3>${d.deliveries.length ? `<ul class="st-list">${d.deliveries.map((e) => `<li>${e.late ? '<span class="st-flag bad">Late</span> ' : ''}<strong>${esc(e.item_name)}</strong> · ${qty(e.due)} <span class="muted">${esc(e.supplier || '')} ${esc(e.po_ref || '')}${e.order_key ? ` · ${esc(e.order_key)}` : ''}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing due today.</p>'}</section>
      <section class="card"><h3 style="margin-top:0">Picked but not used</h3>${d.stuck.length ? `<ul class="st-list">${d.stuck.map((u) => `<li><strong>${esc(u.item.name)}</strong> · ${qty(u.qty)} <span class="muted">${esc(u.orderKey || '')} · since ${when(u.pickedAt)} by ${esc(u.pickedBy || '')}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing left on the bench.</p>'}</section>
      <section class="card"><h3 style="margin-top:0">Expiring, not on a job</h3>${d.expiring.length ? `<ul class="st-list">${d.expiring.map((u) => `<li><strong>${esc(u.item.name)}</strong> · ${qty(u.qty)} <span class="muted">${esc(u.location?.code || '')} · use by ${day(u.expiry)}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing.</p>'}</section>
      <section class="card"><h3 style="margin-top:0">Bins running low</h3>${d.binsLow.length ? `<ul class="st-list">${d.binsLow.map((i) => `<li><strong>${esc(i.name)}</strong> · ${qty(i.qty)} left <span class="muted">(keep ${qty(i.min)})</span></li>`).join('')}</ul>` : '<p class="muted">All topped up.</p>'}</section>
      <section class="card"><h3 style="margin-top:0">Checks due</h3>${d.checksDue.length ? `<ul class="st-list">${d.checksDue.map((p) => `<li><strong>${esc(p.name)}</strong> <span class="muted">due ${day(p.next_due)}</span></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}</section>
      <section class="card st-wide"><h3 style="margin-top:0">Used in the last 30 days</h3>${d.use.length ? `<div class="st-table-wrap"><table class="st-table"><thead><tr><th>Item</th><th>Used</th>${S.me?.canManage ? '<th>Value</th>' : ''}</tr></thead><tbody>${d.use.map((u) => `<tr><td>${esc(u.name)}</td><td>${qty(u.qty)} ${esc(u.unit || '')}</td>${S.me?.canManage ? `<td>${money(u.value)}</td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing used yet.</p>'}</section>
    </div></div>`;
}

// ---------- setup ----------

function setupHtml() {
  const subs = [['items', 'Items'], ['locations', 'Locations'], ['panels', 'Panel defaults'], ['labels', 'Labels'], ['deleted', 'Deleted lines'], ['settings', 'Jira and Xero']];
  return `<div class="row st-tools"><span class="segment">${subs.map(([k, l]) => `<button class="seg${S.setupSub === k ? ' on' : ''}" data-st-setsub="${k}">${l}</button>`).join('')}</span></div>
    ${({ items: setupItemsHtml, locations: setupLocationsHtml, panels: setupPanelsHtml, labels: setupLabelsHtml, deleted: setupDeletedHtml, settings: setupSettingsHtml })[S.setupSub]()}`;
}

function setupItemsHtml() {
  const items = S.items?.items || [];
  const e = S.editItem;
  const cats = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();
  return `<datalist id="st-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    ${e ? `<form class="card" data-st-form="item"><h3 style="margin-top:0">${e.id ? `Edit ${esc(e.name)}` : 'New stock item'}</h3><input type="hidden" name="id" value="${e.id || ''}">${itemFields(e)}
      <label>Usual location <select name="usual_location"><option value="">None</option>${(S.locations?.locations || []).map((l) => `<option value="${l.id}"${e.usual_location === l.id ? ' selected' : ''}>${esc(l.code)}</option>`).join('')}</select></label>
      <div class="row"><button class="btn" type="submit">Save</button><button class="linklike" type="button" data-st-cancelform>Cancel</button>${e.id ? `<button class="linklike danger" type="button" data-st-itemdel="${e.id}">Remove item</button>` : ''}</div></form>`
      : `<p class="row"><button class="btn" data-st-itemnew>New stock item</button>${S.me?.canManage ? '<label class="btn secondary st-file">Import from Quoter<input type="file" accept=".csv,text/csv" data-st-quoter hidden></label>' : ''}</p>`}
    ${S.quoter ? quoterHtml() : ''}
    <div class="st-table-wrap"><table class="st-table"><thead><tr><th>Item</th><th>Kind</th><th>Weight</th><th>Supplier</th><th>Cost</th><th></th></tr></thead><tbody>
      ${items.map((i) => `<tr><td><strong>${esc(i.name)}</strong><br><span class="muted small">${esc(i.code || '')}${i.aliases.length ? ` · ${esc(i.aliases.join(', '))}` : ''}</span></td><td>${esc({ serial: 'One at a time', batch: 'By quantity', bin: 'Bin' }[i.mode] || i.mode)}${i.two_bin ? ' · two-bin' : ''}</td><td>${esc(i.weight)}</td>
        <td>${esc(i.supplier || '')}<br><span class="muted small">${esc(i.supplier_part || '')}</span></td><td>${money(i.unit_cost)}</td><td>${S.me?.canManage ? `<button class="linklike" data-st-itemedit="${i.id}">Edit</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">None yet.</td></tr>'}
    </tbody></table></div>`;
}

function quoterHtml() {
  const q = S.quoter;
  const list = (rows, fmt) => `<ul class="st-list small">${rows.map(fmt).join('')}</ul>`;
  return `<section class="card st-ask"><h3 style="margin-top:0">${q.applied ? 'Imported from Quoter' : 'Import from Quoter'}</h3>
    <p>${q.applied ? `${q.added.length} new item${q.added.length === 1 ? '' : 's'} added and ${q.updated.length} updated.${q.linked ? ` ${q.linked} line${q.linked === 1 ? '' : 's'} on work orders now link to a stock item.` : ''}`
      : `Hardware and critical spares from the file: <strong>${q.added.length} new</strong>, <strong>${q.updated.length} already here</strong> (supplier, cost and codes updated), ${q.skipped.length} left out.`}</p>
    ${q.applied ? '' : '<p class="muted small">Kind, unit, weight and usual location of items already here are kept. New items are batch items; weights and categories are a first guess from the name, to check in the list below.</p>'}
    ${q.skipped.length ? `<details><summary>Left out (${q.skipped.length})</summary>${list(q.skipped, (r) => `<li>${esc(r.name)} <span class="muted">· ${esc(r.why)}</span></li>`)}</details>` : ''}
    ${q.shared.length ? `<details><summary>Codes used by more than one Quoter item (${q.shared.length})</summary><p class="muted small">Each is still added, with its own code. Fix these in Quoter so each part has one code.</p>${list(q.shared, (r) => `<li>${esc(r.name)} <span class="muted">· ${esc(r.code)}</span></li>`)}</details>` : ''}
    ${!q.applied && q.added.length ? `<details><summary>New items (${q.added.length})</summary>${list(q.added, (r) => `<li>${esc(r.name)} <span class="muted">· ${esc(r.code || 'own code')} · ${esc(r.supplier || 'no supplier')} · ${money(r.cost)} · ${esc(r.weight)}</span></li>`)}</details>` : ''}
    <p class="row">${q.applied ? '<button class="btn secondary" data-st-quoterdone>Done</button>' : '<button class="btn" data-st-quoterapply>Import them</button><button class="linklike" data-st-quoterdone>Cancel</button>'}</p></section>`;
}

function setupLocationsHtml() {
  const locs = S.locations?.locations || [];
  const areas = [...new Set(locs.map((l) => l.area).filter(Boolean))];
  return `${S.me?.canManage ? `<form class="card" data-st-form="locrange"><h3 style="margin-top:0">Add locations</h3>
      <div class="st-grid"><label>Area <input name="area" placeholder="Racking A" list="st-areas" required></label><label>Code start <input name="prefix" placeholder="A-" required></label>
        <label>How many <input name="count" type="number" min="1" max="200" value="1"></label><label>Numbered from <input name="start" type="number" min="0" value="1"></label>
        <label>Shelf <select name="level"><option value="low">Low (heavy is fine)</option><option value="mid" selected>Middle</option><option value="high">High (light only)</option></select></label>
        <label class="st-check"><input type="checkbox" name="quarantine"> Quarantine area</label></div>
      <p class="muted small">One location is made with exactly the code given; several are numbered on from it, as A-01, A-02.</p>
      <button class="btn" type="submit">Add</button></form><datalist id="st-areas">${areas.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>` : ''}
    <div class="st-table-wrap"><table class="st-table"><thead><tr><th></th><th>Code</th><th>Area</th><th>Shelf</th><th>Items</th><th></th></tr></thead><tbody>
      ${locs.map((l) => `<tr><td><input type="checkbox" data-st-lpick="locations" value="${l.id}" ${S.labelPick.locations.includes(l.id) ? 'checked' : ''} aria-label="Label for ${esc(l.code)}"></td><td><strong>${esc(l.code)}</strong>${l.quarantine ? ' <span class="st-flag bad">Quarantine</span>' : ''}</td><td>${esc(l.area || '')}</td>
        <td>${S.me?.canManage ? `<select data-st-loclevel="${l.id}">${['low', 'mid', 'high'].map((v) => `<option value="${v}"${l.level === v ? ' selected' : ''}>${v}</option>`).join('')}</select>` : esc(l.level)}</td><td>${l.items}</td>
        <td>${S.me?.canManage && !l.items ? `<button class="linklike" data-st-locdel="${l.id}">Remove</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">None yet.</td></tr>'}
    </tbody></table></div>
    ${locs.length ? `<p class="row"><button class="btn secondary small" data-st-printpicked>Print labels for the ticked ones</button><button class="linklike" data-st-pickall>Tick all</button></p>` : ''}`;
}

function setupPanelsHtml() {
  const list = S.panels?.panels || [];
  const e = S.editPanel;
  if (e) {
    return `<form class="card" data-st-form="panelsave"><h3 style="margin-top:0">${e.id ? esc(e.name) : 'New panel type'}</h3>
      <label>Name <input name="name" value="${esc(e.name || '')}" placeholder="Batch weigher control panel" required></label>
      <label>Notes <input name="notes" value="${esc(e.notes || '')}" placeholder="Optional"></label>
      <h4>Usually in it</h4>
      <ul class="st-count">${e.items.map((i, k) => `<li><span><strong>${esc(i.name)}</strong><br><span class="muted small">${esc(i.code || '')}</span></span><input type="number" min="0" step="any" class="st-qty" data-st-panelqty="${k}" value="${i.qty}"> <button class="linklike" type="button" data-st-paneldel="${k}">Remove</button></li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul>
      <div class="st-link"><input id="st-panelq" placeholder="Add a stock item" autocomplete="off"><div class="st-sugg" id="st-panel-sugg"></div></div>
      <div class="row"><button class="btn" type="submit">Save</button><button class="linklike" type="button" data-st-cancelform>Cancel</button>${e.id ? `<button class="linklike danger" type="button" data-st-panelremove="${e.id}">Remove panel type</button>` : ''}</div></form>`;
  }
  return `<p class="muted">The stock that usually goes into each kind of panel. Added to a work order, it can then be changed for that build.</p>
    ${S.me?.canManage ? '<p><button class="btn" data-st-panelnew>New panel type</button></p>' : ''}
    ${list.length ? `<ul class="st-list">${list.map((p) => `<li${S.me?.canManage ? ` class="st-click" data-st-paneledit="${p.id}"` : ''}><strong>${esc(p.name)}</strong> <span class="muted small">${p.items.length} item${p.items.length === 1 ? '' : 's'}${p.updated_by ? ` · ${esc(p.updated_by)}` : ''}</span><br><span class="small">${p.items.slice(0, 6).map((i) => `${qty(i.qty)} × ${esc(i.name)}`).join(', ')}${p.items.length > 6 ? '…' : ''}</span></li>`).join('')}</ul>` : '<section class="card"><p class="muted">No panel types yet.</p></section>'}`;
}

function setupLabelsHtml() {
  const items = S.items?.items || [];
  return `<section class="card"><h3 style="margin-top:0">Labels</h3><p class="muted">Code 128 labels for a label printer or plain paper: stock labels print as stock is taken in, location labels from Locations, and item labels (for bins) here.</p>
    ${items.length ? `<ul class="st-pickl">${items.map((i) => `<li><label class="st-check"><input type="checkbox" data-st-lpick="items" value="${i.id}" ${S.labelPick.items.includes(i.id) ? 'checked' : ''}> ${esc(i.name)} <span class="muted small">${esc(i.code || '')}</span></label></li>`).join('')}</ul>
      <button class="btn secondary small" data-st-printpicked>Print the ticked labels</button>` : '<p class="muted">No items yet.</p>'}</section>`;
}

function setupDeletedHtml() {
  const list = S.deleted?.deleted || [];
  return `<p class="muted">Required stock deleted from work orders. Restoring a line puts it back on its work order.</p>
    ${list.length ? `<div class="st-table-wrap"><table class="st-table"><thead><tr><th>Work order</th><th>Item</th><th>Qty</th><th>Deleted</th><th>Why</th><th></th></tr></thead><tbody>
      ${list.map((d) => `<tr><td><strong>${esc(d.orderKey)}</strong><br><span class="muted small">${esc(d.customer || '')}</span></td><td>${esc(d.item || '')}</td><td>${qty(d.qty)}</td>
        <td>${d.at ? when(d.at) : '—'}<br><span class="muted small">${esc(d.by || '')}</span></td><td>${esc(d.reason || '')}</td><td><button class="btn secondary small" data-st-restore="${d.id}">Restore</button></td></tr>`).join('')}
    </tbody></table></div>` : '<section class="card"><p class="muted">Nothing deleted.</p></section>'}`;
}

function setupSettingsHtml() {
  const s = S.settings || {};
  return `<section class="card"><h3 style="margin-top:0">Jira</h3>
      <label class="st-check"><input type="checkbox" data-st-jiramoves ${s.jiraMoves ? 'checked' : ''} ${s.canManage ? '' : 'disabled'}> Hardware complete moves the Jira items: closes Purchase Order and Build, and starts Testing & Configuration</label>
      <p class="muted small">Work orders were last read from Jira ${s.lastSync ? when(s.lastSync) : 'never'}. <button class="linklike" data-st-sync>Read them now</button></p></section>
    <section class="card"><h3 style="margin-top:0">Xero</h3><p class="muted">Not linked. Once it is, stock orders are read from Xero every hour.</p>
      ${s.canManage ? '<button class="btn secondary small" data-st-recheck>Re-check stock orders</button>' : ''}</section>`;
}

// A question with a text box, in a dialog. Resolves to the answer, or null if cancelled.
function ask(question, { placeholder = '', confirm = 'OK', danger = false, value = '' } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'st-dialog';
    d.innerHTML = `<form method="dialog"><p><strong>${esc(question)}</strong></p><textarea rows="3" placeholder="${esc(placeholder)}" required>${esc(value)}</textarea>
      <div class="row"><button class="btn${danger ? ' danger' : ''}" value="ok">${esc(confirm)}</button><button class="btn secondary" value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.appendChild(d);
    const box = d.querySelector('textarea');
    d.addEventListener('close', () => { const v = d.returnValue === 'ok' ? box.value.trim() : ''; d.remove(); resolve(v || null); });
    d.showModal();
    box.focus();
  });
}

// ---------- events ----------

async function onClick(e) {
  const t = (sel) => e.target.closest(sel);
  let b;
  if ((b = t('[data-st-tab]'))) { S.tab = b.dataset.stTab; S.orderId = null; S.intakeStep = null; S.item = null; S.check = null; S.counting = null; S.unit = null; S.binAsk = null; return refresh(); }
  if ((b = t('[data-st-flush]'))) return flushQueue(true);
  if ((b = t('[data-st-cam]'))) return camera(b.dataset.stCam);
  if ((b = t('[data-st-order]'))) { if (b.dataset.stGotab) S.tab = 'orders'; S.orderId = Number(b.dataset.stOrder); S.binAsk = null; window.scrollTo(0, 0); return refresh(); }
  if ((b = t('[data-st-back]'))) { S.orderId = null; S.order = null; S.binAsk = null; return refresh(); }
  if ((b = t('[data-st-ofilter]'))) { S.orderFilter = b.dataset.stOfilter; return refresh(); }
  if ((b = t('[data-st-sync]'))) return act(b, async () => { const r = await post('sync'); H.toast(r.error ? r.error : `Read ${r.orders} hardware categories from Jira`); await refresh(); });
  if ((b = t('[data-st-needdel]'))) {
    const reason = await ask('Why is this stock no longer required for the order?', { placeholder: 'For example: customer supplying their own, swapped for another part', confirm: 'Delete', danger: true });
    if (!reason) return;
    return act(b, async () => { await post('need-set', { id: Number(b.dataset.stNeeddel), remove: true, reason }); H.toast('Deleted. It can be restored from the Stock settings.'); await refresh(); });
  }
  if ((b = t('[data-st-pickitem]'))) return pickedSuggestion(b);
  if ((b = t('[data-st-newfor]'))) return newItemFor(Number(b.dataset.stNewfor), b.dataset.text);
  if ((b = t('[data-st-takefrom]'))) return takeFromFlow(S.orderId);
  if ((b = t('[data-st-binact]'))) { S.binAsk = { ...S.binAsk, again: false, action: b.dataset.stBinact }; return redraw(); }
  if ((b = t('[data-st-bincancel]'))) { S.binAsk = null; return redraw(); }
  if ((b = t('[data-st-return]'))) return returnFlow(Number(b.dataset.stReturn));
  if ((b = t('[data-st-override]'))) {
    const reason = prompt('Why is it coming back after Hardware complete?');
    if (!reason) return;
    const loc = prompt('Scan or type the location it\'s going back to (or leave blank)') || '';
    return act(b, async () => { await post('return', { unitId: Number(b.dataset.stOverride), reason, location: loc || undefined }); H.toast('Brought back'); await refresh(); });
  }
  if ((b = t('[data-st-quar]'))) {
    const reason = prompt('What\'s wrong with it?');
    if (!reason) return;
    return act(b, async () => { const r = await post('quarantine', { unitId: Number(b.dataset.stQuar), reason }); H.toast(r.reorderFor ? `Put aside. ${r.reorderFor} needs it again.` : 'Put aside'); await refresh(); });
  }
  if ((b = t('[data-st-qrel]'))) {
    const ok = confirm('Is it fine to use? OK puts it back into stock; Cancel writes it off.');
    return act(b, async () => { await post('quarantine-release', { unitId: Number(b.dataset.stQrel), to: ok ? 'available' : 'gone' }); await refresh(); });
  }
  if ((b = t('[data-st-move]'))) {
    const loc = prompt('Scan or type where it\'s going');
    if (!loc) return;
    return act(b, async () => { await post('relocate', { unitId: Number(b.dataset.stMove), location: loc }); H.toast(`Moved to ${loc.toUpperCase()}`); await refresh(); });
  }
  if ((b = t('[data-st-reassign]'))) return reassignFlow(Number(b.dataset.stReassign));
  if ((b = t('[data-st-complete]'))) {
    return act(b, async () => {
      const r = await post('complete', { orderId: S.orderId });
      H.toast(jiraSummary(r.jira));
      await refresh();
    });
  }
  if ((b = t('[data-st-force]'))) {
    const reason = prompt('Not everything is scanned out. Why is the hardware complete?');
    if (!reason) return;
    return act(b, async () => { const r = await post('complete', { orderId: S.orderId, force: true, reason }); H.toast(jiraSummary(r.jira)); await refresh(); });
  }
  if ((b = t('[data-st-reopen]'))) return act(b, async () => { await post('reopen', { orderId: S.orderId }); await refresh(); });
  if ((b = t('[data-st-ostatus]'))) {
    const status = b.dataset.stOstatus;
    if (status === 'cancelled' && !confirm('Cancel this work order? What\'s held for it goes back to free stock.')) return;
    return act(b, async () => { await post('order-status', { orderId: S.orderId, status }); await refresh(); });
  }
  // Intake
  if ((b = t('[data-st-manual]'))) { S.intakeStep = { kind: 'manual', code: null }; return redraw(); }
  if ((b = t('[data-st-cancel]'))) { S.intakeStep = null; return refresh(); }
  if ((b = t('[data-st-dismiss]'))) { S.lastIntake = null; return redraw(); }
  if ((b = t('[data-st-recv]'))) return startReceive(Number(b.dataset.item), Number(b.dataset.stRecv));
  if ((b = t('[data-st-issue]'))) { S.intakeStep = { kind: 'issue', expectedId: Number(b.dataset.stIssue) || null, itemId: Number(b.dataset.item) || null, back: S.intakeStep }; S.tab = 'intake'; return redraw(); }
  if ((b = t('[data-st-eachdel]'))) { S.intakeStep.each.splice(Number(b.dataset.stEachdel), 1); return redraw(); }
  if ((b = t('[data-st-eachadd]'))) return addEach('');
  if ((b = t('[data-st-loc]'))) { S.intakeStep.location = b.dataset.stLoc; const box = document.getElementById('st-recv-loc'); if (box) box.value = b.dataset.stLoc; view.querySelectorAll('[data-st-loc]').forEach((x) => x.classList.toggle('on', x === b)); return; }
  if ((b = t('[data-st-useitem]'))) return useItem(Number(b.dataset.stUseitem));
  if ((b = t('[data-st-bcretry]'))) { S.intakeStep.barcode = null; redraw(); return loadBarcode(S.intakeStep.code); }
  if ((b = t('[data-st-bcuse]'))) {
    const i = S.intakeStep.barcode.items[Number(b.dataset.stBcuse)];
    const f = view.querySelector('form[data-st-form="newitem"]');
    const set = (n, v) => { const el = f?.querySelector(`[name="${n}"]`); if (el && v) el.value = v; };
    set('name', i.title); set('manufacturer', i.brand); set('mpn', i.model); set('description', i.description); set('category', i.category);
    f?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    f?.querySelector('[name=name]')?.focus();
    return H.toast('Filled in from the barcode. Check them, then add supplier and cost.');
  }
  if ((b = t('[data-st-printunits]'))) return printLabels({ units: b.dataset.stPrintunits });
  if ((b = t('[data-st-printitem]'))) return printLabels({ items: b.dataset.stPrintitem });
  if ((b = t('[data-st-totrace]'))) { S.tab = 'trace'; S.unit = await get(`unit?id=${b.dataset.stTotrace}`); S.intakeStep = null; return redraw(); }
  // Stock
  if ((b = t('[data-st-ssub]'))) { S.stockSub = b.dataset.stSsub; S.item = null; return refresh(); }
  if ((b = t('[data-st-item]'))) { S.item = await itemDetail(b.dataset.stItem); return redraw(); }
  if ((b = t('[data-st-itemback]'))) { S.item = null; return refresh(); }
  if ((b = t('[data-st-expnew]'))) { const host = b.closest('section'); host.insertAdjacentHTML('afterend', expectedFormHtml(S.item)); b.disabled = true; return; }
  if ((b = t('[data-st-cancelform]'))) { S.editItem = null; S.editPanel = null; const f = b.closest('form'); if (f?.dataset.stForm === 'expected') { f.remove(); return; } return redraw(); }
  if ((b = t('[data-st-expdel]'))) { if (!confirm('Cancel this expected delivery?')) return; return act(b, async () => { await post('expected-remove', { id: Number(b.dataset.stExpdel) }); await refresh(); }); }
  if ((b = t('[data-st-recheck]'))) return act(b, async () => { const r = await post('recheck'); H.toast(r.message || 'Checked'); });
  // Checks
  if ((b = t('[data-st-startplan]'))) return act(b, async () => { const r = await post('check-start', { planId: Number(b.dataset.stStartplan) }); await openCheck(r.id); });
  if ((b = t('[data-st-startall]'))) { if (!confirm('Start a count of every location?')) return; return act(b, async () => { const r = await post('check-start', {}); await openCheck(r.id); }); }
  if ((b = t('[data-st-plandel]'))) return act(b, async () => { await post('plan-remove', { id: Number(b.dataset.stPlandel) }); await refresh(); });
  if ((b = t('[data-st-check]'))) return openCheck(Number(b.dataset.stCheck));
  if ((b = t('[data-st-checkback]'))) { S.check = null; stopPoll(); return refresh(); }
  if ((b = t('[data-st-countloc]'))) return startCount(b.dataset.stCountloc);
  if ((b = t('[data-st-countback]'))) { S.counting = null; await openCheck(S.check.check.id); return; }
  if ((b = t('[data-st-finish]'))) { if (!confirm('Finish counting? The expected numbers and variances show once it\'s finished.')) return; return act(b, async () => { await post('check-finish', { id: S.check.check.id }); await openCheck(S.check.check.id); }); }
  if ((b = t('[data-st-apply]'))) { if (!confirm('Make these counts the stock records? Shortfalls are written off and extras added.')) return; return act(b, async () => { const r = await post('check-apply', { id: S.check.check.id }); H.toast(`${r.changed} line${r.changed === 1 ? '' : 's'} changed`); await openCheck(S.check.check.id); }); }
  if ((b = t('[data-st-export]'))) return exportCheck();
  // Trace
  if ((b = t('[data-st-unitback]'))) { S.unit = null; return redraw(); }
  // Dashboard
  if ((b = t('[data-st-logtime]'))) return logTime(S.time.suggestions[Number(b.dataset.stLogtime)]);
  if ((b = t('[data-st-timehide]'))) return act(b, async () => { await post('time-hide', { orderKey: b.dataset.stTimehide }); S.time = await get('time'); redraw(); });
  // Setup
  if ((b = t('[data-st-restore]'))) return act(b, async () => { await post('need-restore', { id: Number(b.dataset.stRestore) }); H.toast('Restored'); await refresh(); });
  if ((b = t('[data-st-setsub]'))) { S.setupSub = b.dataset.stSetsub; S.editItem = null; S.editPanel = null; return refresh(); }
  if ((b = t('[data-st-itemnew]'))) { S.editItem = {}; return redraw(); }
  if ((b = t('[data-st-quoterapply]'))) return act(b, async () => { S.quoter = await post('import-quoter', { csv: S.quoterCsv, apply: true }); S.quoterCsv = null; await refresh(); });
  if ((b = t('[data-st-quoterdone]'))) { S.quoter = null; S.quoterCsv = null; return redraw(); }
  if ((b = t('[data-st-itemedit]'))) { S.editItem = S.items.items.find((i) => i.id === Number(b.dataset.stItemedit)); window.scrollTo(0, 0); return redraw(); }
  if ((b = t('[data-st-itemdel]'))) { if (!confirm('Remove this stock item?')) return; return act(b, async () => { await post('item-remove', { id: Number(b.dataset.stItemdel) }); S.editItem = null; await refresh(); }); }
  if ((b = t('[data-st-locdel]'))) return act(b, async () => { await post('location-remove', { id: Number(b.dataset.stLocdel) }); await refresh(); });
  if ((b = t('[data-st-pickall]'))) { S.labelPick.locations = (S.locations?.locations || []).map((l) => l.id); return redraw(); }
  if ((b = t('[data-st-printpicked]'))) return printLabels({ locations: S.labelPick.locations.join(','), items: S.labelPick.items.join(',') });
  if ((b = t('[data-st-panelnew]'))) { S.editPanel = { name: '', notes: '', items: [] }; return redraw(); }
  if ((b = t('[data-st-paneledit]'))) { const p = S.panels.panels.find((x) => x.id === Number(b.dataset.stPaneledit)); S.editPanel = { ...p, items: p.items.map((i) => ({ ...i })) }; return redraw(); }
  if ((b = t('[data-st-paneldel]'))) { S.editPanel.items.splice(Number(b.dataset.stPaneldel), 1); return redraw(); }
  if ((b = t('[data-st-panelremove]'))) { if (!confirm('Remove this panel type?')) return; return act(b, async () => { await post('panel-remove', { id: Number(b.dataset.stPanelremove) }); S.editPanel = null; await refresh(); }); }
}

async function onSubmit(e) {
  const f = e.target.closest('form[data-st-form]');
  if (!f) return;
  e.preventDefault();
  const kind = f.dataset.stForm;
  const fd = Object.fromEntries(new FormData(f));
  const btn = f.querySelector('[type=submit]');
  if (kind === 'pick') return scanPick(fd.code, f);
  if (kind === 'intake') return scanIntake(fd.code, f);
  if (kind === 'countloc') return startCount(fd.code);
  if (kind === 'binqty') return binQty(fd.qty);
  if (kind === 'manual') return act(btn, async () => { const r = await post('manual', { key: fd.key }); S.orderId = r.id; await refresh(); });
  if (kind === 'panel') return act(btn, async () => { await post('panel-apply', { orderId: S.orderId, panelId: Number(fd.panel), count: Number(fd.count) || 1 }); await refresh(); });
  if (kind === 'hold') return act(btn, async () => { if (!fd.itemId) throw new Error('Choose the item first.'); const r = await post('hold', { orderId: S.orderId, itemId: Number(fd.itemId), qty: Number(fd.qty) }); if (r.short) H.toast(`${r.short} more couldn't be held: there isn't enough free.`); await refresh(); });
  if (kind === 'newitem' || kind === 'item') {
    const body = { ...fd, two_bin: f.querySelector('[name=two_bin]')?.checked };
    return act(btn, async () => {
      const r = await post('item', body);
      if (kind === 'newitem') return useItem(r.id);
      S.editItem = null; H.toast('Saved'); await refresh();
    });
  }
  if (kind === 'receive') return act(btn, async () => {
    const st = S.intakeStep;
    const L = st.label || {};
    const each = st.item.mode === 'serial' ? (st.each || []) : null;
    if (each && !each.length) throw new Error('Scan each one in first.');
    const r = await post('intake', { itemId: st.item.id, location: fd.location, qty: each ? each.length : fd.qty, serials: each ? each.map((u) => u.serial).filter(Boolean) : [],
      expectedId: fd.expectedId ? Number(fd.expectedId) : null, barcode: st.code || null, makeUsual: f.querySelector('[name=makeUsual]')?.checked,
      lot: L.lot || L.dateCode || null, expiry: L.expiry || null, poRef: L.po || null });
    S.lastIntake = r; S.intakeStep = null; await refresh();
  });
  if (kind === 'issue') return act(btn, async () => {
    const st = S.intakeStep;
    if (!st.expectedId) throw new Error('Choose the expected delivery it was, from the list on Intake.');
    const r = await post('intake-issue', { expectedId: st.expectedId, qty: Number(fd.qty), reason: fd.reason, note: fd.note });
    H.toast(r.reorderFor ? `Reported. ${r.reorderFor} shows it as needing ordering again.` : 'Reported'); S.intakeStep = null; await refresh();
  });
  if (kind === 'expected') return act(btn, async () => { const r = await post('expected', { ...fd, itemId: Number(fd.itemId), qty: Number(fd.qty) }); H.toast(r.orderId ? 'Saved, and held for the job that needs it most' : 'Saved'); f.remove(); await refresh(); });
  if (kind === 'ordered') return act(btn, async () => {
    const s = S.buy.suppliers.find((x) => x.supplier === f.dataset.supplier);
    const si = S.buy.suppliers.indexOf(s);
    const lines = [...f.querySelectorAll('[name=pick]:checked')].map((c) => {
      const li = Number(c.value.split(':')[1]); const l = s.lines[li];
      return { itemId: l.item.id, qty: Number(f.querySelector(`[name="qty-${si}-${li}"]`).value), orders: l.orders, team: l.team, unitCost: l.item.unit_cost };
    }).filter((l) => l.qty > 0);
    const r = await post('ordered', { lines, supplier: s.supplier === 'No supplier set' ? null : s.supplier, poRef: fd.poRef, expectedDate: fd.expectedDate });
    H.toast(`${r.made} deliveries now expected`); await refresh();
  });
  if (kind === 'plan') return act(btn, async () => { await post('plan', { ...fd, areas: String(fd.areas || '').split(',').map((a) => a.trim()).filter(Boolean) }); await refresh(); });
  if (kind === 'count') return saveCount(btn);
  if (kind === 'trace') { S.traceQ = { ...fd, expiring: f.querySelector('[name=expiring]').checked ? '1' : '' }; return act(btn, async () => { S.trace = await get(`trace?${new URLSearchParams(Object.entries(S.traceQ).filter(([, v]) => v))}`); redraw(); }); }
  if (kind === 'recall') return act(btn, async () => { S.recall = await get(`recall?${new URLSearchParams(Object.entries(fd).filter(([, v]) => v))}`); redraw(); });
  if (kind === 'locrange') return act(btn, async () => {
    const one = !(Number(fd.count) > 1);
    await post('location', one ? { code: fd.prefix, area: fd.area, level: fd.level, quarantine: f.querySelector('[name=quarantine]').checked } : { ...fd, count: Number(fd.count), start: Number(fd.start) });
    H.toast('Added'); await refresh();
  });
  if (kind === 'panelsave') return act(btn, async () => { await post('panel', { id: S.editPanel.id, name: fd.name, notes: fd.notes, items: S.editPanel.items }); S.editPanel = null; H.toast('Saved'); await refresh(); });
}

let suggestTimer = null;
function onInput(e) {
  const el = e.target;
  if (el.id === 'st-oq') { S.orderQuery = el.value; return redraw(); }
  if (el.id === 'st-iq') { S.itemQuery = el.value; clearTimeout(suggestTimer); suggestTimer = setTimeout(refresh, 250); return; }
  if (el.dataset.stCountrow != null) { S.countRows[Number(el.dataset.stCountrow)].counted = el.value === '' ? null : Number(el.value); return; }
  if (el.dataset.stPanelqty != null) { S.editPanel.items[Number(el.dataset.stPanelqty)].qty = Number(el.value); return; }
  const hosts = { 'st-addq': 'st-add-sugg', 'st-holdq': 'st-hold-sugg', 'st-manq': 'st-man-sugg', 'st-panelq': 'st-panel-sugg', 'st-countq': 'st-count-sugg' };
  const host = hosts[el.id] || (el.dataset.stLinkq ? `st-link-${el.dataset.stLinkq}` : null);
  if (host) {
    if (el.id === 'st-manq' && S.intakeStep) S.intakeStep.q = el.value;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
      const box = document.getElementById(host);
      if (!box) return;
      if (el.value.trim().length < 2) { box.innerHTML = ''; return; }
      const { items } = await get(`suggest?q=${encodeURIComponent(el.value)}`).catch(() => ({ items: [] }));
      box.innerHTML = items.length ? items.map((i) => `<button type="button" class="st-sugg-row" data-st-pickitem="${i.id}" data-for="${el.id || el.dataset.stLinkq}" data-name="${esc(i.name)}" data-code="${esc(i.code || '')}" data-unit="${esc(i.unit || '')}"><strong>${esc(i.name)}</strong> <span class="muted small">${esc(i.code || '')} ${esc(i.supplier || '')}</span></button>`).join('')
        : `<p class="muted small">No stock item matches.${el.id === 'st-addq' ? ` <button type="button" class="linklike" data-st-pickitem="" data-for="st-addq" data-name="${esc(el.value)}">Add "${esc(el.value)}" as a line anyway</button>` : ''}</p>`;
    }, 200);
  }
}

async function onChange(e) {
  const el = e.target;
  if (el.matches('[data-st-expsel]') && S.intakeStep) { S.intakeStep.expectedId = el.value ? Number(el.value) : null; return redraw(); }
  if (el.id === 'st-recv-loc' && S.intakeStep) S.intakeStep.location = el.value;
  if (el.matches('[data-st-ocust]')) { S.orderCustomer = el.value; return redraw(); }
  if (el.matches('[data-st-oteam]')) { S.orderTeam = el.value; return redraw(); }
  if (el.dataset.stNeedqty) return act(null, async () => { await post('need-set', { id: Number(el.dataset.stNeedqty), qty: Number(el.value) }); await refresh(); });
  if (el.matches('[data-st-prio]')) {
    return act(null, async () => {
      const r = await post('priority', { orderId: S.orderId, priority: el.value || null });
      await refresh();
      if (r.takeFrom?.length) await takeFromFlow(S.orderId, r.takeFrom);
    });
  }
  if (el.dataset.stLpick) {
    const list = S.labelPick[el.dataset.stLpick];
    const id = Number(el.value);
    S.labelPick[el.dataset.stLpick] = el.checked ? [...new Set([...list, id])] : list.filter((x) => x !== id);
    return;
  }
  if (el.dataset.stLoclevel) {
    const l = S.locations.locations.find((x) => x.id === Number(el.dataset.stLoclevel));
    return act(null, async () => { await post('location', { id: l.id, code: l.code, area: l.area, name: l.name, level: el.value, quarantine: l.quarantine }); H.toast(`${l.code} is a ${el.value} shelf`); });
  }
  if (el.matches('[data-st-quoter]') && el.files?.[0]) {
    return act(null, async () => { S.quoterCsv = await el.files[0].text(); S.quoter = await post('import-quoter', { csv: S.quoterCsv }); redraw(); });
  }
  if (el.matches('[data-st-jiramoves]')) return act(null, async () => { S.settings = await post('settings', { jiraMoves: el.checked }); H.toast(el.checked ? 'Jira moves on' : 'Jira moves off'); });
}

// A button that does something on the server, with errors shown rather than lost.
async function act(btn, fn) {
  if (S.busy) return;
  S.busy = true;
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try { await fn(); }
  catch (err) { H.toast(err.message); }
  finally { S.busy = false; if (btn && btn.isConnected) { btn.disabled = false; btn.classList.remove('busy'); } }
}

function jiraSummary(j) {
  if (!j) return 'Hardware complete';
  if (!j.on) return `Hardware complete. In Jira this would ${j.moves.map((m) => `move ${m.key} to ${m.to}`).join(', ') || 'move nothing'}.`;
  const done = j.moves.filter((m) => m.done); const not = j.moves.filter((m) => !m.done);
  return `Hardware complete. ${done.map((m) => `${m.key} → ${m.status}`).join(', ')}${not.length ? `. Not moved: ${not.map((m) => `${m.key} (${m.skipped})`).join(', ')}` : ''}`;
}

// ---------- flows ----------

async function pickedSuggestion(b) {
  const id = b.dataset.stPickitem ? Number(b.dataset.stPickitem) : null;
  const target = b.dataset.for;
  if (target === 'st-addq') return act(null, async () => { const qtyIn = prompt(`How many ${b.dataset.unit || ''} of ${b.dataset.name}?`, '1'); if (!qtyIn) return; await post('need', { orderId: S.orderId, itemId: id, text: id ? null : b.dataset.name, qty: Number(qtyIn) }); await refresh(); });
  if (target === 'st-holdq') { document.getElementById('st-hold-id').value = id; document.getElementById('st-holdq').value = b.dataset.name; document.getElementById('st-hold-sugg').innerHTML = ''; return; }
  if (target === 'st-manq') return useItem(id);
  if (target === 'st-panelq') { if (!S.editPanel.items.some((i) => i.itemId === id)) S.editPanel.items.push({ itemId: id, qty: 1, name: b.dataset.name, code: b.dataset.code }); return redraw(); }
  if (target === 'st-countq') { if (!S.countRows.some((r) => r.id === id)) S.countRows.push({ id, name: b.dataset.name, code: b.dataset.code, unit: b.dataset.unit, counted: null }); return redraw(); }
  // Linking a line read from Jira to the stock item it means.
  return act(null, async () => { await post('need-set', { id: Number(target), itemId: id }); await refresh(); });
}

// A line on a work order that isn't a stock item yet becomes one, and is linked to it.
function newItemFor(needId, textIn) {
  const d = document.createElement('dialog');
  d.className = 'st-dialog wide';
  d.innerHTML = `<form method="dialog" class="st"><h3 style="margin-top:0">New stock item</h3>${itemFields({ name: textIn }, { compact: true })}
    <div class="row"><button class="btn" value="ok">Add it to stock items</button><button class="btn secondary" value="cancel" formnovalidate>Cancel</button></div></form>`;
  document.body.appendChild(d);
  const f = d.querySelector('form');
  f.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(f)), two_bin: f.querySelector('[name=two_bin]')?.checked };
    try {
      const r = await post('item', body);
      await post('need-set', { id: needId, itemId: r.id });
      d.close(); H.toast('Added, and linked to this line'); await refresh();
    } catch (err) { H.toast(err.message); }
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
}

async function scanPick(code, form) {
  code = String(code || '').trim();
  if (!code) return;
  form.reset();
  await pickCall({ orderId: S.orderId, code, at: new Date().toISOString() });
}

async function pickCall(body) {
  try {
    const r = await post('pick', body);
    if (r.bin) { S.binAsk = { ...r, body }; return redraw(); }
    S.binAsk = null;
    beep(true);
    if (r.picked) H.toast(`${r.picked.qty} ${r.picked.unit || ''} ${r.picked.item} out${r.remaining ? ` · ${r.remaining} more needed` : ''}`);
    if (r.returned) H.toast(`${r.returned.qty} ${r.returned.unit || ''} ${r.returned.item} back in the bin`);
    await refresh();
  } catch (err) {
    if (offline(err)) { enqueue('pick', body); H.toast('No signal: the scan is kept and sent once it\'s back.'); return redraw(); }
    beep(false);
    if (err.data?.confirm) {
      if (confirm(err.message)) return pickCall({ ...body, [err.data.confirm]: true });
      return;
    }
    H.toast(err.message);
  }
}

function binQty(v) {
  const b = S.binAsk;
  if (v === '' || v == null) return;
  return pickCall({ ...b.body, qty: Number(v), binAction: b.action || (b.again ? 'take' : 'take') });
}

async function returnFlow(unitId) {
  const u = S.order.out.find((x) => x.id === unitId);
  const q = u.qty > 1 ? prompt(`How many of the ${u.qty} ${u.item.unit || ''} are coming back?`, String(u.qty)) : '1';
  if (!q) return;
  const loc = prompt('Scan or type the location it\'s going back to', u.location?.code || '');
  if (loc === null) return;
  const body = { unitId, qty: Number(q), location: loc || undefined, at: new Date().toISOString() };
  try { await post('return', body); H.toast('Brought back'); await refresh(); }
  catch (err) { if (offline(err)) { enqueue('return', body); H.toast('No signal: kept to send later.'); return redraw(); } H.toast(err.message); }
}

async function reassignFlow(unitId) {
  const orders = (await get('orders?sync=0')).orders.filter((o) => o.status === 'open');
  const list = orders.map((o, k) => `${k + 1}. ${o.key} (${o.priority}) ${o.customer || ''}`).join('\n');
  const pick = prompt(`Move it to which work order? Enter its number, or 0 to put it back in free stock.\n\n${list}`);
  if (pick === null || pick === '') return;
  const n = Number(pick);
  const to = n === 0 ? null : orders[n - 1];
  if (n !== 0 && !to) return H.toast('That isn\'t one of the numbers.');
  return act(null, async () => { await post('reassign', { unitId, toOrderId: to?.id || null }); H.toast(to ? `Now held for ${to.key}` : 'Back in free stock'); await refresh(); });
}

async function takeFromFlow(orderId, from = null) {
  const list = from || (await get(`take-from?id=${orderId}`)).from;
  if (!list.length) return H.toast('Nothing held for lower-priority jobs would cover what\'s short.');
  const keys = [...new Set(list.map((f) => f.fromKey))];
  const detail = list.map((f) => `${f.qty} × ${f.item} from ${f.fromKey}`).join('\n');
  if (!confirm(`Stock required will take stock from ${keys.join(', ')}, would you like to continue?\n\n${detail}`)) return;
  return act(null, async () => { await post('take-from', { orderId }); H.toast('Stock moved to this job'); await refresh(); });
}

async function scanIntake(code, form) {
  code = String(code || '').trim();
  if (!code) return;
  form.reset();
  try {
    const r = await get(`lookup?code=${encodeURIComponent(code)}`);
    if (r.type === 'unknown') { S.intakeStep = { kind: 'manual', code: r.code, label: r.label || null, q: '', barcode: null }; redraw(); return r.code ? loadBarcode(r.code) : null; }
    else if (r.type === 'item') return startReceive(r.item.id, r.expected[0]?.id || null, { code: r.label ? r.label.gtin || null : code, expected: r.expected, item: r.item, label: r.label || null });
    else S.intakeStep = { kind: r.type, ...r };
    redraw();
  } catch (err) { H.toast(err.message); }
}

async function useItem(id) {
  const code = S.intakeStep?.code || null;
  const label = S.intakeStep?.label || null;
  if (code) await post('alias', { itemId: id, code }).catch((err) => H.toast(err.message));
  const expected = (await get('expected')).expected.filter((e) => e.item_id === id);
  return startReceive(id, expected[0]?.id || null, { code, expected, label });
}

async function startReceive(itemId, expectedId, extra = {}) {
  const [items, put, exp] = await Promise.all([extra.item ? null : get('items'), get(`putaway?item=${itemId}`), extra.expected ? null : get('expected')]);
  const item = extra.item || items.items.find((i) => i.id === itemId);
  const expected = extra.expected || exp.expected.filter((e) => e.item_id === itemId);
  S.tab = 'intake';
  S.intakeStep = { kind: 'item', item, expected, expectedId, putaway: put, code: extra.code || null, label: extra.label || null, location: null,
    each: item.mode === 'serial' && (extra.code || extra.label) ? [{ serial: extra.label?.serial || null }] : [] };
  redraw();
}

let pollTimer = null;
function stopPoll() { clearInterval(pollTimer); pollTimer = null; }
async function openCheck(id) {
  S.check = await get(`check?id=${id}`);
  S.counting = null;
  redraw();
  stopPoll();
  // Progress shared between everyone counting.
  if (S.check.check.status === 'open') {
    pollTimer = setInterval(async () => {
      if (!here() || S.tab !== 'checks' || !S.check || S.counting) return stopPoll();
      if (document.activeElement?.matches('input, textarea, select')) return;
      try { S.check = await get(`check?id=${S.check.check.id}`); redraw(); } catch { /* next time */ }
    }, 6000);
  }
}

async function startCount(code) {
  code = String(code || '').trim();
  if (!code || !S.check) return;
  try {
    const r = await get(`check-location?id=${S.check.check.id}&code=${encodeURIComponent(code)}`);
    S.counting = r;
    S.countRows = r.items.map((i) => ({ ...i }));
    redraw();
  } catch (err) { H.toast(err.message); }
}

async function saveCount(btn) {
  const c = S.counting;
  const missing = S.countRows.filter((r) => r.counted == null);
  if (missing.length && !confirm(`${missing.length} item${missing.length === 1 ? ' has' : 's have'} no count. Count ${missing.length === 1 ? 'it' : 'them'} as none here?`)) return;
  const body = { checkId: S.check.check.id, locationId: c.location.id, done: true, at: new Date().toISOString(), counts: S.countRows.map((r) => ({ itemId: r.id, counted: r.counted ?? 0 })) };
  const id = S.check.check.id;
  try { await post('check-count', body); beep(true); H.toast(`${c.location.code} counted`); await openCheck(id); }
  catch (err) {
    if (offline(err)) { enqueue('check-count', body); H.toast('No signal: the count is kept and sent once it\'s back.'); S.counting = null; return redraw(); }
    H.toast(err.message);
  }
}

async function exportCheck() {
  const d = S.check;
  const { writeBook } = await import('/xlsx-write.js');
  const loc = (id) => d.locations.find((l) => l.id === id);
  const head = { bold: true, fill: 'D9E7F5' };
  const rows = [['Location', 'Area', 'Item', 'Code', 'Expected', 'Counted', 'Variance', 'Value (£)', 'Counted by', 'When'].map((v) => ({ v, s: head })),
    ...d.counts.map((r) => [loc(r.locationId)?.code || '', loc(r.locationId)?.area || '', r.name, r.code || '', r.expected, r.counted, r.variance, r.value, r.countedBy || '', r.countedAt ? r.countedAt.slice(0, 16).replace('T', ' ') : ''])];
  const byLoc = [['Location', 'Area', 'Counted by', 'Lines off', 'Units off'].map((v) => ({ v, s: head })),
    ...d.locations.map((l) => [l.code, l.area || '', l.doneBy || 'Not counted', l.off ?? 0, l.variance ?? 0])];
  const sheets = [
    { name: 'Counts', cols: 10, widths: [12, 16, 36, 14, 10, 10, 10, 11, 18, 17], freeze: { rows: 1 }, filter: `A1:J${rows.length}`, rows, selected: true },
    { name: 'By location', cols: 5, widths: [12, 16, 18, 10, 10], freeze: { rows: 1 }, rows: byLoc },
    { name: 'Summary', cols: 2, widths: [22, 30], rows: [[{ v: d.check.name, s: { bold: true } }, ''], ['Started', `${d.check.started_at?.slice(0, 16).replace('T', ' ')} by ${d.check.started_by}`], ['Lines counted', d.totals.lines], ['Lines off', d.totals.off], ['Units off', d.totals.units], ['Value off (£)', d.totals.value], ['Status', d.check.status]] },
  ];
  await H.saveFile(writeBook(sheets), `Stock check ${d.check.name.replace(/[\\/:*?"<>|]/g, '')} ${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function logTime(s) {
  if (!s?.target?.option) return;
  H.logFromStock({ option: s.target.option, minutes: s.minutes, start: s.start, description: `Hardware for ${s.orderKey} (from stock scans)` });
}

// ---------- the offline queue ----------

const offline = (err) => !navigator.onLine || err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(err?.message || '');
function queue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
function saveQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* storage off */ } }
function enqueue(path, body) { saveQueue([...queue(), { path, body, queued: new Date().toISOString() }]); }
async function flushQueue(loud = false) {
  const q = queue();
  if (!q.length) return;
  const left = []; const problems = [];
  for (const job of q) {
    try { await post(job.path, job.body); }
    catch (err) { if (offline(err)) left.push(job); else problems.push(`${job.body.code || job.path}: ${err.message}`); }
  }
  saveQueue(left);
  if (problems.length) H.toast(`Some saved scans couldn't be used: ${problems.join('; ')}`);
  else if (loud || q.length !== left.length) H.toast(left.length ? `${q.length - left.length} sent, ${left.length} still waiting` : 'Saved scans sent');
  if (here()) await refresh();
}

// ---------- camera scanning ----------

async function camera(target) {
  if (!('BarcodeDetector' in window)) return H.toast('This browser can\'t read barcodes with the camera. Use Chrome on Android, or type the code.');
  let stream;
  const host = document.createElement('div');
  host.className = 'st-camera';
  host.innerHTML = '<video playsinline muted></video><div class="st-camera-frame"></div><button class="btn secondary" type="button">Close</button>';
  document.body.appendChild(host);
  const video = host.querySelector('video');
  let alive = true;
  const close = () => { alive = false; stream?.getTracks().forEach((t) => t.stop()); host.remove(); };
  host.querySelector('button').onclick = close;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    await video.play();
    const detector = new window.BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix', 'itf'] });
    const tick = async () => {
      if (!alive) return;
      try {
        const found = await detector.detect(video);
        if (found.length) {
          close();
          const value = found[0].rawValue;
          if (target === 'each') { addEach(value); return; }
          if (target === 'loc') {
            const box = document.getElementById('st-recv-loc');
            if (box) { box.value = value; if (S.intakeStep) S.intakeStep.location = value; view.querySelectorAll('[data-st-loc]').forEach((x) => x.classList.toggle('on', x.dataset.stLoc === value.toUpperCase())); }
            return;
          }
          const box = document.getElementById(`st-scan-${target}`);
          if (box) { box.value = value; box.closest('form')?.requestSubmit(); }
          return;
        }
      } catch { /* try the next frame */ }
      requestAnimationFrame(tick);
    };
    tick();
  } catch (err) { close(); H.toast(`The camera couldn't be opened: ${err.message}`); }
}

let audio = null;
function beep(good) {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.frequency.value = good ? 880 : 220; g.gain.value = 0.08;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + (good ? 0.08 : 0.25));
  } catch { /* no sound */ }
  if (!good) navigator.vibrate?.(200);
}

// ---------- labels ----------

async function printLabels(sel) {
  const p = new URLSearchParams(Object.entries(sel).filter(([, v]) => v));
  const { labels } = await get(`labels?${p}`);
  if (!labels.length) return H.toast('Tick what to print first.');
  const w = window.open('', '_blank');
  if (!w) return H.toast('Allow pop-ups to print labels.');
  w.document.write(`<!DOCTYPE html><html><head><title>Stock labels</title><style>
    @page { size: 50mm 25mm; margin: 0; }
    body { margin: 0; font-family: Helvetica, Arial, sans-serif; }
    .l { width: 50mm; height: 25mm; box-sizing: border-box; padding: 1.5mm 2mm; page-break-after: always; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
    .t { font-size: 8pt; font-weight: 700; line-height: 1.1; max-height: 2.3em; overflow: hidden; }
    .s { font-size: 6.5pt; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    svg { width: 100%; height: 9mm; display: block; }
    .c { font-size: 8pt; font-family: monospace; text-align: center; letter-spacing: .5px; }
    @media screen { body { background: #eee; display: flex; flex-wrap: wrap; gap: 4mm; padding: 4mm; } .l { background: #fff; page-break-after: auto; } }
  </style></head><body>${labels.map((l) => `<div class="l"><div class="t">${esc(l.title)}</div>${code128Svg(l.code)}<div class="c">${esc(l.code)}</div><div class="s">${esc(l.lines.join(' · '))}</div></div>`).join('')}
  <script>window.onload = () => setTimeout(() => window.print(), 300);<\/script></body></html>`);
  w.document.close();
}

// Code 128 (set B), drawn as bars in an SVG.
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];
export function code128Svg(text) {
  const s = String(text).replace(/[^\x20-\x7E]/g, '');
  const codes = [104, ...[...s].map((ch) => ch.charCodeAt(0) - 32)];
  const check = codes.reduce((sum, c, i) => sum + c * (i || 1), 0) % 103;
  const pattern = [...codes, check, 106].map((c) => C128[c]).join('');
  let x = 10; let bars = '';
  [...pattern].forEach((w, i) => { const n = Number(w); if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${n}" height="40"/>`; x += n; });
  return `<svg viewBox="0 0 ${x + 10} 40" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}
