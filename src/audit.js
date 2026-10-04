// A record of changes people make by hand, so anything edited can be traced to
// who changed it, when, and what it was before. Background syncing isn't logged.

const LABELS = {
  employees: {
    name: 'Name', email: 'Email', pronouns: 'Pronouns', job_title: 'Job title', department: 'Department', manager_id: 'Reports to',
    org_order: 'Chart order', role: 'Hub role', team: 'Team', extension: 'Extension', baseline: 'XP rate', elo: 'ELO', icons: 'Chart icons',
    avatar: 'Photo', notes: 'Notes', active: 'Active', account_id: 'Jira account ID', groups: 'Groups', teams: 'Teams', lead_of: 'Leads',
  },
  vehicles: {
    registration: 'Registration', make: 'Make', model: 'Model', kind: 'Type', mot_due: 'MOT due', insurance_due: 'Insurance due',
    tax_due: 'Tax due', service_due: 'Service due', mileage: 'Mileage', status: 'Status', responsible_email: 'Looked after by',
    notes: 'Notes', active: 'In use',
  },
  mes_capacity: { hours_per_week: 'Hours a week', days: 'Days', away: 'Days away', included: 'Planned for' },
};
const IGNORE = new Set(['updated_at', 'created_at', 'jira_xp', 'opening_xp', 'elo_week', 'condor_elo', 'condor_elo_week', 'role', 'team']);
const shown = (field, v) => {
  if (v === null || v === undefined || v === '') return '';
  if (field === 'avatar') return 'a photo';
  if (field === 'active' || field === 'included') return Number(v) ? 'Yes' : 'No';
  if (field === 'groups' || field === 'teams' || field === 'lead_of') {
    try { const list = JSON.parse(v); return list.length ? list.map((x) => ({ admin: 'Admin', management: 'Management', lead: 'Team lead', sales: 'Sales', developer: 'Developer' }[x] || x)).join(', ') : 'None'; } catch { return String(v); }
  }
  if (field === 'days') return String(v).split('').map((d) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).filter(Boolean).join(', ');
  if (field === 'away') {
    try { return JSON.parse(v).map((a) => `${a.from}${a.until && a.until !== a.from ? ` to ${a.until}` : ''}${a.note ? ` (${a.note})` : ''}`).join('; ') || 'None'; } catch { return String(v); }
  }
  return String(v).slice(0, 300);
};

// An empty list and nothing at all are the same, so tidying a record isn't a change.
const blank = (v) => (v === null || v === undefined || v === '' || v === '[]' || v === '{}' ? '' : String(v));
export const same = (a, b) => blank(a) === blank(b);

export function diff(table, before, after) {
  const labels = LABELS[table] || {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];
  for (const key of keys) {
    if (IGNORE.has(key)) continue;
    const a = before?.[key] ?? null, b = after?.[key] ?? null;
    if (same(a, b)) continue;
    out.push({ field: key, label: labels[key] || key, before: shown(key, a), after: shown(key, b) });
  }
  return out;
}

export async function record(env, viewer, { area, action, subjectType = null, subjectId = null, label = null, changes = [], note = null }) {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor_email, actor_name, area, action, subject_type, subject_id, subject_label, changes, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(new Date().toISOString(), viewer?.email || null, viewer?.employee?.name || null, area, action, subjectType,
    subjectId == null ? null : String(subjectId), label, JSON.stringify(changes), note).run();
}

// Pages by id so the log stays quick however long it grows.
export async function list(env, { area = '', q = '', before = null, limit = 50 } = {}) {
  const where = [], args = [];
  if (area) { where.push('area = ?'); args.push(area); }
  if (q) { where.push('(subject_label LIKE ? OR actor_name LIKE ? OR actor_email LIKE ? OR changes LIKE ?)'); const like = `%${q}%`; args.push(like, like, like, like); }
  if (before) { where.push('id < ?'); args.push(Number(before)); }
  const { results } = await env.DB.prepare(
    `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
  ).bind(...args, Math.min(200, limit)).all();
  const { results: areas } = await env.DB.prepare('SELECT DISTINCT area FROM audit_log ORDER BY area').all();
  return { entries: results.map((r) => ({ ...r, changes: JSON.parse(r.changes || '[]') })), areas: areas.map((a) => a.area),
    more: results.length === Math.min(200, limit) ? results[results.length - 1].id : null };
}

export async function csv(env, { area = '', q = '' } = {}) {
  const rows = [['When', 'Who', 'Area', 'Action', 'Subject', 'Field', 'Before', 'After', 'Note']];
  let before = null;
  for (let page = 0; page < 100; page++) {
    const r = await list(env, { area, q, before, limit: 200 });
    for (const e of r.entries) {
      const changes = e.changes.length ? e.changes : [{ label: '', before: '', after: '' }];
      for (const c of changes) rows.push([e.at, e.actor_name || e.actor_email || '', e.area, e.action, e.subject_label || '', c.label, c.before, c.after, e.note || '']);
    }
    if (!r.more) break;
    before = r.more;
  }
  return rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
