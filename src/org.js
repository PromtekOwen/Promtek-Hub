// The company chart, built from the employee list so it keeps itself current.

export const DEPARTMENTS = [
  ['Board', '#1f4e79'],
  ['Operations', '#2f6fb5'],
  ['Compliance', '#e07b39'],
  ['Marketing', '#d93a3a'],
  ['Sales', '#b858c4'],
  ['Projects', '#2f9ae0'],
  ['Service', '#2e9e63'],
  ['Condor', '#e8a317'],
  ['External', '#7a5cd6'],
];

export const departmentColour = (name) => (DEPARTMENTS.find(([key]) => key === name) || [null, '#5b7385'])[1];

// The chart as it stands today, used to fill in titles and reporting lines
// the first time, matched on name. Nothing here overwrites what is already set
// unless an admin asks for it.
export const ORG_SEED = [
  // [name, job title, department, manager name, order]
  ['Charles Williams', 'Managing Director', 'Board', null, 10],
  ['Simon Williams', 'Technical Director', 'Board', 'Charles Williams', 20],
  ['Daniel Williams', 'Senior Commissioning Engineer', 'Board', 'Charles Williams', 30],

  ['Nic Beech', 'Office Manager', 'Operations', 'Charles Williams', 40],
  ['Katie Bradbury', 'Sustainability and Compliance Manager', 'Compliance', 'Charles Williams', 50],
  ['Becky Key', 'Compliance Assistant', 'Compliance', 'Katie Bradbury', 10],

  ['Lani Scholtz', 'Marketing Manager', 'Marketing', 'Charles Williams', 60],
  ['Georgia Simcock', 'Apprentice Multi-Channel Marketer', 'Marketing', 'Lani Scholtz', 10],

  ['Vishal Pansare', 'Sales Manager', 'Sales', 'Charles Williams', 70],
  ['Graeme Key', 'Internal Sales Account Manager', 'Sales', 'Vishal Pansare', 10],
  ['Doug Anderson', 'Business Development Manager', 'Sales', 'Vishal Pansare', 20],
  ['Guinevere Vosloo', 'Sales and Marketing Co-ordinator', 'Sales', 'Vishal Pansare', 30],

  ['Liam Barks', 'Head of Projects', 'Projects', 'Charles Williams', 80],
  ['Stefan Vosloo', 'Engineering and Software Team Leader', 'Projects', 'Liam Barks', 10],
  ['Amal Wickramasinghe', 'Project Systems Engineer', 'Projects', 'Liam Barks', 20],
  ['Zulk Ghalib', 'Projects Systems Engineer', 'Projects', 'Liam Barks', 30],
  ['Dominic Hulme', 'Senior Control System Software Developer', 'Projects', 'Liam Barks', 40],
  ['Jim FitzSimmons', 'Senior Control System Software Developer', 'Projects', 'Liam Barks', 50],
  ['Cobus Nel', 'Senior Projecting Engineer', 'Projects', 'Liam Barks', 60],
  ['Ruan Venter', 'Maintenance Engineer', 'Projects', 'Liam Barks', 70],
  ['Ali Bagdat', 'Apprentice Software Engineer', 'Projects', 'Liam Barks', 80],
  ['John Banks', 'Apprentice Software Engineer', 'Projects', 'Liam Barks', 90],

  ['Richard Key', 'Head of Service', 'Service', 'Charles Williams', 90],
  ['Mark Sherratt', 'Service Team Lead', 'Service', 'Richard Key', 10],
  ['Karen Vosloo', 'Sales & Marketing Assistant', 'Service', 'Richard Key', 20],
  ['Graham Hart', 'Senior Control System Software Developer', 'Service', 'Richard Key', 30],
  ['Mark Woolley', 'Senior Software Engineer', 'Service', 'Richard Key', 40],
  ['Daniel Manteghi', 'Control System Software Developer', 'Service', 'Richard Key', 50],
  ['Daniel Ellis', 'Level 2 Lean Manufacturing Apprentice', 'Service', 'Richard Key', 60],
  ['Leonard Harffey', 'Apprentice Engineer', 'Service', 'Richard Key', 70],
  ['Ruben Gouveia', 'Apprentice Engineer', 'Service', 'Richard Key', 80],
  ['Jody Naicker', 'Field Sales and Service Engineer', 'Service', 'Richard Key', 90],

  ['Kieran Haycock', 'Condor Team Lead, Senior Full Stack Software Developer', 'Condor', 'Simon Williams', 100],
  ['Owen Hume', 'Business Analyst', 'Condor', 'Kieran Haycock', 10],
  ['Peter Kirkham', 'Senior Full Stack Software Developer', 'Condor', 'Kieran Haycock', 20],
  ['Craig Hamnett', 'Front End Software Developer', 'Condor', 'Kieran Haycock', 30],
  ['Callum Lewis', 'Apprentice Software Engineer', 'Condor', 'Kieran Haycock', 40],
  ['Taylor Nixon', 'Apprentice Software Engineer', 'Condor', 'Kieran Haycock', 50],
  ['Mia Opara-Burton', 'Junior Software Engineer', 'Condor', 'Kieran Haycock', 60],
  ['Michael Mutyaba', 'IT Support', 'Condor', 'Simon Williams', 110],

  ['Ash Vivakanantha', 'KTP Associate', 'External', 'Simon Williams', 120],
];

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

export function matchSeed(name) {
  const keys = nameKeys(name);
  return ORG_SEED.find((row) => nameKeys(row[0]).some((key) => keys.includes(key))) || null;
}

export async function chart(env) {
  const { results } = await env.DB.prepare(
    `SELECT account_id, name, job_title, department, manager_id, org_order, team, role, email
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

// Fills in titles and reporting lines from the chart as it stands.
export async function applySeed(env, { overwrite = false } = {}) {
  const { results } = await env.DB.prepare('SELECT account_id, name, job_title, manager_id, department FROM employees WHERE active = 1').all();
  const idByName = new Map();
  for (const person of results) {
    for (const key of nameKeys(person.name)) idByName.set(key, person.account_id);
  }

  const now = new Date().toISOString();
  const statements = [];
  const unmatched = [];
  for (const person of results) {
    const seed = matchSeed(person.name);
    if (!seed) { unmatched.push(person.name); continue; }
    const [, title, department, managerName, order] = seed;
    const managerId = managerName
      ? nameKeys(managerName).map((key) => idByName.get(key)).find(Boolean) || null
      : null;

    statements.push(env.DB.prepare(
      `UPDATE employees SET job_title = ?, department = ?, manager_id = ?, org_order = ?, updated_at = ? WHERE account_id = ?`
    ).bind(
      overwrite ? title : (person.job_title || title),
      overwrite ? department : (person.department || department),
      overwrite ? managerId : (person.manager_id || managerId),
      order, now, person.account_id,
    ));
  }
  for (let i = 0; i < statements.length; i += 40) await env.DB.batch(statements.slice(i, i + 40));
  return { filled: statements.length, unmatched };
}
