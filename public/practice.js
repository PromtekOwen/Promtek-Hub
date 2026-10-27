// Example data for the walkthroughs. While the hub is in practice mode, every
// request comes here instead of going to the server. The answers come from the
// small made-up world below, which changes as the person works through a
// walkthrough, so what they do shows up on the page as it would for real.
// Nothing here reaches Jira, Tempo, 8x8 or the hub's database.
//
// A few things are the same for everyone and safe to read, such as the survey
// layout, the vehicle check items and the company chart, so those are read from
// the hub as they are.

const READ_FROM_HUB = new Set(['/api/obs/config', '/api/obs/library', '/api/vehicles/check-schema', '/api/pow/schema', '/api/org', '/api/prefs/tiles', '/api/prefs/tours']);

// ---------- time ----------

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ago = (ms) => iso(now() - ms);
const londonDate = (ms = now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(ms));
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const mondayOf = (day) => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
const today = () => londonDate();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- the made-up world ----------

const PEOPLE = [
  { id: 'ex-sam', name: 'Sam Turner', team: 'Service', service: true },
  { id: 'ex-ellie', name: 'Ellie Morgan', team: 'Service', service: true },
  { id: 'ex-priya', name: 'Priya Shah', team: 'Projecting', service: false },
  { id: 'ex-dan', name: 'Dan Walsh', team: 'Projecting', service: false },
  { id: 'ex-tom', name: 'Tom Reid', team: 'Condor', service: false },
  { id: 'ex-amy', name: 'Amy Clarke', team: 'Condor', service: false },
];

const CUSTOMERS = [
  { key: 'NGB', name: 'Northgate Bakery', tier: 'Gold', contract: 'NGB-90', bankHoliday: true },
  { key: 'HBM', name: 'Harbour Mills', tier: 'Platinum', contract: 'HBM-40', bankHoliday: true },
  { key: 'ASF', name: 'Ashby Feeds', tier: 'Silver', contract: 'ASF-61', bankHoliday: false },
  { key: 'KWD', name: 'Kingsway Dairies', tier: null, contract: null, bankHoliday: false },
];
const customer = (key) => CUSTOMERS.find((c) => c.key === key);

// Orders, their categories and the stages under them, as Log time browses them.
const ORDERS = [
  { key: 'NGB-118', customer: 'NGB', summary: 'Line 2 recipe system upgrade', categories: [
    { key: 'NGB-119', discipline: 'software', stages: [['NGB-121', 'Software - Recipe download testing'], ['NGB-122', 'Software - FAT']] },
    { key: 'NGB-120', discipline: 'hardware', stages: [['NGB-123', 'Hardware - Panel wiring']] },
  ] },
  { key: 'HBM-204', customer: 'HBM', summary: 'Intake weigher replacement', categories: [
    { key: 'HBM-205', discipline: 'engineering', stages: [['HBM-207', 'Site - Commissioning'], ['HBM-208', 'Site - Installation']] },
    { key: 'HBM-206', discipline: 'hardware', stages: [['HBM-209', 'Hardware - Panel build']] },
  ] },
  { key: 'ASF-70', customer: 'ASF', summary: 'Bagging line controls', categories: [
    { key: 'ASF-71', discipline: 'software', stages: [['ASF-73', 'Software - HMI screens']] },
  ] },
  { key: 'KWD-30', customer: 'KWD', summary: 'Silo level monitoring', categories: [
    { key: 'KWD-31', discipline: 'engineering', stages: [['KWD-33', 'Site - Survey']] },
  ] },
];
const DISCIPLINE = { software: 'Software', hardware: 'Hardware', engineering: 'Site visit', condor: 'Condor' };
const INTERNAL = [['PMB-12', 'Training'], ['PMB-15', 'Workshop and stores'], ['PMB-18', 'Team meeting']];

let idSeq = 5000;
const nextId = () => String(++idSeq);
const issueIds = new Map();
const idOf = (key) => { if (!issueIds.has(key)) issueIds.set(key, nextId()); return issueIds.get(key); };

function stageOption(key, title, orderKey) {
  const o = ORDERS.find((x) => x.key === orderKey);
  return { label: key, title, sublabel: `${customer(o.customer).name}, ${o.summary}`, issueId: idOf(key), rate: 1, jobElo: 1180 };
}
const allStages = () => ORDERS.flatMap((o) => o.categories.flatMap((c) => c.stages.map(([k, t]) => stageOption(k, t, o.key))));
const issueTitle = (key) => allStages().find((s) => s.label === key)?.title
  || INTERNAL.find(([k]) => k === key)?.[1] || world?.psc.find((p) => p.key === key)?.summary || key;

let world = null;
let me = null;

function initWorld(real) {
  const employee = real.employee || {
    name: real.user?.email?.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'You',
    accountId: 'ex-me', team: 'Service', elo: 1150, baseline: 60,
    rank: { name: 'Kilogram I' },
    progress: { xp: 52_400, level: 214, title: 'Load Bearer', nextTitle: 'Lord of the Load', nextTitleLevel: 250, xpIntoLevel: 310, levelSpan: 640, xpToNextLevel: 330 },
  };
  const myId = employee.accountId || 'ex-me';
  me = { id: myId, name: employee.name, first: String(employee.name).split(' ')[0], user: real.user };
  const day = today(), monday = mondayOf(day);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter((d) => d <= day);
  const entry = (key, date, mins, description = '') => ({
    worklog_id: nextId(), issue_key: key, summary: issueTitle(key), work_date: date, seconds: mins * 60, description,
    job_elo: key.startsWith('PMB') ? null : 1180, engineer_elo: employee.elo ?? 1150, rate: key.startsWith('PMB') ? null : 1.03, override: null, xp: Math.round(mins * 1.03),
  });
  const worklogs = [];
  // A believable week so far, and the one before it.
  weekDays.forEach((d, i) => {
    if (i > 4) return;
    worklogs.push(entry(['NGB-122', 'HBM-209', 'ASF-73', 'NGB-123', 'HBM-208'][i], d, 240 + i * 15));
    worklogs.push(entry(i % 2 ? 'PMB-18' : 'ASF-73', d, i % 2 ? 60 : 150));
  });
  for (let i = 0; i < 5; i++) {
    const d = addDays(monday, i - 7);
    worklogs.push(entry(['HBM-208', 'HBM-208', 'NGB-121', 'NGB-122', 'PMB-12'][i], d, 300 + (i % 3) * 30));
    worklogs.push(entry(['NGB-123', 'ASF-73', 'HBM-209', 'PMB-18', 'ASF-73'][i], d, 150 + (i % 2) * 30));
  }
  world = {
    real, employee: clone(employee), worklogs,
    timer: null, stretches: [],
    modifiers: [],
    jobs: initJobs(),
    disputes: me.user?.isLead ? [{
      id: 901, raised_by: 'Dan Walsh', category_key: 'ASF-71', epic_key: 'ASF-70', order_summary: 'Bagging line controls', discipline: 'software',
      before_elo: 1150, proposed_elo: 1300, before_estimate_seconds: 24 * 3600, proposed_estimate_seconds: 32 * 3600, logged_seconds: 26 * 3600,
      reasons: ['Scope grew', 'More testing than expected'], comment: 'Ashby added a second bagging line to the HMI after the quote, and every screen needed testing on both.',
      quoted_tech: 3, quoted_scope: 2, quoted_risk: 2, quoted_dep: 2, proposed_tech: 3, proposed_scope: 4, proposed_risk: 3, proposed_dep: 2,
    }] : [],
    leadModifiers: me.user?.isLead ? [{ id: 801, name: 'Ellie Morgan', kind: 'Supporting apprentices', start_date: addDays(day, -2), end_date: addDays(day, 26) }] : [],
    quotes: initQuotes(),
    mes: initMes(),
    calls: initCalls(),
    it: [
      { key: 'IT-311', summary: 'Second monitor flickering', status: 'In progress', priority: 'Medium', assignee: 'IT support', done: false },
      { key: 'IT-298', summary: 'Licence for the label designer', status: 'Done', priority: 'Low', assignee: 'IT support', done: true },
    ],
    vehicles: initVehicles(),
    pow: [
      { id: 'pow-ex1', issue_key: 'HBM-208', customer: 'Harbour Mills', status: 'submitted', submitted_at: ago(6 * DAY) },
    ],
    obs: [
      { id: 'obs-ex1', client: 'Northgate Bakery', report_key: 'NGB-77', status: 'submitted', submitted_at: ago(20 * DAY) },
    ],
    obsSales: [
      { key: 'HBM-31', client: 'Harbour Mills', projectKey: 'HBM', surveyDate: addDays(day, -3), serviceContract: 'Platinum', siteContact: 'Rob Fenwick', survey: { id: 'obs-ex2' }, url: '#' },
    ],
    requests: [
      { id: 71, kind: 'change', tile: 'Vehicles', title: 'Show the van\'s mileage on the booking', details: 'It would help to see the mileage when booking, so the van due a service gets used for short trips.', status: 'complete', reply: 'Done, it shows under each van now.', updated_by: 'Owen Hume', created_at: ago(30 * DAY), name: me.name },
    ],
    psc: initPsc(myId),
    pscActions: [],
    eotq: initEotq(myId),
    contracts: initContracts(),
    contractFlags: initFlags(),
    // Time on contracts still needing a chargeable answer.
    contractTime: [
      { worklogId: 'pw-1', contract: 'NGB-90', kind: 'contract', key: 'NGB-90', summary: 'Time on the contract', date: addDays(day, -1), seconds: 5400, who: 'You', mine: true },
      { worklogId: 'pw-2', contract: 'NGB-90', kind: 'psc', key: 'NGB-140', summary: 'Mixer 3 weigher reading 2kg heavy', date: day, seconds: 2700, who: 'Sam Turner' },
    ],
    tiles: null,
    homeMessages: [
      { id: 9001, kind: 'alert', tone: 'important', title: 'Return the van keys to reception', body: 'The Transit keys need to be back by 5pm on Fridays so the van can be serviced.', link: '#/vehicles', from: 'Owen Hume', at: ago(2 * HOUR) },
      { id: 9002, kind: 'announcement', tone: 'info', title: 'Christmas party, Friday 19 December', body: 'Drinks from 6pm at The Swan, food at 7. Partners welcome. Let Becky know by the end of the month if you\'re coming.', link: null, from: 'Owen Hume', at: ago(DAY) },
      { id: 9003, kind: 'announcement', tone: 'info', title: 'New fire assembly point', body: 'The assembly point has moved to the far end of the car park, by the gate.', link: null, from: 'Owen Hume', at: ago(3 * DAY) },
    ],
  };
}

// ---------- the people the hub knows ----------

function meResponse() {
  const e = world.employee;
  const monday = mondayOf(today());
  const week = world.worklogs.filter((w) => w.work_date >= monday);
  const recent = [...world.worklogs].sort((a, b) => b.work_date.localeCompare(a.work_date) || Number(b.worklog_id) - Number(a.worklog_id)).slice(0, 50);
  return {
    ...world.real,
    linked: true,
    employee: { ...e, accountId: me.id, week: { xp: week.reduce((a, w) => a + w.xp, 0), seconds: week.reduce((a, w) => a + w.seconds, 0), from: monday } },
    recent,
  };
}

// ---------- Log time ----------

function browse(node) {
  if (node === 'root') {
    return { title: 'Internal or customer?', options: [
      { label: 'Customers', sublabel: 'Orders, quotes and service items', next: 'customers' },
      { label: 'Internal', sublabel: 'Training, meetings, the workshop', next: 'internal' },
    ] };
  }
  if (node === 'customers') {
    return { title: 'Which customer?', options: CUSTOMERS.map((c) => ({ label: c.name, sublabel: c.key, next: `customer:uk:${c.key}` })) };
  }
  if (node === 'internal') {
    return { title: 'Internal work', options: INTERNAL.map(([k, t]) => ({ label: k, title: t, sublabel: 'Internal', issueId: idOf(k), rate: null, jobElo: null })) };
  }
  const [kind, , key] = node.split(':');
  if (kind === 'customer') {
    const c = customer(key);
    const items = world.psc.filter((p) => p.project === key && !p.done).map((p) => ({ label: p.key, title: p.summary, sublabel: `${p.type}, ${p.status}`, issueId: p.id, rate: 1, jobElo: null }));
    return {
      title: c.name, subtitle: 'Open orders, then their service items',
      options: [...ORDERS.filter((o) => o.customer === key).map((o) => ({ label: o.key, title: o.summary, sublabel: 'Order', next: `order::${o.key}` })), ...items],
      canCreatePsc: { projectKey: key },
    };
  }
  if (kind === 'order') {
    const o = ORDERS.find((x) => x.key === key);
    return { title: `${o.key} ${o.summary}`, subtitle: 'Which part of the job?', options: o.categories.map((c) => ({ label: c.key, title: DISCIPLINE[c.discipline], sublabel: 'Category', next: `cat::${c.key}` })) };
  }
  if (kind === 'cat') {
    const o = ORDERS.find((x) => x.categories.some((c) => c.key === key));
    const c = o.categories.find((x) => x.key === key);
    return { title: `${c.key} ${DISCIPLINE[c.discipline]}`, subtitle: 'Pick the stage you worked on. Stages earn the full XP.', options: c.stages.map(([k, t]) => stageOption(k, t, o.key)) };
  }
  return { title: 'Nothing here', options: [] };
}

function search(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = [
    ...allStages(),
    ...INTERNAL.map(([k, t]) => ({ label: k, title: t, sublabel: 'Internal', issueId: idOf(k), rate: null, jobElo: null })),
    ...world.psc.filter((p) => !p.done).map((p) => ({ label: p.key, title: p.summary, sublabel: p.customer || 'PSC board', issueId: p.id, rate: 1, jobElo: null })),
  ];
  return pool.filter((o) => words.every((w) => `${o.label} ${o.title} ${o.sublabel}`.toLowerCase().includes(w))).slice(0, 12);
}

function logWorklog({ issueKey, seconds, date, description }) {
  if (!seconds || seconds < 60) throw new Error('Say how long it took.');
  const mins = Math.round(seconds / 60);
  const internal = issueKey.startsWith('PMB');
  const w = {
    worklog_id: nextId(), issue_key: issueKey, summary: issueTitle(issueKey), work_date: date || today(), seconds, description: description || '',
    job_elo: internal ? null : 1180, engineer_elo: world.employee.elo ?? 1150, rate: internal ? null : 1.03, override: null, xp: Math.round(mins * 1.03),
  };
  world.worklogs.push(w);
  world.employee.progress = { ...world.employee.progress, xp: world.employee.progress.xp + w.xp };
  return { seconds, issueKey, worklogId: w.worklog_id };
}

// ---------- the timer ----------

function trackerStatus(extra = {}) {
  const t = world.timer;
  const running = t?.current ? { ...t.current, seconds: Math.round((now() - Date.parse(t.current.startedAt)) / 1000) } : null;
  return {
    timer: t ? { job: t.job, current: running, state: t.state } : null,
    today: [...world.stretches].sort((a, b) => b.started_at.localeCompare(a.started_at)),
    assist: { team: { key: 'PMB-37', label: 'Assisting the team' }, apprentice: { key: 'PMB-39', label: 'Assisting an apprentice' } },
    serverNow: iso(now()),
    ...extra,
  };
}

// A walkthrough can't wait an hour for time to pass, so each part of it is
// pretended to have run for a while: the job from 90 minutes ago, and so on.
function endStretch(cur, at) {
  const seconds = Math.round((at - Date.parse(cur.startedAt)) / 1000);
  const row = { id: nextId(), issue_key: cur.issueKey, kind: cur.kind, started_at: cur.startedAt, ended_at: iso(at), seconds, status: seconds < 60 ? 'too short' : 'logged', call_id: null };
  world.stretches.push(row);
  if (row.status === 'logged') logWorklog({ issueKey: cur.issueKey, seconds, date: londonDate(Date.parse(cur.startedAt)), description: 'Tracked in Promtek Hub.' });
  return [{ status: row.status, seconds }];
}

function tracker(action, body) {
  const t = world.timer;
  if (action === 'start') {
    if (t?.current) endStretch(t.current, now());
    const job = { issueId: String(body.issueId), issueKey: body.issueKey, summary: body.summary || body.issueKey };
    world.timer = { job, current: { kind: 'job', ...job, startedAt: ago(90 * MIN) }, state: 'running' };
    return trackerStatus();
  }
  if (action === 'pause') {
    if (!t?.current) return trackerStatus();
    const saved = endStretch(t.current, now());
    world.timer = { ...t, current: null, state: 'paused' };
    return trackerStatus({ saved });
  }
  if (action === 'resume') {
    if (!t?.job) throw new Error('There is nothing to carry on with.');
    world.timer = { ...t, current: { kind: 'job', ...t.job, startedAt: iso(now()) }, state: 'running' };
    return trackerStatus();
  }
  if (action === 'stop') {
    const saved = t?.current ? endStretch(t.current, now()) : [];
    world.timer = null;
    return trackerStatus({ saved });
  }
  if (action === 'assist') {
    const at = t?.current ? Math.min(now(), Math.max(Date.parse(t.current.startedAt) + 60_000, now() - 50 * MIN)) : now();
    if (t?.current) endStretch(t.current, at);
    const key = body.kind === 'team' ? 'PMB-37' : 'PMB-39';
    world.timer = { ...(t || {}), current: { kind: body.kind, issueId: idOf(key), issueKey: key, summary: body.kind === 'team' ? 'Assisting the team' : 'Assisting an apprentice',
      whoId: body.whoId, whoName: body.whoName, theirKey: body.theirKey, startedAt: iso(at) }, state: 'running' };
    return trackerStatus();
  }
  if (action === 'end-interruption') {
    if (!t?.current || t.current.kind === 'job') return trackerStatus();
    const at = Math.min(now(), Math.max(Date.parse(t.current.startedAt) + 60_000, now() - 35 * MIN));
    const saved = endStretch(t.current, at);
    const next = body.resume && t.job ? { kind: 'job', ...t.job, startedAt: iso(at) } : null;
    world.timer = t.job ? { ...t, current: next, state: next ? 'running' : 'paused' } : null;
    return trackerStatus({ saved });
  }
  if (action === 'poll') return trackerStatus({ call: null });
  return trackerStatus();
}

// ---------- XP, ELO and what's taken into account ----------

const ELO_BOARD = [['Tom Reid', 1388, 41, 6], ['Sam Turner', 1302, 12, 4], ['Priya Shah', 1265, -8, 3], ['Ellie Morgan', 1190, 26, 2], ['Dan Walsh', 1140, -22, 3], ['Amy Clarke', 1101, 0, 0]];

function eloBoard(period) {
  const scale = period === 'month' ? 0.4 : period === 'quarter' ? 1 : 2.2;
  const rankName = (e) => (e < 1100 ? 'Gram II' : e < 1300 ? 'Kilogram I' : e < 1500 ? 'Kilogram II' : 'Tonne I');
  const mine = eloHistory(1100);
  const rows = [...ELO_BOARD.map(([name, elo, change, jobs]) => ({ name, elo, change: Math.round(change * scale), jobs: Math.round(jobs * scale), ratedJobs: jobs ? 8 : 0, isYou: false })),
    { name: me.name, elo: Math.round(mine.elo), change: Math.round(mine.elo - mine.start) * (period === 'month' ? 0 : 1), jobs: 3, ratedJobs: mine.events.length, isYou: true }]
    .sort((a, b) => b.elo - a.elo).map((r, i) => ({ ...r, position: i + 1, rank: rankName(r.elo) }));
  return { metric: 'elo', period, top: rows.slice(0, 10), all: rows, you: rows.find((r) => r.isYou), total: rows.length };
}

function leaderboard(period) {
  const scale = period === 'week' ? 1 : period === 'month' ? 4.2 : 60;
  const rows = [
    ['Sam Turner', 912], ['Priya Shah', 870], ['Tom Reid', 845], ['Ellie Morgan', 790], ['Dan Walsh', 760],
    ['Amy Clarke', 731], ['Chris Doyle', 698], ['Jordan Pike', 655], ['Megan Ross', 610], ['Lewis Hart', 580], ['Kate Bell', 540], ['Ryan Moss', 505],
  ].map(([name, xp]) => ({ name, xp: Math.round(xp * scale), level: 180 + Math.round(xp / 9), levelFrom: period === 'all' ? null : 180 + Math.round(xp / 9) - Math.max(1, Math.round(scale)), isYou: false }));
  const mine = meResponse().employee;
  rows.push({ name: me.name, xp: period === 'week' ? mine.week.xp : Math.round(mine.week.xp * scale * 0.95), level: mine.progress.level, levelFrom: period === 'all' ? null : mine.progress.level - Math.max(1, Math.round(scale)), isYou: true });
  rows.sort((a, b) => b.xp - a.xp);
  rows.forEach((r, i) => { r.position = i + 1; });
  return { top: rows.slice(0, 10), all: rows, you: rows.find((r) => r.isYou), total: rows.length };
}

function eloHistory(start = 1100, name = null) {
  let elo = start;
  const jobs = [
    ['HBM-150', 'Category - Site visit', 26, 22, 1210], ['NGB-96', 'Category - Software', 40, 46, 1260], ['ASF-55', 'Category - Hardware', 18, 15, 1120],
    ['NGB-104', 'Category - Software', 30, 28, 1190], ['HBM-171', 'Category - Site visit', 12, 16, 1080], ['ASF-62', 'Category - Software', 34, 30, 1240],
    ['HBM-188', 'Category - Hardware', 22, 21, 1170], ['NGB-110', 'Category - Site visit', 16, 13, 1150],
  ];
  const events = jobs.map(([key, summary, est, act, jobElo], i) => {
    const delta = Math.round(((est - act) / est) * 40 + (jobElo - elo) / 40);
    elo += delta;
    return { id: 700 + i, kind: 'job', issue_key: key, summary, estimate_seconds: est * 3600, actual_seconds: act * 3600, seconds: act * 3600 * 0.6, share: 0.6,
      job_elo: jobElo, delta, elo_after: elo, done_date: addDays(today(), -(jobs.length - i) * 9), created_at: ago((jobs.length - i) * 9 * DAY) };
  });
  return { start, elo, events, rank: { name: 'Kilogram I', heldFrom: null }, name };
}

// ---------- Jobs ----------

function initJobs() {
  const cat = (id, key, discipline, logged, estimate, jobElo, extra = {}) => ({ id, key, discipline, summary: `Category - ${DISCIPLINE[discipline]}`, jobElo,
    loggedSeconds: logged * 3600, estimateSeconds: estimate * 3600, pct: logged / estimate, done: false, mine: true, pendingDispute: false, pendingIsMine: false,
    disputed: false, quotedElo: null, scores: { tech: 3, scope: 3, risk: 2, dep: 2 }, ...extra });
  return [
    { key: 'HBM-204', summary: 'Intake weigher replacement', customer: 'Harbour Mills', team: 'Projecting', categories: [
      cat('c-hbm205', 'HBM-205', 'engineering', 41, 40, 1220, { scores: { tech: 3, scope: 3, risk: 3, dep: 2 } }),
      cat('c-hbm206', 'HBM-206', 'hardware', 18, 30, 1150),
    ] },
    { key: 'NGB-118', summary: 'Line 2 recipe system upgrade', customer: 'Northgate Bakery', team: 'Projecting', categories: [
      cat('c-ngb119', 'NGB-119', 'software', 33, 36, 1260, { scores: { tech: 4, scope: 3, risk: 2, dep: 2 } }),
      cat('c-ngb120', 'NGB-120', 'hardware', 12, 16, 1100, { scores: { tech: 2, scope: 2, risk: 2, dep: 2 } }),
    ] },
    { key: 'ASF-70', summary: 'Bagging line controls', customer: 'Ashby Feeds', team: 'Projecting', categories: [
      cat('c-asf71', 'ASF-71', 'software', 26, 24, 1150, { mine: false, pendingDispute: Boolean(me.user?.isLead), pendingIsMine: false }),
    ] },
  ];
}

const REASONS = ['Scope grew', 'Spec was unclear or wrong', 'Kit faulty or obsolete', 'Customer delays', 'Third-party delays', 'Site access or conditions', 'More testing than expected', 'Something else'];
const allCategories = () => world.jobs.flatMap((o) => o.categories.map((c) => ({ ...c, order: o })));
const eloFromScores = (s) => 750 + 250 * (s.tech * 0.4 + s.scope * 0.3 + s.risk * 0.2 + s.dep * 0.1);

function jobsList(scope) {
  const orders = world.jobs.map((o) => ({ ...o, categories: o.categories.filter((c) => scope !== 'mine' || c.mine) })).filter((o) => o.categories.length);
  return { scope, orders, reasons: REASONS };
}

// ---------- Quotes ----------

const QUOTE_CONFIG = {
  common: ['New customer', 'New site'],
  software: { counts: [['integrations', 'Systems to integrate with'], ['screens', 'Screens or workflows'], ['recipes', 'Recipes or products'], ['reports', 'Reports'], ['lines', 'Sites or lines']],
    chips: ['Customer IT involved', 'Legacy system to migrate from', 'Data migration', 'Reused design'] },
  hardware: { counts: [['panels', 'Panels'], ['io', 'I/O points'], ['weighpoints', 'Weigh points or load cells'], ['boughtout', 'Bought-out items']],
    chips: ['ATEX', 'Custom enclosure', 'Drawings supplied by the customer', 'Legacy or obsolete kit', 'Reused design'] },
  engineering: { jobTypes: ['Maintenance', 'Build', 'Commissioning', 'Repair', 'Calibration', 'Training'], counts: [['days', 'Days on site'], ['devices', 'Devices'], ['weighpoints', 'Weigh points'], ['attendees', 'People to train']],
    chips: ['ATEX', 'Working at height', 'Permits needed', 'Out of hours', 'Customer staff available', 'Fault not yet known', 'Long travel'] },
  condor: { counts: [['stations', 'Weigh points or stations'], ['modules', 'Standard modules switched on'], ['custom', 'Custom features beyond standard'], ['integrations', 'Integrations']],
    chips: ['New install', 'Upgrade', 'Customer IT involved', 'Legacy or obsolete kit'] },
};

function blankSection(discipline, extra = {}) {
  return { discipline, counts: {}, chips: [], novelty: null, spec: null, best_hours: null, likely_hours: null, worst_hours: null, tech: null, risk: null, dep: null,
    quoted_hours: null, job_type: null, estimator: null, estimator_id: null, reference_id: null, reference_compare: null, ...extra };
}

function initQuotes() {
  return {
    seq: 3,
    list: [
      { id: 'q1', title: 'Second intake weigher', project_key: 'HBM', customer: 'Harbour Mills', quote_key: 'HBM-221', status: 'open', team: 'Projecting', created_name: 'Priya Shah', description: 'Harbour Mills want a second intake weigher on the new silo, matching the one fitted this year.',
        sections: [blankSection('hardware', { counts: { panels: 1, weighpoints: 4 }, best_hours: 20, likely_hours: 26, worst_hours: 34, tech: 2, risk: 2, dep: 2, estimator: 'Dan Walsh', estimator_id: 'ex-dan' }),
          blankSection('engineering', { job_type: 'Commissioning', counts: { days: 2 } })] },
      { id: 'q2', title: 'Recipe reports for line 3', project_key: 'NGB', customer: 'Northgate Bakery', quote_key: 'NGB-130', status: 'ready', team: 'Condor', created_name: 'Priya Shah', description: '', sections: [blankSection('software')] },
    ],
    // Someone asking this person for their view: everyone sees this one.
    requests: [{ id: 'r1', quote_id: 'q1', discipline: 'engineering', title: 'Second intake weigher', customer: 'Harbour Mills', quote_key: 'HBM-221',
      requested_name: 'Priya Shah', note: 'Same site as HBM-204. Can it be done in the same shutdown?', status: 'pending', account_id: 'me', name: null }],
    asks: [],
    // Every open quote in Jira, including ones made there rather than here.
    open: [
      ['HBM-221', 'HBM', 'Second intake weigher', 'In Progress', 'Projecting', 'Priya Shah', 12, 'q1'],
      ['NGB-130', 'NGB', 'Recipe reports for line 3', 'Open', 'Condor', 'Priya Shah', 5, 'q2'],
      ['ASF-77', 'ASF', 'Bagging line PLC upgrade', 'Open', 'Projecting', 'Dan Walsh', 31, null],
      ['KWD-48', 'KWD', 'Annual calibration visit', 'Open', 'Service', 'Sam Turner', 3, null],
      ['HBM-224', 'HBM', 'Silo level sensors', 'In Progress', 'Service', 'Ellie Morgan', 9, null],
      ['NGB-133', 'NGB', 'MicroMan second station', 'Open', null, null, 64, null],
    ].map(([key, project, summary, status, team, assignee, days, hubId]) => ({ key, project, summary, status, team, assignee, reporter: assignee,
      created: new Date(Date.now() - days * 86_400_000).toISOString(), hubId })),
  };
}

function quoteHelp(s) {
  const counts = Object.values(s.counts || {}).reduce((a, v) => a + (Number(v) || 0), 0);
  const likely = Number(s.likely_hours) || 0;
  const pert = s.best_hours != null && s.likely_hours != null && s.worst_hours != null
    ? (Number(s.best_hours) + 4 * Number(s.likely_hours) + Number(s.worst_hours)) / 6 : null;
  const base = pert ?? (likely || (counts ? 6 + counts * 3.5 : null));
  const suggested = base ? Math.round(base * 1.12 * 10) / 10 : null;
  const score = (Number(s.tech) || 3) * 0.4 + 3 * 0.3 + (Number(s.risk) || 2) * 0.2 + (Number(s.dep) || 2) * 0.1;
  return {
    pert, refFactor: 1.12, bias: null, model: null, modelNeeds: 6, suggestedHours: suggested, jobElo: 750 + 250 * score,
    references: [
      { id: 'ref1', key: s.discipline === 'software' ? 'NGB-96' : 'HBM-150', customer: s.discipline === 'software' ? 'Northgate Bakery' : 'Harbour Mills', estimateHours: 24, actualHours: 27, learnedElo: 1190, doneDate: addDays(today(), -60) },
      { id: 'ref2', key: s.discipline === 'software' ? 'ASF-55' : 'NGB-110', customer: s.discipline === 'software' ? 'Ashby Feeds' : 'Northgate Bakery', estimateHours: 16, actualHours: 15, learnedElo: 1110, doneDate: addDays(today(), -120) },
    ],
  };
}

function quoteGet(id) {
  const q = world.quotes.list.find((x) => x.id === id);
  if (!q) throw new Error('That quote has gone.');
  const canEdit = Boolean(me.user?.can?.quotes);
  return {
    quote: { id: q.id, title: q.title, customer: q.customer, project_key: q.project_key, quote_key: q.quote_key, status: q.status, team: q.team || null, description: q.description, epic_key: null, description_synced: 1 },
    sections: q.sections.map((s) => ({ ...s, help: quoteHelp(s) })),
    requests: world.quotes.asks.filter((r) => r.quote_id === q.id),
    canEdit, config: QUOTE_CONFIG, jiraUrl: '#', teams: ['Projecting', 'Service', 'Condor'],
  };
}

// ---------- Condor ----------

function initMes() {
  const t = (id, key, summary, type, module, extra = {}) => ({ issue_id: id, issue_key: key, summary, type, module, hours: null, timebox: false, difficulty: null, priority: null, version_name: null,
    status: 'To Do', assignee_id: null, assignee_name: null, notes_kind: null, ...extra });
  const tom = { assignee_id: 'ex-tom', assignee_name: 'Tom Reid' }, amy = { assignee_id: 'ex-amy', assignee_name: 'Amy Clarke' };
  return {
    tickets: [
      t('m1', 'MES-512', 'Batch report shows the wrong operator', 'Bug', 'Reports'),
      t('m2', 'MES-518', 'Allow two recipes per weigh station', 'Story', 'Recipes', tom),
      t('m3', 'MES-521', 'Add a search to the ingredient list', 'Story', 'Ingredients', { hours: 6, difficulty: 2 }),
      t('m4', 'MES-525', 'Label printer queue stalls after a restart', 'Bug', 'Printing'),
      t('m5', 'MES-530', 'Export stock movements to CSV', 'Story', 'Stock', { hours: 10, difficulty: 3, ...amy }),
    ],
    // What's left of Gobi, for a mid-release review: furthest along first.
    mid: [
      t('g1', 'MES-480', 'Recipe import keeps the line order', 'Story', 'Recipes', { status: 'In Review', hours: 8, difficulty: 3, ...amy, notes_kind: 'paragraph' }),
      t('g2', 'MES-486', 'Scheduling board shows shift breaks', 'Story', 'Scheduling', { status: 'In Progress', hours: 12, difficulty: 3, ...tom, notes_kind: 'photo' }),
      t('g3', 'MES-489', 'Reprint a weighbridge ticket', 'Improvement', 'Weighbridge', { status: 'To Do', hours: 5, difficulty: 2, notes_kind: 'sentence' }),
      t('g4', 'MES-491', 'Stock take variance report', 'Story', 'Reports', { status: 'To Do' }),
    ],
    reviewed: {},
    kinds: {},
    refs: [
      { id: 'f1', key: 'MES-402', summary: 'Show the batch number on the weigh screen', type: 'Story', module: 'Weighing', hours: 5 },
      { id: 'f2', key: 'MES-377', summary: 'Recipe copy keeps the old version number', type: 'Bug', module: 'Recipes', hours: 9 },
      { id: 'f3', key: 'MES-415', summary: 'New ingredient allergen report', type: 'Story', module: 'Reports', hours: 16, done: false },
    ],
    versions: [{ id: 'v1', name: 'Gobi', releaseDate: addDays(today(), 70) }, { id: 'v2', name: 'Kalahari', releaseDate: addDays(today(), 160) }],
    triaged: {},
    drafts: [
      { day: addDays(today(), -1), drafts: [
        { key: 'MES-521', summary: 'Add a search to the ingredient list', start: '08:45', seconds: 3.5 * 3600, alreadyLogged: 0 },
        { key: 'MES-512', summary: 'Batch report shows the wrong operator', start: '13:15', seconds: 2.25 * 3600, alreadyLogged: 0 },
        { key: 'MES-498', summary: 'Pull request review: stock export', start: '22:10', seconds: 0.5 * 3600, alreadyLogged: 0 },
      ] },
    ],
    suggestions: [{ id: 'm2', key: 'MES-518', summary: 'Allow two recipes per weigh station', priority: 'Could', hours: 14, reason: 'it doesn\'t fit before Gobi and it is a Could' }],
    accepted: null,
    estimates: {},
    notes: initNotes(),
  };
}

// A made-up screen, so the release notes have pictures to show.
function mockShot(title, accent = '#008dc6') {
  const rows = [0, 1, 2, 3].map((i) => `<rect x="230" y="${150 + i * 54}" width="560" height="40" rx="4" fill="${i % 2 ? '#f6f8fa' : '#fff'}" stroke="#e1e6ea"/><rect x="246" y="${164 + i * 54}" width="${180 - i * 25}" height="12" rx="3" fill="#c9d3da"/><rect x="560" y="${164 + i * 54}" width="90" height="12" rx="3" fill="#dfe6eb"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="400" viewBox="0 0 820 400"><rect width="820" height="400" fill="#fff"/>`
    + `<rect width="200" height="400" fill="#1b75b0"/><circle cx="34" cy="32" r="14" fill="#fff" opacity=".9"/><rect x="56" y="24" width="100" height="14" rx="3" fill="#fff" opacity=".85"/>`
    + [0, 1, 2, 3, 4, 5].map((i) => `<rect x="24" y="${78 + i * 30}" width="${110 - (i % 3) * 18}" height="10" rx="3" fill="#fff" opacity=".6"/>`).join('')
    + `<text x="230" y="58" font-family="Arial" font-size="22" fill="#333">${title}</text><rect x="230" y="80" width="560" height="44" rx="6" fill="#f2f6f9"/>`
    + `<rect x="680" y="90" width="96" height="26" rx="5" fill="${accent}"/>${rows}`
    + `<path d="M520 360 L600 300" stroke="#e53935" stroke-width="3"/><path d="M600 300 l-14 2 l8 10 z" fill="#e53935"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function initNotes() {
  const it = (id, key, summary, type, module, kind, done, blocks, who, title = null) => ({ id, key, summary, type, module, kind, done, blocks, title, status: done ? 'Done' : 'In Progress',
    assigneeId: who === 'me' ? me.id : who || null, assigneeName: who === 'me' ? me.name : who === 'ex-tom' ? 'Tom Reid' : who === 'ex-amy' ? 'Amy Clarke' : null });
  return {
    intro: null,
    number: null,
    edits: {},
    uploads: {},
    items: [
      it('n1', 'MES-488', 'Expected throughput on finished products', 'Story', 'Stock', 'sentence', true, [
        { type: 'text', text: 'Finished products can now include expected throughput times, supporting the QC metrics report and a countdown timer in the control system.' }], 'ex-amy'),
      it('n2', 'MES-493', 'Remove stock locations', 'Improvement', 'Stock', 'sentence', true, [
        { type: 'text', text: 'Stock locations can now be removed through the user interface.' }], 'ex-tom'),
      it('n9', 'MES-495', 'MicroMan multiple scales per station', 'Story', 'Microman', 'photo', true, [
        { type: 'text', text: 'A MicroMan station can now use multiple scales. This supports stations that need different weighing ranges, such as a smaller scale for low-quantity ingredients and a larger scale for bulk additions.' },
        { type: 'text', text: 'The required scale can be selected for the station, helping operators use equipment appropriate to each weighment.' },
        { type: 'image', attachmentId: 'a1', filename: 'scales.png', caption: 'MicroMan station configured with multiple scales', src: mockShot('Station scales') }], 'ex-amy', 'Multiple scales per station'),
      it('n10', 'MES-499', 'Keyboard shortcuts for the MicroMan schedule', 'Improvement', 'Microman', 'sentence', true, [
        { type: 'text', text: 'Added keyboard shortcuts for moving directly to the top or bottom of the MicroMan schedule.' }], 'ex-tom'),
      it('n3', 'MES-497', 'Work order list keeps its filters', 'Task', 'Work Orders', 'sentence', true, [
        { type: 'text', text: 'The work order list now remembers the filters you chose.' }], 'ex-tom'),
      it('n4', 'MES-501', 'Batch report shows the wrong operator', 'Bug', 'Reports', 'sentence', true, [], 'me'),
      it('n8', 'MES-503', 'Label preview before printing', 'Story', 'Work Orders', 'photo', true, [], 'me'),
      it('n5', 'MES-506', 'Weighbridge tickets print twice', 'Bug', 'Weighbridge', 'paragraph', false, [], 'ex-amy'),
      it('n6', 'MES-509', 'Tidy the importer logging', 'Task', 'Importer / Exporter', null, true, [], 'ex-tom'),
      it('n7', 'MES-511', 'Refactor the label service', 'Task', null, 'none', true, [], 'ex-amy'),
    ],
  };
}

const NOTE_HEADINGS = ['Stock', 'Reports', 'Formulas and recipes', 'MicroMan', 'Weighbridge', 'Site and system management', 'Work orders',
  'Scheduling', 'Time in motion and energy', 'LIMS and quality control', 'Purchase and sales orders', 'Importer and exporter'];
const NOTE_FROM = { stock: 'Stock', reports: 'Reports', formulas: 'Formulas and recipes', recipes: 'Formulas and recipes', microman: 'MicroMan', weighbridge: 'Weighbridge',
  security: 'Site and system management', general: 'Site and system management', 'work orders': 'Work orders', 'importer / exporter': 'Importer and exporter' };
const noteHeading = (m) => NOTE_FROM[String(m || '').toLowerCase()] || m || 'Site and system management';

function noteMissing(kind, blocks, title) {
  const shown = blocks.filter((b) => !b.hidden);
  const out = [];
  if (kind !== 'sentence' && !String(title || '').trim()) out.push('a heading');
  if (!shown.some((b) => b.type === 'text' && b.text.trim())) out.push(kind === 'sentence' ? 'a sentence' : 'a paragraph');
  if (kind === 'photo' && !shown.some((b) => b.type === 'image')) out.push('a picture');
  return out;
}

function mesNotes(versionId) {
  const m = world.mes, nt = m.notes;
  const version = m.versions.find((v) => v.id === versionId) || m.versions[0];
  const items = nt.items.map((i) => {
    const e = nt.edits[i.id] || {};
    const kind = e.kind !== undefined ? e.kind : i.kind;
    const blocks = e.blocks || i.blocks;
    const title = e.title !== undefined ? e.title : i.title;
    return { id: i.id, key: i.key, summary: i.summary, type: i.type, status: i.status, done: i.done, kind, include: kind == null ? null : kind === 'none' ? 'no' : 'yes',
      assigneeId: i.assigneeId, assigneeName: i.assigneeName, kindWaiting: false, notePending: false,
      module: i.module, heading: e.module || noteHeading(i.module), moduleSet: Boolean(e.module || i.module), title,
      blocks, jiraBlocks: i.blocks, edited: Boolean(e.blocks || e.title || e.module), changedInJira: false,
      missing: kind && kind !== 'none' ? noteMissing(kind, blocks, title) : [] };
  });
  const shown = (i) => {
    let b = i.blocks.filter((x) => !x.hidden);
    if (i.kind === 'sentence') b = b.filter((x) => x.type === 'text').slice(0, 1);
    if (i.kind === 'paragraph') b = b.filter((x) => x.type === 'text');
    return b.some((x) => x.type === 'text') ? b : [{ type: 'text', text: i.summary, fromSummary: true }, ...b];
  };
  const inDoc = items.filter((i) => i.include === 'yes' && i.done);
  const rank = (h) => (NOTE_HEADINGS.indexOf(h) >= 0 ? NOTE_HEADINGS.indexOf(h) : 500);
  const document = [...new Set(inDoc.map((i) => i.heading))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((name) => {
    const here = inDoc.filter((i) => i.heading === name);
    return {
      name,
      features: here.filter((i) => i.kind !== 'sentence').map((i) => ({ id: i.id, key: i.key, title: i.title || i.summary, titleFromSummary: !i.title, blocks: shown(i) })),
      bullets: here.filter((i) => i.kind === 'sentence').map((i) => { const b = shown(i)[0]; return { id: i.id, key: i.key, text: b.text, fromSummary: Boolean(b.fromSummary) }; }),
    };
  });
  const toWrite = items.filter((i) => i.kind && i.kind !== 'none' && i.missing.length);
  const rd = version.releaseDate || '';
  return {
    releases: [...m.versions.map((v) => ({ ...v, released: false })), { id: 'v0', name: 'Fuji', releaseDate: addDays(today(), -40), released: true }],
    version: { ...version, released: false, displayName: version.name, number: nt.number || (rd ? `${rd.slice(0, 4)}.${rd.slice(5, 7)}` : ''), numberSet: Boolean(nt.number) },
    readAt: iso(now()), error: null, me: me.id,
    intro: nt.intro, introDefault: `${version.name} introduces improvements across ${document.map((d) => (d.name === 'MicroMan' ? d.name : d.name.toLowerCase())).join(', ').replace(/, ([^,]*)$/, ' and $1')}.`,
    document, items, headings: NOTE_HEADINGS,
    counts: { inDocument: inDoc.length, unfinished: items.filter((i) => i.include === 'yes' && !i.done).length, undecided: items.filter((i) => !i.kind).length,
      left: items.filter((i) => i.kind === 'none').length, pictures: inDoc.reduce((t, i) => t + shown(i).filter((b) => b.type === 'image').length, 0),
      toWrite: toWrite.length, mine: toWrite.filter((i) => i.assigneeId === me.id).length },
  };
}

function mesQuestion({ issueId, answers }) {
  const tk = [...world.mes.tickets, ...world.mes.mid].find((x) => x.issue_id === issueId);
  const asked = answers.length;
  const ticket = { issue_key: tk.issue_key, summary: tk.summary, type: tk.type, module: tk.module };
  if (asked < 2) {
    const ref = world.mes.refs[asked === 0 ? 0 : (answers[0].answer === 'bigger' ? 1 : 0)];
    const next = asked === 1 ? world.mes.refs[answers[0].answer === 'bigger' ? 2 : 1] : ref;
    return { ticket, poolSize: 3, asked, maxQuestions: 3, next };
  }
  const score = answers.reduce((a, x) => a + (x.answer === 'bigger' ? 1 : x.answer === 'smaller' ? -1 : 0), 0);
  const hours = Math.max(1, 7 + score * 3.5);
  return { ticket, poolSize: 3, asked, maxQuestions: 3, next: null, estimate: { hours, low: Math.max(0.5, hours * 0.7), high: hours * 1.5 } };
}

function mesPlan() {
  const m = world.mes;
  const v = m.versions[0];
  const names = Object.fromEntries([...PEOPLE.filter((p) => p.team === 'Condor'), { id: me.id, name: me.name }].map((p) => [p.id, p.name]));
  const start = today();
  const sched = m.tickets.filter((t) => m.triaged[t.issue_id] && m.triaged[t.issue_id] !== 'none' && t.hours != null).map((t, i) => {
    const person = i % 2 ? 'ex-tom' : 'ex-amy';
    const s = addDays(start, i * 4), due = addDays(start, i * 4 + Math.ceil(t.hours / 6));
    return { id: t.issue_id, key: t.issue_key, summary: t.summary, priority: m.triaged[t.issue_id], hours: t.hours, personId: person, plannedAssignee: true, start: s, due, fits: true, sprint: null };
  });
  const base = [
    { id: 'm3', key: 'MES-521', summary: 'Add a search to the ingredient list', priority: 'Must', hours: 6, personId: 'ex-tom', start: addDays(start, 1), due: addDays(start, 3), fits: true },
    { id: 'm5', key: 'MES-530', summary: 'Export stock movements to CSV', priority: 'Should', hours: 10, personId: 'ex-amy', start: addDays(start, 2), due: addDays(start, 8), fits: true },
    ...(m.suggestions.length ? [{ id: 'm2', key: 'MES-518', summary: 'Allow two recipes per weigh station', priority: 'Could', hours: 14, personId: 'ex-tom', start: addDays(start, 60), due: addDays(start, 78), fits: false }] : []),
  ];
  const schedule = [...base, ...sched.filter((s) => !base.some((b) => b.key === s.key))];
  const planned = schedule.filter((s) => s.fits).reduce((a, s) => a + s.hours, 0);
  return {
    version: v, versions: m.versions, next: m.versions[1], canPlan: Boolean(me.user?.can?.condorPlan), names,
    schedule, usable: 220, capacity: 275, reserve: 0.2, planned, noRelease: false, sprints: [],
    projected: schedule.some((x) => !x.fits) ? { finish: addDays(start, 78), lateDays: 6, cannotPlace: 0 } : null,
    suggestions: m.suggestions, stillOut: [], needsEstimate: m.tickets.filter((t) => t.hours == null && m.triaged[t.issue_id] && m.triaged[t.issue_id] !== 'none').map((t) => ({ id: t.issue_id, key: t.issue_key, summary: t.summary, priority: m.triaged[t.issue_id] })),
    accepted: m.accepted || { count: 0 },
    people: [
      { id: 'ex-tom', name: 'Tom Reid', included: true, hoursPerWeek: 30, days: '1234', away: [] },
      { id: 'ex-amy', name: 'Amy Clarke', included: true, hoursPerWeek: 22.5, days: '125', away: [{ from: addDays(start, 21), until: addDays(start, 25), note: 'University block' }] },
    ],
  };
}

// ---------- 8x8 calls ----------

function initCalls() {
  const at = (h, m) => `${today()}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  return [
    { callId: 'c1', direction: 'in', otherName: 'Rob Fenwick', otherRaw: '01632 960118', other: '+441632960118', started: at(8, 52), talkTime: '6m 40s', seconds: 400,
      customer: { label: 'Harbour Mills', project_key: 'HBM' }, handled: null },
    { callId: 'c2', direction: 'in', otherName: null, otherRaw: '01632 960455', other: '+441632960455', started: at(10, 17), talkTime: '12m 05s', seconds: 725, customer: null, handled: null },
    { callId: 'c3', direction: 'out', otherName: 'Northgate Bakery', otherRaw: '01632 960301', other: '+441632960301', started: at(11, 40), talkTime: '3m 12s', seconds: 192,
      customer: { label: 'Northgate Bakery', project_key: 'NGB' }, handled: { action: 'logged', issue_key: 'NGB-122' } },
  ];
}

// ---------- Vehicles ----------

function initVehicles() {
  return {
    fleet: [
      { id: 'v1', registration: 'PK21 HUB', make: 'Ford', model: 'Transit Custom', offRoad: false, openDefects: 0, mileage: 48210, soonest: { label: 'Service', days: 41 } },
      { id: 'v2', registration: 'PL70 WGH', make: 'Vauxhall', model: 'Vivaro', offRoad: false, openDefects: 1, mileage: 61877, soonest: { label: 'MOT', days: 12 } },
      { id: 'v3', registration: 'PN19 CAL', make: 'Ford', model: 'Transit Connect', offRoad: false, openDefects: 0, mileage: 30544, soonest: { label: 'Tax', days: 96 } },
    ],
    bookings: [],
    others: [
      { vehicle_id: 'v2', starts_at: `${addDays(today(), 1)}T07:00`, ends_at: `${addDays(today(), 1)}T16:00`, engineer: 'Sam Turner' },
      { vehicle_id: 'v1', starts_at: `${addDays(today(), 2)}T08:00`, ends_at: `${addDays(today(), 2)}T13:00`, engineer: 'Ellie Morgan' },
    ],
    defects: [{ id: 'd1', registration: 'PL70 WGH', item: 'Wiper blades', severity: 'minor', note: 'Passenger side smears', reporter: 'Sam Turner', created_at: ago(4 * DAY) }],
  };
}

// ---------- PSC ----------

const TIERS = {
  platinum: { name: 'Platinum', rank: 0, cover: 'anytime', coverText: '1 to 3 shifts, any day', callout: 'Same day', calloutRate: 90, mileage: 0.9, tmRate: 80, tokens: 15, remote: true, portal: true, line: true, rollover: true },
  gold: { name: 'Gold', rank: 1, cover: 'weekdays', coverText: '1 to 3 shifts, weekdays', callout: '1 working day', calloutRate: 100, mileage: 1.0, tmRate: 90, tokens: 10, remote: true, portal: true, line: true, rollover: false },
  silver: { name: 'Silver', rank: 2, cover: 'shift', coverText: '1 shift, weekdays', callout: '2 working days', calloutRate: 110, mileage: 1.1, tmRate: 100, tokens: 5, remote: true, portal: false, line: false, rollover: false },
  none: { name: 'No contract', rank: 3, cover: 'shift', coverText: 'Office hours, weekdays', callout: 'By arrangement', chargeable: true },
};
const TARGET_H = { platinum: 1, gold: 2, silver: 4, none: 8 };

function pscItem(myId, x) {
  const c = x.project === 'PSC' ? (x.org ? CUSTOMERS.find((k) => k.name === x.org) : null) : customer(x.project);
  const tier = c?.tier ? c.tier.toLowerCase() : 'none';
  const created = ago(x.ageMins * MIN);
  const item = {
    id: idOf(x.key), key: x.key, project: x.project, summary: x.summary, type: x.type, status: x.status || 'Open', priority: x.priority || 'Medium',
    assignee: x.assignee || null, assigneeId: x.assigneeId || null, reporter: x.reporter, created, resolvedAt: null, org: x.org || null,
    customer: c?.name || null, customerKey: c?.key || null, orderWork: false,
    contract: c?.contract ? { key: c.contract, tier: c.tier, status: 'In Contract', bankHoliday: c.bankHoliday, end: addDays(today(), 160), tokensFree: { NGB: 4, HBM: 9, ASF: 2 }[c.key] } : null,
    tier, tierName: TIERS[tier].name, tierRank: TIERS[tier].rank,
    cover: { raisedInCover: true, inCoverNow: true, clockFrom: created },
    raisedByTeam: false,
    response: { at: null, by: null, how: null, waitMs: 0, late: false, dueAt: iso(Date.parse(created) + TARGET_H[tier] * HOUR), targetMs: TARGET_H[tier] * HOUR, leftMs: 0 },
    lastTeam: null, customerLast: x.customerLast || { at: created, by: x.reporter }, customerWaiting: false, customerWaitMs: 0, quietMs: 0, stale: false,
    missing: [], state: 'new', rank: 0, copyOf: null, uncopied: false, done: false, chargeable: x.chargeable || null,
    timeline: x.timeline || [{ at: created, by: x.reporter, team: false, kind: 'created', text: x.firstText || 'Raised' }],
  };
  if (x.response) Object.assign(item.response, x.response);
  if (x.lastTeam) item.lastTeam = x.lastTeam;
  return refreshPsc(item, myId);
}

// Works out what the hub would show about an item from its facts, as psc.js does.
function refreshPsc(p, myId = me?.id) {
  const r = p.response;
  if (!r.at) {
    r.waitMs = now() - Date.parse(p.created);
    r.leftMs = Date.parse(r.dueAt) - now();
    r.late = r.leftMs < 0;
  }
  const lastCustomer = p.customerLast ? Date.parse(p.customerLast.at) : 0;
  const lastTeam = p.lastTeam ? Date.parse(p.lastTeam.at) : 0;
  p.customerWaiting = Boolean(r.at) && lastCustomer > lastTeam;
  p.quietMs = lastTeam ? now() - lastTeam : 0;
  p.stale = Boolean(lastTeam) && p.quietMs > 3 * DAY;
  p.missing = [...(p.project === 'PSC' && !p.org ? ['org'] : []), ...(!p.assigneeId ? ['assignee'] : []), ...(!r.at ? ['response'] : []),
    ...(!p.chargeable && !p.done ? ['charge'] : [])];
  p.state = p.done ? 'resolved' : !r.at && r.late ? 'late' : p.customerWaiting ? 'waiting' : !r.at ? 'new' : p.stale ? 'quiet' : 'active';
  p.customer = p.project === 'PSC' ? (p.org || null) : p.customer;
  return p;
}

function initPsc(myId) {
  const team = (who, mins, what) => ({ at: ago(mins * MIN), by: who, what });
  return [
    pscItem(myId, { key: 'NGB-140', project: 'NGB', summary: 'Mixer 3 weigher reading 2kg heavy', type: 'Incident', priority: 'High', reporter: 'Hannah Price', ageMins: 25,
      firstText: 'Since the cleandown this morning the mixer 3 weigher reads about 2kg heavy on an empty bowl. We have stopped using it.' }),
    pscItem(myId, { key: 'PSC-212', project: 'PSC', summary: 'Label printer on line 1 printing blank labels', type: 'PSC', reporter: 'Rob Fenwick', ageMins: 70,
      firstText: 'Called in by Rob at Harbour Mills. Line 1 label printer feeds blank labels after the ribbon change.' }),
    pscItem(myId, { key: 'ASF-88', project: 'ASF', summary: 'Request for a copy of last month\'s batch reports', type: 'Service Request', reporter: 'Leah Grant', ageMins: 26 * 60,
      assignee: 'Ellie Morgan', assigneeId: 'ex-ellie', chargeable: 'yes', response: { at: ago(25 * 60 * MIN), by: 'Ellie Morgan', how: 'comment', waitMs: 60 * MIN, late: false },
      lastTeam: team('Ellie Morgan', 25 * 60, 'commented'), customerLast: { at: ago(3 * 60 * MIN), by: 'Leah Grant' },
      timeline: [
        { at: ago(3 * HOUR), by: 'Leah Grant', team: false, kind: 'comment', text: 'Thanks Ellie. Could you include the weekend shifts as well?' },
        { at: ago(25 * HOUR), by: 'Ellie Morgan', team: true, kind: 'comment', text: 'Hi Leah, I\'ll pull these off the Condor server this afternoon.' },
        { at: ago(26 * HOUR), by: 'Leah Grant', team: false, kind: 'created', text: 'Please could we have a copy of the batch reports for last month for our audit.' },
      ] }),
    pscItem(myId, { key: 'HBM-233', project: 'HBM', summary: 'Intake conveyor trips when the silo is full', type: 'Problem', reporter: 'Rob Fenwick', ageMins: 5 * DAY / MIN,
      assignee: me ? me.name : 'You', assigneeId: myId, chargeable: 'yes', response: { at: ago((5 * DAY) / 1 - 40 * MIN), by: 'Sam Turner', how: 'status', waitMs: 40 * MIN, late: false },
      lastTeam: team('Sam Turner', 4 * 24 * 60, 'moved it on'),
      timeline: [
        { at: ago(4 * DAY), by: 'Sam Turner', team: true, kind: 'status', text: 'Moved to Investigating' },
        { at: ago(4 * DAY + HOUR), by: 'Sam Turner', team: true, kind: 'comment', internal: true, text: 'Likely the high level probe. Needs a site visit if it happens again.' },
        { at: ago(5 * DAY), by: 'Rob Fenwick', team: false, kind: 'created', text: 'The intake conveyor keeps tripping when silo 2 is full.' },
      ] }),
    pscItem(myId, { key: 'KWD-41', project: 'KWD', summary: 'Silo display not updating', type: 'Incident', reporter: 'Gary Holt', ageMins: 3 * 60,
      assignee: 'Sam Turner', assigneeId: 'ex-sam', chargeable: 'no', response: { at: ago(2.5 * HOUR), by: 'Sam Turner', how: 'comment', waitMs: 30 * MIN, late: false },
      lastTeam: team('Sam Turner', 150, 'commented'), customerLast: { at: ago(3 * HOUR), by: 'Gary Holt' } }),
  ];
}

function pscOverview() {
  const items = world.psc.map((p) => refreshPsc(p));
  const order = (p) => (p.state === 'late' ? 0 : p.state === 'new' && p.response.leftMs < HOUR ? 1 : p.customerWaiting ? 2 : p.state === 'new' ? 3 : 4);
  items.sort((a, b) => order(a) - order(b) || a.tierRank - b.tierRank || Date.parse(a.created) - Date.parse(b.created));
  items.forEach((p, i) => { p.rank = i; });
  return {
    items: clone(items), people: [{ id: me.id, name: me.name, service: true }, ...PEOPLE.map((p) => ({ id: p.id, name: p.name, service: p.service }))],
    pending: [], settings: { targets: TARGET_H, shiftStart: 8, shiftEnd: 17, staleDays: 3 }, me: me.id, tiers: TIERS, surcharge: 750,
    reading: null, syncedAt: ago(3 * MIN), isAdmin: false,
  };
}

function pscPickup(key) {
  const p = world.psc.find((x) => x.key === key);
  p.assignee = me.name;
  p.assigneeId = me.id;
  if (!p.response.at) Object.assign(p.response, { at: iso(now()), by: me.name, how: 'moved it to In Progress', waitMs: now() - Date.parse(p.created), late: false });
  p.lastTeam = { at: iso(now()), by: me.name, what: 'picked it up' };
  p.timeline.unshift({ at: iso(now()), by: me.name, team: true, kind: 'status', text: `${p.status} → In Progress` });
  p.timeline.unshift({ at: iso(now()), by: me.name, team: true, kind: 'hub', text: 'Picked it up in the hub' });
  if (!/in progress/i.test(p.status)) p.status = 'In Progress';
  refreshPsc(p);
  return { saved: true };
}

// ---------- Service contracts ----------

function initContracts() {
  const day = today();
  const c = (key, cust, project, tier, status, startDays, endDays, extra = {}) => ({
    key, customer: cust, project, summary: `${cust} service contract`, status, tier, bankHoliday: false,
    start: addDays(day, startDays), end: addDays(day, endDays), renewal: addDays(day, endDays - 30), renewalSet: true, live: true,
    visits: { done: 1, total: 2 }, calibration: { done: 0, total: 1 }, obsolescence: { done: 0, total: 1 },
    tokens: { total: 10, available: 6, used: 4, overdraft: 0, free: 4, allocated: 2, spent: 4, expired: 0 },
    clock: { seconds: 16 * 3600 + 2.5 * 3600, towardsNext: 2.5 * 3600, charged: 4, due: 4 }, ...extra,
  });
  return [
    c('HBM-40', 'Harbour Mills', 'HBM', 'Platinum', 'In Contract', -200, 165, { bankHoliday: true, visits: { done: 2, total: 4 }, calibration: { done: 1, total: 2 },
      tokens: { total: 15, available: 9, used: 6, overdraft: 0, free: 9, allocated: 1, spent: 5, expired: 0 }, clock: { seconds: 21.5 * 3600, towardsNext: 1.5 * 3600, charged: 5, due: 5 } }),
    c('NGB-90', 'Northgate Bakery', 'NGB', 'Gold', 'In Contract', -300, 65, { bankHoliday: true }),
    c('ASF-61', 'Ashby Feeds', 'ASF', 'Silver', 'Requires Renewal', -340, 25, { visits: { done: 0, total: 1 }, calibration: null,
      tokens: { total: 5, available: 2, used: 3, overdraft: 0, free: 2, allocated: 0, spent: 3, expired: 0 }, clock: { seconds: 13 * 3600, towardsNext: 1 * 3600, charged: 3, due: 3 } }),
    c('KWD-12', 'Kingsway Dairies', 'KWD', 'Bronze', 'Needs Chasing', -4, 361, { live: false, visits: null, calibration: null, obsolescence: null, tokens: null, clock: null }),
  ];
}

function initFlags() {
  return [
    { id: 61, kind: 'start-passed', contract_key: 'KWD-12', customer: 'Kingsway Dairies', detail: 'Its start date passed 4 days ago and it still says Needs Chasing. Chase the signed contract, or move the dates.' },
    { id: 62, kind: 'psc-org', ref_key: 'PSC-212', detail: 'Time has been logged to PSC-212 but it has no Organization, so it can\'t count towards anyone\'s tokens.' },
  ];
}

function contractDetail(key) {
  const c = world.contracts.find((x) => x.key === key);
  const p = c.project;
  const n = (k) => `${p}-${k}`;
  return {
    started: ago(40 * DAY), clockStart: addDays(today(), -40), clockChanged: ago(2 * HOUR), syncedAt: ago(4 * MIN), error: null, contract: c, problems: [],
    items: c.live ? [
      { key: n(91), kind: 'visit', summary: 'Service visit 1 of 2', status: 'Done', done: true },
      { key: n(92), kind: 'visit', summary: 'Service visit 2 of 2', status: 'To Do', done: false },
      { key: n(93), kind: 'calibration', summary: 'Calibration visit', status: 'To Do', done: false },
      { key: n(94), kind: 'obsolescence', summary: 'Obsolescence survey', status: 'To Do', done: false },
      { key: n(95), kind: 'token', summary: 'Token 1', status: 'Token Used', done: true },
      { key: n(96), kind: 'token', summary: 'Token 2', status: 'Token Allocated', done: false },
      { key: n(97), kind: 'token', summary: 'Token 3', status: 'Token Available', done: false },
    ] : [],
    contributions: c.clock ? [
      { key: `${p}-233`, summary: 'Intake conveyor trips when the silo is full', seconds: 9 * 3600 },
      { key: `${p}-140`, summary: 'Weigher reading heavy', seconds: 6 * 3600 },
      { key: n(92), summary: 'Service visit 2 of 2', seconds: 4.5 * 3600 },
    ] : [],
    charges: c.clock ? [
      { seq: 4, token: n(95), trigger: `${p}-233`, reason: 'clock', overdraft: false, done: true, at: ago(6 * DAY), error: null },
    ] : [],
    events: c.clock ? [{ at: ago(6 * DAY), text: `${n(95)} used: the clock passed 16h on ${p}-233` }] : [],
    waiting: world.contractTime.filter((t) => t.contract === key),
    notCharged: [],
    canDecide: true,
  };
}

// The waiting time shows on each contract's clock line.
function withWaiting(c) {
  const w = world.contractTime.filter((t) => t.contract === c.key);
  return c.clock ? { ...c, clock: { ...c.clock, waitingSeconds: w.reduce((n, t) => n + t.seconds, 0), waiting: w.length } } : c;
}

function contractInsights() {
  const day = today();
  return {
    today: day,
    renewals: { upcoming: [{ key: 'ASF-61', customer: 'Ashby Feeds', status: 'Requires Renewal', end: addDays(day, 25), days: 25 }, { key: 'NGB-90', customer: 'Northgate Bakery', status: 'In Contract', end: addDays(day, 65), days: 65 }],
      chasing: [{ key: 'KWD-12', customer: 'Kingsway Dairies', status: 'Needs Chasing', start: addDays(day, -4), late: true }], renewed: 7, lost: 2, undecided: 0 },
    pace: [
      { key: 'HBM-40', customer: 'Harbour Mills', end: addDays(day, 165), total: 15, used: 5, allocated: 1, overdraft: 0, timeShare: 0.55, tokenShare: 0.4, runsOut: null, left: 9, early: false },
      { key: 'NGB-90', customer: 'Northgate Bakery', end: addDays(day, 65), total: 10, used: 4, allocated: 2, overdraft: 0, timeShare: 0.82, tokenShare: 0.6, runsOut: null, left: 4, early: false },
      { key: 'ASF-61', customer: 'Ashby Feeds', end: addDays(day, 25), total: 5, used: 3, allocated: 0, overdraft: 0, timeShare: 0.93, tokenShare: 0.6, runsOut: null, left: 2, early: false },
    ],
    behind: [{ key: 'NGB-90', customer: 'Northgate Bakery', label: 'Calibration 0 of 1', done: 0, total: 1, weeksLeft: 9 }],
    leaks: {
      noOrg: [{ key: 'PSC-212', summary: 'Label printer on line 1 printing blank labels', seconds: 1.5 * 3600 }],
      noContract: [{ customer: 'Kingsway Dairies', seconds: 5 * 3600, logs: [{ date: addDays(day, -2), key: 'KWD-41', summary: 'Silo display not updating', who: 'Sam Turner', seconds: 5 * 3600 }] }],
      unmatched: [],
    },
    holidays: [{ name: 'Christmas Day', date: `${day.slice(0, 4)}-12-25` }, { name: 'Boxing Day', date: `${day.slice(0, 4)}-12-28` }],
    time: { days: 30, customers: [
      { customer: 'Harbour Mills', seconds: 21 * 3600, logs: [{ date: addDays(day, -3), key: 'HBM-233', summary: 'Intake conveyor trips when the silo is full', who: me.name, seconds: 3 * 3600 }, { date: addDays(day, -8), key: 'HBM-92', summary: 'Service visit 2 of 2', who: 'Sam Turner', seconds: 7 * 3600 }] },
      { customer: 'Northgate Bakery', seconds: 12 * 3600, logs: [{ date: addDays(day, -1), key: 'NGB-140', summary: 'Mixer 3 weigher reading 2kg heavy', who: 'Ellie Morgan', seconds: 2 * 3600 }] },
    ], people: [
      { name: 'Sam Turner', seconds: 19 * 3600, logs: [{ date: addDays(day, -8), key: 'HBM-92', summary: 'Service visit 2 of 2', customer: 'Harbour Mills', who: 'Sam Turner', seconds: 7 * 3600 }] },
      { name: me.name, seconds: 9 * 3600, logs: [{ date: addDays(day, -3), key: 'HBM-233', summary: 'Intake conveyor trips when the silo is full', customer: 'Harbour Mills', who: me.name, seconds: 3 * 3600 }] },
    ] },
  };
}

// ---------- Reports ----------

function reportTeam(weeks) {
  const monday = mondayOf(today());
  const list = Array.from({ length: weeks }, (_, i) => addDays(monday, (i - weeks + 1) * 7));
  const people = [{ id: me.id, name: me.name, team: world.employee.team }, ...PEOPLE].map((p, k) => ({
    account_id: p.id, name: p.name, team: p.team,
    weeks: Object.fromEntries(list.map((w, i) => [w, { seconds: (k === 3 && i === list.length - 2 ? 14 : 33 + ((k * 7 + i * 3) % 9)) * 3600, xp: 1900 + ((k * 13 + i * 7) % 6) * 150, avg_lag_days: ((k + i) % 4) * 0.6 }])),
  }));
  return { weeks: list, people };
}

// ---------- the requests themselves ----------

let starting = null;

export async function handle(path, options = {}, server) {
  const url = new URL(path, location.origin);
  const p = url.pathname;
  const q = url.searchParams;
  const method = (options.method || 'GET').toUpperCase();
  const body = (() => { try { return options.body ? JSON.parse(options.body) : {}; } catch { return {}; } })();

  if (!world) {
    starting ||= server('/api/me').then(initWorld);
    await starting;
  }
  if (p === '/api/me') return meResponse();
  if (READ_FROM_HUB.has(p) && method === 'GET') return server(path, options);
  if (p === '/api/prefs/tiles') { world.tiles = body; return { ok: true }; }

  // A moment's pause, so the page behaves as it does for real.
  await wait(method === 'GET' ? 120 : 260);
  // A picture for a release note: kept in the browser, nothing is sent.
  if (p === '/api/mes/notes/upload') {
    const nt = world.mes.notes;
    const file = options.body;
    const id = `up${nextId()}`;
    nt.uploads[id] = { src: URL.createObjectURL(file), filename: decodeURIComponent(options.headers?.['x-filename'] || 'picture.png') };
    return { id, filename: nt.uploads[id].filename, mimeType: file.type, src: nt.uploads[id].src };
  }
  return clone(await answer(p, q, method, body));
}

async function answer(p, q, method, body) {
  const post = method === 'POST';

  // Everyday bits the hub asks for in the background.
  if (p === '/api/sync') return { changed: 0 };
  if (p.startsWith('/api/tracker')) {
    const action = p.replace('/api/tracker', '').replace(/^\//, '');
    return tracker(action || 'status', body);
  }

  // The strip on the home screen
  if (p === '/api/home') {
    const monday = mondayOf(today());
    const days = Array.from({ length: 5 }, (_, i) => addDays(monday, i));
    const secs = (d) => world.worklogs.filter((w) => w.work_date === d).reduce((t, w) => t + w.seconds, 0);
    // One weekday with nothing logged, so the week shows what a gap looks like.
    const gap = days.find((d) => d < today() && d !== monday);
    const shown = (d) => (d === gap ? 0 : secs(d));
    return {
      alerts: [
        ...world.homeMessages.filter((m) => m.kind === 'alert'),
        { key: 'quote', tone: 'info', title: 'Priya Shah would like your estimate', body: 'Second intake weigher for Harbour Mills, Site visit.', link: '#/quotes' },
        { key: 'psc', tone: 'important', title: 'Hannah Price is waiting on you', body: 'She replied on NGB-140, Mixer 3 weigher reading 2kg heavy.', link: '#/psc' },
      ],
      news: world.homeMessages.filter((m) => m.kind === 'announcement'),
      week: { seconds: days.reduce((t, d) => t + shown(d), 0), target: 37.5 * 3600,
        days: days.map((d) => ({ date: d, seconds: shown(d), past: d < today(), today: d === today() })),
        missing: days.filter((d) => d < today() && !shown(d)) },
    };
  }
  if (p === '/api/home/dismiss') { world.homeMessages = world.homeMessages.filter((m) => String(m.id) !== String(body.id)); return { ok: true }; }

  // Log time
  if (p === '/api/log/shortcuts') {
    const recentKeys = [...new Set([...world.worklogs].reverse().map((w) => w.issue_key))].slice(0, 4);
    const opt = (k) => allStages().find((s) => s.label === k) || { label: k, title: issueTitle(k), sublabel: 'Internal', issueId: idOf(k), rate: null, jobElo: null };
    return { recent: recentKeys.map(opt), assigned: [opt('HBM-207'), ...world.psc.filter((x) => x.assigneeId === me.id && !x.done).map((x) => ({ label: x.key, title: x.summary, sublabel: x.customer || 'PSC board', issueId: x.id, rate: 1, jobElo: null }))] };
  }
  if (p === '/api/log/browse') return browse(q.get('node') || 'root');
  if (p === '/api/log/search') return { options: search(q.get('q') || '') };
  if (p === '/api/log/hint') return { times: 14, typicalHours: 6.5 };
  if (p === '/api/log/worklog') return logWorklog(body);
  if (p === '/api/log/flag-stage') return { ok: true };
  if (p === '/api/log/psc') {
    const key = `${body.projectKey}-${150 + world.psc.length}`;
    const c = customer(body.projectKey);
    world.psc.push(pscItem(me.id, { key, project: body.projectKey, summary: body.summary || 'Service item', type: body.issueType || 'Service Request', reporter: me.name, ageMins: 1,
      assignee: me.name, assigneeId: me.id, response: { at: iso(now()), by: me.name, how: 'raised by the team', waitMs: 0, late: false } }));
    return { key, id: idOf(key), customer: c?.name };
  }
  if (p === '/api/contracts/check') return { contract: null };

  // My time
  if (p === '/api/time') {
    const monday = q.get('week');
    const end = addDays(monday, 6);
    return { entries: world.worklogs.filter((w) => w.work_date >= monday && w.work_date <= end).sort((a, b) => b.work_date.localeCompare(a.work_date) || Number(b.worklog_id) - Number(a.worklog_id)) };
  }

  // XP and rank
  if (p === '/api/leaderboard') return q.get('metric') === 'elo' ? eloBoard(q.get('period') || 'quarter') : leaderboard(q.get('period') || 'week');
  if (p === '/api/elo/history') return eloHistory(1100);
  if (p === '/api/modifiers') return { modifiers: world.modifiers, kinds: ['Supporting apprentices', 'Training someone', 'Covering for absence', 'Learning on the job', 'Heavy workload', 'Unwell', 'Personal circumstances'], supervisor: 'Sam Turner' };
  if (p === '/api/modifiers/request') {
    if (!body.kind) throw new Error('Choose what it is.');
    world.modifiers.push({ id: Number(nextId()), kind: body.kind, status: 'pending', start_date: body.from || today(), end_date: body.until || null });
    return { ok: true };
  }
  if (p === '/api/modifiers/end') {
    world.modifiers = world.modifiers.filter((m) => String(m.id) !== String(body.id));
    world.leadModifiers = world.leadModifiers.filter((m) => String(m.id) !== String(body.id));
    return { ok: true };
  }
  if (p === '/api/modifiers/decide') { world.leadModifiers = world.leadModifiers.filter((m) => String(m.id) !== String(body.id)); return { ok: true }; }

  // Jobs
  if (p === '/api/jobs') return jobsList(q.get('scope') || 'mine');
  if (p === '/api/jobs/subtasks') return { byParent: {} };
  if (p === '/api/jobs/transitions') return { transitions: [] };
  if (p === '/api/approvals') return { disputes: world.disputes, modifiers: world.leadModifiers, countChecks: [], supervised: [] };
  if (p === '/api/jobs/category') {
    const c = allCategories().find((x) => x.id === q.get('id'));
    return { id: c.id, key: c.key, discipline: c.discipline, epicKey: c.order.key, orderSummary: c.order.summary, customer: c.order.customer, loggedSeconds: c.loggedSeconds,
      current: { ...c.scores, estimateSeconds: c.estimateSeconds, elo: c.jobElo }, quoted: c.scores, reasons: REASONS, history: [] };
  }
  if (p === '/api/jobs/dispute') {
    for (const o of world.jobs) for (const c of o.categories) if (c.id === body.categoryId) { c.pendingDispute = true; c.pendingIsMine = true; }
    return { ok: true };
  }
  if (p === '/api/jobs/dispute-decide') {
    world.disputes = world.disputes.filter((d) => String(d.id) !== String(body.id));
    for (const o of world.jobs) for (const c of o.categories) if (c.key === 'ASF-71') {
      c.pendingDispute = false;
      if (body.decision === 'approve') { c.disputed = true; c.quotedElo = c.jobElo; c.jobElo = eloFromScores(body.scores); if (body.estimateHours) c.estimateSeconds = Number(body.estimateHours) * 3600; c.pct = c.loggedSeconds / c.estimateSeconds; }
    }
    return { status: body.decision === 'approve' ? 'approved' : 'declined', jiraSynced: true };
  }

  // Quotes
  if (p === '/api/quotes') {
    const scope = q.get('scope') || 'open';
    const canCreate = Boolean(me.user?.can?.quotes);
    const list = world.quotes.list.filter((x) => scope === 'all' || (scope === 'mine' ? x.created_name === me.name : ['open', 'ready'].includes(x.status)));
    return { requests: world.quotes.requests.filter((r) => r.status === 'pending'), quotes: canCreate ? list : [], canCreate, teams: ['Projecting', 'Service', 'Condor'] };
  }
  if (p === '/api/quotes/open') {
    const names = Object.fromEntries(CUSTOMERS.map((c) => [c.key, c.name]));
    return { quotes: world.quotes.open.map((x) => ({ ...x, customer: names[x.project] || x.project })), readAt: now(), movedThisWeek: { quotes: 2 }, notMoved: [], teams: ['Projecting', 'Service', 'Condor'] };
  }
  if (p === '/api/quotes/team') {
    const qt = world.quotes.list.find((x) => x.id === body.id); qt.team = body.team;
    const o = world.quotes.open.find((x) => x.key === qt.quote_key); if (o) o.team = body.team;
    return { ok: true, jiraUpdated: true };
  }
  if (p === '/api/quotes/get') return quoteGet(q.get('id'));
  if (p === '/api/quotes/people') return { people: [...PEOPLE].map((x) => ({ account_id: x.id, name: x.name, team: x.team })) };
  if (p === '/api/quotes/customers') return { customers: CUSTOMERS.map((c) => ({ key: c.key, name: c.name })) };
  if (p === '/api/quotes/create') {
    if (!body.projectKey) throw new Error('Choose the customer.');
    if (!body.title) throw new Error('Give it a title.');
    const id = `q${++world.quotes.seq}`;
    const key = `${body.projectKey}-${240 + world.quotes.seq}`;
    world.quotes.list.unshift({ id, title: body.title, project_key: body.projectKey, customer: body.customer, quote_key: key, status: 'open', team: body.team, created_name: me.name,
      description: body.description || '', sections: (body.disciplines?.length ? body.disciplines : ['software']).map((d) => blankSection(d)) });
    world.quotes.open.unshift({ key, project: body.projectKey, summary: body.title, status: 'Open', team: body.team, assignee: me.name, reporter: me.name, created: iso(now()), hubId: id });
    return { id, quoteKey: key };
  }
  if (p === '/api/quotes/section') {
    const qt = world.quotes.list.find((x) => x.id === body.quoteId);
    const s = qt.sections.find((x) => x.discipline === body.discipline);
    Object.assign(s, body.data, { estimator: me.name, estimator_id: me.id });
    return { help: quoteHelp(s) };
  }
  if (p === '/api/quotes/ask') {
    const person = PEOPLE.find((x) => x.id === body.accountId);
    world.quotes.asks.push({ id: nextId(), quote_id: body.quoteId, discipline: body.discipline, account_id: body.accountId, name: person?.name, status: 'pending', note: body.note });
    return { ok: true };
  }
  if (p === '/api/quotes/status') { const qt = world.quotes.list.find((x) => x.id === body.id); qt.status = body.status; return { jiraUpdated: true }; }
  if (p === '/api/quotes/description') { const qt = world.quotes.list.find((x) => x.id === body.id); qt.description = body.description; return { jiraUpdated: true }; }
  if (p === '/api/quotes/answer') {
    const r = world.quotes.requests.find((x) => String(x.id) === String(body.requestId));
    if (r) r.status = 'answered';
    return { commented: true };
  }
  if (['/api/quotes/use-answer', '/api/quotes/retry-jira', '/api/quotes/check-counts'].includes(p)) return { ok: true };

  // Condor
  if (p === '/api/devtime/drafts') return { days: world.mes.drafts };
  if (p === '/api/devtime/dismiss') {
    for (const d of world.mes.drafts) d.drafts = d.drafts.filter((x) => !(d.day === body.day && x.key === body.key));
    world.mes.drafts = world.mes.drafts.filter((d) => d.drafts.length);
    return { ok: true };
  }
  if (p === '/api/devtime/log') {
    for (const x of body.items || []) logWorklog({ issueKey: x.key, seconds: x.seconds, date: body.day, description: 'From Bitbucket activity' });
    world.mes.drafts = world.mes.drafts.filter((d) => d.day !== body.day);
    return { results: (body.items || []).map((x) => ({ ok: true, key: x.key })), logged: (body.items || []).length };
  }
  if (p === '/api/mes/outstanding') {
    const m = world.mes;
    const filter = q.get('filter');
    const base = { canTriage: Boolean(me.user?.can?.condorPlan), canEstimate: true, priorities: ['Must', 'Should', 'Could'],
      tags: ['Database change', 'Needs investigation', 'Customer testing needed', 'UI only', 'Touches several modules'],
      hints: { 1: 'A small change in familiar code', 2: 'Routine work in a module the team knows', 3: 'A typical feature or fix with some thinking in it', 4: 'Tricky: unfamiliar code, several parts, or careful testing', 5: 'New ground: design decisions, unknowns, or risk of breaking things' },
      versions: m.versions, catchingUp: false, known: m.tickets.length,
      team: [{ id: 'ex-amy', name: 'Amy Clarke' }, { id: me.id, name: me.name }, { id: 'ex-tom', name: 'Tom Reid' }],
      noteKinds: ['none', 'sentence', 'paragraph', 'photo'] };
    const withPriority = m.tickets.map((t) => ({ ...t, notes_kind: m.kinds[t.issue_id] ?? t.notes_kind, priority: m.triaged[t.issue_id] ? (m.triaged[t.issue_id] === 'none' ? 'Not this time' : m.triaged[t.issue_id]) : null, version_name: m.triaged[t.issue_id] && m.triaged[t.issue_id] !== 'none' ? 'Gobi' : null }));
    if (filter === 'none') return { ...base, tickets: [] };
    if (filter === 'untriaged') {
      const left = withPriority.filter((t) => !m.triaged[t.issue_id]);
      return { ...base, tickets: left, release: { sprints: [] }, inRelease: Object.values(m.triaged).filter((v) => v !== 'none').length + 2 };
    }
    const list = filter === 'unestimated' ? withPriority.filter((t) => t.hours == null) : withPriority;
    return { ...base, tickets: list, total: list.length };
  }
  if (p === '/api/mes/question') return mesQuestion(body);
  if (p === '/api/mes/estimate') {
    const t = [...world.mes.tickets, ...world.mes.mid].find((x) => x.issue_id === body.issueId);
    let hours;
    if (body.method === 'timebox') { hours = Number(body.timeboxHours) || 4; t.timebox = true; }
    else if (body.method === 'three-point') hours = ((Number(body.best) || 0) + 4 * (Number(body.likely) || 0) + (Number(body.worst) || 0)) / 6 || 4;
    else hours = mesQuestion({ issueId: body.issueId, answers: body.answers || [] }).estimate?.hours || 6;
    if (!body.difficulty && body.method !== 'timebox') throw new Error('Say how hard it is to do well.');
    t.hours = Math.round(hours * 4) / 4;
    t.difficulty = body.difficulty || 3;
    return { hours: t.hours, jiraSynced: true };
  }
  if (p === '/api/mes/triage') {
    const m = world.mes;
    const t = [...m.tickets, ...m.mid].find((x) => x.issue_id === body.issueId);
    if (body.priority !== 'none' && !body.assigneeId && !t?.assignee_id) throw new Error('Choose who will do it.');
    if (body.priority !== 'none' && t?.hours == null) throw new Error('Estimate it first, so the plan knows how long it takes.');
    if (body.priority !== 'none' && !body.notes && !t?.notes_kind && !m.kinds[body.issueId]) throw new Error('Choose how it appears in the release notes.');
    if (t && body.assigneeId) { t.assignee_id = body.assigneeId; t.assignee_name = [{ id: 'ex-amy', name: 'Amy Clarke' }, { id: me.id, name: me.name }, { id: 'ex-tom', name: 'Tom Reid' }].find((x) => x.id === body.assigneeId)?.name; }
    if (body.notes) m.kinds[body.issueId] = body.notes;
    if (body.mode === 'mid') {
      m.reviewed[body.issueId] = true;
      if (body.priority === 'none') return { jiraSynced: true, movedTo: m.versions[1]?.name || null };
      return { jiraSynced: true };
    }
    m.triaged[body.issueId] = body.priority; return { jiraSynced: true };
  }
  if (p === '/api/mes/mid-release') {
    const m = world.mes;
    const tickets = m.mid.map((t) => ({ ...t, notes_kind: m.kinds[t.issue_id] ?? t.notes_kind, reviewed: Boolean(m.reviewed[t.issue_id]) }));
    return { version: m.versions[0], next: m.versions[1], tickets, total: tickets.length, reviewed: tickets.filter((t) => t.reviewed).length,
      team: [{ id: 'ex-amy', name: 'Amy Clarke' }, { id: me.id, name: me.name }, { id: 'ex-tom', name: 'Tom Reid' }], noteKinds: ['none', 'sentence', 'paragraph', 'photo'],
      priorities: ['Must', 'Should', 'Could'], tags: [], hints: {}, canEstimate: true, canTriage: true };
  }
  if (p === '/api/mes/mid-release/restart') { world.mes.reviewed = {}; return { ok: true }; }
  if (p === '/api/mes/notes') return mesNotes(q.get('versionId'));
  if (p === '/api/mes/notes/item') {
    const e = world.mes.notes.edits[body.issueId] = world.mes.notes.edits[body.issueId] || {};
    if (body.blocks !== undefined) e.blocks = body.blocks;
    if (body.title !== undefined) e.title = body.title;
    if (body.module !== undefined) e.module = body.module;
    if (body.kind !== undefined) e.kind = body.kind;
    return { ok: true, jiraSynced: true };
  }
  if (p === '/api/mes/notes/write') {
    const nt = world.mes.notes;
    const item = nt.items.find((i) => i.id === body.issueId);
    const e = nt.edits[body.issueId] = nt.edits[body.issueId] || {};
    const kind = e.kind !== undefined ? e.kind : item.kind;
    const text = String(body.text || '').trim();
    if (!text) throw new Error(kind === 'sentence' ? 'Write the sentence first.' : 'Write the paragraph first.');
    if (kind === 'sentence' && /\n/.test(text)) throw new Error('Keep it to a single sentence, on one line.');
    const known = new Map([...item.blocks.filter((b) => b.type === 'image').map((b) => [b.attachmentId, b]),
      ...Object.entries(nt.uploads).map(([id, u]) => [id, { type: 'image', attachmentId: id, filename: u.filename, src: u.src }])]);
    if (kind !== 'sentence' && !String(body.title || '').trim()) throw new Error('Give it a heading, such as "Multiple scales per station".');
    const pics = kind === 'photo' ? (body.images || []).map((x) => known.get(x.id) && { ...known.get(x.id), caption: x.caption || '' }).filter(Boolean) : [];
    if (kind === 'photo' && !pics.length) throw new Error('Add at least one picture.');
    e.blocks = [...text.split(/\n\s*\n/).map((t) => ({ type: 'text', text: t.trim() })).filter((b) => b.text), ...pics];
    if (kind !== 'sentence') e.title = String(body.title).trim();
    return { ok: true, jiraSynced: true };
  }
  if (p === '/api/mes/notes/intro') { world.mes.notes.intro = body.intro; if (body.number !== undefined) world.mes.notes.number = body.number; return { ok: true }; }
  if (p === '/api/mes/release') { const v = { id: `v${world.mes.versions.length + 1}`, name: body.name || 'New release', releaseDate: body.releaseDate || addDays(today(), 90) }; world.mes.versions.push(v); return v; }
  if (p === '/api/mes/make-sprints') return { moved: 4, board: { created: false, name: 'MES' } };
  if (p === '/api/mes/plan') return mesPlan();
  if (p === '/api/mes/suggestion') { world.mes.suggestions = world.mes.suggestions.filter((s) => s.id !== body.issueId); return { ok: true }; }
  if (p === '/api/mes/accept-plan') { world.mes.accepted = { at: iso(now()), count: mesPlan().schedule.filter((s) => s.fits).length, waiting: 0 }; return { waiting: 0, startField: true, sprints: { moved: 0 } }; }
  if (['/api/mes/reserve', '/api/mes/capacity'].includes(p)) return { ok: true };
  if (p === '/api/mes/team') return { team: [{ account_id: 'ex-tom', name: 'Tom Reid', condor_elo: 1240, jobs: 18 }, { account_id: 'ex-amy', name: 'Amy Clarke', condor_elo: 1105, jobs: 9 }] };
  if (p === '/api/mes/rating') {
    const who = q.get('accountId');
    const person = PEOPLE.find((x) => x.id === who);
    return { ...eloHistory(1050, person?.name || me.name), name: person?.name || me.name };
  }

  // Point of work
  if (p === '/api/pow/forms') return { forms: world.pow };
  if (p === '/api/pow/browse') {
    const node = q.get('node') || 'root';
    if (node === 'root') return { title: 'Whose site are you on?', subtitle: 'Visits planned for this week', options: CUSTOMERS.slice(0, 3).map((c) => ({ label: c.name, sublabel: c.key, next: `pow:${c.key}` })) };
    const key = node.split(':')[1];
    const visits = { NGB: [['NGB-131', 'Service visit, line 2']], HBM: [['HBM-207', 'Site - Commissioning'], ['HBM-208', 'Site - Installation']], ASF: [['ASF-66', 'Calibration visit']] }[key] || [];
    return { title: customer(key).name, subtitle: 'Which visit?', options: visits.map(([k, t]) => ({ label: k, title: t, sublabel: 'Due today', issueId: idOf(k) })), allowMissing: true };
  }
  if (p === '/api/pow/visit') {
    const k = q.get('issueKey');
    const c = customer(k.split('-')[0]);
    return { projectKey: c.key, customer: c.name, site: { NGB: 'Unit 4, Northgate Road', HBM: 'The Old Quay, Harbour Lane', ASF: 'Ashby Mill, Station Road' }[c.key], contact: { NGB: 'Hannah Price', HBM: 'Rob Fenwick', ASF: 'Leah Grant' }[c.key], contactPhone: '01632 960000', contactEmail: '' };
  }
  if (p === '/api/pow/draft') {
    const row = { id: body.id, issue_key: body.issueKey, customer: body.details?.customer, status: 'draft', updated_at: iso(now()), data: body };
    world.pow = [row, ...world.pow.filter((f) => f.id !== body.id)];
    return { id: body.id, status: 'draft' };
  }
  if (p === '/api/pow/form') return { data: world.pow.find((f) => f.id === q.get('id'))?.data || null };
  if (p === '/api/pow/delete') { world.pow = world.pow.filter((f) => !(f.id === body.id && f.status === 'draft')); return { ok: true }; }
  if (p === '/api/pow/submit') {
    world.pow = [{ id: body.id, issue_key: body.issueKey, customer: body.details?.customer, status: 'submitted', submitted_at: iso(now()) }, ...world.pow.filter((f) => f.id !== body.id)];
    return { id: body.id, jiraAttached: true, driveFileId: 'example', notes: [] };
  }

  // Obsolescence
  if (p === '/api/obs/surveys') return { surveys: world.obs };
  if (p === '/api/obs/reports') return { reports: [
    { key: 'ASF-77', client: 'Ashby Feeds', status: 'Survey due', projectKey: 'ASF', serviceContract: 'Silver', contractNo: 'ASF-61', siteContact: 'Leah Grant' },
    { key: 'HBM-31', client: 'Harbour Mills', status: 'Survey due', projectKey: 'HBM', serviceContract: 'Platinum', contractNo: 'HBM-40', siteContact: 'Rob Fenwick' },
    { key: 'NGB-77', client: 'Northgate Bakery', status: 'Up to date', projectKey: 'NGB', serviceContract: 'Gold', contractNo: 'NGB-90', siteContact: 'Hannah Price' },
  ] };
  if (p === '/api/obs/draft') {
    const row = { id: body.id, client: body.title?.client, report_key: body.reportKey, status: 'draft', updated_at: iso(now()), data: body };
    world.obs = [row, ...world.obs.filter((s) => s.id !== body.id)];
    return { id: body.id, status: 'draft' };
  }
  if (p === '/api/obs/survey') return { data: world.obs.find((s) => s.id === q.get('id'))?.data || null };
  if (p === '/api/obs/delete') { world.obs = world.obs.filter((s) => !(s.id === body.id && s.status === 'draft')); return { ok: true }; }
  if (p === '/api/obs/submit') {
    world.obs = [{ id: body.id, client: body.title?.client, report_key: body.reportKey, status: 'submitted', submitted_at: iso(now()) }, ...world.obs.filter((x) => x.id !== body.id)];
    return { notes: [] };
  }
  if (p === '/api/obs/sales') return { reports: world.obsSales };
  if (p === '/api/obs/quote') {
    world.obsSales = world.obsSales.filter((r) => r.key !== body.reportKey);
    return { quoteKey: body.needed ? 'HBM-250' : null, notes: [] };
  }

  // 8x8 calls
  if (p === '/api/calls') {
    const all = q.get('all') === '1';
    const calls = all ? [...world.calls, { callId: 'c9', direction: 'in', otherName: 'Leah Grant', otherRaw: '01632 960702', other: '+441632960702', started: `${today()}T09:30:00`, talkTime: '4m 10s', seconds: 250, customer: { label: 'Ashby Feeds', project_key: 'ASF' }, handled: null, handledBy: 'Ellie Morgan' }] : world.calls;
    return { date: q.get('date') || today(), calls, showingAll: all, total: 4, matched: world.calls.length };
  }
  if (p === '/api/calls/customers') return { customers: CUSTOMERS.map((c) => ({ key: c.key, name: c.name })) };
  if (p === '/api/calls/pscs') {
    const key = q.get('projectKey');
    return { options: world.psc.filter((x) => x.project === key && !x.done).map((x) => ({ label: x.key, title: x.summary, sublabel: `${x.type}, ${x.status}`, issueId: x.id, rate: 1, jobElo: null })) };
  }
  if (p === '/api/calls/link') {
    const call = world.calls.find((c) => c.other === body.phone);
    if (call && body.projectKey) call.customer = { label: body.label, project_key: body.projectKey };
    return { ok: true };
  }
  if (p === '/api/calls/handled') {
    const call = world.calls.find((c) => c.callId === body.callId);
    if (call) call.handled = { action: body.action, issue_key: body.issueKey || null };
    return { ok: true };
  }

  // IT support
  if (p === '/api/it/options') return {
    categories: [['hardware-fault', 'Broken or faulty hardware', 'Laptops, phones, printers, anything physical'], ['software-problem', 'Software or system problem', 'Something not working as it should'],
      ['account', 'Account or access request', 'New account, password, access to something'], ['admin-access', 'Admin access request', 'Rights to install or change something'],
      ['new-hardware', 'New hardware', 'Laptop, phone, monitor, other equipment'], ['new-software', 'New software', 'A licence or an application you need'], ['other', 'Something else', 'If none of the above fit']]
      .map(([id, label, hint]) => ({ id, label, hint, ready: true })),
    urgencies: [['blocked', "I can't work until this is fixed"], ['slowed', 'It is slowing me down, but I have a way round it'], ['soon', 'Not urgent, but it needs sorting'], ['whenever', 'Nice to have when there is time']].map(([id, label]) => ({ id, label })),
  };
  if (p === '/api/it/requests') return { requests: world.it.map((r) => ({ ...r, url: '#' })) };
  if (p === '/api/it/assets') return { assets: [
    { key: 'ASSET-1042', label: 'ASSET-1042', title: 'Dell Latitude 5440 laptop', sublabel: 'Laptop, In use' },
    { key: 'ASSET-1187', label: 'ASSET-1187', title: 'Samsung Galaxy A54 phone', sublabel: 'Phone, In use' },
  ].filter((a) => !q.get('q') || a.title.toLowerCase().includes(q.get('q').toLowerCase())) };
  if (p === '/api/it/raise') {
    const key = `IT-${330 + world.it.length}`;
    world.it.unshift({ key, summary: body.summary, status: 'Waiting for support', priority: { blocked: 'Highest', slowed: 'High', soon: 'Medium', whenever: 'Low' }[body.urgency] || 'Medium', assignee: 'IT support', done: false });
    return { key, notes: [] };
  }

  // Vehicles
  if (p === '/api/vehicles') return { vehicles: world.vehicles.fleet };
  if (p === '/api/vehicles/mine') return { bookings: world.vehicles.bookings };
  if (p === '/api/vehicles/week') {
    const week = q.get('week');
    const all = [...world.vehicles.others, ...world.vehicles.bookings.map((b) => ({ vehicle_id: b.vehicle_id, starts_at: b.starts_at, ends_at: b.ends_at, engineer: me.name }))];
    return { weekStart: week, bookings: all.filter((b) => b.starts_at.slice(0, 10) >= week && b.starts_at.slice(0, 10) <= addDays(week, 6)) };
  }
  if (p === '/api/vehicles/defects') return { defects: world.vehicles.defects };
  if (p === '/api/vehicles/book') {
    const v = world.vehicles.fleet.find((x) => x.id === body.vehicleId);
    if (!v) throw new Error('Choose a vehicle.');
    if (body.endsAt <= body.startsAt) throw new Error('The end needs to be after the start.');
    world.vehicles.bookings.push({ id: nextId(), vehicle_id: v.id, registration: v.registration, make: v.make, model: v.model, starts_at: body.startsAt.slice(0, 16), ends_at: body.endsAt.slice(0, 16), issue_key: body.issueKey });
    return { ok: true };
  }
  if (p === '/api/vehicles/cancel') { world.vehicles.bookings = world.vehicles.bookings.filter((b) => b.id !== body.id); return { ok: true }; }
  if (p === '/api/vehicles/check') {
    const fails = Object.entries(body.results || {}).filter(([, r]) => r.result === 'fail');
    const v = world.vehicles.fleet.find((x) => x.id === body.vehicleId);
    for (const [item, r] of fails) world.vehicles.defects.push({ id: nextId(), registration: v.registration, item: item.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), severity: body.fitToDrive ? 'minor' : 'not-fit', note: r.note, reporter: me.name, created_at: iso(now()) });
    if (fails.length) v.openDefects += fails.length;
    if (body.mileage) v.mileage = Number(body.mileage);
    return { defects: fails.length, transitionNote: null };
  }
  if (p === '/api/vehicles/resolve-defect') { world.vehicles.defects = world.vehicles.defects.filter((d) => d.id !== body.id); return { ok: true }; }

  // PSC
  if (p === '/api/psc') return pscOverview();
  if (p === '/api/psc/item') {
    const item = world.psc.find((x) => x.key === q.get('key'));
    refreshPsc(item);
    return { item: clone(item), timeline: item.timeline };
  }
  if (p === '/api/psc/orgs') return { orgs: CUSTOMERS.map((c, i) => ({ id: String(i + 1), name: c.name })) };
  if (p === '/api/psc/pickup') return pscPickup(body.key);
  if (p === '/api/psc/resolve') {
    const item = world.psc.find((x) => x.key === body.key);
    if (item) {
      Object.assign(item, { status: 'Resolved [Promtek]', done: true, chargeable: body.chargeable ? 'yes' : 'no', resolvedAt: iso(now()) });
      item.timeline.unshift({ at: iso(now()), by: me.name, team: true, kind: 'status', text: 'In Progress → Resolved [Promtek]' });
      refreshPsc(item);
    }
    return { ok: true, saved: true };
  }
  if (p === '/api/psc/charge') {
    const item = world.psc.find((x) => x.key === body.key);
    if (item) { item.chargeable = body.chargeable ? 'yes' : 'no'; refreshPsc(item); }
    return { ok: true, saved: true };
  }
  if (p === '/api/psc/assign') {
    const item = world.psc.find((x) => x.key === body.key);
    const person = [{ id: me.id, name: me.name }, ...PEOPLE].find((x) => x.id === body.accountId);
    item.assignee = person.name; item.assigneeId = person.id;
    item.timeline.unshift({ at: iso(now()), by: me.name, team: true, kind: 'assignee', text: `Assigned to ${person.name}` });
    refreshPsc(item);
    return { saved: true };
  }
  if (p === '/api/psc/org') {
    const item = world.psc.find((x) => x.key === body.key);
    const c = CUSTOMERS[Number(body.orgId) - 1];
    Object.assign(item, { org: c.name, customer: c.name, customerKey: c.key, tier: c.tier ? c.tier.toLowerCase() : 'none' });
    item.tierName = TIERS[item.tier].name;
    item.tierRank = TIERS[item.tier].rank;
    item.contract = c.contract ? { key: c.contract, tier: c.tier, status: 'In Contract', bankHoliday: c.bankHoliday, end: addDays(today(), 160), tokensFree: 4 } : null;
    item.uncopied = true;
    item.timeline.unshift({ at: iso(now()), by: me.name, team: true, kind: 'hub', text: `Organization set to ${c.name}` });
    refreshPsc(item);
    return { saved: true };
  }
  if (p === '/api/psc/refresh') return { count: world.psc.length };
  if (p === '/api/psc/insights') {
    const items = world.psc.map((x) => refreshPsc(x));
    return {
      settings: { targets: TARGET_H }, response: { count: 23, medianMs: 52 * MIN, inTarget: 20, unanswered: items.filter((x) => !x.response.at).length },
      byTier: Object.entries(TIERS).map(([tier, t]) => ({ tier, name: t.name, target: TARGET_H[tier], count: { platinum: 6, gold: 9, silver: 5, none: 3 }[tier], inTarget: { platinum: 6, gold: 8, silver: 4, none: 2 }[tier], medianMs: { platinum: 25, gold: 70, silver: 110, none: 200 }[tier] * MIN, open: items.filter((x) => x.tier === tier && !x.done).length })),
      weeks: [-21, -14, -7, 0].map((d, i) => ({ start: addDays(mondayOf(today()), d), raised: [6, 5, 7, 4][i], inTarget: [5, 5, 6, 3][i], answered: [6, 5, 7, 3][i], resolved: [5, 6, 6, 2][i] })),
      states: { late: 0, waiting: items.filter((x) => x.customerWaiting).length, quiet: 0, open: items.length },
      ages: [{ label: 'Under 2 days', n: 3 }, { label: '2 to 7 days', n: 2 }, { label: '1 to 4 weeks', n: 0 }, { label: 'Over 4 weeks', n: 0 }],
      byCustomer: [{ name: 'Harbour Mills', n: 2 }, { name: 'Northgate Bakery', n: 1 }, { name: 'Ashby Feeds', n: 1 }, { name: 'Kingsway Dairies', n: 1 }],
      byAssignee: [{ name: me.name, n: 1 }, { name: 'Sam Turner', n: 1 }, { name: 'Ellie Morgan', n: 1 }],
      oldestQuiet: items.filter((x) => x.lastTeam).sort((a, b) => Date.parse(a.lastTeam.at) - Date.parse(b.lastTeam.at)).slice(0, 3).map((x) => ({ key: x.key, summary: x.summary, customer: x.customer, lastTeam: x.lastTeam })),
    };
  }

  // Service contracts
  if (p === '/api/contracts') {
    return { started: ago(40 * DAY), clockStart: addDays(today(), -40), clockChanged: ago(2 * HOUR), syncedAt: ago(4 * MIN), error: null,
      flags: world.contractFlags, canInsights: Boolean(me.user?.isLead || me.user?.isAdmin || me.user?.can?.oversight), isAdmin: false, today: today(),
      bankHoliday: { today: null, next: { name: 'Christmas Day', date: `${today().slice(0, 4)}-12-25` } }, contracts: world.contracts.map(withWaiting) };
  }
  if (p === '/api/contracts/mine') return { time: world.contractTime.filter((t) => t.mine).map((t) => ({ worklog_id: t.worklogId, work_date: t.date, seconds: t.seconds, issue_key: t.key, customer: 'Northgate Bakery' })) };
  if (p === '/api/contracts/charge') {
    const t = world.contractTime.find((x) => x.worklogId === String(body.worklogId));
    world.contractTime = world.contractTime.filter((x) => x !== t);
    const c = t && world.contracts.find((x) => x.key === t.contract);
    if (c?.clock && body.chargeable) {
      const seconds = c.clock.seconds + t.seconds;
      c.clock = { ...c.clock, seconds, towardsNext: seconds % (4 * 3600) };
    }
    return { ok: true, contract: t?.contract };
  }
  if (p === '/api/contracts/detail') return contractDetail(q.get('key'));
  if (p === '/api/contracts/insights') return contractInsights();
  if (p === '/api/contracts/resolve') { world.contractFlags = world.contractFlags.filter((f) => f.id !== Number(body.id)); return { ok: true }; }

  // Employee of the Quarter
  if (p.startsWith('/api/eotq')) return eotqAnswer(p, q, post, body);

  // Requests
  if (p === '/api/requests') {
    const dev = Boolean(me.user?.isAdmin || me.user?.can?.developer);
    if (post) {
      if (!body.kind) throw new Error('Say what kind of request it is.');
      if (!String(body.title || '').trim()) throw new Error('Give it a title.');
      world.requests.unshift({ id: Number(nextId()), kind: body.kind, tile: body.tile, title: body.title, details: body.details || '', status: 'new', reply: null, created_at: iso(now()), name: me.name, email: '' });
      return { ok: true };
    }
    const status = q.get('status') || '';
    const list = world.requests.filter((r) => !dev || !status || (status === 'open' ? ['new', 'working'].includes(r.status) : r.status === status));
    const counts = world.requests.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
    return { requests: dev ? list : world.requests.filter((r) => r.name === me.name), developer: dev, counts,
      kinds: { tile: 'A new tile', change: 'A change to a tile', problem: 'Something not working' }, statuses: { new: 'New', working: 'Working on it', complete: 'Complete', rejected: 'Not going ahead' } };
  }
  if (p === '/api/requests/update') {
    const r = world.requests.find((x) => String(x.id) === String(body.id));
    Object.assign(r, { status: body.status, reply: body.reply, updated_by: me.name });
    return { ok: true };
  }

  // Reports
  if (p === '/api/reports/team') return reportTeam(Number(q.get('weeks')) || 8);
  if (p === '/api/reports/engineer') {
    const id = q.get('accountId');
    const person = [{ id: me.id, name: me.name, team: world.employee.team }, ...PEOPLE].find((x) => x.id === id) || PEOPLE[0];
    const t = reportTeam(8);
    const row = t.people.find((x) => x.account_id === person.id);
    return {
      employee: { name: person.name, email: `${person.name.split(' ')[0].toLowerCase()}@example.com`, team: person.team, role: 'Engineer', accountId: person.id, progress: world.employee.progress, elo: 1180, rank: { name: 'Kilogram I' } },
      weeks: t.weeks, byWeek: t.weeks.map((w) => ({ week_start: w, ...row.weeks[w] })), snapshots: [],
      topJobs: [{ issue_key: 'HBM-208', summary: 'Site - Installation', seconds: 22 * 3600, xp: 1360 }, { issue_key: 'NGB-122', summary: 'Software - FAT', seconds: 14 * 3600, xp: 870 }],
      recent: world.worklogs.slice(-6).reverse(),
    };
  }
  if (p === '/api/reports/elo') {
    const weeks = Number(q.get('weeks')) || 26;
    const list = Array.from({ length: weeks }, (_, i) => addDays(mondayOf(today()), (i - weeks + 1) * 7));
    const people = [...ELO_BOARD, [me.name, 1180, 18, 3]].map(([name, elo, change, jobs], k) => {
      const total = Math.round(change * weeks / 13);
      const from = elo - total;
      const series = list.map((_, i) => Math.round(from + (total * Math.min(1, Math.max(0, (i - k) / (weeks - k - 1 || 1))))));
      series[series.length - 1] = elo;
      const person = PEOPLE.find((x) => x.name === name);
      const rankName = (e) => (e < 1100 ? 'Gram II' : e < 1300 ? 'Kilogram I' : e < 1500 ? 'Kilogram II' : 'Tonne I');
      return { accountId: person?.id || me.id, name, team: person?.team || world.employee.team, elo, from, change: total, rank: rankName(elo), rankFrom: rankName(from),
        jobs: Math.round(jobs * weeks / 13), ratedEver: jobs > 0,
        best: total > 0 ? { key: 'HBM-150', delta: Math.round(total * 0.6), at: addDays(today(), -30) } : null,
        worst: total < 0 ? { key: 'ASF-62', delta: Math.round(total * 0.7), at: addDays(today(), -20) } : null, series };
    }).sort((a, b) => b.elo - a.elo);
    const avg = (xs) => Math.round(xs.reduce((t, x) => t + x, 0) / xs.length);
    return {
      weeks: list, people, average: list.map((_, i) => avg(people.map((p) => p.series[i]))),
      summary: { averageNow: avg(people.map((p) => p.elo)), averageFrom: avg(people.map((p) => p.from)), up: people.filter((p) => p.change > 0).length,
        down: people.filter((p) => p.change < 0).length, still: people.filter((p) => !p.change).length, jobs: people.reduce((t, p) => t + p.jobs, 0),
        rankUps: people.filter((p) => p.rank !== p.rankFrom && p.change > 0).length, rankDowns: people.filter((p) => p.rank !== p.rankFrom && p.change < 0).length },
      ranks: ['Gram II', 'Kilogram I', 'Kilogram II', 'Tonne I'].map((name) => ({ name, n: people.filter((p) => p.rank === name).length })).filter((x) => x.n),
    };
  }
  if (p === '/api/reports/quoting') return {
    byBand: [{ discipline: 'software', size: 'Under 20h', jobs: 14, medianEstimateHours: 12, medianActualHours: 13.5, medianRatio: 1.12, spreadHours: [8, 19] },
      { discipline: 'engineering', size: '20 to 50h', jobs: 9, medianEstimateHours: 32, medianActualHours: 41, medianRatio: 1.28, spreadHours: [24, 55] }],
    byCustomer: [{ name: 'Harbour Mills', jobs: 7, medianRatio: 1.3 }, { name: 'Northgate Bakery', jobs: 9, medianRatio: 1.05 }],
    byTeam: [{ name: 'Projecting', jobs: 16, medianRatio: 1.15 }],
    coverage: [{ n: 40, confidence: 'good' }, { n: 12, confidence: 'patchy' }],
    jobs: [{ done_date: addDays(today(), -5), project_name: 'Harbour Mills', issue_key: 'HBM-171', discipline: 'engineering', job_elo: 1210, estimate_seconds: 12 * 3600, actual_seconds: 16 * 3600 }],
  };
  if (p === '/api/reports/stages') return {
    stages: [{ discipline: 'software', stage: 'FAT', times: 12, medianHours: 9.5, lowHours: 6, highHours: 14, medianShare: 0.22, lastSeen: addDays(today(), -9) },
      { discipline: 'engineering', stage: 'Commissioning', times: 15, medianHours: 18, lowHours: 10, highHours: 30, medianShare: 0.45, lastSeen: addDays(today(), -3) }],
    difficulty: { jobs: 0, byScore: [], drivers: [] }, customers: CUSTOMERS.map((c) => c.name), minJobs: 3, skipped: 4,
  };

  // Anything else is answered as done, so nothing in practice ever fails for want of a server.
  return post ? { ok: true, saved: true } : {};
}

// ---------- Employee of the Quarter ----------

const EOTQ_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const eotqWords = (iso) => `${Number(iso.slice(8, 10))} ${EOTQ_MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const eotqDayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
const eotqLabel = (r) => {
  if (r.name) return r.name;
  const [y1, m1] = r.opens.split('-').map(Number), [y2, m2] = r.closes.split('-').map(Number);
  if (y1 === y2 && m1 === m2) return `${EOTQ_MONTHS[m1 - 1]} ${y1}`;
  return y1 === y2 ? `${EOTQ_MONTHS[m1 - 1]} to ${EOTQ_MONTHS[m2 - 1]} ${y2}` : `${EOTQ_MONTHS[m1 - 1]} ${y1} to ${EOTQ_MONTHS[m2 - 1]} ${y2}`;
};
const EOTQ_MEDALS = ['bronze', 'silver', 'gold', 'diamond'];

function initEotq(myId) {
  const d = today();
  const rounds = [
    { id: 3, name: '', opens: addDays(d, -20), closes: addDays(d, 40), winner: null },
    { id: 2, name: '', opens: addDays(d, -110), closes: addDays(d, -21), winner: 'ex-tom', award: 'Going the extra mile' },
    { id: 1, name: '', opens: addDays(d, -200), closes: addDays(d, -111), winner: myId, award: 'Always there to help' },
  ];
  const v = (round, voter, nominee, reason, daysAgo) => ({ id: Number(nextId()), round, voter, nominee, reason, at: ago(daysAgo * DAY) });
  return {
    rounds,
    votes: [
      v(3, 'ex-sam', myId, 'Always willing to help and give training where they can. A big part of how quickly the new starters have picked things up.', 9),
      v(3, 'ex-priya', 'ex-tom', 'Worked on site with Harbour Mills through the commissioning and kept the customer happy the whole way.', 6),
      v(3, 'ex-dan', 'ex-tom', 'Mentored Amy on the new datatable package, which will save every project time.', 3),
      v(2, 'ex-ellie', myId, 'Adapts to changes as soon as they come in and helps everyone else keep up.', 100),
      v(2, 'ex-amy', 'ex-tom', 'Took the Ashby call-out on a Sunday and had them running by lunch.', 95),
      v(1, 'ex-tom', myId, 'The go-to person for site work on both projects and service.', 150),
    ],
    shoutouts: [
      { id: 1, accountId: 'ex-ellie', name: 'Ellie Morgan', message: 'Stayed late to get Northgate\'s line running again, and talked the night shift through it.', from: 'Priya Shah', at: ago(4 * DAY) },
    ],
  };
}

const eotqName = (id) => (id === me.id ? me.name : PEOPLE.find((p) => p.id === id)?.name || 'Someone');

function eotqAnswer(p, q, post, body) {
  const E = world.eotq;
  const d = today();
  const round = E.rounds.find((r) => r.closes >= d);
  const lead = Boolean(me.user?.isAdmin || me.user?.can?.eotq);
  const people = [...PEOPLE].sort((a, b) => a.name.localeCompare(b.name));
  const wins = (id) => E.rounds.filter((r) => r.winner === id).length;
  const medal = (id) => (wins(id) ? { tier: EOTQ_MEDALS[Math.min(wins(id), 4) - 1], wins: wins(id) } : null);
  if (p === '/api/eotq/vote') {
    if (!body.nomineeId) throw new Error('Choose who you\'re nominating.');
    if (String(body.reason || '').trim().length < 10) throw new Error('Say why you\'ve nominated them.');
    if (E.votes.some((v) => v.round === round.id && v.voter === me.id && v.nominee === body.nomineeId)) throw new Error(`You've already nominated ${eotqName(body.nomineeId)} this round. You can change what you wrote instead.`);
    E.votes.push({ id: Number(nextId()), round: round.id, voter: me.id, nominee: body.nomineeId, reason: String(body.reason).trim(), at: iso(now()) });
    return { ok: true };
  }
  if (p === '/api/eotq/edit') { const v = E.votes.find((x) => x.id === Number(body.id)); v.reason = String(body.reason || '').trim(); v.edited = iso(now()); return { ok: true }; }
  if (p === '/api/eotq/withdraw') { E.votes = E.votes.filter((x) => x.id !== Number(body.id)); return { ok: true }; }
  if (p === '/api/eotq/seen') return { ok: true };
  if (p === '/api/eotq/shoutouts') {
    return { canManage: lead, people: lead ? people.map((x) => ({ id: x.id, name: x.name })) : [], shoutouts: E.shoutouts.map((x) => ({ ...x, mine: x.accountId === me.id })) };
  }
  if (p === '/api/eotq/shoutout') {
    if (!body.accountId) throw new Error('Choose who the shout-out is for.');
    if (String(body.message || '').trim().length < 5) throw new Error('Say what they did.');
    E.shoutouts.unshift({ id: Number(nextId()), accountId: body.accountId, name: eotqName(body.accountId), message: String(body.message).trim(), from: me.name, at: iso(now()) });
    return { ok: true };
  }
  if (p === '/api/eotq/shoutout-remove') { E.shoutouts = E.shoutouts.filter((x) => x.id !== Number(body.id)); return { ok: true }; }
  if (p === '/api/eotq/history') {
    if (!lead) throw new Error('Only the management team can see the history.');
    const done = E.rounds.filter((r) => r.closes <= d || r.winner);
    const count = new Map(); const tier = new Map();
    for (const r of [...done].reverse()) if (r.winner) { count.set(r.winner, (count.get(r.winner) || 0) + 1); tier.set(r.id, EOTQ_MEDALS[Math.min(count.get(r.winner), 4) - 1]); }
    const share = (list) => { const m = new Map(); for (const v of list) m.set(v.nominee, (m.get(v.nominee) || 0) + 1);
      return [...m].map(([id, c]) => ({ key: id, name: eotqName(id), n: c })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)); };
    return { canManage: lead, shares: { all: share(E.votes), current: { label: eotqLabel(round), people: share(E.votes.filter((v) => v.round === round.id)) } }, rounds: done.map((r) => ({ id: r.id, label: eotqLabel(r), opens: r.opens, closes: r.closes, open: false, imported: false,
      nominations: lead ? E.votes.filter((v) => v.round === r.id).length : undefined,
      winner: r.winner ? { id: r.winner, name: eotqName(r.winner), medal: tier.get(r.id) } : null, award: r.award || null, certificate: r.winner ? { made: true } : null })) };
  }
  if (p === '/api/eotq/certificate-data') {
    const r = E.rounds.find((x) => x.id === Number(q.get('round')));
    return { round: r.id, label: eotqLabel(r), name: eotqName(r.winner), avatar: r.winner === me.id ? world.employee.avatar || null : null, award: r.award || 'Going the extra mile',
      citation: 'For their invaluable work and team involvement, the company recognise them as the most outstanding employee of the quarter. Thank you for your effort, congratulations!' };
  }
  if (p === '/api/eotq/round') { const r = E.rounds.find((x) => x.id === Number(body.id)); r.name = body.name || ''; if (body.closesOn) r.closes = body.closesOn; return { ok: true }; }
  if (p === '/api/eotq/winner') {
    const r = E.rounds.find((x) => x.id === Number(body.roundId));
    r.winner = body.accountId || null; r.award = body.award || 'Going the extra mile';
    return { ok: true };
  }
  if (p === '/api/eotq/manage') {
    if (!lead) throw new Error('Only the management team can see every nomination.');
    const r = E.rounds.find((x) => x.id === Number(q.get('round'))) || round;
    const votes = E.votes.filter((v) => v.round === r.id);
    const tally = new Map();
    for (const v of votes) { const t = tally.get(v.nominee) || { id: v.nominee, name: eotqName(v.nominee), typed: eotqName(v.nominee), votes: 0 }; t.votes++; tally.set(v.nominee, t); }
    const everyone = [{ id: me.id, name: me.name }, ...people];
    const voted = new Set(votes.map((v) => v.voter));
    return {
      round: { id: r.id, label: eotqLabel(r), name: r.name, opens: r.opens, closes: r.closes, closesWords: eotqWords(r.closes), current: r === round, imported: false, open: r.closes >= d,
        winner: r.winner ? { id: r.winner, name: eotqName(r.winner) } : null, award: r.award || 'Going the extra mile', citation: '', announced: r.winner ? r.closes : null },
      today: d,
      rounds: E.rounds.map((x) => ({ id: x.id, label: eotqLabel(x), count: E.votes.filter((v) => v.round === x.id).length, winner: x.winner ? eotqName(x.winner) : null, current: x === round })),
      tally: [...tally.values()].sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name)),
      votes: votes.map((v) => ({ id: v.id, nomineeId: v.nominee, nominee: eotqName(v.nominee), typed: eotqName(v.nominee), by: eotqName(v.voter), reason: v.reason, at: v.at, edited: v.edited || null })),
      turnout: r.closes >= addDays(d, -30) ? { total: everyone.length, voted: everyone.filter((x) => voted.has(x.id)).map((x) => x.name).sort(), notYet: everyone.filter((x) => !voted.has(x.id)).map((x) => x.name).sort() } : null,
      people: everyone.map((x) => ({ id: x.id, name: x.name, left: false })),
    };
  }
  const mine = E.votes.filter((v) => v.round === round.id && v.voter === me.id);
  const about = E.votes.filter((v) => v.nominee === me.id);
  return {
    round: { id: round.id, label: eotqLabel(round), closes: round.closes, closesWords: eotqWords(round.closes), closesDay: eotqDayName(round.closes) },
    me: { id: me.id, name: me.name, medal: medal(me.id) },
    people: people.map((x) => ({ id: x.id, name: x.name, nominated: mine.some((v) => v.nominee === x.id) })),
    mine: mine.map((v) => ({ id: v.id, nomineeId: v.nominee, nominee: eotqName(v.nominee), reason: v.reason, at: v.at })),
    aboutMe: E.rounds.filter((r) => about.some((v) => v.round === r.id)).map((r) => ({ round: r.id, label: eotqLabel(r), current: r === round, reasons: about.filter((v) => v.round === r.id).map((v) => v.reason) })),
    shoutouts: E.shoutouts.filter((x) => x.accountId === me.id).map((x) => ({ message: x.message, at: x.at })),
    canManage: lead,
  };
}
