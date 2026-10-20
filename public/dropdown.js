// Drop-down menus across the hub: one style for every choice list, and for the
// suggestions under fields that have them.
//
// Lists (<select>) keep the real element on the page, so the code that reads
// and changes them is unchanged. With a mouse, the list opens in the hub's own
// panel instead of the browser's. On phones and tablets the phone's own picker
// is kept, as it's easier to use with a thumb.
//
// Fields with suggestions (<input list="…">) show them in the same panel as you
// type, filtered by what's typed, on every device.

const finePointer = () => window.matchMedia?.('(pointer: fine)').matches;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let open = null;   // { owner, panel, kind, items, active, search }

export function closeDropdown() { close(); }

function close() {
  if (!open) return;
  open.panel.remove();
  open.owner.setAttribute('aria-expanded', 'false');
  open.owner.classList.remove('dd-open');
  open = null;
}

// Puts the panel under its field, or above it if there's more room there.
function place(panel, owner) {
  const r = owner.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 8;
  const above = r.top - 8;
  const up = below < 220 && above > below;
  const max = Math.max(140, Math.min(340, up ? above : below));
  panel.style.maxHeight = `${max}px`;
  panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 200) - 8))}px`;
  panel.style.minWidth = `${Math.max(r.width, 200)}px`;
  panel.style.maxWidth = `${Math.max(r.width, Math.min(480, window.innerWidth - 16))}px`;
  if (up) { panel.style.top = ''; panel.style.bottom = `${window.innerHeight - r.top + 4}px`; }
  else { panel.style.bottom = ''; panel.style.top = `${r.bottom + 4}px`; }
}

function highlight(i) {
  if (!open) return;
  const rows = [...open.panel.querySelectorAll('.dd-option:not(.disabled)')];
  if (!rows.length) { open.active = -1; return; }
  open.active = (i + rows.length) % rows.length;
  rows.forEach((row, n) => row.classList.toggle('active', n === open.active));
  rows[open.active].scrollIntoView({ block: 'nearest' });
}

function renderRows() {
  const { items, search } = open;
  const q = (search || '').trim().toLowerCase();
  const shown = q ? items.filter((it) => it.label.toLowerCase().includes(q)) : items;
  const list = open.panel.querySelector('.dd-list');
  list.innerHTML = shown.length
    ? shown.map((it) => {
      let label = esc(it.label);
      if (q) {
        const at = it.label.toLowerCase().indexOf(q);
        if (at >= 0) label = `${esc(it.label.slice(0, at))}<mark>${esc(it.label.slice(at, at + q.length))}</mark>${esc(it.label.slice(at + q.length))}`;
      }
      return `<div class="dd-option${it.selected ? ' selected' : ''}${it.disabled ? ' disabled' : ''}${it.placeholder ? ' placeholder' : ''}" role="option"
        aria-selected="${it.selected ? 'true' : 'false'}" data-dd-value="${esc(it.value)}">${label}</div>`;
    }).join('')
    : '<div class="dd-empty">No matches</div>';
  // A list starts on its current choice; suggestions start with nothing picked,
  // so Enter still keeps what was typed.
  if (open.kind === 'input') { open.active = -1; return; }
  const start = shown.findIndex((it) => it.selected && !it.disabled);
  highlight(start >= 0 && !q ? start : 0);
}

function openPanel(owner, kind, items) {
  close();
  const panel = document.createElement('div');
  panel.className = `dd-panel dd-${kind}`;
  panel.setAttribute('role', 'listbox');
  const searchable = kind === 'select' && items.length > 8;
  panel.innerHTML = `${searchable ? '<div class="dd-search"><input type="search" placeholder="Type to filter" autocomplete="off" aria-label="Filter the list"></div>' : ''}<div class="dd-list"></div>`;
  document.body.appendChild(panel);
  open = { owner, panel, kind, items, active: -1, search: kind === 'input' ? owner.value : '' };
  owner.setAttribute('aria-expanded', 'true');
  owner.classList.add('dd-open');
  renderRows();
  place(panel, owner);
  const box = panel.querySelector('.dd-search input');
  if (box) {
    box.addEventListener('input', () => { open.search = box.value; renderRows(); });
    box.focus({ preventScroll: true });
  }
  // Clicks in the panel mustn't take focus from the field.
  panel.addEventListener('mousedown', (e) => { if (!e.target.closest('.dd-search')) e.preventDefault(); });
  panel.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.dd-option:not(.disabled)');
    if (!row || row.classList.contains('active')) return;
    const rows = [...panel.querySelectorAll('.dd-option:not(.disabled)')];
    open.active = rows.indexOf(row);
    rows.forEach((r) => r.classList.toggle('active', r === row));
  });
  panel.addEventListener('click', (e) => {
    const row = e.target.closest('.dd-option');
    if (row && !row.classList.contains('disabled')) choose(row.dataset.ddValue);
  });
}

// Sets the value the way a person would, so the page's own handlers run.
function choose(value) {
  if (!open) return;
  const { owner, kind } = open;
  close();
  if (kind === 'select') {
    if (owner.value === value) { owner.focus({ preventScroll: true }); return; }
    owner.value = value;
    owner.dispatchEvent(new Event('input', { bubbles: true }));
    owner.dispatchEvent(new Event('change', { bubbles: true }));
    if (owner.isConnected) owner.focus({ preventScroll: true });
  } else {
    owner.value = value;
    owner.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
    owner.dispatchEvent(new Event('change', { bubbles: true }));
    if (owner.isConnected) owner.focus({ preventScroll: true });
  }
}

function keys(e) {
  if (!open) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); highlight(open.active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(open.active - 1); }
  else if (e.key === 'Enter') {
    const row = open.panel.querySelectorAll('.dd-option:not(.disabled)')[open.active];
    if (row) { e.preventDefault(); choose(row.dataset.ddValue); }
  } else if (e.key === 'Escape') { e.preventDefault(); const owner = open.owner; close(); owner.focus({ preventScroll: true }); }
  else if (e.key === 'Tab') close();
}

// ---------- lists ----------

function selectItems(select) {
  return [...select.options].map((o) => ({
    value: o.value, label: o.textContent.trim() || o.value, selected: o.selected,
    disabled: o.disabled, placeholder: o.value === '' && o.index === 0,
  }));
}

function openSelect(select) {
  if (select.disabled || select.multiple) return;
  openPanel(select, 'select', selectItems(select));
}

document.addEventListener('mousedown', (e) => {
  const select = e.target.closest?.('select');
  if (select && !select.multiple && finePointer() && e.button === 0) {
    e.preventDefault();
    if (open?.owner === select) { close(); return; }
    select.focus({ preventScroll: true });
    openSelect(select);
    return;
  }
  if (open && !open.panel.contains(e.target) && e.target !== open.owner) close();
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (open && (t === open.owner || open.panel.contains(t))) { keys(e); return; }
  if (t.tagName === 'SELECT' && !t.multiple && finePointer() && [' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(e.key) && !e.altKey) {
    e.preventDefault();
    openSelect(t);
  }
});

// ---------- fields with suggestions ----------

// The browser's own suggestion list is switched off; the hub shows its own.
function adopt(input) {
  const id = input.getAttribute('list');
  if (!id) return;
  input.dataset.suggest = id;
  input.removeAttribute('list');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-autocomplete', 'list');
}

export function suggestionsFor(input) {
  const id = input?.dataset?.suggest || input?.getAttribute?.('list');
  return id ? document.getElementById(id) : null;
}

function showSuggestions(input) {
  const list = suggestionsFor(input);
  if (!list) return;
  const typed = input.value.trim().toLowerCase();
  const items = [...list.options].map((o) => o.value).filter(Boolean)
    .filter((v) => !typed || v.toLowerCase().includes(typed))
    .filter((v) => v.toLowerCase() !== typed)
    .slice(0, 200)
    .map((v) => ({ value: v, label: v }));
  if (!items.length) { if (open?.owner === input) close(); return; }
  if (open?.owner === input) { open.items = items; open.search = input.value; renderRows(); place(open.panel, input); return; }
  openPanel(input, 'input', items);
}

document.addEventListener('focusin', (e) => { if (e.target.dataset?.suggest) showSuggestions(e.target); });
document.addEventListener('input', (e) => {
  if (!e.target.dataset?.suggest) return;
  // Only typing opens suggestions; the hub filling a field in (or a guide doing it) doesn't.
  if (!e.isTrusted || e.inputType === 'insertReplacementText') return;
  // The page may change the suggestions as you type, so they're read afterwards.
  queueMicrotask(() => showSuggestions(e.target));
});
document.addEventListener('focusout', (e) => {
  if (open?.kind === 'input' && e.target === open.owner) setTimeout(() => { if (open?.owner === e.target && document.activeElement !== e.target) close(); }, 120);
});

// Fields are drawn and redrawn all the time, so each new one is picked up as it appears.
const adoptAll = (root) => {
  if (root.matches?.('input[list]')) adopt(root);
  root.querySelectorAll?.('input[list]').forEach(adopt);
};
new MutationObserver((changes) => {
  for (const c of changes) {
    for (const node of c.addedNodes) if (node.nodeType === 1) adoptAll(node);
    if (c.type === 'attributes' && c.target.matches?.('input[list]')) adopt(c.target);
  }
  if (open && !open.owner.isConnected) close();
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['list'] });
adoptAll(document);

// The page moving (or a phone's keyboard opening) moves the panel with its field.
const follow = (e) => {
  if (!open || (e && open.panel.contains(e.target))) return;
  const r = open.owner.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) { close(); return; }
  place(open.panel, open.owner);
};
window.addEventListener('resize', () => follow());
document.addEventListener('scroll', follow, true);
