// Adds whoever logs time on a Jira item to its "Promtek Staff Involved" field.
// New worklogs are noted as Tempo syncs, and a scheduled job writes them to Jira
// a few at a time. Jira's "add" keeps everyone already in the field.
import { jira, blockedForLookup } from './jira.js';

export const STAFF_FIELD = 'customfield_14523';
const PER_RUN = 20;               // on its own turn, of the 50 outside calls a scheduled run may make
export const EVERY_RUN = 5;       // every run, straight after Tempo, so new time goes through within minutes
const MAX_TRIES = 10;
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_CAP_MS = 6 * 3600 * 1000;

const projectOf = (key) => String(key || '').split('-')[0].toUpperCase();

// Statements that note each person and item once. An item in a project the hub
// leaves alone isn't noted at all.
export function noteStatements(env, pairs) {
  const now = new Date().toISOString();
  const seen = new Set();
  const stmts = [];
  for (const { issueId, accountId, issueKey } of pairs) {
    if (!issueId || !accountId) continue;
    if (issueKey && blockedForLookup(projectOf(issueKey))) continue;
    const k = `${issueId}|${accountId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    stmts.push(env.DB.prepare(
      `INSERT INTO staff_involved (issue_id, account_id, issue_key, queued_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(issue_id, account_id) DO NOTHING`
    ).bind(String(issueId), accountId, issueKey || null, now));
  }
  return stmts;
}

const retryIn = (tries) => Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 3 ** (tries - 1));

export async function run(env, { raiseAlert, londonDate, limit = PER_RUN }) {
  const now = Date.now();
  const { results: due } = await env.DB.prepare(
    `SELECT issue_id, account_id, issue_key, tries FROM staff_involved WHERE status = 'pending' AND next_at <= ? LIMIT ${Math.min(PER_RUN, Math.max(1, Number(limit) || 1))}`
  ).bind(now).all();
  if (!due.length) return { idle: true };

  let added = 0;
  const failed = [];
  for (const row of due) {
    const target = row.issue_key || row.issue_id;
    try {
      await jira(env, `/rest/api/3/issue/${encodeURIComponent(target)}`, {
        method: 'PUT',
        body: JSON.stringify({ update: { [STAFF_FIELD]: [{ add: { accountId: row.account_id } }] } }),
      });
      await env.DB.prepare(`UPDATE staff_involved SET status = 'done', error = NULL, done_at = ? WHERE issue_id = ? AND account_id = ?`)
        .bind(new Date().toISOString(), row.issue_id, row.account_id).run();
      added++;
    } catch (err) {
      // A deleted item can't take anyone, so it's let go.
      const gone = err.status === 404;
      const tries = row.tries + 1;
      const giveUp = gone || tries >= MAX_TRIES;
      const message = String(err.message || err).slice(0, 500);
      await env.DB.prepare('UPDATE staff_involved SET status = ?, tries = ?, error = ?, next_at = ? WHERE issue_id = ? AND account_id = ?')
        .bind(giveUp ? (gone ? 'gone' : 'failed') : 'pending', tries, message, now + retryIn(tries), row.issue_id, row.account_id).run();
      if (!gone) failed.push({ target, account: row.account_id, message, giveUp });
    }
  }

  if (failed.length) {
    const day = londonDate();
    const first = failed[0];
    await raiseAlert(env, {
      kind: 'staff-involved',
      dedupe: `staff-involved:${day}`,
      subject: 'Promtek Staff Involved could not be updated in Jira',
      body: `Jira refused to add someone who logged time to Promtek Staff Involved (${STAFF_FIELD}) on ${first.target}:\n\n  ${first.message}\n\n`
        + 'The field needs to be on the edit screen of the issue type, and the hub\'s Jira account needs permission to edit it. '
        + `Each one is tried again later, up to ${MAX_TRIES} times, so they go through once Jira allows it.`
        + (failed.some((f) => f.giveUp) ? '\n\nSome have now been tried too many times and won\'t be tried again.' : ''),
    });
  }
  return { added, failed: failed.length };
}
