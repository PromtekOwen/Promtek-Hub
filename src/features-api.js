// The Features page: what each tile does (from src/features.js, with any changes made in the hub)
// and what's being worked on next (written in the hub).
import { FEATURES, FEATURE_TILES } from './features.js';

const nowIso = () => new Date().toISOString();
function bad(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const canEdit = (v) => Boolean(v?.isAdmin || v?.can?.featuresEdit);
const need = (v) => { if (!canEdit(v)) throw bad('Only developers change the Features page.', 403); };
const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
const whoOf = (v) => v.employee?.name || v.email;

// The tiles someone can open, and General. Editors see every tile, so nothing can be missed.
function tilesFor(viewer) {
  return Object.keys(FEATURE_TILES).filter((t) => t === 'general' || canEdit(viewer) || (t === 'admin' ? viewer.isAdmin || viewer.can?.developer : viewer.isAdmin || viewer.tiles?.[t]));
}

export async function list(env, viewer) {
  const editor = canEdit(viewer);
  const [edits, custom, plans] = await Promise.all([
    env.DB.prepare('SELECT * FROM feature_edits').all().then((r) => r.results || []).catch(() => []),
    env.DB.prepare('SELECT * FROM feature_custom ORDER BY id').all().then((r) => r.results || []).catch(() => []),
    env.DB.prepare('SELECT * FROM feature_plans ORDER BY sort, id').all().then((r) => r.results || []).catch(() => []),
  ]);
  const byId = new Map(edits.map((e) => [e.id, e]));
  const shipped = FEATURES.map((x) => {
    const e = byId.get(x.id);
    return { id: x.id, tile: x.tile, text: e?.text || x.text, original: x.text, edited: Boolean(e?.text), hidden: Boolean(e?.hidden), added: x.added, own: false };
  });
  const own = custom.map((c) => ({ id: `custom.${c.id}`, tile: c.tile, text: c.text, hidden: Boolean(c.hidden), added: c.added || (c.created_at || '').slice(0, 10), own: true }));
  const tiles = tilesFor(viewer);
  const released = tiles.map((t) => ({
    tile: t, name: FEATURE_TILES[t],
    items: [...shipped, ...own].filter((x) => x.tile === t && (editor || !x.hidden))
      .sort((a, b) => String(b.added || '').localeCompare(String(a.added || ''))),
  })).filter((s) => s.items.length || editor);
  const working = tiles.map((t) => ({ tile: t, name: FEATURE_TILES[t], items: plans.filter((p) => p.tile === t).map((p) => ({ id: p.id, text: p.text, added: (p.created_at || '').slice(0, 10) })) }))
    .filter((s) => s.items.length || editor);
  const latest = [...shipped, ...own].filter((x) => !x.hidden && tiles.includes(x.tile)).map((x) => x.added).filter(Boolean).sort().pop() || null;
  return { released, working, canEdit: editor, latest };
}

// The newest release-note date someone can see, for the "new" mark in the account menu.
export async function latest(env, viewer) {
  return { latest: (await list(env, viewer)).latest };
}

export async function edit(env, viewer, { id, text, hidden }) {
  need(viewer);
  const key = String(id || '');
  if (key.startsWith('custom.')) {
    const n = Number(key.slice(7));
    const row = await env.DB.prepare('SELECT * FROM feature_custom WHERE id = ?').bind(n).first();
    if (!row) throw bad('That line isn\'t on record.', 404);
    if (text !== undefined && !clean(text)) throw bad('Write something, or hide the line instead.');
    await env.DB.prepare('UPDATE feature_custom SET text = ?, hidden = ? WHERE id = ?').bind(text !== undefined ? clean(text) : row.text, hidden !== undefined ? (hidden ? 1 : 0) : row.hidden, n).run();
    return { ok: true };
  }
  const base = FEATURES.find((x) => x.id === key);
  if (!base) throw bad('That line isn\'t on record.', 404);
  const was = await env.DB.prepare('SELECT * FROM feature_edits WHERE id = ?').bind(key).first();
  // Wording put back to what shipped is stored as no change, so later rewording in the code shows.
  const newText = text === undefined ? was?.text || null : clean(text) && clean(text) !== base.text ? clean(text) : null;
  if (text !== undefined && !clean(text)) throw bad('Write something, or hide the line instead.');
  const newHidden = hidden === undefined ? was?.hidden || 0 : hidden ? 1 : 0;
  await env.DB.prepare(`INSERT INTO feature_edits (id, text, hidden, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET text = excluded.text, hidden = excluded.hidden, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(key, newText, newHidden, nowIso(), whoOf(viewer)).run();
  return { ok: true };
}

export async function add(env, viewer, { tile, text }) {
  need(viewer);
  if (!FEATURE_TILES[tile]) throw bad('Choose a tile.');
  const t = clean(text);
  if (!t) throw bad('Write what it does.');
  await env.DB.prepare('INSERT INTO feature_custom (tile, text, added, hidden, created_at, created_by) VALUES (?, ?, ?, 0, ?, ?)').bind(tile, t, nowIso().slice(0, 10), nowIso(), whoOf(viewer)).run();
  return { ok: true };
}

export async function removeOwn(env, viewer, { id }) {
  need(viewer);
  const n = Number(String(id || '').replace(/^custom\./, ''));
  await env.DB.prepare('DELETE FROM feature_custom WHERE id = ?').bind(n).run();
  return { ok: true };
}

// "Working on": ideas planned for each tile, in the order they're listed.
export async function planSave(env, viewer, { id, tile, text }) {
  need(viewer);
  const t = clean(text);
  if (!t) throw bad('Write what\'s planned.');
  if (id) {
    await env.DB.prepare('UPDATE feature_plans SET text = ?, updated_at = ? WHERE id = ?').bind(t, nowIso(), Number(id)).run();
    return { ok: true };
  }
  if (!FEATURE_TILES[tile]) throw bad('Choose a tile.');
  const last = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM feature_plans WHERE tile = ?').bind(tile).first();
  await env.DB.prepare('INSERT INTO feature_plans (tile, text, sort, created_at, created_by) VALUES (?, ?, ?, ?, ?)').bind(tile, t, (last?.s || 0) + 1, nowIso(), whoOf(viewer)).run();
  return { ok: true };
}

export async function planRemove(env, viewer, { id }) {
  need(viewer);
  await env.DB.prepare('DELETE FROM feature_plans WHERE id = ?').bind(Number(id)).run();
  return { ok: true };
}

export async function planMove(env, viewer, { id, dir }) {
  need(viewer);
  const p = await env.DB.prepare('SELECT * FROM feature_plans WHERE id = ?').bind(Number(id)).first();
  if (!p) throw bad('That line isn\'t on record.', 404);
  const rows = (await env.DB.prepare('SELECT * FROM feature_plans WHERE tile = ? ORDER BY sort, id').bind(p.tile).all()).results || [];
  const i = rows.findIndex((r) => r.id === p.id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= rows.length) return { ok: true };
  [rows[i], rows[j]] = [rows[j], rows[i]];
  await env.DB.batch(rows.map((r, k) => env.DB.prepare('UPDATE feature_plans SET sort = ? WHERE id = ?').bind(k + 1, r.id)));
  return { ok: true };
}
