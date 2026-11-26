// The Features page (account menu → Features): what each tile does, and what's being worked on.
let H = null;
const view = document.getElementById('view');
const S = { tab: 'released', data: null, open: new Set(), editing: null, adding: null, seen: null };
const SEEN_KEY = 'hub.features.seen';
const here = () => location.hash.startsWith('#/features');
const esc = (s) => H.esc(s);
const post = (path, body) => H.api(`/api/features/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
const month = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '');

export function seen() { try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; } }
function markSeen(latest) { try { if (latest && latest > seen()) localStorage.setItem(SEEN_KEY, latest); } catch { /* storage off */ } }

export function init(helpers) {
  if (H) { H = helpers; return; }
  H = helpers;
  view.addEventListener('click', (e) => { if (here()) onClick(e); });
  view.addEventListener('submit', (e) => { if (here()) onSubmit(e); });
}

export async function render() {
  S.data = await H.api('/api/features');
  // What was new on arrival stays marked while the page is open; it counts as seen from the next visit.
  S.seen = seen();
  markSeen(S.data.latest);
  // Sections with something new start open; the rest start folded.
  if (!S.opened) {
    S.opened = true;
    for (const s of S.data.released) if (s.items.some((i) => isNew(i))) S.open.add(`released:${s.tile}`);
  }
  return html();
}

const isNew = (i) => Boolean(S.seen && i.added && i.added > S.seen && !i.hidden);

function html() {
  const d = S.data;
  const tabs = [['released', 'Release notes'], ['working', 'Working on']];
  const list = S.tab === 'released' ? d.released : d.working;
  const newCount = d.released.reduce((n, s) => n + s.items.filter(isNew).length, 0);
  return `<div class="ft">
    <div class="row ft-tools"><span class="segment">${tabs.map(([k, l]) => `<button class="seg${S.tab === k ? ' on' : ''}" data-ft-tab="${k}">${l}${k === 'released' && newCount ? ` <span class="ft-count">${newCount} new</span>` : ''}</button>`).join('')}</span></div>
    <div class="row ft-intro"><span class="muted">${S.tab === 'released' ? 'What each tile you use can do, newest first.' : 'Ideas planned for each tile, not built yet.'}</span>
      ${list.length ? `<button class="linklike" data-ft-all="${list.every((s) => S.open.has(`${S.tab}:${s.tile}`)) ? 'close' : 'open'}">${list.every((s) => S.open.has(`${S.tab}:${s.tile}`)) ? 'Fold all' : 'Open all'}</button>` : ''}</div>
    ${list.length ? list.map((s) => sectionHtml(s)).join('') : `<section class="card"><p class="muted">${S.tab === 'released' ? 'Nothing listed yet.' : 'Nothing planned yet.'}</p></section>`}
  </div>`;
}

function sectionHtml(s) {
  const key = `${S.tab}:${s.tile}`;
  const open = S.open.has(key);
  const fresh = S.tab === 'released' ? s.items.filter(isNew).length : 0;
  const shown = s.items.filter((i) => !i.hidden).length;
  return `<section class="card ft-sec${open ? ' open' : ''}">
    <button class="ft-head" data-ft-toggle="${key}" aria-expanded="${open}"><span class="ft-name">${esc(s.name)}</span>
      <span class="ft-meta">${fresh ? `<span class="ft-count">${fresh} new</span>` : ''}<span class="muted">${shown}</span><span class="ft-chev" aria-hidden="true">›</span></span></button>
    ${open ? `<div class="ft-body">${S.tab === 'released' ? releasedBody(s) : workingBody(s)}</div>` : ''}
  </section>`;
}

function releasedBody(s) {
  const edit = S.data.canEdit;
  const rows = s.items.map((i) => {
    if (S.editing === i.id) return editForm(i.id, i.text, 'edit');
    return `<li class="${i.hidden ? 'ft-hidden' : ''}${isNew(i) ? ' ft-new' : ''}"><span class="ft-text">${esc(i.text)}</span>
      <span class="ft-when">${isNew(i) ? '<span class="ft-tag">New</span>' : ''}${month(i.added)}${edit && i.edited ? ' · reworded' : ''}${edit && i.own ? ' · added here' : ''}${edit && i.hidden ? ' · hidden' : ''}</span>
      ${edit ? `<span class="ft-acts"><button class="linklike" data-ft-edit="${esc(i.id)}">Edit</button>
        <button class="linklike" data-ft-hide="${esc(i.id)}" data-hidden="${i.hidden ? 1 : 0}">${i.hidden ? 'Show' : 'Hide'}</button>
        ${i.own ? `<button class="linklike danger" data-ft-del="${esc(i.id)}">Delete</button>` : ''}</span>` : ''}</li>`;
  }).join('');
  return `${rows ? `<ul class="ft-list">${rows}</ul>` : '<p class="muted">Nothing listed yet.</p>'}
    ${edit ? (S.adding === `released:${s.tile}` ? editForm(s.tile, '', 'add') : `<button class="linklike" data-ft-add="released:${s.tile}">+ Add a line</button>`) : ''}`;
}

function workingBody(s) {
  const edit = S.data.canEdit;
  const rows = s.items.map((i, k) => {
    if (S.editing === `plan.${i.id}`) return editForm(i.id, i.text, 'plan');
    return `<li><span class="ft-text">${esc(i.text)}</span>
      ${edit ? `<span class="ft-acts">${k ? `<button class="linklike" data-ft-move="${i.id}" data-dir="up" aria-label="Move up">↑</button>` : ''}${k < s.items.length - 1 ? `<button class="linklike" data-ft-move="${i.id}" data-dir="down" aria-label="Move down">↓</button>` : ''}
        <button class="linklike" data-ft-editplan="${i.id}">Edit</button><button class="linklike danger" data-ft-delplan="${i.id}">Delete</button></span>` : ''}</li>`;
  }).join('');
  return `${rows ? `<ul class="ft-list">${rows}</ul>` : '<p class="muted">Nothing planned yet.</p>'}
    ${edit ? (S.adding === `working:${s.tile}` ? editForm(s.tile, '', 'newplan') : `<button class="linklike" data-ft-add="working:${s.tile}">+ Add an idea</button>`) : ''}`;
}

function editForm(id, value, kind) {
  return `<form class="ft-form" data-ft-form="${kind}" data-id="${esc(id)}"><textarea name="text" rows="2" required>${esc(value)}</textarea>
    <div class="row"><button class="btn small" type="submit">Save</button><button class="linklike" type="button" data-ft-cancel>Cancel</button></div></form>`;
}

async function refresh() { S.data = await H.api('/api/features'); redraw(); }
function redraw() { view.innerHTML = html(); view.querySelector('.ft-form textarea')?.focus(); }

async function act(fn) { try { await fn(); } catch (err) { H.toast(err.message); } }

async function onClick(e) {
  const t = (sel) => e.target.closest(sel);
  let b;
  if ((b = t('[data-ft-tab]'))) { S.tab = b.dataset.ftTab; S.editing = null; S.adding = null; return redraw(); }
  if ((b = t('[data-ft-toggle]'))) { const k = b.dataset.ftToggle; S.open.has(k) ? S.open.delete(k) : S.open.add(k); return redraw(); }
  if ((b = t('[data-ft-all]'))) {
    const list = S.tab === 'released' ? S.data.released : S.data.working;
    for (const s of list) b.dataset.ftAll === 'open' ? S.open.add(`${S.tab}:${s.tile}`) : S.open.delete(`${S.tab}:${s.tile}`);
    return redraw();
  }
  if ((b = t('[data-ft-edit]'))) { S.editing = b.dataset.ftEdit; S.adding = null; return redraw(); }
  if ((b = t('[data-ft-editplan]'))) { S.editing = `plan.${b.dataset.ftEditplan}`; S.adding = null; return redraw(); }
  if ((b = t('[data-ft-add]'))) { S.adding = b.dataset.ftAdd; S.editing = null; return redraw(); }
  if ((b = t('[data-ft-cancel]'))) { S.editing = null; S.adding = null; return redraw(); }
  if ((b = t('[data-ft-hide]'))) return act(async () => { await post('edit', { id: b.dataset.ftHide, hidden: b.dataset.hidden !== '1' }); await refresh(); });
  if ((b = t('[data-ft-del]'))) { if (!confirm('Delete this line?')) return; return act(async () => { await post('remove', { id: b.dataset.ftDel }); await refresh(); }); }
  if ((b = t('[data-ft-delplan]'))) { if (!confirm('Delete this idea?')) return; return act(async () => { await post('plan-remove', { id: b.dataset.ftDelplan }); await refresh(); }); }
  if ((b = t('[data-ft-move]'))) return act(async () => { await post('plan-move', { id: b.dataset.ftMove, dir: b.dataset.dir }); await refresh(); });
}

async function onSubmit(e) {
  const f = e.target.closest('form[data-ft-form]');
  if (!f) return;
  e.preventDefault();
  const text = new FormData(f).get('text');
  const { ftForm: kind } = f.dataset; const id = f.dataset.id;
  await act(async () => {
    if (kind === 'edit') await post('edit', { id, text });
    if (kind === 'add') await post('add', { tile: id, text });
    if (kind === 'plan') await post('plan', { id, text });
    if (kind === 'newplan') await post('plan', { tile: id, text });
    S.editing = null; S.adding = null;
    await refresh();
  });
}
