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
  return res.json();
}

export async function searchJql(env, jql, fields) {
  const issues = [];
  let token = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ jql, fields: fields.join(','), maxResults: '100' });
    if (token) params.set('nextPageToken', token);
    const data = await jira(env, `/rest/api/3/search/jql?${params}`);
    issues.push(...(data.issues || []));
    token = data.nextPageToken || null;
    pages++;
  } while (token && pages < 50);
  return issues;
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
