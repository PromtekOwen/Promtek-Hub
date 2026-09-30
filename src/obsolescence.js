// Obsolescence surveys: the equipment library, the client list from Jira,
// the survey itself, and the sales review that follows it.
import { jira, searchJql } from './jira.js';
import { raiseAlert, londonDate } from './sync.js';
import { LIBRARY_SEED } from './obs-library.js';
import { buildSurveyPdf } from './obs-pdf.js';

const REPORT_ISSUE_TYPE = 'Obsolescence Reports';
const CONTRACT_ISSUE_TYPE = 'Service Contract';
const CONTRACT_STATUSES = ['In Contract', 'Requires Renewal'];
const CONTRACT_FIELD = 'customfield_12700';
const CONTACT_FIELD = 'customfield_14261';
const REPORT_LINK_FIELD = 'customfield_14455';
const QUOTE_LIST_TYPE = 'Quote List';
const QUOTE_TYPE = 'Quote';
const QUOTE_LINK_TYPE = 'Causes';          // quote "is caused by" the report

export const SURVEY_COMPLETE_STATUS = 'New Survey Added';
export const REPORT_DONE_STATUS = 'Report Up To Date';

// The sections of a survey, and the fields on each item.
export const SECTIONS = [
  { id: 'controlServers', name: 'Control servers', library: 'controlPCs', fixed: ['RMX Control Server', 'Intime Control Server', 'Kestrel Server', 'Condor Server', 'Livelink Server'],
    fields: [['os', 'Operating system'], ['cpu', 'CPU'], ['ram', 'RAM'], ['hdd', 'HDD / storage'], ['ip', 'IP address'], ['subnet', 'Subnet'], ['gateway', 'Gateway']] },
  { id: 'vdus', name: 'VDUs and client PCs', library: 'vdus', addLabel: 'VDU',
    fields: [['os', 'Operating system'], ['cpu', 'CPU'], ['ram', 'RAM'], ['hdd', 'HDD / storage'], ['partNo', 'Part no'], ['dom', 'Date of manufacture'], ['ip', 'IP address'], ['subnet', 'Subnet'], ['gateway', 'Gateway']] },
  { id: 'lcAmps', name: 'Load cell amplifiers', library: 'lcAmps', addLabel: 'AW',
    fields: [['partNo', 'Part no'], ['hwRev', 'Hardware rev'], ['swRev', 'Software rev'], ['serialNo', 'Serial no'], ['dom', 'Date of manufacture']] },
  { id: 'loadCells', name: 'Load cells', library: 'loadCells', addLabel: 'AW',
    fields: [['partNo', 'Part no'], ['manufacturer', 'Manufacturer'], ['mvv', 'mV/V'], ['serialNo', 'Serial no']] },
  { id: 'plcCards', name: 'PLC panels', library: 'plcCards', addLabel: 'Panel', cards: true,
    fields: [['manufacturer', 'Manufacturer'], ['partNo', 'Part number'], ['cardType', 'Card type'], ['voltage', 'Control voltage'], ['density', 'Density / I/O count']] },
  { id: 'software', name: 'Software', library: 'software', addLabel: 'Software',
    fields: [['version', 'Version'], ['filename', 'Filename'], ['fileVersion', 'File version'], ['dateModified', 'Date modified']] },
  { id: 'criticalSpares', name: 'Critical spares', library: 'criticalSpares', addLabel: 'Spare', spares: true,
    fields: [['area', 'Area'], ['inStock', 'In stock']] },
];

export const CARD_TYPES = ['Processor', 'Digital Input', 'Digital Output', 'Analogue Input', 'Analogue Output', 'Power Supply'];
export const CONDITIONS = ['Active', 'Active mature', 'Obsolete', 'End of life'];

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// ---------- The equipment library ----------

export async function library(env, kind = null) {
  const seeded = await env.DB.prepare('SELECT COUNT(*) AS n FROM obs_library').first();
  if (!seeded.n) {
    const rows = [];
    for (const [key, section] of Object.entries(LIBRARY_SEED)) {
      section.rows.forEach((row, i) => rows.push([`seed-${key}-${i}`, key, JSON.stringify(row)]));
    }
    for (let i = 0; i < rows.length; i += 50) {
      await env.DB.batch(rows.slice(i, i + 50).map(([id, k, data]) => env.DB.prepare(
        'INSERT INTO obs_library (id, kind, data, source, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
      ).bind(id, k, data, 'master sheet', new Date().toISOString())));
    }
  }

  const { results } = kind
    ? await env.DB.prepare('SELECT id, kind, data, source FROM obs_library WHERE kind = ? ORDER BY id').bind(kind).all()
    : await env.DB.prepare('SELECT id, kind, data, source FROM obs_library ORDER BY kind, id').all();

  const out = {};
  for (const row of results) {
    (out[row.kind] ||= []).push({ id: row.id, source: row.source, ...JSON.parse(row.data) });
  }
  for (const [key, section] of Object.entries(LIBRARY_SEED)) {
    out[key] ||= [];
    out[`${key}Columns`] = section.columns;
  }
  return out;
}

// Anything new an engineer types during a survey is kept, so the library grows.
export async function learn(env, entries) {
  const now = new Date().toISOString();
  const statements = entries
    .filter((e) => e.kind && e.data && Object.values(e.data).some(Boolean))
    .slice(0, 100)
    .map((e) => env.DB.prepare('INSERT INTO obs_library (id, kind, data, source, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(newId('lib'), e.kind, JSON.stringify(e.data), e.source || 'survey', now));
  if (statements.length) await env.DB.batch(statements);
  return { added: statements.length };
}

export async function addLibraryEntry(env, { kind, data, source = 'added by hand' }) {
  return learn(env, [{ kind, data, source }]);
}

export async function removeLibraryEntry(env, id) {
  await env.DB.prepare('DELETE FROM obs_library WHERE id = ?').bind(id).run();
  return { ok: true };
}

// ---------- The client list, read straight from Jira ----------

async function contractFor(env, projectKey) {
  try {
    const issues = await searchJql(env,
      `project = "${projectKey}" AND issuetype = "${CONTRACT_ISSUE_TYPE}"`
      + ` AND status in (${CONTRACT_STATUSES.map((s) => `"${s}"`).join(', ')}) ORDER BY created DESC`,
      [CONTRACT_FIELD], { limit: 1 });
    const first = issues[0];
    if (!first) return { contractNo: '', serviceContract: '' };
    const value = first.fields?.[CONTRACT_FIELD];
    return {
      contractNo: first.key,
      serviceContract: typeof value === 'object' ? (value?.value || value?.name || '') : String(value || ''),
    };
  } catch (err) {
    return { contractNo: '', serviceContract: '' };
  }
}

export async function listReports(env, { status = null } = {}) {
  const jql = `issuetype = "${REPORT_ISSUE_TYPE}"${status ? ` AND status = "${status}"` : ''} ORDER BY updated DESC`;
  const issues = await searchJql(env, jql, ['summary', 'status', 'project', 'updated', CONTACT_FIELD, REPORT_LINK_FIELD], { limit: 100 });

  const reports = [];
  for (const issue of issues) {
    const f = issue.fields || {};
    const projectKey = f.project?.key || '';
    const contract = await contractFor(env, projectKey);
    reports.push({
      key: issue.key,
      url: `${env.JIRA_BASE_URL}/browse/${issue.key}`,
      summary: f.summary || '',
      status: f.status?.name || '',
      client: f.project?.name || '',
      projectKey,
      updated: (f.updated || '').slice(0, 10),
      siteContact: typeof f[CONTACT_FIELD] === 'object' ? (f[CONTACT_FIELD]?.value || '') : (f[CONTACT_FIELD] || ''),
      reportLink: f[REPORT_LINK_FIELD] || '',
      ...contract,
    });
  }
  return { reports };
}

// ---------- Surveys ----------

export async function saveSurvey(env, viewer, survey) {
  const id = survey.id || newId('obs');
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO obs_surveys (id, account_id, status, report_key, project_key, client, survey_date, data, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET report_key = excluded.report_key, project_key = excluded.project_key,
       client = excluded.client, survey_date = excluded.survey_date, data = excluded.data, updated_at = excluded.updated_at`
  ).bind(id, viewer.accountId, survey.reportKey || null, survey.projectKey || null,
    survey.title?.client || null, survey.title?.date || londonDate(), JSON.stringify(survey), now, now).run();
  return { id, status: 'draft' };
}

export async function listSurveys(env, viewer, { all = false } = {}) {
  const { results } = all && viewer.isLead
    ? await env.DB.prepare(
      `SELECT s.id, s.status, s.report_key, s.client, s.survey_date, s.updated_at, s.submitted_at, s.drive_link,
              s.delivery_note, e.name AS engineer
         FROM obs_surveys s LEFT JOIN employees e ON e.account_id = s.account_id
        ORDER BY COALESCE(s.submitted_at, s.updated_at) DESC LIMIT 40`).all()
    : await env.DB.prepare(
      `SELECT id, status, report_key, client, survey_date, updated_at, submitted_at, drive_link, delivery_note
         FROM obs_surveys WHERE account_id = ? ORDER BY COALESCE(submitted_at, updated_at) DESC LIMIT 40`)
      .bind(viewer.accountId).all();
  return { surveys: results };
}

export async function getSurvey(env, viewer, id) {
  const row = await env.DB.prepare('SELECT * FROM obs_surveys WHERE id = ?').bind(id).first();
  if (!row) throw new Error('That survey has gone.');
  if (row.account_id !== viewer.accountId && !viewer.isLead) throw new Error('That survey belongs to someone else.');
  return { ...row, data: JSON.parse(row.data) };
}

export async function deleteSurvey(env, viewer, id) {
  await env.DB.prepare("DELETE FROM obs_surveys WHERE id = ? AND account_id = ? AND status = 'draft'")
    .bind(id, viewer.accountId).run();
  return { ok: true };
}

export async function submitSurvey(env, viewer, survey) {
  const id = survey.id || newId('obs');
  const now = new Date();
  const completedAt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(now).replace(' at ', ', ');

  const record = {
    ...survey,
    id,
    completedAt,
    title: { ...survey.title, engineer: survey.title?.engineer || viewer.employee?.name || viewer.email },
  };

  const pdf = await buildSurveyPdf(record);
  const client = (record.title?.client || 'Unknown client').trim();
  const filename = `Obsolescence Survey ${client} ${record.title?.date || londonDate()}.pdf`.replace(/[\\/:*?"<>|]/g, '-');

  const notes = [];
  let attached = 0;
  if (record.reportKey) {
    try {
      await attachToJira(env, record.reportKey, filename, pdf);
      attached = 1;
    } catch (err) {
      notes.push(`Jira attachment failed: ${err.message}`);
    }
  }

  let drive = { id: null, link: null };
  try {
    drive = await uploadToDrive(env, client, filename, pdf);
  } catch (err) {
    notes.push(`Drive upload failed: ${err.message}`);
  }

  // The report link on the Jira item points at the new PDF.
  if (record.reportKey && drive.link) {
    try {
      await jira(env, `/rest/api/3/issue/${record.reportKey}`, {
        method: 'PUT', body: JSON.stringify({ fields: { [REPORT_LINK_FIELD]: drive.link } }),
      });
    } catch (err) {
      notes.push('The report link field could not be updated.');
    }
  }

  if (record.reportKey) {
    const problem = await transitionTo(env, record.reportKey, SURVEY_COMPLETE_STATUS);
    if (problem) notes.push(`Status not changed: ${problem}`);
  }

  await env.DB.prepare(
    `INSERT INTO obs_surveys (id, account_id, status, report_key, project_key, client, survey_date, data, pdf_name,
       jira_attached, drive_file_id, drive_link, delivery_note, created_at, updated_at, submitted_at)
     VALUES (?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = 'submitted', report_key = excluded.report_key, project_key = excluded.project_key,
       client = excluded.client, survey_date = excluded.survey_date, data = excluded.data, pdf_name = excluded.pdf_name,
       jira_attached = excluded.jira_attached, drive_file_id = excluded.drive_file_id, drive_link = excluded.drive_link,
       delivery_note = excluded.delivery_note, updated_at = excluded.updated_at, submitted_at = excluded.submitted_at`
  ).bind(id, viewer.accountId, record.reportKey || null, record.projectKey || null, client,
    record.title?.date || londonDate(), JSON.stringify(record), filename, attached, drive.id, drive.link,
    notes.join(' | ') || null, now.toISOString(), now.toISOString(), now.toISOString()).run();

  // Everything new the engineer typed is added to the library.
  try {
    await learn(env, harvest(record));
  } catch (err) {
    console.warn('Library update failed:', err.message);
  }

  if (notes.length) {
    await raiseAlert(env, {
      kind: 'obs-delivery',
      dedupe: `obs-delivery:${id}`,
      subject: `Obsolescence survey saved but not fully filed: ${client}`,
      body: `${record.title.engineer}'s survey is stored in the hub, but:\n\n${notes.join('\n')}\n\nIt can be downloaded from the hub and filed by hand.`,
    });
  }

  return { id, filename, jiraAttached: Boolean(attached), driveLink: drive.link, notes };
}

// Pulls anything worth remembering out of a finished survey.
function harvest(survey) {
  const entries = [];
  for (const section of SECTIONS) {
    const items = survey[section.id] || [];
    for (const item of items) {
      if (section.cards) {
        for (const card of item.cards || []) {
          if (card.partNo) entries.push({ kind: 'plcCards', data: { 'Manufacturer': card.manufacturer, 'Part Number': card.partNo, 'Card Type': card.cardType, 'Control Voltage': card.voltage, 'Density / I/O Count': card.density, 'Comments': card.comments } });
        }
        continue;
      }
      const meaningful = section.fields.some(([key]) => item[key]);
      if (meaningful) entries.push({ kind: section.library, data: Object.fromEntries(section.fields.map(([key, label]) => [label, item[key] || ''])) });
    }
  }
  return entries;
}

export async function renderPdf(env, viewer, id) {
  const survey = await getSurvey(env, viewer, id);
  return { bytes: await buildSurveyPdf(survey.data), filename: survey.pdf_name || `Obsolescence Survey ${id}.pdf` };
}

// ---------- The sales review ----------

export async function salesQueue(env) {
  const { reports } = await listReports(env, { status: SURVEY_COMPLETE_STATUS });
  const keys = reports.map((r) => r.key);
  if (!keys.length) return { reports: [] };

  const { results } = await env.DB.prepare(
    `SELECT id, report_key, client, survey_date, submitted_at, drive_link FROM obs_surveys
      WHERE report_key IN (${keys.map(() => '?').join(',')}) AND status = 'submitted' ORDER BY submitted_at DESC`
  ).bind(...keys).all();
  const surveys = new Map();
  results.forEach((row) => { if (!surveys.has(row.report_key)) surveys.set(row.report_key, row); });

  return {
    reports: reports.map((report) => ({
      ...report,
      survey: surveys.get(report.key) || null,
      surveyDate: surveys.get(report.key)?.survey_date || report.updated,
    })),
  };
}

export async function quoteDecision(env, viewer, { reportKey, projectKey, surveyDate, needed }) {
  if (!reportKey || !projectKey) throw new Error('Which report is this about?');
  const result = { reportKey, quoteKey: null, notes: [] };

  if (needed) {
    const listIssues = await searchJql(env,
      `project = "${projectKey}" AND issuetype = "${QUOTE_LIST_TYPE}" ORDER BY created ASC`, ['summary'], { limit: 1 });
    const parent = listIssues[0];

    const fields = {
      project: { key: projectKey },
      issuetype: { name: QUOTE_TYPE },
      summary: `Obsolescence quote for ${surveyDate || londonDate()} Survey`,
      assignee: { id: viewer.accountId },
    };
    if (parent) fields.parent = { key: parent.key };

    let created;
    try {
      created = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
    } catch (err) {
      if (parent) {
        // Some projects won't take a parent on create; fall back to a flat quote.
        delete fields.parent;
        created = await jira(env, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
        result.notes.push(`Created outside the quote list: ${err.message}`);
      } else {
        throw err;
      }
    }
    result.quoteKey = created.key;
    result.quoteUrl = `${env.JIRA_BASE_URL}/browse/${created.key}`;

    // The quote "is caused by" the obsolescence report. If that link type
    // isn't in this Jira, fall back to a plain relates link.
    const link = async (typeName) => jira(env, '/rest/api/3/issueLink', {
      method: 'POST',
      body: JSON.stringify({
        type: { name: typeName },
        inwardIssue: { key: created.key },
        outwardIssue: { key: reportKey },
      }),
    });
    try {
      await link(QUOTE_LINK_TYPE);
    } catch (err) {
      try {
        await link('Relates');
        result.notes.push(`Linked as "relates to": the "${QUOTE_LINK_TYPE}" link type was not available.`);
      } catch (second) {
        result.notes.push('The quote could not be linked to the report automatically.');
      }
    }
  }

  const problem = await transitionTo(env, reportKey, REPORT_DONE_STATUS);
  if (problem) result.notes.push(`Status not changed: ${problem}`);
  return result;
}

// ---------- Shared helpers ----------

async function transitionTo(env, issueKey, statusName) {
  try {
    const { transitions } = await jira(env, `/rest/api/3/issue/${issueKey}/transitions`);
    const transition = (transitions || []).find((t) => (t.to?.name || t.name) === statusName);
    if (!transition) return `"${statusName}" was not available on ${issueKey}`;
    await jira(env, `/rest/api/3/issue/${issueKey}/transitions`, {
      method: 'POST', body: JSON.stringify({ transition: { id: transition.id } }),
    });
    return null;
  } catch (err) {
    return err.message;
  }
}

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
}

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${header}.${claims}.${base64url(signature)}`,
  });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return (await res.json()).access_token;
}

// Reports go in a folder per client, matched loosely so small differences in
// spelling don't create duplicates.
async function clientFolder(env, token, client) {
  const parent = env.OBS_DRIVE_FOLDER_ID;
  if (!parent) throw new Error('No obsolescence folder configured');
  const query = encodeURIComponent(`'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive ${res.status}`);
  const { files } = await res.json();
  const tidy = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const existing = (files || []).find((f) => tidy(f.name) === tidy(client));
  if (existing) return existing.id;

  const made = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: client, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
  });
  if (!made.ok) throw new Error(`Drive folder ${made.status}`);
  return (await made.json()).id;
}

async function uploadToDrive(env, client, filename, bytes) {
  const token = await googleToken(env);
  const folder = await clientFolder(env, token, client);
  const body = new FormData();
  body.append('metadata', new Blob([JSON.stringify({ name: filename, parents: [folder] })], { type: 'application/json' }));
  body.append('file', new Blob([bytes], { type: 'application/pdf' }));
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
  });
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const file = await res.json();
  return { id: file.id, link: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view` };
}
