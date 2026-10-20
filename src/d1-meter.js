// Counts the rows D1 reads, so the free plan's daily limit (5 million rows)
// can be watched, and background work can stand down before it runs out.

const getState = async (env, key) => (await env.DB.prepare('SELECT value FROM sync_state WHERE key = ?').bind(key).first())?.value ?? null;
const setState = (env, key, value) => env.DB.prepare(
  'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).bind(key, String(value)).run();

export const DAILY_ROW_LIMIT = 5_000_000;
// Background jobs stop for the day once they have read this many rows, which
// leaves the rest of the allowance for people using the hub.
export const BACKGROUND_ROW_LIMIT = 2_000_000;
const KEEP_DAYS = 7;

export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

// Wraps a D1 binding so every query's rows read go to count(rows).
// first() is answered with all(), which is what D1 does underneath, so the
// rows read are reported for it too.
// A query's text, short enough to show, so the busiest ones can be listed.
export const queryName = (sql) => String(sql).replace(/\s+/g, ' ').replace(/\((\?,\s*)+\?\)/g, '(?…)').trim().slice(0, 140);

export function metered(db, count) {
  const tally = (result, sql) => { const rows = Number(result?.meta?.rows_read); if (rows > 0) count(rows, sql); return result; };
  const wrap = (stmt, sql) => ({
    statement: stmt,
    sql,
    bind: (...args) => wrap(stmt.bind(...args), sql),
    all: async () => tally(await stmt.all(), sql),
    run: async () => tally(await stmt.run(), sql),
    raw: (...args) => stmt.raw(...args),
    first: async (column) => {
      const result = tally(await stmt.all(), sql);
      const row = result?.results?.[0] ?? null;
      return column ? (row ? row[column] ?? null : null) : row;
    },
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (statements) => {
      const results = await db.batch(statements.map((s) => s.statement || s));
      results.forEach((r, i) => tally(r, statements[i]?.sql || 'batch'));
      return results;
    },
    unmetered: db,
  };
}

// Adds counts to a day's record: { total, jobs: { name: rows }, runs }.
const KEEP_QUERIES = 60;
export async function addReads(env, key, counts, { runs = 0, queries = {} } = {}) {
  const db = env.DB.unmetered || env.DB;
  const plain = { DB: db };
  const day = utcDay();
  const stateKey = `${key}:${day}`;
  let record;
  try { record = JSON.parse((await getState(plain, stateKey)) || '{}'); } catch { record = {}; }
  record.total ||= 0; record.jobs ||= {}; record.runs ||= 0;
  for (const [name, rows] of Object.entries(counts)) {
    if (!rows) continue;
    record.jobs[name] = (record.jobs[name] || 0) + rows;
    record.total += rows;
  }
  record.runs += runs;
  record.queries ||= {};
  for (const [q, rows] of Object.entries(queries)) record.queries[q] = (record.queries[q] || 0) + rows;
  // Only the busiest are kept, so the record stays small.
  record.queries = Object.fromEntries(Object.entries(record.queries).sort((a, b) => b[1] - a[1]).slice(0, KEEP_QUERIES));
  await setState(plain, stateKey, JSON.stringify(record));
  return record;
}

export async function readsToday(env, key) {
  const db = env.DB.unmetered || env.DB;
  try { return JSON.parse((await getState({ DB: db }, `${key}:${utcDay()}`)) || '{}'); } catch { return {}; }
}

// Old days are dropped so the record stays small.
export async function tidyReads(env) {
  const db = env.DB.unmetered || env.DB;
  const cutoff = utcDay(Date.now() - KEEP_DAYS * 86_400_000);
  await db.prepare("DELETE FROM sync_state WHERE (key LIKE 'd1_reads_bg:%' OR key LIKE 'd1_reads_web:%') AND substr(key, instr(key, ':') + 1) < ?")
    .bind(cutoff).run();
}

// The day's reads for Admin: background jobs and pages, busiest first.
export async function readsReport(env) {
  const db = env.DB.unmetered || env.DB;
  const { results } = await db.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'd1_reads_bg:%' OR key LIKE 'd1_reads_web:%'").all();
  const days = {};
  for (const row of results) {
    const [kind, day] = row.key.split(':');
    let value;
    try { value = JSON.parse(row.value); } catch { continue; }
    (days[day] ||= { day, background: { total: 0, jobs: {}, runs: 0 }, pages: { total: 0, jobs: {} } })[kind === 'd1_reads_bg' ? 'background' : 'pages'] = {
      total: value.total || 0, runs: value.runs || 0,
      jobs: value.jobs || {}, queries: value.queries || {},
    };
  }
  const list = Object.values(days).sort((a, b) => b.day.localeCompare(a.day)).map((d) => ({
    ...d,
    background: { ...d.background, top: Object.entries(d.background.jobs).sort((a, b) => b[1] - a[1]).slice(0, 12) },
    pages: { ...d.pages, top: Object.entries(d.pages.jobs).sort((a, b) => b[1] - a[1]).slice(0, 12) },
    queries: [...Object.entries(d.background.queries || {}).map(([q, n]) => ({ q, n, where: 'Background' })),
      ...Object.entries(d.pages.queries || {}).map(([q, n]) => ({ q, n, where: 'Pages' }))].sort((a, b) => b.n - a.n).slice(0, 15),
  }));
  return {
    limit: DAILY_ROW_LIMIT, backgroundLimit: BACKGROUND_ROW_LIMIT,
    paused: (await getState({ DB: db }, 'd1_paused_day')) === utcDay(),
    days: list,
  };
}
