// Who can do what. A person can be in any number of groups (roles) and teams, and
// can lead some teams. Which tiles each role and team can open, and what they can do
// inside them, start from the defaults here and can be changed by admins in Admin
// (kept in sync_state as access_config). Admins can always do everything, and the
// Admin tile and the admin permission can't be changed, so nobody can lock themselves out.

// Condor Dev is the developers within Condor; they alone are planned for and rated in Condor Dev.
export const TEAMS = ['Projecting', 'Service', 'Condor', 'Condor Dev', 'Sales', 'Marketing'];
// Who Condor Dev plans for: the Condor Dev team, or the whole Condor team until anyone is put in Condor Dev.
export const CONDOR_DEVS = (alias = '') => {
  const e = alias ? `${alias}.` : '';
  return `(${e}teams LIKE '%"Condor Dev"%' OR (NOT EXISTS (SELECT 1 FROM employees d WHERE d.active = 1 AND d.teams LIKE '%"Condor Dev"%')
    AND (${e}teams LIKE '%"Condor"%' OR (${e}teams IS NULL AND ${e}team = 'Condor'))))`;
};

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

// What each permission is, which groups have it to begin with, and the tile it
// belongs to. Admin has everything.
export const PERMISSIONS = {
  oversight: { name: 'Team oversight', about: 'Approvals, disputes, modifiers and count checks, everyone\'s records, and team lists across the hub', groups: ['management', 'lead'] },
  quotes: { name: 'Build quotes', about: 'Start and edit quotes, and see every quote', groups: ['management', 'lead', 'sales'], tile: 'quotes' },
  condorPlan: { name: 'Condor planning', about: 'Triage MES and plan Condor releases', groups: ['management', 'lead'], tile: 'condor' },
  eotq: { name: 'Employee of the Quarter results', about: 'See every nomination and who made it, and choose the winner', groups: ['management'], tile: 'eotq' },
  invoiceUpdate: { name: 'Update invoices', about: 'Set Target End, create drafts, mark invoices sent or paid, and change Invoice Due Dates in Jira', groups: ['management'], tile: 'invoicing' },
  invoiceDates: { name: 'Set invoice Target Ends', about: 'Set and change Target End on invoices not yet invoiced, and nothing else', groups: ['management', 'lead'], tile: 'invoicing' },
  wipEdit: { name: 'Change the WIP', about: 'Change an order\'s value or division, WIP settings, and customers\' payment terms', groups: ['management'], tile: 'wip' },
  contractInsights: { name: 'Contract insights', about: 'Insights across every service contract', groups: ['management'], leads: ['Service'], tile: 'contracts' },
  nearMissReview: { name: 'Near miss reports', about: 'Read every near miss reported, note what was done and close them, and hear about each new one', groups: [], tile: 'nearmiss' },
  feedbackReview: { name: 'Feedback moderation', about: 'Read anonymous feedback before it\'s posted, post or turn it down, and reply to writers', groups: [], tile: 'feedback' },
  developer: { name: 'Developer tools', about: 'Sync and Bitbucket status, connection tests, error details and viewing the hub as someone else', groups: ['developer'] },
  admin: { name: 'Admin', about: 'Admin, settings cogs, the audit log, employees, vehicles and the company chart', groups: [], fixed: true },
};

// Who can open each tile to begin with: everyone, unless roles, teams or leads are
// given. These match the tiles in public/modules.js. Admin's own tile isn't here: it
// is always admins and developers.
export const TILES = {
  xp: { name: 'XP & rank' },
  time: { name: 'My time' },
  condor: { name: 'Condor Dev', groups: ['management', 'lead'], teams: ['Condor', 'Condor Dev'] },
  quotes: { name: 'Quotes' },
  jobs: { name: 'Jobs' },
  obsolescence: { name: 'Obsolescence' },
  pow: { name: 'Point of work' },
  psc: { name: 'PSC', groups: ['management', 'lead'], teams: ['Service'] },
  contracts: { name: 'Service contracts', groups: ['management', 'lead'], teams: ['Service'] },
  capacity: { name: 'Capacity', groups: ['management', 'lead'] },
  wip: { name: 'WIP', groups: ['management'] },
  invoicing: { name: 'Invoicing', groups: ['management'] },
  calls: { name: '8x8 calls' },
  it: { name: 'IT support' },
  requests: { name: 'Requests' },
  feedback: { name: 'Feedback' },
  nearmiss: { name: 'Near misses' },
  vehicles: { name: 'Vehicles' },
  eotq: { name: 'Employee of the Quarter' },
  shop: { name: 'XP shop', groups: ['management', 'lead'] },
  org: { name: 'Company chart' },
  reports: { name: 'Reports', groups: ['management', 'lead'] },
};

// A rule: open to everyone, or to the roles, teams and leads of teams listed.
const asList = (v, allowed) => [...new Set(Array.isArray(v) ? v : [])].filter((x) => allowed.includes(x));
export function cleanRule(rule, { tile = false } = {}) {
  return {
    open: tile ? Boolean(rule?.open) : false,
    groups: asList(rule?.groups, Object.keys(GROUPS)),
    teams: asList(rule?.teams, TEAMS),
    leads: asList(rule?.leads, TEAMS),
  };
}
export const defaultTileRule = (id) => {
  const t = TILES[id] || {};
  return { open: !t.groups && !t.teams && !t.leads, groups: t.groups || [], teams: t.teams || [], leads: t.leads || [] };
};
export const defaultPermissionRule = (key) => ({ open: false, groups: PERMISSIONS[key]?.groups || [], teams: [], leads: PERMISSIONS[key]?.leads || [] });

// What's in force: the defaults, with whatever admins have changed on top.
export function rulesFrom(config) {
  const c = config && typeof config === 'object' ? config : {};
  const tiles = Object.fromEntries(Object.keys(TILES).map((id) => [id, c.tiles?.[id] ? cleanRule(c.tiles[id], { tile: true }) : defaultTileRule(id)]));
  const permissions = Object.fromEntries(Object.keys(PERMISSIONS).map((k) => [k,
    !PERMISSIONS[k].fixed && c.permissions?.[k] ? cleanRule(c.permissions[k]) : defaultPermissionRule(k)]));
  return { tiles, permissions };
}

export const matches = (rule, { groups, teams, leads }) => Boolean(rule.open
  || rule.groups.some((g) => groups.includes(g)) || rule.teams.some((t) => teams.includes(t)) || rule.leads.some((t) => leads.includes(t)));

// Read once in a while, rather than on every request; saving clears it straight away.
let kept = { at: 0, value: null };
const KEEP_MS = 30_000;
export async function loadAccessConfig(env) {
  if (kept.value && Date.now() - kept.at < KEEP_MS) return kept.value;
  let value = {};
  try {
    const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'access_config'").first();
    value = row?.value ? JSON.parse(row.value) : {};
  } catch { value = {}; }
  kept = { at: Date.now(), value };
  return value;
}
export async function saveAccessConfig(env, value) {
  await env.DB.prepare("INSERT INTO sync_state (key, value) VALUES ('access_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(value)).run();
  kept = { at: Date.now(), value };
}

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

// Builds what the rest of the hub asks about the signed-in person. config is the
// access_config admins have saved; without it, the defaults apply.
export function access(emp, { fallbackAdmin = false, config = null } = {}) {
  const groups = new Set(groupsOf(emp));
  if (fallbackAdmin) groups.add('admin');
  const teams = teamsOf(emp);
  const leads = groups.has('lead') ? leadOf(emp) : [];
  const admin = groups.has('admin');
  const rules = rulesFrom(config);
  const who = { groups: [...groups], teams, leads };
  const can = Object.fromEntries(Object.keys(PERMISSIONS).map((key) => [key, admin || (key !== 'admin' && matches(rules.permissions[key], who))]));
  const tiles = Object.fromEntries(Object.keys(TILES).map((id) => [id, admin || matches(rules.tiles[id], who)]));
  // The names older parts of the hub ask for.
  can.wip = tiles.wip;
  can.shop = tiles.shop;
  return {
    tiles,
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

// Whether someone can open a tile. A viewer built without tiles (in a test, say) gets the default.
export function canTile(viewer, id) {
  if (viewer?.isAdmin) return true;
  if (viewer?.tiles) return Boolean(viewer.tiles[id]);
  return matches(defaultTileRule(id), { groups: viewer?.groups || [], teams: viewer?.teams || [], leads: viewer?.leads || [] });
}

// Everyone active who can do something, as the hub works it out for them.
export async function peopleWith(env, permission) {
  const config = await loadAccessConfig(env);
  const admins = (env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const { results } = await env.DB.prepare('SELECT * FROM employees WHERE active = 1 AND email IS NOT NULL').all();
  return results.filter((e) => access(e, { config, fallbackAdmin: admins.includes(String(e.email).toLowerCase()) }).can[permission]);
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
