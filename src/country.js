// The hub is split between Promtek UK and Promtek Africa. In Jobs, Quotes, Service
// contracts, PSC, Capacity, Invoicing, Vehicles, 8x8 calls and Customers, people see
// their own country's customers and items. Admins, Management and developers see both,
// as do tile admins in their tile. Someone from the other country can be involved in a
// single PSC item or job, and then sees and works on it as if it were their own.
import { customerProjects } from './jira.js';
import { onlyCountry, countryOf, access, loadAccessConfig, canTile, COUNTRY_NAMES } from './permissions.js';

export { onlyCountry, countryOf, COUNTRY_NAMES };
export const projectOf = (key) => String(key || '').split('-')[0].toUpperCase();
const other = (c) => (c === 'sa' ? 'uk' : 'sa');

// Each customer project's country. Projects that aren't customers' have none.
export async function projectRegions(env) {
  try { return new Map((await customerProjects(env)).map((p) => [p.key.toUpperCase(), p.region])); } catch { return new Map(); }
}

// The issue keys someone has been involved in from the other country.
export async function involvedKeys(env, viewer) {
  if (!viewer?.accountId) return new Set();
  try {
    const { results } = await env.DB.prepare('SELECT issue_key FROM item_involvements WHERE account_id = ?').bind(viewer.accountId).all();
    return new Set(results.map((r) => r.issue_key));
  } catch { return new Set(); }
}

// What someone sees in a tile: a test for an item's country (and keys they're involved in).
// Items with no country (not a customer's) are for everyone.
export async function scopeFor(env, viewer, tile) {
  const only = onlyCountry(viewer, tile);
  const [regions, involved] = await Promise.all([projectRegions(env), only ? involvedKeys(env, viewer) : new Set()]);
  const regionOf = (projectKey) => regions.get(projectOf(projectKey)) || null;
  if (!only) return { only: null, regions, regionOf, involved, sees: () => true, seesProject: () => true, seesRegion: () => true };
  const seesRegion = (r) => !r || r === only;
  const seesProject = (projectKey) => seesRegion(regions.get(projectOf(projectKey)));
  // An item: its own country, or one they're involved in (on it, or the order it's part of).
  const sees = ({ region, project, keys = [] } = {}) => {
    if (keys.some((k) => k && involved.has(k))) return true;
    return region !== undefined ? seesRegion(region) : seesProject(project || keys[0]);
  };
  return { only, regions, regionOf, involved, sees, seesProject, seesRegion };
}

// Refuses an item from the other country, unless they're involved in it.
export async function mustSeeItem(env, viewer, tile, { region, project, keys = [] }) {
  const s = await scopeFor(env, viewer, tile);
  if (!s.sees({ region, project, keys })) {
    const err = new Error(`That belongs to Promtek ${s.only === 'sa' ? 'UK' : 'Africa'}.`); err.status = 403; throw err;
  }
  return s;
}

// ---------- involving someone from the other country ----------

const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const KINDS = { psc: 'psc', job: 'jobs' };

async function itemCountry(env, kind, key) {
  if (kind === 'psc') {
    const { context, describe } = await import('./psc.js');
    const ctx = await context(env);
    const row = ctx.items.find((r) => r.issue_key === key);
    if (!row) return null;
    return describe(row, ctx).region || null;
  }
  return (await projectRegions(env)).get(projectOf(key)) || null;
}

async function everyone(env) {
  const config = await loadAccessConfig(env);
  const admins = (env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const { results } = await env.DB.prepare("SELECT * FROM employees WHERE active = 1 AND account_id NOT LIKE 'pending%' ORDER BY name").all();
  return results.map((e) => ({ e, a: { ...access(e, { config, fallbackAdmin: admins.includes(String(e.email || '').toLowerCase()) }), accountId: e.account_id } }));
}

// Who is involved in an item, and who from the other country could be.
export async function involvement(env, viewer, { kind, key }) {
  if (!KINDS[kind] || !KEY.test(String(key || ''))) throw new Error('Choose a PSC item or a job.');
  const tile = KINDS[kind];
  const region = await itemCountry(env, kind, key);
  const theirs = region || viewer.country || 'uk';
  await mustSeeItem(env, viewer, tile, { region: region || undefined, project: key, keys: [key] });
  const { results } = await env.DB.prepare(
    'SELECT i.account_id, i.added_at, e.name, e.avatar, a.name AS added_name FROM item_involvements i LEFT JOIN employees e ON e.account_id = i.account_id LEFT JOIN employees a ON a.account_id = i.added_by WHERE i.issue_key = ? ORDER BY e.name'
  ).bind(key).all();
  const already = new Set(results.map((r) => r.account_id));
  const want = other(theirs);
  // People from the other country who can open the tile but wouldn't already see this.
  const options = (await everyone(env)).filter(({ e, a }) => countryOf(e) === want && canTile(a, tile) && onlyCountry(a, tile) && !already.has(e.account_id))
    .map(({ e }) => ({ id: e.account_id, name: e.name }));
  return { key, kind, country: theirs, otherCountry: want, label: `Involve user from ${COUNTRY_NAMES[want]}`,
    people: results.map((r) => ({ id: r.account_id, name: r.name || 'Someone not in the hub', avatar: r.avatar || null, addedBy: r.added_name || null, addedAt: r.added_at })),
    options };
}

export async function involve(env, viewer, { kind, key, accountId }) {
  const now = await involvement(env, viewer, { kind, key });
  const pick = now.options.find((o) => o.id === accountId);
  if (!pick) throw new Error(`Choose someone from Promtek ${now.otherCountry === 'sa' ? 'Africa' : 'UK'}.`);
  await env.DB.prepare('INSERT OR IGNORE INTO item_involvements (issue_key, kind, account_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
    .bind(key, kind, accountId, viewer.accountId || null, new Date().toISOString()).run();
  return { ok: true, name: pick.name, ...(await involvement(env, viewer, { kind, key })) };
}

export async function uninvolve(env, viewer, { kind, key, accountId }) {
  await involvement(env, viewer, { kind, key });
  await env.DB.prepare('DELETE FROM item_involvements WHERE issue_key = ? AND account_id = ?').bind(key, String(accountId || '')).run();
  return { ok: true, ...(await involvement(env, viewer, { kind, key })) };
}

// A PSC row's country (psc_items: project_key and org), for lists outside the PSC tile.
export async function pscRegions(env) {
  const { context } = await import('./psc.js');
  const ctx = await context(env).catch(() => null);
  const regions = new Map((ctx?.projects || []).map((p) => [p.key, p.region]));
  return (row) => {
    const key = row.project_key === 'PSC' ? (row.org && ctx ? row.org.split(' | ').map(ctx.match).find(Boolean) : null) : row.project_key;
    return (key && regions.get(key)) || null;
  };
}
