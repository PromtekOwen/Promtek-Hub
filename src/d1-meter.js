// Counts the rows D1 reads and writes, so the Workers Paid plan's monthly
// allowance (25 billion rows read, 50 million rows written) can be watched,
// and background work can stand down before it runs out.

const getState = async (env, key) => (await env.DB.prepare('SELECT value FROM sync_state WHERE key = ?').bind(key).first())?.value ?? null;
const setState = (env, key, value) => env.DB.prepare(
  'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).bind(key, String(value)).run();

export const MONTHLY_READ_LIMIT = 25_000_000_000;
export const MONTHLY_WRITE_LIMIT = 50_000_000;
// Background jobs stop for the rest of the month once the month's total reaches
// this share of either allowance, which leaves the rest for people using the hub.
export const BACKGROUND_SHARE = 0.9;
// A day using more than twice its even share of the month is worth a look.
export const PACE_ALERT = 2;
const KEEP_DAYS = 40;

export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
export const utcMonth = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 7);
export const daysInMonth = (ms = Date.now()) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); };

// A query's text, short enough to show, so the busiest ones can be listed.
export const queryName = (sql) => String(sql).replace(/\s+/g, ' ').replace(/\((\?,\s*)+\?\)/g, '(?…)').trim().slice(0, 140);

// Wraps a D1 binding so every query's rows read and written go to count(read, sql, written).
// first() is answered with all(), which is what D1 does underneath, so the
// rows read are reported for it too.
export function metered(db, count) {
  const tally = (result, sql) => {
    const read = Number(result?.meta?.rows_read) || 0;
    const written = Number(result?.meta?.rows_written) || 0;
    if (read > 0 || written > 0) count(read, sql, written);
    return result;
  };
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

// Adds counts to a day's record, { total, jobs, runs, writes, writeJobs, queries },
// and to the month's running totals.
const KEEP_QUERIES = 60;
export async function addReads(env, key, counts, { runs = 0, queries = {}, writes = {} } = {}) {
  const db = env.DB.unmetered || env.DB;
  const plain = { DB: db };
  const stateKey = `${key}:${utcDay()}`;
  let record;
  try { record = JSON.parse((await getState(plain, stateKey)) || '{}'); } catch { record = {}; }
  record.total ||= 0; record.jobs ||= {}; record.runs ||= 0; record.writes ||= 0; record.writeJobs ||= {};
  let read = 0, written = 0;
  for (const [name, rows] of Object.entries(counts)) {
    if (!rows) continue;
    record.jobs[name] = (record.jobs[name] || 0) + rows;
    read += rows;
  }
  for (const [name, rows] of Object.entries(writes)) {
    if (!rows) continue;
    record.writeJobs[name] = (record.writeJobs[name] || 0) + rows;
    written += rows;
  }
  record.total += read;
  record.writes += written;
  record.runs += runs;
  record.queries ||= {};
  for (const [q, rows] of Object.entries(queries)) record.queries[q] = (record.queries[q] || 0) + rows;
  // Only the busiest are kept, so the record stays small.
  record.queries = Object.fromEntries(Object.entries(record.queries).sort((a, b) => b[1] - a[1]).slice(0, KEEP_QUERIES));
  await setState(plain, stateKey, JSON.stringify(record));
  if (read || written) {
    const monthKey = `d1_month:${utcMonth()}`;
    let month;
    try { month = JSON.parse((await getState(plain, monthKey)) || '{}'); } catch { month = {}; }
    month.reads = (month.reads || 0) + read;
    month.writes = (month.writes || 0) + written;
    await setState(plain, monthKey, JSON.stringify(month));
  }
  return record;
}

export async function readsToday(env, key) {
  const db = env.DB.unmetered || env.DB;
  try { return JSON.parse((await getState({ DB: db }, `${key}:${utcDay()}`)) || '{}'); } catch { return {}; }
}

export async function monthSoFar(env) {
  const db = env.DB.unmetered || env.DB;
  try { const m = JSON.parse((await getState({ DB: db }, `d1_month:${utcMonth()}`)) || '{}'); return { reads: m.reads || 0, writes: m.writes || 0 }; }
  catch { return { reads: 0, writes: 0 }; }
}

// Whether background jobs should stand down: the month is nearly used up.
export function overBudget(month) {
  return month.reads >= MONTHLY_READ_LIMIT * BACKGROUND_SHARE || month.writes >= MONTHLY_WRITE_LIMIT * BACKGROUND_SHARE;
}

// Old days and months are dropped so the record stays small.
export async function tidyReads(env) {
  const db = env.DB.unmetered || env.DB;
  const cutoff = utcDay(Date.now() - KEEP_DAYS * 86_400_000);
  await db.prepare("DELETE FROM sync_state WHERE (key LIKE 'd1_reads_bg:%' OR key LIKE 'd1_reads_web:%') AND substr(key, instr(key, ':') + 1) < ?")
    .bind(cutoff).run();
  await db.prepare("DELETE FROM sync_state WHERE key LIKE 'd1_month:%' AND substr(key, 10) < ?").bind(cutoff.slice(0, 7)).run();
}

// The month and each day for Admin: background jobs and pages, busiest first.
export async function readsReport(env) {
  const db = env.DB.unmetered || env.DB;
  const { results } = await db.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'd1_reads_bg:%' OR key LIKE 'd1_reads_web:%'").all();
  const days = {};
  const blank = () => ({ total: 0, jobs: {}, runs: 0, writes: 0, writeJobs: {} });
  for (const row of results) {
    const [kind, day] = row.key.split(':');
    let value;
    try { value = JSON.parse(row.value); } catch { continue; }
    (days[day] ||= { day, background: blank(), pages: blank() })[kind === 'd1_reads_bg' ? 'background' : 'pages'] = {
      total: value.total || 0, runs: value.runs || 0, jobs: value.jobs || {}, queries: value.queries || {},
      writes: value.writes || 0, writeJobs: value.writeJobs || {},
    };
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const list = Object.values(days).sort((a, b) => b.day.localeCompare(a.day)).map((d) => ({
    ...d,
    background: { ...d.background, top: top(d.background.jobs), topWrites: top(d.background.writeJobs) },
    pages: { ...d.pages, top: top(d.pages.jobs), topWrites: top(d.pages.writeJobs) },
    queries: [...Object.entries(d.background.queries || {}).map(([q, n]) => ({ q, n, where: 'Background' })),
      ...Object.entries(d.pages.queries || {}).map(([q, n]) => ({ q, n, where: 'Pages' }))].sort((a, b) => b.n - a.n).slice(0, 15),
  }));
  const month = await monthSoFar(env);
  return {
    readLimit: MONTHLY_READ_LIMIT, writeLimit: MONTHLY_WRITE_LIMIT, share: BACKGROUND_SHARE,
    month: { ...month, name: utcMonth(), daysIn: daysInMonth(), day: new Date().getUTCDate() },
    paused: (await getState({ DB: db }, 'd1_paused_month')) === utcMonth(),
    days: list,
  };
}

// While a developer views the hub as someone else, nothing is written: anything that would
// change the database (marking something seen, say) quietly does nothing.
const WRITES = /^\s*(insert|update|delete|replace|create|alter|drop)\b/i;
export function readOnly(db) {
  const fake = () => ({ results: [], success: true, meta: { changes: 0, rows_read: 0, rows_written: 0, last_row_id: 0 } });
  const wrap = (stmt, sql) => ({
    statement: stmt,
    sql,
    bind: (...args) => wrap(stmt.bind(...args), sql),
    all: async () => (WRITES.test(sql) ? fake() : stmt.all()),
    run: async () => (WRITES.test(sql) ? fake() : stmt.run()),
    raw: async (...args) => (WRITES.test(sql) ? [] : stmt.raw(...args)),
    first: async (column) => (WRITES.test(sql) ? null : stmt.first(column)),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (statements) => {
      const reads = statements.filter((s) => !WRITES.test(s.sql || ''));
      const done = reads.length ? await db.batch(reads.map((s) => s.statement || s)) : [];
      let i = 0;
      return statements.map((s) => (WRITES.test(s.sql || '') ? fake() : done[i++]));
    },
    unmetered: db.unmetered ? readOnly(db.unmetered) : undefined,
    readOnly: true,
  };
}
