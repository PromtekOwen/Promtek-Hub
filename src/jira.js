// Minimal Jira Cloud REST client.

function authHeader(env) {
  return 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
}

export async function jira(env, path, init = {}) {
  // An issue in a path is always a plain key or id, so nothing typed into the hub
  // can steer a request to a different part of Jira.
  const issue = String(path).match(/^\/rest\/(?:api\/3|agile\/1\.0)\/issue\/([^/?#]+)/);
  if (issue && !/^([A-Za-z][A-Za-z0-9_]*-\d+|\d+)$/.test(decodeURIComponent(issue[1]))) throw badInput('That isn\'t a Jira item.');
  const res = await fetch(env.JIRA_BASE_URL + path, {
    ...init,
    headers: {
      Authorization: authHeader(env),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    const err = new Error(`Jira ${res.status} on ${path.split('?')[0]}: ${body}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  // Some calls, such as linking two issues, answer 201 with nothing in the body.
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

// ---------- which projects the hub works with ----------
// Customer projects are the ones in the two customer categories. Any project
// outside them (testing, archive, special access) is left out of everything
// the hub lists or searches, except the hub's own working projects below.
export const CUSTOMER_CATEGORIES = ['Promtek UK Customers', 'Promtek SA Customers'];
export const CUSTOMER_CATEGORY_IDS = { uk: '10333', sa: '10300' };
// MES for Condor Dev, PSC for service items, PMB for general tasks and assisting,
// PROMTEKIT and ASSET for IT support, and the ten IMS projects for internal time.
export const HUB_PROJECTS = ['MES', 'PSC', 'PMB', 'PROMTEKIT', 'ASSET',
  'GOALS', 'LEGAL', 'HEALTH', 'COMPLIANCE', 'FINANCE', 'INNOV', 'IS', 'MARKETING', 'SUGGEST', 'QA'];
// Never shown, even if one is ever put in a customer category by mistake.
export const BLOCKED_PROJECTS = ['CSIMS', 'CSIMSB', 'CSIMST', 'ARCHIVE', 'TEST', 'TPB'];
// Left out of every list and search like the others, but an item can still be opened
// by its key, so the hub can be tried out on it.
const TESTING_PROJECTS = ['TEST'];
const blockedForLookup = (key) => BLOCKED_PROJECTS.includes(key) && !TESTING_PROJECTS.includes(key);

const projectOf = (keyOrIssueKey) => String(keyOrIssueKey || '').split('-')[0].toUpperCase();

// ---------- checking what people send ----------
// Keys go into searches and addresses, so anything else is turned away.
export function badInput(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
export function issueKeyOf(value) {
  const key = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/.test(key)) throw badInput('That isn\'t a Jira key.');
  return key;
}
export function projectKeyOf(value) {
  const key = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(key)) throw badInput('That isn\'t a Jira project.');
  return key;
}
// An item or project the hub works with: a customer project or one of the hub's own, never a blocked one.
export async function mustBeHubIssue(env, keyOrProject) {
  if (TESTING_PROJECTS.includes(projectOf(keyOrProject))) return keyOrProject;
  const ok = await projectFilter(env);
  if (!ok(keyOrProject)) throw badInput('The hub doesn\'t work with that project.');
  return keyOrProject;
}
const PROJECT_LIST_MS = 6 * 3600 * 1000;
let listCache = null;

// Every customer project, with its name and region, kept for six hours.
export async function customerProjects(env, { fresh = false } = {}) {
  if (!fresh && listCache && Date.now() - listCache.at < PROJECT_LIST_MS) return listCache.list;
  if (!fresh && env.DB) {
    const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'customer_projects'").first().catch(() => null);
    const saved = row ? JSON.parse(row.value) : null;
    if (saved && Date.now() - saved.at < PROJECT_LIST_MS) { listCache = saved; return saved.list; }
  }
  const list = [];
  for (const [region, categoryId] of Object.entries(CUSTOMER_CATEGORY_IDS)) {
    let startAt = 0;
    for (let page = 0; page < 10; page++) {
      const data = await jira(env, `/rest/api/3/project/search?categoryId=${categoryId}&status=live&orderBy=name&maxResults=50&startAt=${startAt}`);
      for (const p of data.values || []) {
        if (!BLOCKED_PROJECTS.includes(p.key.toUpperCase())) list.push({ key: p.key, name: p.name, region, id: String(p.id) });
      }
      if (data.isLast || !data.values?.length) break;
      startAt += data.values.length;
    }
  }
  listCache = { at: Date.now(), list };
  if (env.DB) {
    await env.DB.prepare(`INSERT INTO sync_state (key, value) VALUES ('customer_projects', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(listCache)).run().catch(() => {});
  }
  return list;
}

// A test for whether an issue or project key is one the hub works with.
export async function projectFilter(env) {
  let keys = null;
  try { keys = new Set((await customerProjects(env)).map((p) => p.key.toUpperCase())); } catch { /* fall back to the blocked list */ }
  return (keyOrIssueKey) => {
    const k = projectOf(keyOrIssueKey);
    if (BLOCKED_PROJECTS.includes(k)) return false;
    if (HUB_PROJECTS.includes(k)) return true;
    return keys ? keys.has(k) : true;
  };
}

// Searches for particular keys, ids or children are left as they are; anything
// broader only looks in customer and hub projects. If Jira ever rejects the
// clause (a hub project renamed, say), results are filtered instead.
let scopeInJql = true;
const targeted = (jql) => /^(key|id|issuekey|parent)\s*(=|in\b)/i.test(String(jql).trim());

export function scopeJql(jql) {
  const text = String(jql).trim();
  if (!scopeInJql || targeted(text)) return text;
  const at = text.search(/\bORDER\s+BY\b/i);
  const where = (at < 0 ? text : text.slice(0, at)).trim();
  const order = at < 0 ? '' : ` ${text.slice(at)}`;
  // Keys are quoted: some, such as IS, are also words JQL keeps for itself.
  const q = (xs) => xs.map((x) => `"${x}"`).join(', ');
  const scope = `(category in (${q(CUSTOMER_CATEGORIES)}) OR project in (${q(HUB_PROJECTS)}))`
    + ` AND project not in (${q(BLOCKED_PROJECTS)})`;
  return where ? `${scope} AND (${where})${order}` : `${scope}${order}`;
}

// One page of a search, keeping to the projects above either way.
export async function searchPage(env, call, jql, params) {
  const run = (q) => call(`/rest/api/3/search/jql?${new URLSearchParams({ ...params, jql: q })}`);
  let data;
  let scoped = scopeInJql && !targeted(jql);
  try {
    data = await run(scopeJql(jql));
  } catch (err) {
    // Any problem with the scoped search: try it as written, so one bad clause never stops the hub.
    if (!scoped || err.status !== 400) throw err;
    data = await run(String(jql).trim());      // if this fails too, the search itself is wrong, and that error is the one to see
    console.warn('Project scope rejected by Jira, filtering results instead:', err.message);
    scopeInJql = false; scoped = false;
  }
  if (!targeted(jql)) {
    // The JQL clause already did this when it worked; checking again costs nothing once the list is held.
    const ok = scoped ? (key) => !BLOCKED_PROJECTS.includes(projectOf(key)) : await projectFilter(env);
    data.issues = (data.issues || []).filter((i) => ok(i.key));
  } else {
    // Lookups by key or parent never return a blocked project's items either (TEST aside, for trying things out).
    data.issues = (data.issues || []).filter((i) => !blockedForLookup(projectOf(i.key)));
  }
  return data;
}

export async function searchJql(env, jql, fields, { limit = Infinity, pageSize = 100 } = {}) {
  const issues = [];
  let token = null;
  let pages = 0;
  do {
    const params = { fields: fields.join(','), maxResults: String(Math.min(pageSize, limit - issues.length)) };
    if (token) params.nextPageToken = token;
    const data = await searchPage(env, (path) => jira(env, path), jql, params);
    issues.push(...(data.issues || []));
    token = data.nextPageToken || null;
    pages++;
  } while (token && pages < 50 && issues.length < limit);
  return issues.slice(0, limit === Infinity ? undefined : limit);
}

export async function getIssue(env, idOrKey, fields) {
  try {
    return await jira(env, `/rest/api/3/issue/${idOrKey}?fields=${encodeURIComponent(fields.join(','))}`);
  } catch (err) {
    if (err.status === 404 || err.status === 403) return null;
    throw err;
  }
}

export async function findFieldId(env, name) {
  const fields = await jira(env, '/rest/api/3/field');
  const match = fields.find((f) => (f.name || '').toLowerCase() === name.toLowerCase());
  return match ? match.id : null;
}

// Finds the Atlassian account that belongs to a Google sign-in email.
export async function findAccountIdByEmail(env, email) {
  const users = await jira(env, `/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
  const people = (users || []).filter((u) => u.accountType === 'atlassian');
  const exact = people.filter((u) => (u.emailAddress || '').toLowerCase() === email);
  if (exact.length === 1) return exact[0].accountId;
  if (people.length === 1) return people[0].accountId;
  return null;
}
