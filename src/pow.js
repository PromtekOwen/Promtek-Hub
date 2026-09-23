// Point of work risk assessments: picking the job, keeping drafts, and
// delivering the finished PDF to Jira and Google Drive.
import { jira, searchJql } from './jira.js';
import { raiseAlert, londonDate } from './sync.js';
import { buildPowPdf } from './pow-pdf.js';
import { SITE_VISIT_TYPES, DEFAULT_RA_LIBRARY, BEFORE_QUESTIONS, PPE_ITEMS, HAZARDS, REVIEW_QUESTIONS, RISK_LEVELS } from './pow-data.js';

const TEAM_FIELD = 'customfield_14562';
const CONTACT_FIELD = 'customfield_14261';
const CONTACT_PHONE_FIELD = 'customfield_14260';
const CONTACT_EMAIL_FIELD = 'customfield_14239';
const ADDRESS_FIELD = 'customfield_11300';
const TEAM_IDS = { projecting: '12681', service: '12680' };
const VISIT_FIELDS = ['summary', 'issuetype', 'status', 'parent', 'project', 'updated',
  CONTACT_FIELD, CONTACT_PHONE_FIELD, CONTACT_EMAIL_FIELD, ADDRESS_FIELD];

// Atlassian documents come back as a tree; this pulls the plain text out.
function plainText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(plainText).filter(Boolean).join(', ');
  if (node.type === 'hardBreak') return ', ';
  if (node.text) return node.text;
  return plainText(node.content);
}

const cleanAddress = (value) => plainText(value).replace(/\s*,\s*/g, ', ').replace(/(, )+/g, ', ').trim().replace(/^,\s*|,\s*$/g, '');

export function formSchema() {
  return {
    before: BEFORE_QUESTIONS.map(([id, text]) => ({ id, text })),
    ppe: PPE_ITEMS.map(([id, label]) => ({ id, label })),
    hazards: HAZARDS.map(([id, label]) => ({ id, label })),
    review: REVIEW_QUESTIONS.map(([id, text]) => ({ id, text })),
    risks: RISK_LEVELS,
  };
}

// ---------- The RA and SSOW list ----------

export async function raLibrary(env, { includeInactive = false } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, active, sort_order FROM ra_library${includeInactive ? '' : ' WHERE active = 1'} ORDER BY sort_order, title`
  ).all();
  if (results.length) return results;

  // First run: seed the list that was on the paper form.
  const now = Date.now();
  await env.DB.batch(DEFAULT_RA_LIBRARY.map((title, i) => env.DB.prepare(
    'INSERT INTO ra_library (id, title, active, sort_order) VALUES (?, ?, 1, ?)'
  ).bind(`ra-${now}-${i}`, title, i)));
  return raLibrary(env, { includeInactive });
}

export async function saveRa(env, { id, title, active, sortOrder }) {
  if (id) {
    await env.DB.prepare('UPDATE ra_library SET title = ?, active = ?, sort_order = ? WHERE id = ?')
      .bind(String(title).slice(0, 200), active ? 1 : 0, Number(sortOrder) || 0, id).run();
    return { id };
  }
  const newId = `ra-${Date.now()}`;
  await env.DB.prepare('INSERT INTO ra_library (id, title, active, sort_order) VALUES (?, ?, 1, ?)')
    .bind(newId, String(title).slice(0, 200), Number(sortOrder) || 99).run();
  return { id: newId };
}

// ---------- Finding the visit ----------

async function customerProjects(env, region) {
  const categoryId = region === 'sa' ? '10300' : '10333';
  const projects = [];
  let startAt = 0;
  for (let page = 0; page < 10; page++) {
    const data = await jira(env, `/rest/api/3/project/search?categoryId=${categoryId}&status=live&orderBy=name&maxResults=50&startAt=${startAt}`);
    projects.push(...(data.values || []));
    if (data.isLast || !data.values?.length) break;
    startAt += data.values.length;
  }
  return projects.map((p) => ({ id: p.key, label: p.name, sublabel: p.key, next: `${region}:${p.key}` }));
}

// Site visits sit under an order or a service contract. The order carries the
// team, and a contract is always service work, so the parents decide which
// branch a visit belongs to.
function branchOfParent(parent) {
  if (!parent) return null;
  if ((parent.fields?.issuetype?.name || '') === 'Service Contract') return 'service';
  const value = parent.fields?.[TEAM_FIELD];
  const id = Array.isArray(value) ? value[0]?.id : value?.id;
  if (id === TEAM_IDS.service) return 'service';
  if (id === TEAM_IDS.projecting) return 'projecting';
  return null;                                     // team not set on the order
}

async function visitsFor(env, projectKey, branch) {
  const visits = await searchJql(env,
    `project = "${projectKey}" AND issuetype in (${SITE_VISIT_TYPES.map((t) => `"${t}"`).join(', ')})`
    + ' AND statusCategory != Done ORDER BY updated DESC', VISIT_FIELDS, { limit: 80 });

  const parentKeys = [...new Set(visits.map((v) => v.fields?.parent?.key).filter(Boolean))];
  const parents = parentKeys.length
    ? await searchJql(env, `key in (${parentKeys.map((k) => `"${k}"`).join(', ')})`, ['summary', 'issuetype', TEAM_FIELD])
    : [];
  const parentByKey = new Map(parents.map((p) => [p.key, p]));

  const matching = [];
  const unsorted = [];
  for (const visit of visits) {
    const parentKey = visit.fields?.parent?.key;
    const parent = parentKey ? parentByKey.get(parentKey) : null;
    const parentBranch = branchOfParent(parent);
    if (parentBranch && parentBranch !== branch) continue;   // belongs to the other team

    const option = {
      id: visit.key,
      issueId: String(visit.id),
      label: visit.key,
      title: visit.fields?.summary || '',
      sublabel: [visit.fields?.issuetype?.name, visit.fields?.status?.name,
        parent ? `under ${parent.fields?.summary || parentKey}` : null].filter(Boolean).join(', '),
      loggable: true,
    };

    if (parentBranch) {
      matching.push(option);
    } else {
      // Nothing says which team it's for, so it's shown under both rather than
      // disappearing, but flagged so the gap is obvious.
      option.note = parent ? 'Team not set' : 'No order';
      unsorted.push(option);
    }
  }
  return [...matching, ...unsorted];
}

export async function browseVisits(env, node = 'root') {
  const parts = String(node).split(':');
  if (parts[0] === 'root') {
    return {
      title: 'Which customer are you visiting?',
      options: [
        { id: 'uk', label: 'UK customers', next: 'uk' },
        { id: 'sa', label: 'South Africa customers', next: 'sa' },
      ],
    };
  }
  const [region, projectKey, branch] = parts;
  if (!projectKey) return { title: 'Which customer?', options: await customerProjects(env, region) };
  if (!branch) {
    return {
      title: projectKey,
      subtitle: 'Which team is the visit for?',
      options: [
        { id: 'service', label: 'Service', next: `${region}:${projectKey}:service` },
        { id: 'projecting', label: 'Projecting', next: `${region}:${projectKey}:projecting` },
      ],
    };
  }
  const options = await visitsFor(env, projectKey, branch);
  return {
    title: `${projectKey} ${branch}`,
    subtitle: options.length ? 'Pick the visit you are on' : 'No open visits for this team',
    options,
    allowMissing: { projectKey, branch },
  };
}

// Everything the form can fill in for itself.
export async function visitDetails(env, issueKey) {
  const issue = (await searchJql(env, `key = "${issueKey}"`, VISIT_FIELDS))[0];
  if (!issue) throw new Error('That item no longer exists in Jira.');
  const f = issue.fields || {};
  return {
    issueKey: issue.key,
    issueId: String(issue.id),
    projectKey: f.project?.key || '',
    summary: f.summary || '',
    customer: f.project?.name || '',
    site: cleanAddress(f[ADDRESS_FIELD]),
    contact: f[CONTACT_FIELD] || '',
    contactPhone: f[CONTACT_PHONE_FIELD] || '',
    contactEmail: f[CONTACT_EMAIL_FIELD] || '',
  };
}

// ---------- Drafts and submission ----------

const newId = () => `pow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function saveDraft(env, viewer, form) {
  const id = form.id || newId();
  const now = new Date().toISOString();
  const details = form.details || {};
  await env.DB.prepare(
    `INSERT INTO pow_forms (id, account_id, status, issue_key, issue_id, project_key, customer, site, job_missing, data, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET issue_key = excluded.issue_key, issue_id = excluded.issue_id,
       project_key = excluded.project_key, customer = excluded.customer, site = excluded.site,
       job_missing = excluded.job_missing, data = excluded.data, updated_at = excluded.updated_at`
  ).bind(id, viewer.accountId, form.issueKey || null, form.issueId || null, form.projectKey || null,
    details.customer || null, details.site || null, form.jobMissing ? 1 : 0, JSON.stringify(form), now, now).run();
  return { id, status: 'draft' };
}

export async function listForms(env, viewer, { all = false, limit = 30 } = {}) {
  const { results } = all
    ? await env.DB.prepare(
      `SELECT p.id, p.account_id, p.status, p.issue_key, p.customer, p.site, p.job_missing, p.submitted_at,
              p.updated_at, p.drive_file_id, p.jira_attached, p.delivery_note, e.name AS engineer
         FROM pow_forms p LEFT JOIN employees e ON e.account_id = p.account_id
        ORDER BY COALESCE(p.submitted_at, p.updated_at) DESC LIMIT ?`
    ).bind(limit).all()
    : await env.DB.prepare(
      `SELECT id, status, issue_key, customer, site, job_missing, submitted_at, updated_at, drive_file_id, jira_attached, delivery_note
         FROM pow_forms WHERE account_id = ? ORDER BY COALESCE(submitted_at, updated_at) DESC LIMIT ?`
    ).bind(viewer.accountId, limit).all();
  return { forms: results };
}

export async function getForm(env, viewer, id) {
  const row = await env.DB.prepare('SELECT * FROM pow_forms WHERE id = ?').bind(id).first();
  if (!row) throw new Error('That assessment has gone.');
  if (row.account_id !== viewer.accountId && !viewer.isLead) throw new Error('That assessment belongs to someone else.');
  return { ...row, data: JSON.parse(row.data) };
}

export async function deleteDraft(env, viewer, id) {
  await env.DB.prepare("DELETE FROM pow_forms WHERE id = ? AND account_id = ? AND status = 'draft'")
    .bind(id, viewer.accountId).run();
  return { ok: true };
}

export async function submitForm(env, viewer, form) {
  const id = form.id || newId();
  const now = new Date();
  const completedAt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(now).replace(' at ', ', ');

  const record = {
    ...form,
    id,
    completedAt,
    details: {
      ...form.details,
      engineer: form.details?.engineer || viewer.employee?.name || viewer.email,
      jobNo: form.issueKey || form.details?.jobNo || '',
    },
  };

  const pdf = await buildPowPdf(record);
  const safeJob = (record.issueKey || 'no-job').replace(/[^A-Za-z0-9-]/g, '');
  const filename = `Point of Work Risk Assessment ${safeJob} ${londonDate()}.pdf`;

  const notes = [];
  let attached = 0;
  if (record.issueKey) {
    try {
      await attachToJira(env, record.issueKey, filename, pdf);
      attached = 1;
    } catch (err) {
      notes.push(`Jira attachment failed: ${err.message}`);
    }
  }

  let driveFileId = null;
  try {
    driveFileId = await uploadToDrive(env, filename, pdf);
  } catch (err) {
    notes.push(`Drive upload failed: ${err.message}`);
  }

  await env.DB.prepare(
    `INSERT INTO pow_forms (id, account_id, status, issue_key, issue_id, project_key, customer, site, job_missing,
       data, pdf_name, jira_attached, drive_file_id, delivery_note, created_at, updated_at, submitted_at)
     VALUES (?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = 'submitted', issue_key = excluded.issue_key, issue_id = excluded.issue_id,
       project_key = excluded.project_key, customer = excluded.customer, site = excluded.site,
       job_missing = excluded.job_missing, data = excluded.data, pdf_name = excluded.pdf_name,
       jira_attached = excluded.jira_attached, drive_file_id = excluded.drive_file_id,
       delivery_note = excluded.delivery_note, updated_at = excluded.updated_at, submitted_at = excluded.submitted_at`
  ).bind(id, viewer.accountId, record.issueKey || null, record.issueId || null, record.projectKey || null,
    record.details.customer || null, record.details.site || null, record.jobMissing ? 1 : 0,
    JSON.stringify(record), filename, attached, driveFileId, notes.join(' | ') || null,
    now.toISOString(), now.toISOString(), now.toISOString()).run();

  if (record.jobMissing) {
    await raiseAlert(env, {
      kind: 'pow-no-job',
      dedupe: `pow-no-job:${id}`,
      subject: `Site visit not progressed in Jira: ${record.details.customer || 'unknown customer'}`,
      body: `${record.details.engineer} completed a point of work risk assessment on site but could not find the visit item in Jira.\n\n`
        + `Customer: ${record.details.customer || 'Not given'}\nSite: ${record.details.site || 'Not given'}\n`
        + `Team: ${record.branch || 'Not given'}\n\nThe assessment is saved in the hub and can have its job number added once the item exists.`,
    });
  }
  if (notes.length) {
    await raiseAlert(env, {
      kind: 'pow-delivery',
      dedupe: `pow-delivery:${id}`,
      subject: `Risk assessment saved but not delivered: ${record.issueKey || record.details.customer}`,
      body: `${record.details.engineer}'s assessment is stored in the hub, but:\n\n${notes.join('\n')}\n\nIt can be downloaded and filed by hand from the hub.`,
    });
  }

  return { id, filename, jiraAttached: Boolean(attached), driveFileId, notes };
}

export async function renderPdf(env, viewer, id) {
  const form = await getForm(env, viewer, id);
  const bytes = await buildPowPdf(form.data);
  return { bytes, filename: form.pdf_name || `Point of Work ${form.issue_key || id}.pdf` };
}

// ---------- Delivery ----------

async function attachToJira(env, issueKey, filename, bytes) {
  const body = new FormData();
  body.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
  const res = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`),
      'X-Atlassian-Token': 'no-check',
      Accept: 'application/json',
    },
    body,
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return true;
}

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Signs in as the service account and returns a short-lived access token.
async function googleToken(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT) throw new Error('No Google service account configured');
  const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64url(new TextEncoder().encode(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })));

  const pem = account.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`,
  });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return (await res.json()).access_token;
}

async function uploadToDrive(env, filename, bytes) {
  if (!env.DRIVE_FOLDER_ID) throw new Error('No Drive folder configured');
  const token = await googleToken(env);
  const body = new FormData();
  body.append('metadata', new Blob([JSON.stringify({ name: filename, parents: [env.DRIVE_FOLDER_ID] })], { type: 'application/json' }));
  body.append('file', new Blob([bytes], { type: 'application/pdf' }));
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return (await res.json()).id;
}
