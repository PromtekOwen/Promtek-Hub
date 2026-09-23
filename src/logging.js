// Finding the right item to log time against, and writing the worklog to Tempo.
import { jira, searchJql } from './jira.js';
import { raiseAlert, londonDate } from './sync.js';
import { stageNameOf } from './jobs.js';

const TEMPO = 'https://api.tempo.io/4';

export const IMS_PROJECTS = [
  ['GOALS', 'Strategic Objectives'],
  ['LEGAL', 'Legal & Policy'],
  ['HEALTH', 'Health & Safety'],
  ['COMPLIANCE', 'Compliance & Training'],
  ['FINANCE', 'Finance'],
  ['INNOV', 'Innovation Pipeline'],
  ['IS', 'Information Security'],
  ['MARKETING', 'Marketing'],
  ['SUGGEST', 'Operational Improvements'],
  ['QA', 'Quality Assurance'],
];

export const PMB_CATEGORIES = ['Non-Work', 'General Service', 'Admin', 'Dev Ops', 'Housekeeping', 'Management', 'Training'];
export const CUSTOMER_CATEGORY_IDS = { uk: '10333', sa: '10300' };
const PSC_TYPES = ['Snag', 'Incident', 'Further Investigation', 'PSC', 'Problem', 'Change', 'Service Request'];
const PSC_CLOSED = ['Resolved [Promtek]', 'Verified [Customer]'];
const TEAM_FIELD = 'customfield_14562';
const XP_RATE_FIELD = 'customfield_16566';

const ELO_FIELD = 'customfield_15378';
const LIST_FIELDS = ['summary', 'issuetype', 'status', 'parent', 'project', XP_RATE_FIELD, TEAM_FIELD, ELO_FIELD, 'assignee'];
const quoted = (values) => values.map((v) => `"${v}"`).join(', ');

// What an item is worth to log against, from its XP Rate.
function rateNote(issue) {
  const rate = parseFloat(issue.fields?.[XP_RATE_FIELD]);
  if (!Number.isFinite(rate) || rate === 1) return null;
  if (rate === 0) return 'No XP';
  return `${Math.round(rate * 100)}% XP`;
}

function asOption(issue, { next = null } = {}) {
  return {
    id: issue.key,
    issueId: String(issue.id),
    label: issue.key,
    title: issue.fields?.summary || '',
    sublabel: [issue.fields?.issuetype?.name, issue.fields?.status?.name].filter(Boolean).join(', '),
    note: rateNote(issue),
    rate: Number.isFinite(parseFloat(issue.fields?.[XP_RATE_FIELD])) ? parseFloat(issue.fields[XP_RATE_FIELD]) : 1,
    jobElo: Number.isFinite(parseFloat(issue.fields?.[ELO_FIELD])) ? parseFloat(issue.fields[ELO_FIELD]) : null,
    loggable: true,
    next,
  };
}

async function issuesFor(env, jql, { next = null, limit = 60 } = {}) {
  const issues = await searchJql(env, jql, LIST_FIELDS, { limit });
  return issues.map((i) => asOption(i, { next: next ? `${next}:${i.key}` : null }));
}

async function customerProjects(env, region) {
  const projects = [];
  let startAt = 0;
  for (let page = 0; page < 10; page++) {
    const data = await jira(env, `/rest/api/3/project/search?categoryId=${CUSTOMER_CATEGORY_IDS[region]}&status=live&orderBy=name&maxResults=50&startAt=${startAt}`);
    projects.push(...(data.values || []));
    if (data.isLast || !data.values?.length) break;
    startAt += data.values.length;
  }
  return projects.map((p) => ({ id: p.key, label: p.name, sublabel: p.key, loggable: false, next: `customer:${region}:${p.key}` }));
}

// One step of the "what did you work on?" tree. node is a colon-separated path.
export async function browse(env, node = 'root') {
  const [head, ...rest] = String(node).split(':');

  if (head === 'root') {
    return {
      title: 'What were you working on?',
      options: [
        { id: 'internal', label: 'Internal', sublabel: 'IMS projects and general tasks', next: 'internal' },
        { id: 'customer', label: 'Customer work', sublabel: 'Orders, service and contracts', next: 'customer' },
      ],
    };
  }

  if (head === 'internal') {
    if (!rest.length) {
      return {
        title: 'Internal work',
        options: [
          { id: 'ims', label: 'IMS', sublabel: 'The ten management system projects', next: 'internal:ims' },
          { id: 'general', label: 'General tasks', sublabel: 'Admin, training, housekeeping, leave', next: 'internal:general' },
        ],
      };
    }
    if (rest[0] === 'ims') {
      if (rest.length === 1) {
        return {
          title: 'Which IMS project?',
          options: IMS_PROJECTS.map(([key, name]) => ({ id: key, label: name, sublabel: key, next: `internal:ims:${key}` })),
        };
      }
      return {
        title: `${IMS_PROJECTS.find(([k]) => k === rest[1])?.[1] || rest[1]}`,
        subtitle: 'Open items',
        options: await issuesFor(env, `project = "${rest[1]}" AND statusCategory != Done ORDER BY updated DESC`),
      };
    }
    if (rest[0] === 'general') {
      if (rest.length === 1) {
        return {
          title: 'Which kind of task?',
          options: PMB_CATEGORIES.map((status) => ({ id: status, label: status, next: `internal:general:${status}` })),
        };
      }
      return {
        title: rest.slice(1).join(':'),
        options: await issuesFor(env, `project = PMB AND status = "${rest.slice(1).join(':')}" ORDER BY summary ASC`),
      };
    }
  }

  if (head === 'customer') {
    if (!rest.length) {
      return {
        title: 'Which customer?',
        options: [
          { id: 'uk', label: 'UK customers', next: 'customer:uk' },
          { id: 'sa', label: 'South Africa customers', next: 'customer:sa' },
        ],
      };
    }
    const [region, projectKey, branch, ...tail] = rest;
    if (!projectKey) return { title: 'Which customer?', options: await customerProjects(env, region) };

    if (!branch) {
      return {
        title: projectKey,
        subtitle: 'What kind of work?',
        options: [
          { id: 'service', label: 'Service', next: `customer:${region}:${projectKey}:service` },
          { id: 'projecting', label: 'Projecting', next: `customer:${region}:${projectKey}:projecting` },
        ],
      };
    }

    if (branch === 'projecting') {
      return {
        title: `${projectKey} projecting`,
        subtitle: 'Open orders',
        options: await issuesFor(env,
          `project = "${projectKey}" AND issuetype = Epic AND "${TEAM_FIELD}" = 12681 AND statusCategory != Done ORDER BY updated DESC`,
          { next: 'epic' }),
      };
    }

    if (branch === 'service') {
      if (!tail.length) {
        return {
          title: `${projectKey} service`,
          options: [
            { id: 'psc', label: 'Support and contract work', sublabel: 'PSCs, snags and the maintenance contract', next: `customer:${region}:${projectKey}:service:psc` },
            { id: 'orders', label: 'Service orders', sublabel: 'Quoted service jobs', next: `customer:${region}:${projectKey}:service:orders` },
          ],
        };
      }
      if (tail[0] === 'orders') {
        return {
          title: `${projectKey} service orders`,
          options: await issuesFor(env,
            `project = "${projectKey}" AND issuetype = Epic AND "${TEAM_FIELD}" = 12680 AND statusCategory != Done ORDER BY updated DESC`,
            { next: 'epic' }),
        };
      }
      const contracts = await issuesFor(env, `project = "${projectKey}" AND issuetype = "Service Contract" ORDER BY created DESC`, { limit: 5 });
      const open = await issuesFor(env,
        `project = "${projectKey}" AND issuetype in (${quoted(PSC_TYPES)}) AND status not in (${quoted(PSC_CLOSED)}) ORDER BY updated DESC`);
      return {
        title: `${projectKey} support`,
        subtitle: open.length ? 'Open items and the contract' : 'No open items, so log against the contract',
        options: [...open, ...contracts],
        canCreatePsc: { projectKey },
      };
    }
  }

  // An order: its categories, then the stages underneath.
  if (head === 'epic') {
    const epicKey = rest[0];
    const children = await issuesFor(env, `parent = "${epicKey}" ORDER BY summary ASC`, { next: 'parent' });
    const epic = (await searchJql(env, `key = "${epicKey}"`, LIST_FIELDS))[0];
    return {
      title: epicKey,
      subtitle: children.length ? 'Pick the part you worked on' : 'No breakdown on this order',
      options: [...children, ...(epic ? [{ ...asOption(epic), sublabel: 'The order itself' }] : [])],
    };
  }

  if (head === 'parent') {
    const parentKey = rest[0];
    const children = await issuesFor(env, `parent = "${parentKey}" ORDER BY summary ASC`);
    const parent = (await searchJql(env, `key = "${parentKey}"`, LIST_FIELDS))[0];
    return {
      title: parentKey,
      subtitle: children.length ? 'Pick the stage you worked on' : 'No stages on this item',
      options: [...children, ...(parent ? [{ ...asOption(parent), sublabel: 'The category itself' }] : [])],
      flaggable: parent ? { issueKey: parentKey, summary: parent.fields?.summary || '' } : null,
    };
  }

  throw new Error('Unknown step.');
}

// The two shortcuts that skip the tree: what you logged against lately, and
// what Jira says is yours.
export async function shortcuts(env, accountId) {
  const { results } = await env.DB.prepare(
    `SELECT j.issue_key, j.summary, MAX(l.work_date) AS last_used
       FROM xp_ledger l JOIN jobs j ON j.issue_id = l.issue_id
      WHERE l.account_id = ? GROUP BY l.issue_id ORDER BY last_used DESC LIMIT 8`
  ).bind(accountId).all();

  let assigned = [];
  try {
    assigned = await issuesFor(env, `assignee = "${accountId}" AND statusCategory != Done ORDER BY updated DESC`, { limit: 15 });
  } catch (err) {
    console.warn('Assigned lookup failed:', err.message);
  }

  const recentKeys = results.map((r) => r.issue_key).filter(Boolean);
  const recent = recentKeys.length
    ? await issuesFor(env, `key in (${quoted(recentKeys)})`, { limit: 8 })
    : [];
  return { recent, assigned };
}

export async function search(env, query) {
  const q = String(query || '').trim();
  if (q.length < 2) return { options: [] };
  const isKey = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(q);
  const jql = isKey
    ? `key = "${q.toUpperCase()}"`
    : `summary ~ "${q.replace(/["\\]/g, '')}" AND statusCategory != Done ORDER BY updated DESC`;
  try {
    return { options: await issuesFor(env, jql, { limit: 25 }) };
  } catch (err) {
    return { options: [], error: 'No match for that. Check the key, or try a word from the summary.' };
  }
}

// What this kind of stage usually takes, from finished work.
export async function stageHint(env, issueKey) {
  const issue = (await searchJql(env, `key = "${issueKey}"`, ['summary', 'parent']))[0];
  if (!issue) return null;
  const name = stageNameOf(issue.fields?.summary, issue.key);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS times, AVG(actual_seconds) / 3600.0 AS mean_hours
       FROM completed_jobs WHERE kind = 'stage' AND stage_name = ? AND actual_seconds > 0`
  ).bind(name).first();
  if (!row || row.times < 2) return null;
  return { stage: name, times: row.times, typicalHours: row.mean_hours };
}

// ---------- Writing the worklog ----------

export async function createWorklog(env, viewer, { issueId, issueKey, seconds, date, startTime, description }) {
  if (!viewer.accountId) throw new Error("Your account isn't linked to an engineer profile yet.");
  if (!issueId) throw new Error('Choose something to log against.');
  const secs = Math.round(Number(seconds));
  if (!Number.isFinite(secs) || secs < 60) throw new Error('Log at least a minute.');
  if (secs > 16 * 3600) throw new Error('That is more than 16 hours. Split it across days instead.');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : londonDate();
  if (day > londonDate()) throw new Error("You can't log time in the future.");

  const res = await fetch(`${TEMPO}/worklogs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TEMPO_API_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      issueId: Number(issueId),
      // Always the signed-in person: nobody can log time as someone else.
      authorAccountId: viewer.accountId,
      timeSpentSeconds: secs,
      startDate: day,
      startTime: /^\d{2}:\d{2}(:\d{2})?$/.test(startTime || '') ? (startTime.length === 5 ? `${startTime}:00` : startTime) : '09:00:00',
      description: String(description || '').slice(0, 500) || 'Logged from Promtek Hub',
    }),
  });
  if (!res.ok) throw new Error(`Tempo wouldn't accept that (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const worklog = await res.json();
  return { worklogId: String(worklog.tempoWorklogId), issueKey, seconds: secs, date: day };
}

// Engineers can raise service items, and nothing else.
export async function createPsc(env, viewer, { projectKey, issueType, summary, description }) {
  if (!PSC_TYPES.includes(issueType)) throw new Error('Choose a service item type.');
  if (!projectKey || !String(summary || '').trim()) throw new Error('A project and a summary are needed.');

  const created = await jira(env, '/rest/api/3/issue', {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        issuetype: { name: issueType },
        summary: String(summary).slice(0, 250),
        assignee: { id: viewer.accountId },
        description: {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: String(description || 'Raised from Promtek Hub.').slice(0, 2000) }] }],
        },
      },
    }),
  });
  return { key: created.key, id: String(created.id) };
}

// Tells the team lead a stage may be missing, without creating anything.
export async function flagMissingStage(env, viewer, { issueKey, summary, note }) {
  await raiseAlert(env, {
    kind: 'missing-stage',
    dedupe: `missing-stage:${issueKey}:${viewer.accountId}:${londonDate()}`,
    subject: `Possible missing stage on ${issueKey}`,
    body: `${viewer.employee?.name || viewer.email} logged time against ${issueKey} (${summary}) because no stage matched the work.\n\n`
      + `What they did: ${String(note || 'Not described').slice(0, 500)}\n\n`
      + 'Worth checking whether the quote missed a stage.',
  });
  return { ok: true };
}
