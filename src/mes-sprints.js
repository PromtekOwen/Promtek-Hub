// Each Condor release has its own board in Jira and three sprints, which the
// team works from. The hub makes them from triage and places each ticket in the
// sprint its plan starts in. A board or sprints made by hand are used as they are.
import { jira } from './jira.js';
import { versions, canTriage } from './mes.js';
import { londonDate } from './sync.js';

const PROJECT = 'MES';
const SPRINTS_PER_RELEASE = 3;
const MOVE_BATCH = 50;                 // Jira moves at most 50 issues into a sprint per call

const boardName = (release) => `${release} Release`;
const sprintName = (release, n) => `${release} Sprint ${n}`;
const dayMs = 86_400_000;
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

async function projectId(env) {
  return String((await jira(env, `/rest/api/3/project/${PROJECT}`)).id);
}

export async function createRelease(env, viewer, input) {
  if (!canTriage(viewer)) throw new Error('A Condor lead, management or an admin starts a release.');
  const name = String(input.name || '').trim().slice(0, 100);
  if (!name) throw new Error('Give the release a name.');
  if (!isDate(input.startDate) || !isDate(input.releaseDate)) throw new Error('Give the release a start date and a release date.');
  if (input.releaseDate <= input.startDate) throw new Error('The release date needs to be after the start date.');
  if ((await versions(env)).some((v) => v.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already an open release called ${name}.`);
  const v = await jira(env, '/rest/api/3/version', {
    method: 'POST',
    body: JSON.stringify({ name, projectId: Number(await projectId(env)), startDate: input.startDate, releaseDate: input.releaseDate, released: false }),
  });
  return { id: String(v.id), name: v.name, startDate: v.startDate, releaseDate: v.releaseDate };
}

// A board is the release's if its name contains the release's name.
async function findBoard(env, release) {
  const data = await jira(env, `/rest/agile/1.0/board?projectKeyOrId=${PROJECT}&type=scrum&maxResults=50`);
  const want = release.toLowerCase();
  return (data.values || []).find((b) => String(b.name).toLowerCase().includes(want)) || null;
}

// Its Backlog shows the release's tickets plus everything in MES not yet in a release,
// the way the team already works from it.
async function createBoard(env, version) {
  const pid = await projectId(env);
  const jql = `project = ${PROJECT} AND (fixVersion = ${version.id} OR fixVersion is EMPTY) AND statusCategory != Done ORDER BY Rank ASC`;
  const filter = await jira(env, '/rest/api/3/filter', {
    method: 'POST',
    body: JSON.stringify({ name: boardName(version.name), jql, sharePermissions: [{ type: 'project', project: { id: pid } }] }),
  });
  const board = await jira(env, '/rest/agile/1.0/board', {
    method: 'POST',
    body: JSON.stringify({ name: boardName(version.name), type: 'scrum', filterId: Number(filter.id) }),
  });
  return { board, filterId: String(filter.id) };
}

async function boardSprints(env, boardId) {
  const data = await jira(env, `/rest/agile/1.0/board/${boardId}/sprint?state=future,active,closed&maxResults=50`);
  return (data.values || [])
    .map((s) => ({ id: String(s.id), name: s.name, state: s.state, start: (s.startDate || '').slice(0, 10) || null, end: (s.endDate || '').slice(0, 10) || null }))
    .sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999') || Number(a.id) - Number(b.id));
}

// Three sprints splitting the release's dates into thirds, each ending on a
// Friday and the next starting the Monday after.
export function sprintWindows(start, release, count = SPRINTS_PER_RELEASE) {
  const a = Date.parse(`${start}T00:00:00Z`);
  const days = Math.round((Date.parse(`${release}T00:00:00Z`) - a) / dayMs) + 1;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const out = [];
  let from = a;
  for (let i = 0; i < count; i++) {
    let to = a + (Math.round(((i + 1) * days) / count) - 1) * dayMs;
    if (i < count - 1) {
      while (new Date(to).getUTCDay() !== 5) to -= dayMs;          // back to Friday
      if (to < from) to = from;
    } else to = Date.parse(`${release}T00:00:00Z`);
    out.push({ start: iso(from), end: iso(to) });
    from = to + dayMs;
    while ([0, 6].includes(new Date(from).getUTCDay())) from += dayMs; // on to Monday
  }
  return out;
}

// Finds or makes the release's board and sprints, and remembers them.
export async function ensureRelease(env, viewer, versionId) {
  const version = (await versions(env)).find((v) => v.id === String(versionId));
  if (!version) throw new Error('That release is no longer open in Jira.');
  const start = version.startDate || londonDate();
  if (!version.releaseDate) throw new Error(`${version.name} needs a release date in Jira before its sprints can be made.`);
  let board = await findBoard(env, version.name);
  let filterId = null;
  if (!board) ({ board, filterId } = await createBoard(env, version));
  let sprints = await boardSprints(env, board.id);
  if (!sprints.length) {
    for (const [i, w] of sprintWindows(start, version.releaseDate).entries()) {
      const s = await jira(env, '/rest/agile/1.0/sprint', {
        method: 'POST',
        body: JSON.stringify({ name: sprintName(version.name, i + 1), originBoardId: Number(board.id),
          startDate: `${w.start}T09:00:00.000Z`, endDate: `${w.end}T17:00:00.000Z` }),
      });
      sprints.push({ id: String(s.id), name: s.name, state: 'future', start: w.start, end: w.end });
    }
  }
  await env.DB.prepare(
    `INSERT INTO mes_releases (version_id, version_name, board_id, filter_id, sprints, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version_id) DO UPDATE SET version_name = excluded.version_name, board_id = excluded.board_id,
       filter_id = COALESCE(excluded.filter_id, mes_releases.filter_id), sprints = excluded.sprints, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at, error = NULL`
  ).bind(version.id, version.name, String(board.id), filterId, JSON.stringify(sprints), viewer?.email || null, new Date().toISOString()).run();
  return { version, board: { id: String(board.id), name: board.name, created: Boolean(filterId) }, sprints };
}

export async function knownSprints(env, versionId) {
  const r = await env.DB.prepare('SELECT * FROM mes_releases WHERE version_id = ?').bind(String(versionId)).first();
  return r ? { boardId: r.board_id, sprints: JSON.parse(r.sprints || '[]') } : null;
}

// The sprint a ticket belongs in: the one its planned start falls in.
export function sprintFor(sprints, startDate) {
  const dated = sprints.filter((s) => s.start && s.end);
  if (!dated.length || !startDate) return sprints.find((s) => s.state !== 'closed') || null;
  const hit = dated.find((s) => startDate >= s.start && startDate <= s.end);
  if (hit) return hit;
  return startDate < dated[0].start ? dated[0] : dated[dated.length - 1];
}

async function sprintMembers(env, sprintId) {
  const keys = new Set();
  let startAt = 0;
  for (let page = 0; page < 10; page++) {
    const data = await jira(env, `/rest/agile/1.0/sprint/${sprintId}/issue?fields=summary&maxResults=100&startAt=${startAt}`);
    for (const i of data.issues || []) keys.add(i.key);
    startAt += (data.issues || []).length;
    if (!data.issues?.length || startAt >= (data.total || 0)) break;
  }
  return keys;
}

// Puts each planned ticket in its sprint. Anything already in a sprint that has
// started or finished stays where it is; only future sprints are rearranged.
export async function placeTickets(env, versionId, schedule) {
  const known = await knownSprints(env, versionId);
  if (!known?.sprints?.length) return { moved: 0, skipped: 'No sprints yet' };
  const members = new Map();
  for (const s of known.sprints) members.set(s.id, await sprintMembers(env, s.id));
  const where = new Map();
  for (const [id, keys] of members) for (const k of keys) where.set(k, id);
  const state = new Map(known.sprints.map((s) => [s.id, s.state]));
  const moves = new Map();
  for (const t of schedule.filter((x) => x.fits && x.start)) {
    const target = sprintFor(known.sprints, t.start);
    if (!target || target.state === 'closed') continue;
    const current = where.get(t.key);
    if (current && state.get(current) !== 'future') continue;
    if (current === target.id) continue;
    if (!moves.has(target.id)) moves.set(target.id, []);
    moves.get(target.id).push(t.key);
  }
  let moved = 0;
  for (const [sprintId, keys] of moves) {
    for (let i = 0; i < keys.length; i += MOVE_BATCH) {
      const part = keys.slice(i, i + MOVE_BATCH);
      await jira(env, `/rest/agile/1.0/sprint/${sprintId}/issue`, { method: 'POST', body: JSON.stringify({ issues: part }) });
      moved += part.length;
    }
  }
  return { moved, sprints: known.sprints.map((s) => ({ ...s, tickets: [...(members.get(s.id) || [])].length })) };
}
