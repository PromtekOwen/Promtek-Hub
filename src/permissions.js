// Who can do what. Groups are fixed here rather than editable in the hub, so a
// mis-tick in Admin can never open something up; changes are made in code.
// A person can be in any number of groups and teams, and can lead some teams.

export const TEAMS = ['Projecting', 'Service', 'Condor', 'Sales', 'Marketing'];

export const GROUPS = {
  admin: {
    name: 'Admin',
    about: 'Everything, including Admin, every settings cog, the audit log, employees, vehicles and issuing the company chart.',
  },
  management: {
    name: 'Management',
    about: 'Sees and acts on every team: reports, approvals, disputes, modifiers, count checks, Condor planning, quotes and the XP shop preview.',
  },
  lead: {
    name: 'Team lead',
    about: 'The same as Management, but their own lists, approvals and alerts are for the teams they lead.',
  },
  sales: {
    name: 'Sales',
    about: 'Starts and edits quotes.',
  },
  developer: {
    name: 'Developer',
    about: 'The hub\'s technical side: sync and Bitbucket status, connection tests and full error details.',
  },
};

// What each permission is, and which groups have it. Admin has everything.
export const PERMISSIONS = {
  oversight: { about: 'Reports, approvals and everyone\'s records across the teams', groups: ['management', 'lead'] },
  quotes: { about: 'Start and edit quotes', groups: ['management', 'lead', 'sales'] },
  condorPlan: { about: 'Triage MES and plan Condor releases', groups: ['management', 'lead'] },
  shop: { about: 'Preview the XP shop', groups: ['management', 'lead'] },
  developer: { about: 'Sync and Bitbucket status, connection tests and error details', groups: ['developer'] },
  admin: { about: 'Admin, settings cogs, the audit log, employees, vehicles and the company chart', groups: [] },
};

const parseList = (v) => {
  if (Array.isArray(v)) return v;
  try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch { return []; }
};

export function groupsOf(emp) {
  const g = parseList(emp?.groups).filter((x) => x in GROUPS);
  if (g.length || emp?.groups) return g;
  // Older records only have a single role; the Sales team could always quote.
  const g2 = emp?.role === 'admin' ? ['admin'] : emp?.role === 'lead' ? ['lead'] : [];
  if (emp?.team === 'Sales' && !g2.includes('admin')) g2.push('sales');
  return g2;
}

export function teamsOf(emp) {
  const t = parseList(emp?.teams).filter((x) => TEAMS.includes(x));
  if (t.length || emp?.teams) return t;
  return emp?.team && TEAMS.includes(emp.team) ? [emp.team] : [];
}

export function leadOf(emp) {
  const l = parseList(emp?.lead_of).filter((x) => TEAMS.includes(x));
  if (l.length || emp?.lead_of) return l;
  return emp?.role === 'lead' && emp?.team ? [emp.team] : [];
}

// Builds what the rest of the hub asks about the signed-in person.
export function access(emp, { fallbackAdmin = false } = {}) {
  const groups = new Set(groupsOf(emp));
  if (fallbackAdmin) groups.add('admin');
  const teams = teamsOf(emp);
  const leads = groups.has('lead') ? leadOf(emp) : [];
  const can = Object.fromEntries(Object.entries(PERMISSIONS).map(([key, p]) =>
    [key, groups.has('admin') || p.groups.some((g) => groups.has(g))]));
  return {
    groups: [...groups],
    teams,
    leads,
    can,
    isAdmin: can.admin,
    isLead: can.oversight || can.admin,
    // "For me" lists: everything for Admin and Management, the teams they lead for a lead.
    scopeTeams: groups.has('admin') || groups.has('management') ? null : leads,
    inTeam: (team) => teams.includes(team),
    // The single role and team older parts of the hub still read.
    role: groups.has('admin') ? 'admin' : can.oversight ? 'lead' : 'engineer',
    team: teams[0] || null,
  };
}

// Whether an item for a team belongs in this person's own list.
export function forMe(viewer, team) {
  if (viewer.scopeTeams === null) return true;
  if (!team) return true;
  return viewer.scopeTeams.includes(team);
}

export function requireCan(viewer, permission, message) {
  if (!viewer.can?.[permission]) {
    const err = new Error(message || 'You don\'t have access to that.');
    err.status = 403;
    throw err;
  }
}

// Saving: only known groups and teams, and only lead teams the person is in.
export function cleanAccess(input) {
  const groups = [...new Set(parseList(input.groups))].filter((g) => g in GROUPS);
  const teams = [...new Set(parseList(input.teams))].filter((t) => TEAMS.includes(t));
  const lead = groups.includes('lead') ? [...new Set(parseList(input.leadOf))].filter((t) => teams.includes(t)) : [];
  const role = groups.includes('admin') ? 'admin' : groups.some((g) => g === 'management' || g === 'lead') ? 'lead' : 'engineer';
  return { groups, teams, lead, role, team: teams[0] || null };
}

// Everyone who leads a team, for routing that team's alerts.
export async function leadsOfTeam(env, team) {
  const { results } = await env.DB.prepare('SELECT * FROM employees WHERE active = 1 AND email IS NOT NULL').all();
  return results.filter((e) => groupsOf(e).includes('lead') && (team ? leadOf(e).includes(team) : leadOf(e).length));
}

// Someone's supervisor, a lead of one of their teams, Management or an admin:
// the people who may see and decide private things such as modifiers.
export function managesPerson(viewer, person) {
  if (!viewer) return false;
  if (viewer.isAdmin || viewer.groups?.includes('management')) return true;
  if (person?.manager_id && person.manager_id === viewer.accountId) return true;
  return Boolean(viewer.groups?.includes('lead') && teamsOf(person).some((t) => viewer.leads.includes(t)));
}
