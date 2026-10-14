// Minimal Jira Cloud REST client.

function authHeader(env) {
  return 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
}

export async function jira(env, path, init = {}) {
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

// Testing and special customer-access projects, left out of everything the hub
// looks through. Searches for particular keys, ids or children are left as they are.
export const EXCLUDED_PROJECTS = ['CSIMS', 'CSIMSB', 'CSIMST', 'TEST', 'TPB'];
export const isExcludedProject = (keyOrIssueKey) => EXCLUDED_PROJECTS.includes(String(keyOrIssueKey || '').split('-')[0].toUpperCase());

// If Jira ever rejects the list (say one of the projects is renamed), the
// projects are left out of the results instead, so searches keep working.
let excludeInJql = true;

const targeted = (jql) => /^(key|id|issuekey|parent)\s*(=|in\b)/i.test(String(jql).trim());

export function scopeJql(jql) {
  const text = String(jql).trim();
  if (!excludeInJql || targeted(text)) return text;
  const at = text.search(/\bORDER\s+BY\b/i);
  const where = (at < 0 ? text : text.slice(0, at)).trim();
  const order = at < 0 ? '' : ` ${text.slice(at)}`;
  const not = `project NOT IN (${EXCLUDED_PROJECTS.join(', ')})`;
  return where ? `${not} AND (${where})${order}` : `${not}${order}`;
}

// One page of a search, with the excluded projects left out either way.
export async function searchPage(call, jql, params) {
  const run = (q) => call(`/rest/api/3/search/jql?${new URLSearchParams({ ...params, jql: q })}`);
  let data;
  try {
    data = await run(scopeJql(jql));
  } catch (err) {
    if (!excludeInJql || targeted(jql) || err.status !== 400 || !/project/i.test(err.message)) throw err;
    excludeInJql = false;
    data = await run(String(jql).trim());
  }
  if (!targeted(jql)) data.issues = (data.issues || []).filter((i) => !isExcludedProject(i.key));
  return data;
}

export async function searchJql(env, jql, fields, { limit = Infinity, pageSize = 100 } = {}) {
  const issues = [];
  let token = null;
  let pages = 0;
  do {
    const params = { fields: fields.join(','), maxResults: String(Math.min(pageSize, limit - issues.length)) };
    if (token) params.nextPageToken = token;
    const data = await searchPage((path) => jira(env, path), jql, params);
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
