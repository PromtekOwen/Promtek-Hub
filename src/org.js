// The company chart, built from the employee list so it keeps itself current.

export const DEPARTMENTS = [
  ['Operations', '#1f4e79'],
  ['Marketing', '#d93a3a'],
  ['Sales', '#b858c4'],
  ['Projects', '#2f9ae0'],
  ['Service', '#2e9e63'],
  ['Condor', '#e8a317'],
];

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
    `SELECT account_id, name, job_title, department, manager_id, org_order, team, role, email, icons, pronouns, avatar
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
  }));

  const unplaced = nodes.filter((n) => !n.managerId && !n.department).length;
  return { nodes, departments: DEPARTMENTS.map(([name, colour]) => ({ name, colour })), unplaced };
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
