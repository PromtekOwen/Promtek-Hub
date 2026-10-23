// The company chart, built from the employee list so it keeps itself current.

// In the order the chart's columns run, left to right.
export const DEPARTMENTS = [
  ['Operations', '#1f4e79'],
  ['Marketing', '#d93a3a'],
  ['Sales', '#b858c4'],
  ['Service', '#2e9e63'],
  ['Projects', '#2f9ae0'],
  ['Condor', '#e8a317'],
  ['IT', '#3f5fa8'],
  ['Rhapsodi', '#14897f'],
];

// Where someone sits on the chart: a row for each level, and a column for each department.
export const LEVELS = [['director', 'Director'], ['gm', 'General manager'], ['manager', 'Manager or lead'], ['team', 'Team']];
export const GROUPS = [['senior', 'Senior'], ['standard', 'Standard'], ['apprentice', 'Apprentice']];
const LEVEL_KEYS = LEVELS.map(([k]) => k);
const GROUP_KEYS = GROUPS.map(([k]) => k);
const DEPT_KEYS = () => DEPARTMENTS.map(([k]) => k);
const parseList = (v) => { try { const x = v ? JSON.parse(v) : []; return Array.isArray(x) ? x : []; } catch { return []; } };

// Checked and tidied before saving; anything unknown is dropped.
export function cleanChart(input, accountId) {
  const level = LEVEL_KEYS.includes(input.chartLevel) ? input.chartLevel : null;
  const group = GROUP_KEYS.includes(input.chartGroup) ? input.chartGroup : null;
  const covers = [...new Set((Array.isArray(input.chartCovers) ? input.chartCovers : []).filter((d) => DEPT_KEYS().includes(d)))];
  const roles = (Array.isArray(input.chartRoles) ? input.chartRoles : []).slice(0, 4).map((r, i) => {
    const title = String(r?.title || '').trim().slice(0, 120);
    if (!title) throw new Error('Each other role needs a title.');
    if (r.managerId && r.managerId === accountId) throw new Error('Nobody reports to themselves, in any role.');
    return {
      id: String(r.id || `r${Date.now().toString(36)}${i}`).slice(0, 24), title,
      department: DEPT_KEYS().includes(r.department) ? r.department : null,
      level: LEVEL_KEYS.includes(r.level) ? r.level : 'team',
      group: GROUP_KEYS.includes(r.group) ? r.group : null,
      managerId: r.managerId ? String(r.managerId).slice(0, 128) : null,
      order: Number.isFinite(Number(r.order)) ? Number(r.order) : 50,
    };
  });
  return {
    chart_level: level, chart_group: group, chart_covers: covers.length ? JSON.stringify(covers) : null,
    chart_ceremonial: input.chartCeremonial ? 1 : 0, chart_sa: input.chartSa ? 1 : 0, chart_roles: roles.length ? JSON.stringify(roles) : null,
  };
}

export const chartRolesText = (v) => parseList(v).map((r) => `${r.title}${r.department ? ` (${r.department})` : ''}`).join('; ');
export const chartCoversText = (v) => parseList(v).join(', ');
export const chartLevelText = (v) => (LEVELS.find(([k]) => k === v) || [null, ''])[1];

export const departmentColour = (name) => (DEPARTMENTS.find(([key]) => key === name) || [null, '#5b7385'])[1];

// Names come from Jira, so matching is forgiving: case, punctuation and
// middle names are ignored, and a first name plus last initial will do.
const tidy = (name) => String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

function nameKeys(name) {
  const parts = tidy(name).split(' ').filter(Boolean);
  if (!parts.length) return [];
  const first = parts[0];
  const last = parts[parts.length - 1];
  return [`${first} ${last}`, `${first} ${last[0]}`];
}

export async function chart(env) {
  const { results } = await env.DB.prepare(
    `SELECT account_id, name, job_title, department, manager_id, org_order, team, role, email, icons, pronouns, avatar,
            chart_level, chart_group, chart_covers, chart_ceremonial, chart_sa, chart_roles
       FROM employees WHERE active = 1 ORDER BY org_order, name`
  ).all();

  const byId = new Map(results.map((e) => [e.account_id, e]));
  const nodes = results.map((e) => ({
    id: e.account_id,
    name: e.name,
    title: e.job_title || '',
    department: e.department || '',
    colour: departmentColour(e.department),
    managerId: byId.has(e.manager_id) ? e.manager_id : null,   // ignore managers who have left
    order: e.org_order,
    role: e.role,
    team: e.team,
    pronouns: e.pronouns || '',
    icons: e.icons ? JSON.parse(e.icons) : [],
    avatar: e.avatar || null,
    level: e.chart_level || null,
    group: e.chart_group || null,
    covers: parseList(e.chart_covers),
    ceremonial: Boolean(e.chart_ceremonial),
    sa: Boolean(e.chart_sa),
    roles: parseList(e.chart_roles).map((r) => ({ ...r, managerId: byId.has(r.managerId) ? r.managerId : null })),
  }));

  const unplaced = nodes.filter((n) => !n.managerId && !n.department).length;
  return { nodes, departments: DEPARTMENTS.map(([name, colour]) => ({ name, colour })), levels: LEVELS.map(([key, label]) => ({ key, label })), unplaced };
}

// Order within a team, from dragging cards about on the chart. Ids are people, or
// "role:<person>:<role id>" for one of someone's other roles.
export async function saveOrder(env, items) {
  const list = (Array.isArray(items) ? items : []).slice(0, 200);
  const roleMoves = new Map();
  const stmts = [];
  for (const { id, order } of list) {
    const n = Math.round(Number(order));
    if (!Number.isFinite(n)) continue;
    const m = /^role:(.+):([^:]+)$/.exec(String(id));
    if (m) { if (!roleMoves.has(m[1])) roleMoves.set(m[1], new Map()); roleMoves.get(m[1]).set(m[2], n); continue; }
    stmts.push(env.DB.prepare('UPDATE employees SET org_order = ? WHERE account_id = ?').bind(n, String(id)));
  }
  for (const [accountId, moves] of roleMoves) {
    const row = await env.DB.prepare('SELECT chart_roles FROM employees WHERE account_id = ?').bind(accountId).first();
    const roles = parseList(row?.chart_roles).map((r) => (moves.has(r.id) ? { ...r, order: moves.get(r.id) } : r));
    stmts.push(env.DB.prepare('UPDATE employees SET chart_roles = ? WHERE account_id = ?').bind(JSON.stringify(roles), accountId));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, saved: stmts.length };
}

export async function savePerson(env, { accountId, jobTitle, managerId, department, order }) {
  if (!accountId) throw new Error('Which person?');
  if (managerId === accountId) throw new Error('Nobody reports to themselves.');

  // Walking up from the proposed manager must not lead back to this person.
  if (managerId) {
    const { results } = await env.DB.prepare('SELECT account_id, manager_id FROM employees').all();
    const managers = new Map(results.map((r) => [r.account_id, r.manager_id]));
    let cursor = managerId;
    for (let step = 0; step < 50 && cursor; step++) {
      if (cursor === accountId) throw new Error('That would make the chart loop back on itself.');
      cursor = managers.get(cursor);
    }
  }

  await env.DB.prepare(
    'UPDATE employees SET job_title = ?, manager_id = ?, department = ?, org_order = ?, updated_at = ? WHERE account_id = ?'
  ).bind(String(jobTitle || '').slice(0, 120) || null, managerId || null, department || null,
    Number(order) || 50, new Date().toISOString(), accountId).run();
  return { ok: true };
}
