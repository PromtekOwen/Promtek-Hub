// Raising a PSC from the hub. The customer is known, so it goes straight into the
// customer's own project, under its PSC & Snag List (a Service Request under its Service
// item), as the team would raise it in Jira: its type, summary, description, owner and any
// pictures. It can go straight to Condor Dev too. The PSC board is for what customers raise
// themselves, through the portal or by email. Once made it's read into the tile at once.
import { jira, customerProjects } from './jira.js';
import { record } from './audit.js';
import { mustSee, readOne, changed } from './psc.js';
import { PSC_HOME, LISTS } from './customer-lists.js';

// What a PSC can be raised as. Snags and Sub-Snags belong to orders, so they're raised there.
export const CREATE_TYPES = ['Incident', 'Further Investigation', 'PSC', 'Problem', 'Change', 'Service Request'];
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });

export async function options(env, viewer) {
  mustSee(viewer);
  const [projects, { results: people }] = await Promise.all([
    customerProjects(env),
    env.DB.prepare("SELECT account_id, name FROM employees WHERE active = 1 AND account_id NOT LIKE 'pending%' ORDER BY name").all(),
  ]);
  return {
    customers: projects.map((p) => ({ key: p.key, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
    types: CREATE_TYPES,
    people: people.map((p) => ({ id: p.account_id, name: p.name })),
    me: viewer.accountId || null,
  };
}

// The list it goes under: known from the daily read of the lists, or looked up now.
async function listFor(env, projectKey, typeName) {
  const kind = PSC_HOME[typeName] || 'pscs';
  const known = await env.DB.prepare('SELECT issue_key FROM customer_lists WHERE project_key = ? AND kind = ?').bind(projectKey, kind).first().catch(() => null);
  if (known?.issue_key) return known.issue_key;
  const jql = `project = "${projectKey}" AND issuetype = "${LISTS[kind].type}" ORDER BY created ASC`;
  const data = await jira(env, `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=1&fields=summary`).catch(() => null);
  return data?.issues?.[0]?.key || null;
}

// Plain text in Jira's document format: a paragraph per blank-line gap, line breaks kept.
function adf(text) {
  const paras = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    type: 'doc', version: 1,
    content: paras.map((p) => ({ type: 'paragraph', content: p.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]) })),
  };
}

async function attach(env, key, files) {
  const auth = `Basic ${btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`)}`;
  const failed = [];
  for (const f of files) {
    const form = new FormData();
    form.append('file', f, f.name || 'picture');
    const res = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
      method: 'POST', headers: { Authorization: auth, 'X-Atlassian-Token': 'no-check', Accept: 'application/json' }, body: form,
    }).catch(() => null);
    if (!res?.ok) failed.push(f.name || 'a picture');
  }
  return failed;
}

export async function create(env, viewer, form) {
  mustSee(viewer);
  const get = (k) => String(form.get(k) || '').trim();
  const summary = get('summary').replace(/\s+/g, ' ');
  const description = get('description');
  if (summary.length < 3) throw refuse('Give it a summary.');
  if (summary.length > 250) throw refuse('Keep the summary under 250 characters.');
  if (description.length > 30000) throw refuse('That description is too long for Jira.');
  const project = (await customerProjects(env)).find((p) => p.key === get('projectKey'));
  if (!project) throw refuse('Choose the customer from the list.');
  const typeName = get('type');
  if (!CREATE_TYPES.includes(typeName)) throw refuse('Choose what type of item it is.');
  const assignee = get('assigneeId');
  if (assignee && !(await env.DB.prepare('SELECT 1 FROM employees WHERE account_id = ? AND active = 1').bind(assignee).first())) throw refuse('Choose who it\'s assigned to from the list.');
  const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0);
  if (files.length > MAX_FILES) throw refuse(`Add up to ${MAX_FILES} pictures.`);
  for (const f of files) {
    if (!/^image\//.test(f.type || '')) throw refuse(`${f.name || 'One file'} isn't a picture.`);
    if (f.size > MAX_FILE_BYTES) throw refuse(`${f.name || 'One picture'} is over 10 MB.`);
  }
  const name = viewer.employee?.name || viewer.email;
  const info = await jira(env, `/rest/api/3/project/${encodeURIComponent(project.key)}`);
  const type = (info?.issueTypes || []).find((t) => !t.subtask && String(t.name).toLowerCase() === typeName.toLowerCase());
  if (!type) throw refuse(`${project.name}'s project has no ${typeName} type in Jira.`);
  const parent = await listFor(env, project.key, typeName);

  const fields = {
    project: { key: project.key }, issuetype: { id: String(type.id) }, summary,
    description: adf(description || summary),
    ...(parent ? { parent: { key: parent } } : {}),
    ...(assignee ? { assignee: { accountId: assignee } } : {}),
    ...(viewer.accountId ? { reporter: { accountId: viewer.accountId } } : {}),
  };
  const post = () => jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
  let made;
  try { made = await post(); } catch (err) {
    if (err.status !== 400) throw err;
    // Jira won't set who raised it, or won't put it under the list: the hub's account raises it
    // (with their name in the description), and the lists job moves it under the list later.
    const msg = String(err.message);
    if (fields.reporter && (/reporter/i.test(msg) || !/parent/i.test(msg))) { delete fields.reporter; fields.description = adf(`${description || summary}\n\nRaised by ${name} from the hub.`); }
    if (fields.parent && /parent/i.test(msg)) delete fields.parent;
    made = await post();
  }
  const key = made?.key;
  if (!key) throw refuse('Jira didn\'t say what it made.', 502);

  const out = { ok: true, key };
  if (files.length) {
    const failed = await attach(env, key, files);
    if (failed.length) out.pictureProblem = `Jira didn't take ${failed.join(', ')}. Add ${failed.length === 1 ? 'it' : 'them'} in Jira.`;
  }
  await readOne(env, key).catch(() => changed(env));
  await record(env, viewer, { area: 'PSC', action: 'raised a PSC', subjectType: 'psc', subjectId: key, label: key,
    changes: [{ label: 'Customer', before: '', after: project.name }, { label: 'Summary', before: '', after: summary }] }).catch(() => {});

  if (get('condor') === '1') {
    try {
      const r = await (await import('./psc-handoff.js')).toCondor(env, viewer, { key });
      out.condor = r.target || null;
      if (!r.target) out.condorProblem = r.message || 'It waits to go to Condor Dev; the hub tries again.';
    } catch (err) { out.condorProblem = `It wasn't sent to Condor Dev: ${err.message}`; }
  }
  return out;
}
