// Which pages people open, and when each person last used the hub. For admins only.
import { londonDate } from './sync.js';

const KEEP_DAYS = 400;
const SEEN_EVERY_MS = 10 * 60_000;
const PAGE = /^#\/[a-z0-9-]{0,40}$/;

// One count per page opened. A developer viewing as someone writes nothing.
export async function record(env, viewer, page) {
  const p = String(page || '');
  if (!PAGE.test(p)) return { ok: true };
  const who = viewer.accountId || viewer.email;
  if (!who) return { ok: true };
  try {
    await env.DB.prepare(
      `INSERT INTO usage_daily (day, page, account, opens, last_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(day, page, account) DO UPDATE SET opens = usage_daily.opens + 1, last_at = excluded.last_at`
    ).bind(londonDate(), p, who, new Date().toISOString()).run();
  } catch {
    // Until schema-049 adds the time of the last open, the count alone is kept.
    await env.DB.prepare(
      `INSERT INTO usage_daily (day, page, account, opens) VALUES (?, ?, ?, 1)
       ON CONFLICT(day, page, account) DO UPDATE SET opens = usage_daily.opens + 1`
    ).bind(londonDate(), p, who).run();
  }
  return { ok: true };
}

// When someone last opened the hub, kept to the nearest ten minutes so it's rarely written.
export async function seen(env, viewer) {
  if (!viewer?.accountId) return;
  const now = Date.now();
  await env.DB.prepare('UPDATE employees SET last_seen_at = ? WHERE account_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)')
    .bind(new Date(now).toISOString(), viewer.accountId, new Date(now - SEEN_EVERY_MS).toISOString()).run();
}

export async function report(env, { days = 30 } = {}) {
  const n = [7, 30, 90, 365].includes(Number(days)) ? Number(days) : 30;
  const from = londonDate(Date.now() - (n - 1) * 86_400_000);
  const [pages, people, byPerson] = await Promise.all([
    env.DB.prepare('SELECT page, SUM(opens) AS opens, COUNT(DISTINCT account) AS people FROM usage_daily WHERE day >= ? GROUP BY page ORDER BY opens DESC').bind(from).all(),
    env.DB.prepare('SELECT account_id, name, email, last_seen_at FROM employees WHERE active = 1 ORDER BY name').all(),
    env.DB.prepare('SELECT account, page, SUM(opens) AS opens, COUNT(DISTINCT day) AS days, MAX(day) AS last_day, MAX(last_at) AS last_at FROM usage_daily WHERE day >= ? GROUP BY account, page')
      .bind(from).all()
      .catch(() => env.DB.prepare('SELECT account, page, SUM(opens) AS opens, COUNT(DISTINCT day) AS days, MAX(day) AS last_day FROM usage_daily WHERE day >= ? GROUP BY account, page').bind(from).all()),
  ]);
  const mine = new Map();
  for (const r of byPerson.results) {
    const m = mine.get(r.account) || { opens: 0, top: null, topOpens: 0, tiles: [] };
    m.opens += r.opens;
    // Each tile: how often, on how many days, and when last. Opens from before the
    // time was kept only know their day.
    m.tiles.push({ page: r.page, opens: r.opens, days: r.days, lastAt: r.last_at || null, lastDay: r.last_day || null });
    if (r.page !== '#/' && r.opens > m.topOpens) { m.top = r.page; m.topOpens = r.opens; }
    mine.set(r.account, m);
  }
  const activeDays = new Map((await env.DB.prepare('SELECT account, COUNT(DISTINCT day) AS days FROM usage_daily WHERE day >= ? GROUP BY account').bind(from).all())
    .results.map((r) => [r.account, r.days]));
  return {
    days: n, from,
    pages: pages.results,
    people: people.results.map((e) => {
      const m = mine.get(e.account_id) || mine.get(e.email) || null;
      const tiles = (m?.tiles || []).sort((a, b) => String(b.lastAt || b.lastDay).localeCompare(String(a.lastAt || a.lastDay)));
      return { id: e.account_id, name: e.name, lastSeen: e.last_seen_at || null, opens: m?.opens || 0, top: m?.top || null,
        days: activeDays.get(e.account_id) || activeDays.get(e.email) || 0, tiles };
    }).sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || a.name.localeCompare(b.name)),
  };
}

export async function tidy(env) {
  await env.DB.prepare('DELETE FROM usage_daily WHERE day < ?').bind(londonDate(Date.now() - KEEP_DAYS * 86_400_000)).run();
}
