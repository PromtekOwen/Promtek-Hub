// IT support: raises Jira Service Management requests on behalf of the person
// asking, and shows them what happened next.
import { jira, searchJql } from './jira.js';

const IT_PROJECT = 'PROMTEKIT';
const ASSET_PROJECT = 'ASSET';

// What the engineer picks, and the Jira request type it maps to by default.
// The mapping is editable on the Admin page, so renaming one in Jira is a
// dropdown change rather than a code change.
export const IT_CATEGORIES = [
  ['hardware-fault', 'Broken or faulty hardware', 'Laptops, phones, printers, anything physical', 'Report broken hardware'],
  ['software-problem', 'Software or system problem', 'Something not working as it should', 'Report a system problem'],
  ['account', 'Account or access request', 'New account, password, access to something', 'Request a new account'],
  ['admin-access', 'Admin access request', 'Rights to install or change something', 'Request admin access'],
  ['new-hardware', 'New hardware', 'Laptop, phone, monitor, other equipment', 'Request new hardware'],
  ['new-software', 'New software', 'A licence or an application you need', 'Request new software'],
  ['other', 'Something else', "If none of the above fit", 'Get IT help'],
];

export const IT_URGENCIES = [
  ['blocked', "I can't work until this is fixed", 'Highest'],
  ['slowed', 'It is slowing me down, but I have a way round it', 'High'],
  ['soon', 'Not urgent, but it needs sorting', 'Medium'],
  ['whenever', 'Nice to have when there is time', 'Low'],
];

const urgencyPriority = (key) => (IT_URGENCIES.find(([id]) => id === key) || [])[2] || 'Medium';
const urgencyLabel = (key) => (IT_URGENCIES.find(([id]) => id === key) || [])[1] || 'Not given';

// ---------- Service desk lookups ----------

async function serviceDesk(env) {
  const desks = await jira(env, '/rest/servicedeskapi/servicedesk?limit=50');
  const desk = (desks.values || []).find((d) => d.projectKey === IT_PROJECT);
  if (!desk) throw new Error(`No service desk found for ${IT_PROJECT}.`);
  return desk.id;
}

export async function jiraRequestTypes(env) {
  const deskId = await serviceDesk(env);
  const types = await jira(env, `/rest/servicedeskapi/servicedesk/${deskId}/requesttype?limit=100`);
  return {
    serviceDeskId: String(deskId),
    types: (types.values || []).map((t) => ({ id: String(t.id), name: t.name, description: t.description })),
  };
}

// The stored mapping, filled in from the defaults the first time it's needed.
export async function requestTypeMap(env) {
  const { results } = await env.DB.prepare('SELECT hub_key, request_type_id, service_desk_id, label FROM it_request_types').all();
  const stored = new Map(results.map((r) => [r.hub_key, r]));
  if (stored.size) return stored;

  try {
    const { serviceDeskId, types } = await jiraRequestTypes(env);
    const byName = new Map(types.map((t) => [t.name.toLowerCase(), t]));
    const rows = IT_CATEGORIES
      .map(([key, , , defaultName]) => [key, byName.get(defaultName.toLowerCase())])
      .filter(([, type]) => type);
    if (rows.length) {
      await env.DB.batch(rows.map(([key, type]) => env.DB.prepare(
        'INSERT INTO it_request_types (hub_key, request_type_id, service_desk_id, label) VALUES (?, ?, ?, ?) ON CONFLICT(hub_key) DO NOTHING'
      ).bind(key, type.id, serviceDeskId, type.name)));
      return requestTypeMap(env);
    }
  } catch (err) {
    console.warn('Could not read request types:', err.message);
  }
  return stored;
}

export async function saveRequestTypeMap(env, { hubKey, requestTypeId, serviceDeskId, label }) {
  await env.DB.prepare(
    `INSERT INTO it_request_types (hub_key, request_type_id, service_desk_id, label) VALUES (?, ?, ?, ?)
     ON CONFLICT(hub_key) DO UPDATE SET request_type_id = excluded.request_type_id,
       service_desk_id = excluded.service_desk_id, label = excluded.label`
  ).bind(hubKey, String(requestTypeId), String(serviceDeskId), label || null).run();
  return { ok: true };
}

export async function options(env) {
  const map = await requestTypeMap(env);
  return {
    categories: IT_CATEGORIES.map(([id, label, hint]) => ({ id, label, hint, ready: map.has(id) })),
    urgencies: IT_URGENCIES.map(([id, label]) => ({ id, label })),
  };
}

// ---------- Assets ----------

export async function myAssets(env, accountId, query = '') {
  const clean = String(query || '').replace(/["\\]/g, '').trim();
  const jql = clean
    ? `project = ${ASSET_PROJECT} AND summary ~ "${clean}" ORDER BY updated DESC`
    : `project = ${ASSET_PROJECT} AND assignee = "${accountId}" ORDER BY updated DESC`;
  try {
    const issues = await searchJql(env, jql, ['summary', 'issuetype', 'status'], { limit: 25 });
    return issues.map((i) => ({
      key: i.key,
      label: i.key,
      title: i.fields?.summary || '',
      sublabel: [i.fields?.issuetype?.name, i.fields?.status?.name].filter(Boolean).join(', '),
    }));
  } catch (err) {
    console.warn('Asset lookup failed:', err.message);
    return [];
  }
}

// ---------- Raising and following requests ----------

export async function raise(env, viewer, { category, urgency, summary, description, assetKey, attachments = [] }) {
  const text = String(summary || '').trim();
  if (!text) throw new Error('A short summary is needed.');
  const map = await requestTypeMap(env);
  const mapping = map.get(category);
  if (!mapping) throw new Error('That kind of request is not set up yet. Ask an admin to map it on the Admin page.');

  const body = [
    String(description || '').trim() || 'No further detail given.',
    '',
    `Urgency: ${urgencyLabel(urgency)}`,
    assetKey ? `Asset: ${assetKey}` : null,
    `Raised from Promtek Hub by ${viewer.employee?.name || viewer.email}.`,
  ].filter((line) => line !== null).join('\n');

  const created = await jira(env, '/rest/servicedeskapi/request', {
    method: 'POST',
    body: JSON.stringify({
      serviceDeskId: mapping.service_desk_id,
      requestTypeId: mapping.request_type_id,
      raiseOnBehalfOf: viewer.accountId,
      requestFieldValues: { summary: text.slice(0, 240), description: body },
    }),
  });
  const key = created.issueKey;
  const notes = [];

  // Priority often isn't on the request form, so it's set afterwards.
  try {
    await jira(env, `/rest/api/3/issue/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { priority: { name: urgencyPriority(urgency) } } }),
    });
  } catch (err) {
    notes.push('Priority could not be set automatically.');
  }

  if (assetKey) {
    try {
      await jira(env, '/rest/api/3/issueLink', {
        method: 'POST',
        body: JSON.stringify({ type: { name: 'Relates' }, inwardIssue: { key }, outwardIssue: { key: assetKey } }),
      });
    } catch (err) {
      notes.push(`The asset ${assetKey} could not be linked, but it is named in the description.`);
    }
  }

  for (const file of attachments.slice(0, 5)) {
    try {
      await attachFile(env, key, file);
    } catch (err) {
      notes.push(`A photo could not be attached: ${err.message}`);
    }
  }

  return { key, notes, url: `${env.JIRA_BASE_URL}/browse/${key}` };
}

async function attachFile(env, issueKey, { name, type, base64 }) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('over 8 MB');

  const body = new FormData();
  body.append('file', new Blob([bytes], { type: type || 'image/jpeg' }), name || 'photo.jpg');
  const res = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`),
      'X-Atlassian-Token': 'no-check',
      Accept: 'application/json',
    },
    body,
  });
  if (!res.ok) throw new Error(`Jira ${res.status}`);
}

export async function myRequests(env, viewer, { all = false } = {}) {
  const jql = all && viewer.isLead
    ? `project = ${IT_PROJECT} AND statusCategory != Done ORDER BY created DESC`
    : `project = ${IT_PROJECT} AND reporter = "${viewer.accountId}" ORDER BY created DESC`;
  try {
    const issues = await searchJql(env, jql, ['summary', 'status', 'priority', 'created', 'assignee', 'reporter'], { limit: 30 });
    return {
      requests: issues.map((i) => ({
        key: i.key,
        summary: i.fields?.summary || '',
        status: i.fields?.status?.name || '',
        done: i.fields?.status?.statusCategory?.key === 'done',
        priority: i.fields?.priority?.name || '',
        created: (i.fields?.created || '').slice(0, 10),
        assignee: i.fields?.assignee?.displayName || 'Unassigned',
        reporter: i.fields?.reporter?.displayName || '',
        url: `${env.JIRA_BASE_URL}/browse/${i.key}`,
      })),
    };
  } catch (err) {
    return { requests: [], error: err.message };
  }
}

export async function comment(env, viewer, { key, text }) {
  if (!String(text || '').trim()) throw new Error('Nothing to say.');
  await jira(env, `/rest/api/3/issue/${key}/comment`, {
    method: 'POST',
    body: JSON.stringify({
      body: {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `${viewer.employee?.name || viewer.email}: ${String(text).slice(0, 2000)}` }] }],
      },
    }),
  });
  return { ok: true };
}
