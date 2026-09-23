// Minimal Tempo REST client (API v4).
const TEMPO = 'https://api.tempo.io/4';
const MAX_PAGES = 20;

function normalise(wl) {
  return {
    id: String(wl.tempoWorklogId),
    accountId: wl.author?.accountId || wl.worker?.accountId || null,
    issueId: wl.issue?.id != null ? String(wl.issue.id) : null,
    seconds: Number(wl.timeSpentSeconds) || 0,
    startDate: wl.startDate,
    loggedAt: wl.createdAt || null,
    description: wl.description || '',
  };
}

// query: { updatedFrom: '2026-09-22T09:00:00Z' } or { from: '2026-09-22', to: '2026-09-22' }
export async function fetchWorklogs(env, query) {
  const params = new URLSearchParams({ limit: '1000', ...query });
  let next = `${TEMPO}/worklogs?${params}`;
  const out = [];
  let pages = 0;
  while (next && pages < MAX_PAGES) {
    pages++;
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${env.TEMPO_API_TOKEN}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Tempo ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    out.push(...(data.results || []).map(normalise));
    next = data.metadata?.next || null;
  }
  if (next) throw new Error('Tempo returned more results than expected for one sync; nothing was changed.');
  return out;
}
