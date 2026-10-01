// Active jobs, difficulty disputes and estimate alerts. The quoted difficulty
// is never overwritten: each approved dispute is kept alongside it, so quoting
// can learn where jobs turned out harder than they looked.
import { searchJql, getIssue, jira } from './jira.js';
import { ALL_FIELDS, categoryRows, customerFilter, disciplineOf, isDone } from './jobs.js';
import { raiseAlert, recalcIssues, getState, setState, sendAlerts } from './sync.js';
import { weightedScore, jobEloFromScore } from './progression.js';

export const DISPUTE_REASONS = [
  'Scope grew', 'Spec was unclear or wrong', 'Kit faulty or obsolete', 'Customer delays',
  'Third-party delays', 'Site access or conditions', 'More testing than expected', 'Something else',
];
const TEAMS_ALERTED = ['Projecting', 'Service'];
const SCORE_KEYS = ['tech', 'scope', 'risk', 'dep'];

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
const hoursText = (s) => `${Math.round((s || 0) / 360) / 10}h`;

// Every open order in the customer projects, with its categories.
export async function activeCategories(env) {
  const epics = await searchJql(env, `${customerFilter} AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC`,
    ALL_FIELDS, { limit: 300 });
  const byId = new Map(epics.map((e) => [String(e.id), e]));
  const out = [];
  for (const part of chunk(epics.map((e) => e.key), 50)) {
    const cats = await searchJql(env, `parent in (${part.join(',')}) AND issuetype not in subTaskIssueTypes()`, ALL_FIELDS);
    for (const category of cats) {
      if (!disciplineOf(category)) continue;
      const epic = byId.get(String(category.fields?.parent?.id));
      if (!epic) continue;
      const [row] = categoryRows({ epic, category, categoryStages: [] });
      out.push({ ...row, done: isDone(category), order_summary: epic.fields?.summary || '' });
    }
  }
  return out;
}

async function overridesFor(env, ids) {
  const map = new Map();
  for (const part of chunk(ids, 80)) {
    if (!part.length) continue;
    const { results } = await env.DB.prepare(
      `SELECT * FROM job_overrides WHERE category_id IN (${part.map(() => '?').join(',')})`
    ).bind(...part).all();
    for (const r of results) map.set(r.category_id, r);
  }
  return map;
}

export async function listActive(env, viewer, { scope = 'mine' } = {}) {
  const cats = await activeCategories(env);
  const ids = cats.map((c) => c.issue_id);
  const overrides = await overridesFor(env, ids);
  const { results: pending } = await env.DB.prepare(
    "SELECT category_id, account_id FROM job_disputes WHERE status = 'pending'"
  ).all();
  const pendingBy = new Map(pending.map((p) => [p.category_id, p.account_id]));

  // Logged against the category itself, or against one of its stages.
  const mine = new Set();
  if (viewer.accountId) {
    const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT l.issue_id, j.parent_id FROM xp_ledger l LEFT JOIN jobs j ON j.issue_id = l.issue_id
        WHERE l.account_id = ? AND l.work_date >= ?`
    ).bind(viewer.accountId, since).all();
    for (const r of results) { mine.add(String(r.issue_id)); if (r.parent_id) mine.add(String(r.parent_id)); }
  }

  const orders = new Map();
  for (const c of cats) {
    const isMine = mine.has(c.issue_id);
    if (scope === 'mine' && !isMine) continue;
    if (scope === 'team' && c.team !== viewer.team) continue;
    const o = overrides.get(c.issue_id);
    const estimate = o?.estimate_seconds ?? c.estimate_seconds;
    if (!orders.has(c.epic_key)) {
      orders.set(c.epic_key, { key: c.epic_key, summary: c.order_summary, customer: c.project_name, team: c.team, categories: [] });
    }
    orders.get(c.epic_key).categories.push({
      id: c.issue_id, key: c.issue_key, summary: c.summary, discipline: c.discipline, status: c.status, done: c.done,
      jobElo: o?.job_elo ?? c.job_elo ?? jobEloFromScore(c.weighted_score), quotedElo: c.job_elo ?? jobEloFromScore(c.weighted_score),
      estimateSeconds: estimate, quotedEstimateSeconds: c.estimate_seconds, loggedSeconds: c.actual_seconds,
      pct: estimate ? c.actual_seconds / estimate : null, mine: isMine, disputed: Boolean(o),
      pendingDispute: pendingBy.has(c.issue_id), pendingIsMine: pendingBy.get(c.issue_id) === viewer.accountId,
    });
  }
  return { scope, orders: [...orders.values()], reasons: DISPUTE_REASONS };
}

// What the dispute form needs: the scores as quoted, and as they stand now.
export async function categoryDetail(env, categoryId) {
  const category = await getIssue(env, categoryId, ALL_FIELDS);
  if (!category || !disciplineOf(category)) throw new Error('That category could not be found in Jira.');
  const epicId = category.fields?.parent?.id;
  const epic = epicId ? await getIssue(env, epicId, ALL_FIELDS) : null;
  if (!epic) throw new Error('That category has no order above it in Jira.');
  const [row] = categoryRows({ epic, category, categoryStages: [] });
  const override = (await overridesFor(env, [String(category.id)])).get(String(category.id));
  const { results: history } = await env.DB.prepare(
    `SELECT d.*, e.name AS raised_by FROM job_disputes d LEFT JOIN employees e ON e.account_id = d.account_id
      WHERE d.category_id = ? ORDER BY d.id DESC`
  ).bind(String(category.id)).all();
  const latest = history.find((d) => d.status === 'approved');
  const current = latest
    ? { tech: latest.approved_tech, scope: latest.approved_scope, risk: latest.approved_risk, dep: latest.approved_dep }
    : { tech: row.score_tech, scope: row.score_scope, risk: row.score_risk, dep: row.score_dep };
  return {
    id: row.issue_id, key: row.issue_key, summary: row.summary, discipline: row.discipline, team: row.team,
    epicKey: row.epic_key, orderSummary: epic.fields?.summary || '', customer: row.project_name,
    quoted: { tech: row.score_tech, scope: row.score_scope, risk: row.score_risk, dep: row.score_dep,
      elo: row.job_elo ?? jobEloFromScore(row.weighted_score), estimateSeconds: row.estimate_seconds },
    current: { ...current, elo: override?.job_elo ?? row.job_elo ?? jobEloFromScore(row.weighted_score),
      estimateSeconds: override?.estimate_seconds ?? row.estimate_seconds },
    loggedSeconds: row.actual_seconds,
    reasons: DISPUTE_REASONS,
    history,
  };
}

const cleanScores = (scores) => {
  const out = {};
  for (const k of SCORE_KEYS) {
    const v = Number(scores?.[k]);
    if (!(v >= 1 && v <= 5)) throw new Error('Choose a score from 1 to 5 for each of the four areas.');
    out[k] = Math.round(v * 2) / 2;
  }
  return out;
};
const cleanHours = (h) => {
  if (h === '' || h == null) return null;
  const v = Number(h);
  if (!(v > 0 && v < 10000)) throw new Error('The estimate needs to be a number of hours.');
  return Math.round(v * 3600);
};

async function leadEmails(env, team) {
  const { results } = await env.DB.prepare(
    "SELECT email FROM employees WHERE active = 1 AND role = 'lead' AND email IS NOT NULL AND (team = ? OR ? IS NULL)"
  ).bind(team, team).all();
  return results.map((r) => r.email);
}

// Alerts each lead for the team, or the general alert address when there are none.
async function alertLeads(env, team, { kind, dedupe, subject, body }) {
  const emails = await leadEmails(env, team);
  if (!emails.length) return raiseAlert(env, { kind, dedupe, subject, body });
  for (const email of emails) await raiseAlert(env, { kind, dedupe: `${dedupe}:${email}`, subject, body, recipient: email });
}

export async function raiseDispute(env, viewer, input) {
  if (!viewer.accountId) throw new Error('Your account isn\'t linked to a profile yet.');
  const comment = String(input.comment || '').trim().slice(0, 2000);
  if (comment.length < 10) throw new Error('Say a little about why, so your team lead can see what changed.');
  const scores = cleanScores(input.scores);
  const estimate = cleanHours(input.estimateHours);
  const reasons = (Array.isArray(input.reasons) ? input.reasons : []).filter((r) => DISPUTE_REASONS.includes(r));
  const detail = await categoryDetail(env, input.categoryId);
  const open = detail.history.find((d) => d.status === 'pending');
  if (open) throw new Error('There is already a dispute waiting on this category.');

  const proposedElo = jobEloFromScore(weightedScore(scores));
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO job_disputes (category_id, category_key, epic_key, summary, order_summary, discipline, team, account_id, status,
       reasons, comment, quoted_tech, quoted_scope, quoted_risk, quoted_dep, quoted_elo, quoted_estimate_seconds,
       before_elo, before_estimate_seconds, proposed_tech, proposed_scope, proposed_risk, proposed_dep, proposed_elo,
       proposed_estimate_seconds, logged_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(detail.id, detail.key, detail.epicKey, detail.summary, detail.orderSummary, detail.discipline, detail.team,
    viewer.accountId, JSON.stringify(reasons), comment, detail.quoted.tech, detail.quoted.scope, detail.quoted.risk,
    detail.quoted.dep, detail.quoted.elo, detail.quoted.estimateSeconds, detail.current.elo, detail.current.estimateSeconds,
    scores.tech, scores.scope, scores.risk, scores.dep, proposedElo, estimate, detail.loggedSeconds, now).run();

  const name = viewer.employee?.name || viewer.email;
  await alertLeads(env, detail.team, {
    kind: 'dispute',
    dedupe: `dispute:${res.meta?.last_row_id ?? `${detail.id}:${now}`}`,
    subject: `${name} has disputed the difficulty of ${detail.key}`,
    body: `${name} thinks ${detail.key} (${detail.summary}) on ${detail.epicKey}, ${detail.orderSummary}, is harder than quoted.\n\n`
      + `Job ELO ${Math.round(detail.current.elo || 0)} would become ${Math.round(proposedElo)}.`
      + (estimate ? ` They suggest ${hoursText(estimate)} instead of ${hoursText(detail.current.estimateSeconds)}.` : '')
      + `\n${hoursText(detail.loggedSeconds)} logged so far.\n\n`
      + (reasons.length ? `What changed: ${reasons.join(', ')}.\n\n` : '')
      + `In their words:\n${comment}\n\nOpen Jobs in the hub to approve, adjust or decline it.`,
  });
  await sendAlerts(env).catch(() => {});
  return { ok: true, proposedElo };
}

export async function withdrawDispute(env, viewer, id) {
  const d = await env.DB.prepare('SELECT * FROM job_disputes WHERE id = ?').bind(Number(id)).first();
  if (!d || d.account_id !== viewer.accountId) throw new Error('That dispute isn\'t yours to withdraw.');
  if (d.status !== 'pending') throw new Error('That dispute has already been decided.');
  await env.DB.prepare("UPDATE job_disputes SET status = 'withdrawn', decided_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), d.id).run();
  return { ok: true };
}

export function canDecideDispute(viewer, dispute) {
  if (dispute.account_id === viewer.accountId) return false;
  if (viewer.isAdmin) return true;
  return viewer.role === 'lead' && (!dispute.team || dispute.team === viewer.team);
}

export async function pendingDisputes(env, viewer) {
  if (!viewer.isLead) return [];
  const { results } = await env.DB.prepare(
    `SELECT d.*, e.name AS raised_by FROM job_disputes d LEFT JOIN employees e ON e.account_id = d.account_id
      WHERE d.status = 'pending' ORDER BY d.id`
  ).all();
  return results.filter((d) => canDecideDispute(viewer, d)).map((d) => ({ ...d, reasons: JSON.parse(d.reasons || '[]') }));
}

export async function decideDispute(env, viewer, input) {
  const d = await env.DB.prepare('SELECT * FROM job_disputes WHERE id = ?').bind(Number(input.id)).first();
  if (!d) throw new Error('That dispute has gone.');
  if (!canDecideDispute(viewer, d)) throw new Error('Only a team lead for this job, other than the person who raised it, can decide this.');
  if (d.status !== 'pending') throw new Error('That dispute has already been decided.');
  const note = String(input.note || '').trim().slice(0, 1000) || null;
  const now = new Date().toISOString();

  if (input.decision === 'decline') {
    await env.DB.prepare("UPDATE job_disputes SET status = 'declined', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?")
      .bind(viewer.email, now, note, d.id).run();
    return { ok: true, status: 'declined' };
  }
  if (input.decision !== 'approve') throw new Error('Approve or decline it.');

  const scores = cleanScores(input.scores || { tech: d.proposed_tech, scope: d.proposed_scope, risk: d.proposed_risk, dep: d.proposed_dep });
  const estimate = input.estimateHours !== undefined ? cleanHours(input.estimateHours) : d.proposed_estimate_seconds;
  const elo = jobEloFromScore(weightedScore(scores));
  const estimateSeconds = estimate ?? d.before_estimate_seconds;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE job_disputes SET status = 'approved', approved_tech = ?, approved_scope = ?, approved_risk = ?, approved_dep = ?,
         approved_elo = ?, approved_estimate_seconds = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`
    ).bind(scores.tech, scores.scope, scores.risk, scores.dep, elo, estimateSeconds, viewer.email, now, note, d.id),
    env.DB.prepare(
      `INSERT INTO job_overrides (category_id, category_key, job_elo, estimate_seconds, dispute_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(category_id) DO UPDATE SET job_elo = excluded.job_elo, estimate_seconds = excluded.estimate_seconds,
         dispute_id = excluded.dispute_id, updated_at = excluded.updated_at`
    ).bind(d.category_id, d.category_key, elo, estimateSeconds, d.id, now),
    // Estimate alerts start again against the new estimate.
    env.DB.prepare('DELETE FROM estimate_flags WHERE category_id = ?').bind(d.category_id),
  ]);

  const recalculated = await recalcCategory(env, d);
  const synced = await syncDisputeToJira(env, d.id);
  return { ok: true, status: 'approved', elo, estimateSeconds, recalculated, jiraSynced: synced };
}

// The job was always this hard, so XP already earned on it is recalculated.
// A failure is queued and retried hourly rather than lost.
async function recalcCategory(env, d) {
  try {
    const children = await searchJql(env, `parent = ${d.category_key}`, ['summary']);
    const { results: cached } = await env.DB.prepare('SELECT issue_id FROM jobs WHERE parent_id = ?').bind(d.category_id).all();
    const ids = [d.category_id, ...children.map((c) => String(c.id)), ...cached.map((c) => c.issue_id)];
    const { changed } = await recalcIssues(env, ids);
    await dequeueRecalc(env, d.id);
    return changed;
  } catch (err) {
    const queue = await recalcQueue(env);
    if (!queue.includes(d.id)) await setState(env, 'dispute_recalc', [...queue, d.id].join(','));
    await raiseAlert(env, { kind: 'dispute-xp', dedupe: `dispute-xp:${d.id}`, subject: `XP on ${d.category_key} is waiting to be recalculated`,
      body: `The dispute on ${d.category_key} is approved, but recalculating the XP already earned on it didn't finish (${err.message.slice(0, 200)}). The hub tries again every hour.` });
    return null;
  }
}
const recalcQueue = async (env) => String((await getState(env, 'dispute_recalc')) || '').split(',').filter(Boolean).map(Number);
async function dequeueRecalc(env, id) {
  const queue = await recalcQueue(env);
  if (queue.includes(id)) await setState(env, 'dispute_recalc', queue.filter((q) => q !== id).join(','));
}

// Puts the agreed ELO on the category in Jira and leaves a comment there.
// The hub's value is what counts, so a failure only delays Jira catching up.
export async function syncDisputeToJira(env, id) {
  const d = await env.DB.prepare('SELECT d.*, e.name AS raised_by FROM job_disputes d LEFT JOIN employees e ON e.account_id = d.account_id WHERE d.id = ?')
    .bind(id).first();
  if (!d || d.status !== 'approved' || d.jira_synced) return true;
  try {
    await jira(env, `/rest/api/3/issue/${encodeURIComponent(d.category_key)}`, {
      method: 'PUT', body: JSON.stringify({ fields: { [env.FIELD_ELO]: Math.round(d.approved_elo) } }),
    });
    const text = `Difficulty agreed after a dispute from ${d.raised_by || 'an engineer'}: job ELO ${Math.round(d.before_elo || 0)} to ${Math.round(d.approved_elo)}`
      + `, estimate ${hoursText(d.approved_estimate_seconds)}. Reasons: ${JSON.parse(d.reasons || '[]').join(', ') || 'not given'}. Approved by ${d.decided_by}.`;
    await jira(env, `/rest/api/3/issue/${encodeURIComponent(d.category_key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }),
    });
    await env.DB.prepare('UPDATE job_disputes SET jira_synced = 1, jira_error = NULL WHERE id = ?').bind(id).run();
    return true;
  } catch (err) {
    await env.DB.prepare('UPDATE job_disputes SET jira_error = ? WHERE id = ?').bind(err.message.slice(0, 500), id).run();
    await alertLeads(env, d.team, {
      kind: 'dispute-jira', dedupe: `dispute-jira:${id}`,
      subject: `Jira hasn't been updated for the dispute on ${d.category_key}`,
      body: `The dispute on ${d.category_key} is approved and the hub is already using the new difficulty for XP and ELO. Jira couldn't be updated yet (${err.message.slice(0, 200)}). The hub tries again every hour.`,
    });
    return false;
  }
}

// Hourly: retries anything Jira missed, then checks time against estimates.
export async function hourly(env) {
  const { results: unsynced } = await env.DB.prepare("SELECT id FROM job_disputes WHERE status = 'approved' AND jira_synced = 0").all();
  for (const d of unsynced) await syncDisputeToJira(env, d.id);
  for (const id of await recalcQueue(env)) {
    const d = await env.DB.prepare('SELECT * FROM job_disputes WHERE id = ?').bind(id).first();
    if (d) await recalcCategory(env, d); else await dequeueRecalc(env, id);
  }
  return estimateAlerts(env);
}

export async function estimateAlerts(env) {
  const cats = (await activeCategories(env)).filter((c) => !c.done && TEAMS_ALERTED.includes(c.team));
  const overrides = await overridesFor(env, cats.map((c) => c.issue_id));
  // The first run records where everything already stands, so leads aren't
  // sent a pile of alerts about jobs they already know are over.
  const firstRun = !(await getState(env, 'estimate_alerts_since'));
  const now = new Date().toISOString();
  let raised = 0;
  for (const c of cats) {
    const estimate = overrides.get(c.issue_id)?.estimate_seconds ?? c.estimate_seconds;
    if (!estimate) continue;
    const pct = c.actual_seconds / estimate;
    for (const level of [90, 100]) {
      if (pct * 100 < level) continue;
      const res = await env.DB.prepare(
        'INSERT INTO estimate_flags (category_id, level, category_key, raised_at, silent) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
      ).bind(c.issue_id, level, c.issue_key, now, firstRun ? 1 : 0).run();
      if (firstRun || !res.meta?.changes) continue;
      raised++;
      const over = level === 100;
      await alertLeads(env, c.team, {
        kind: 'estimate', dedupe: `estimate${level}:${c.issue_id}`,
        subject: over ? `${c.issue_key} has passed its estimate` : `${c.issue_key} is at 90% of its estimate`,
        body: `${c.epic_key}, ${c.order_summary}: ${c.summary}.\n${hoursText(c.actual_seconds)} logged against ${hoursText(estimate)} estimated.\n\n`
          + (over
            ? 'It may be worth a word with the people on it about how it is going and whether they need anything.'
            : 'The people on it can see this in Jobs and can dispute the difficulty there if the estimate no longer looks right.'),
      });
    }
  }
  if (firstRun) await setState(env, 'estimate_alerts_since', now);
  return { checked: cats.length, raised };
}

