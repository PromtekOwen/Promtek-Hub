// Jira items with a special meaning in the hub, found by key and their IDs kept once found.
// PMB-1 is lunch and breaks: not working time, so it never counts towards anyone's hours.
// PMB-25 is time off in lieu.
import { getIssue } from './jira.js';

export const LUNCH_KEY = 'PMB-1';
export const TOIL_KEY = 'PMB-25';

export async function issueIdOf(env, key, stateKey = `issue_id:${key}`) {
  const saved = await env.DB.prepare('SELECT value FROM sync_state WHERE key = ?').bind(stateKey).first().catch(() => null);
  if (saved?.value) return saved.value;
  const cached = await env.DB.prepare('SELECT issue_id FROM jobs WHERE issue_key = ?').bind(key).first().catch(() => null);
  let id = cached?.issue_id || null;
  if (!id) id = (await getIssue(env, key, ['summary']).catch(() => null))?.id || null;
  if (id) {
    await env.DB.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(stateKey, String(id)).run().catch(() => {});
  }
  return id ? String(id) : null;
}

export const lunchIssueId = (env) => issueIdOf(env, LUNCH_KEY);
