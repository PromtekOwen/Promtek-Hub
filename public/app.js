import { MODULES } from './modules.js';
import { TOURS } from './tours.js';
import { suggestionsFor, closeDropdown } from './dropdown.js';

const view = document.getElementById('view');
const band = document.getElementById('band');
const back = document.getElementById('back');
const avatar = document.getElementById('avatar');
const accountDialog = document.getElementById('account');
const toastEl = document.getElementById('toast');

let me = null;
let installPrompt = null;
let weekOffset = 0;

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v || 0).toLocaleString('en-GB');
const svgIcon = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

function duration(seconds) {
  const mins = Math.round((seconds || 0) / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

const dateOf = (iso) => new Date(`${iso}T12:00:00Z`);
const longDate = (iso) => dateOf(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const shortDate = (iso) => dateOf(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const addDays = (iso, days) => new Date(dateOf(iso).getTime() + days * 86_400_000).toISOString().slice(0, 10);
function mondayOf(iso) {
  const dow = dateOf(iso).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function initials() {
  return (me?.employee?.name || me?.user?.email || '?')
    .split(/[\s.@]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

// Practice mode: the page runs on example data from practice.js and nothing is
// sent anywhere. It's on while the address has ?practice=<page>.
const PRACTICE = (() => { try { return new URLSearchParams(location.search).get('practice') || null; } catch { return null; } })();
const PRACTICE_ROUTE = PRACTICE ? (PRACTICE === 'home' ? '#/' : `#/${PRACTICE}`) : null;
let practiceData = null;
let apiPending = 0;            // requests in flight, so a guide knows when the page has settled

async function api(path, options = {}) {
  apiPending++;
  try {
    if (PRACTICE) {
      practiceData ||= await import('./practice.js');
      return await practiceData.handle(path, options, serverApi);
    }
    return await serverApi(path, options);
  } finally {
    apiPending--;
  }
}

async function serverApi(path, options = {}) {
  const res = await fetch(path, { redirect: 'manual', headers: { 'content-type': 'application/json' }, ...options });
  // An expired sign-in comes back as a redirect to the Google login page.
  if (res.type === 'opaqueredirect' || res.status === 0) {
    location.reload();
    throw new Error('Your sign-in has expired. Reloading…');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

// Level ring: two concentric rings, like the Promtek logo.
function ring(progress, size = 104, light = false) {
  const r = 40, c = 2 * Math.PI * r;
  const pct = progress.levelSpan ? progress.xpIntoLevel / progress.levelSpan : 0;
  const fill = light ? 'var(--ink)' : '#fff';
  const sub = light ? 'var(--muted)' : 'rgba(255,255,255,.85)';
  return `<svg class="ring${light ? ' light' : ''}" width="${size}" height="${size}" viewBox="0 0 100 100" role="img"
      aria-label="Level ${progress.level}, ${Math.round(pct * 100)}% of the way to level ${progress.level + 1}">
    <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(14,98,147)"/><stop offset="1" stop-color="rgb(0,141,198)"/></linearGradient></defs>
    <circle class="outer" cx="50" cy="50" r="48" fill="none" stroke-width="1.5"/>
    <circle class="track" cx="50" cy="50" r="${r}" fill="none" stroke-width="8"/>
    <circle class="arc" cx="50" cy="50" r="${r}" fill="none" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}" transform="rotate(-90 50 50)"/>
    <text x="50" y="47" text-anchor="middle" font-size="${progress.level >= 1000 ? 20 : 26}" font-weight="700" fill="${fill}">${n(progress.level)}</text>
    <text x="50" y="64" text-anchor="middle" font-size="10" font-weight="600" fill="${sub}">level</text>
  </svg>`;
}

// ---------- shared pieces ----------

function notLinkedCard() {
  return `<div class="card notice">
    <p><strong>Your account isn't linked to an engineer profile yet.</strong></p>
    <p class="muted">You're signed in as ${esc(me.user.email)}. An admin can link you from the Admin page. Everything else in the hub still works.</p>
  </div>`;
}

function xpList(entries, emptyText) {
  if (!entries.length) return `<div class="card"><p class="muted">${emptyText}</p></div>`;
  return `<ul class="list">${entries.map((e) => {
    const how = e.job_elo
      ? `Job ELO ${n(Math.round(e.job_elo))} vs your ${n(Math.round(e.engineer_elo))}`
      : 'Baseline rate';
    const override = e.override != null && e.override !== 1 ? `, ×${e.override} override` : '';
    const issue = e.issue_key
      ? `<a href="${esc(me.jiraBaseUrl)}/browse/${esc(e.issue_key)}" target="_blank" rel="noopener">${esc(e.issue_key)}</a> `
      : '';
    const rate = e.rate != null ? `, ${Number(e.rate).toFixed(2)} XP/min` : '';
    return `<li>
      <span class="title">${issue}${esc(e.summary || e.description || 'Time logged')}</span>
      <span class="xp">+${n(e.xp)}<small>${duration(e.seconds)}</small></span>
      <span class="sub">${shortDate(e.work_date)}${e.rate != null ? `. ${how}${override}${rate}` : e.description && e.summary ? `. ${esc(e.description)}` : ''}</span>
    </li>`;
  }).join('')}</ul>`;
}

// ---------- pages ----------

const pages = {
  '#/': {
    band() {
      const first = (me.employee?.name || '').split(' ')[0];
      const e = me.employee;
      return `<h1>${greeting()}${first ? `, ${esc(first)}` : ''}</h1><p>${longDate(todayIso())}</p><div id="home-feed-host">${homeFeedHtml()}</div>`;
    },
    render() {
      const visible = orderedTiles();
      const hidden = MODULES.filter((m) => allowedTile(m) && tilePrefs.hidden.includes(m.id));
      const tiles = visible.map((m, i) => {
        const detail = m.detail ? `<span class="detail">${m.detail(me)}</span>` : '';
        const inner = `<span class="tile-icon">${m.icon}</span><strong>${esc(m.name)}</strong>${detail}`;
        if (arrangeMode) {
          return `<div class="tile arranging" data-tile-id="${esc(m.id)}" tabindex="0" role="listitem" aria-roledescription="Movable tile"
              aria-label="${esc(m.name)}, position ${i + 1} of ${visible.length}. Drag, or use the arrow keys, to move it.">${inner}<span class="arrange">
              <span class="drag-grip" aria-hidden="true">${svgIcon('<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>')}</span>
              <button class="icon-btn" data-tile="hide" data-value="${esc(m.id)}" aria-label="Hide ${esc(m.name)}">${svgIcon('<path d="M4 4l16 16"/><path d="M12 6c5 0 9 6 9 6a15 15 0 01-3 3.4M7.5 7.6A15 15 0 003 12s4 6 9 6a8 8 0 003.7-.9"/>')}</button>
            </span></div>`;
        }
        if (m.construction || tileAccess(m) === 'locked') return `<div class="tile construction" aria-disabled="true">${inner}<span class="badge">Under construction</span></div>`;
        return `<a class="tile" href="${esc(m.route || m.href)}">${inner}</a>`;
      }).join('');

      const hiddenBlock = arrangeMode && hidden.length ? `<h2>Hidden</h2>
        <div class="options">${hidden.map((m) => `<div class="option">
            <span class="option-main"><strong>${esc(m.name)}</strong></span>
            <button class="btn secondary" data-tile="show" data-value="${esc(m.id)}">Show</button>
          </div>`).join('')}</div>` : '';
      const setup = me.user.isAdmin && !me.ledgerStart
        ? `<div class="card notice" style="margin-bottom:1rem"><p><strong>XP tracking hasn't started yet.</strong> Open <a href="#/admin">Admin</a> to start the ledger.</p></div>`
        : '';
      return `${setup}${me.linked ? '' : notLinkedCard()}
        <div class="row" style="justify-content:flex-end;margin-bottom:.75rem">
          <button class="btn secondary" data-tile="${arrangeMode ? 'done' : 'arrange'}">${arrangeMode ? 'Done arranging' : 'Arrange tiles'}</button>
        </div>
        ${arrangeMode ? '<p class="help" style="margin-top:0">Drag tiles into the order you want. Your order is saved as you go.</p>' : ''}
        <div class="tiles${arrangeMode ? ' arranging-grid' : ''}"${arrangeMode ? ' role="list" aria-label="Your tiles"' : ''}>${tiles}</div>
        <div class="visually-hidden" aria-live="polite" id="tile-live"></div>${hiddenBlock}
        ${me.linked && !arrangeMode ? `<h2>Latest XP</h2>${xpList(me.recent.slice(0, 4), 'Log time in Tempo and your XP appears here within a couple of minutes.')}` : ''}`;
    },
  },

  '#/xp': {
    band: () => `<h1>XP &amp; rank</h1><p>Your level, title and ELO, and where your XP came from.</p>`,
    render() {
      if (!me.linked) return notLinkedCard();
      const e = me.employee, p = e.progress;
      const pct = p.levelSpan ? (p.xpIntoLevel / p.levelSpan) * 100 : 0;
      return `
        <div class="card xp-head">
          ${ring(p, 128, true)}
          <div>
            <h3>${esc(p.title)}</h3>
            <div class="bar" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></div>
            <span class="muted">${n(p.xpIntoLevel)} of ${n(p.levelSpan)} XP through level ${n(p.level)}.
            ${p.nextTitle ? `${esc(p.nextTitle)} at level ${n(p.nextTitleLevel)}.` : 'You hold the highest title.'}</span>
          </div>
        </div>
        <dl class="stats">
          <div><dt>Total XP</dt><dd>${n(p.xp)}</dd></div>
          <div><dt>This week</dt><dd>${n(e.week.xp)}<small>${duration(e.week.seconds)} logged</small></dd></div>
          <div><dt>ELO rating</dt><dd>${e.elo != null ? n(Math.round(e.elo)) : '—'}${e.rank ? `<small>${esc(e.rank.name)}</small>` : ''}</dd></div>
          <div><dt>Next rank</dt><dd>${e.rank?.nextAt ? n(e.rank.nextAt) : '—'}${e.rank?.nextName ? `<small>${esc(e.rank.nextName)}</small>` : ''}</dd></div>
        </dl>
        <h2>ELO history</h2>
        <div id="elo-history">${sectionLoading('Loading your ELO history')}</div>
        <h2>Taken into account</h2>
        <div id="modifiers">${sectionLoading()}</div>
        <h2>Leaderboard</h2>
        <div id="leaderboard" class="card">${loaderHtml('Loading the leaderboard', 'small')}</div>
        <h2>Where your XP came from</h2>
        ${xpList(me.recent, 'No XP yet. Log time in Tempo and it appears here within a couple of minutes.')}`;
    },
  },

  '#/time': {
    band: () => `<h1>My time</h1><p>Your Tempo time logs, week by week.</p>`,
    async render() {
      if (!me.linked) return notLinkedCard();
      const monday = addDays(mondayOf(todayIso()), weekOffset * 7);
      const data = await api(`/api/time?week=${monday}`);
      const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
      const byDay = Object.fromEntries(days.map((d) => [d, []]));
      data.entries.forEach((e) => byDay[e.work_date]?.push(e));
      const secs = days.map((d) => byDay[d].reduce((a, e) => a + e.seconds, 0));
      const total = secs.reduce((a, b) => a + b, 0);
      const xp = data.entries.reduce((a, e) => a + e.xp, 0);
      const scale = Math.max(8 * 3600, ...secs);
      const today = todayIso();
      const arrow = (d) => svgIcon(d);

      const chart = days.map((d, i) => `<div class="col${d === today ? ' today' : ''}">
          <span class="h">${secs[i] ? duration(secs[i]) : ''}</span>
          <span class="fill${secs[i] ? '' : ' none'}" style="height:${Math.max(2, (secs[i] / scale) * 100).toFixed(1)}%"></span>
          <span class="d">${dateOf(d).toLocaleDateString('en-GB', { weekday: 'short' })}</span>
        </div>`).join('');

      const listByDay = days.filter((d) => byDay[d].length).reverse().map((d) =>
        `<p class="day-label">${longDate(d)}, ${duration(secs[days.indexOf(d)])}</p>${xpList(byDay[d], '')}`).join('');

      return `
        <div class="card">
          <div class="week-nav">
            <button class="icon-btn" data-week="-1" aria-label="Previous week">${arrow('<path d="M15 5l-7 7 7 7"/>')}</button>
            <div style="text-align:center">
              <strong>${weekOffset === 0 ? 'This week' : weekOffset === -1 ? 'Last week' : `Week of ${shortDate(monday)}`}</strong><br>
              <span class="muted">${duration(total)} logged, ${n(xp)} XP</span>
            </div>
            <button class="icon-btn" data-week="1" aria-label="Next week" ${weekOffset >= 0 ? 'disabled' : ''}>${arrow('<path d="M9 5l7 7-7 7"/>')}</button>
          </div>
          <div class="chart">${chart}</div>
        </div>
        <div class="row" style="margin-top:1rem">
          <a class="btn" href="#/log">Log time</a>
          <a class="btn secondary" href="${esc(me.jiraBaseUrl)}/plugins/servlet/ac/io.tempo.jira/tempo-app" target="_blank" rel="noopener">Open Tempo</a>
        </div>
        ${listByDay || `<h2>Time logs</h2><div class="card"><p class="muted">Nothing logged ${weekOffset === 0 ? 'yet this week' : 'this week'}.</p></div>`}`;
    },
  },

  '#/reports': {
    band: () => `<h1>Reports</h1><p>Effort and progress across the team, week by week.</p>`,
    async render() {
      if (!me.user.isLead) return `<div class="card"><p>Only team leads and admins can see this page.</p></div>`;
      if (reportAccount) return engineerReportHtml(await api(`/api/reports/engineer?accountId=${encodeURIComponent(reportAccount)}`));
      // A lead's reports open on the team they lead; Management and admins see everyone.
      if (reportTeam === undefined) reportTeam = me.user.scopeTeams === null ? '' : (me.user.scopeTeams?.[0] || '');
      const tabs = `<div class="tabs" style="margin-bottom:1rem">
        <button class="tab${reportView === 'team' ? ' on' : ''}" data-view="team">Effort</button>
        <button class="tab${reportView === 'quoting' ? ' on' : ''}" data-view="quoting">Quoting</button>
        <button class="tab${reportView === 'stages' ? ' on' : ''}" data-view="stages">Stages</button>
        <button class="tab${reportView === 'elo' ? ' on' : ''}" data-view="elo">ELO</button>
      </div>${teamPickerHtml(reportTeam, 'data-report-team')}`;
      if (reportView === 'elo') return tabs + eloReportHtml(await api(`/api/reports/elo?weeks=${eloWeeks}${reportTeam ? `&team=${encodeURIComponent(reportTeam)}` : ''}`));
      if (reportView === 'stages') {
        const params = new URLSearchParams();
        if (quotingDiscipline) params.set('discipline', quotingDiscipline);
        if (reportTeam) params.set('team', reportTeam);
        if (stageCustomer) params.set('customer', stageCustomer);
        params.set('group', stageGroup);
        return tabs + stagesHtml(await api(`/api/reports/stages?${params}`));
      }
      if (reportView === 'quoting') {
        const params = new URLSearchParams();
        if (quotingDiscipline) params.set('discipline', quotingDiscipline);
        if (quotingAll) params.set('all', '1');
        if (reportTeam) params.set('team', reportTeam);
        return tabs + quotingHtml(await api(`/api/reports/quoting?${params}`));
      }
      return tabs + teamReportHtml(await api(`/api/reports/team?weeks=${reportWeeks}${reportTeam ? `&team=${encodeURIComponent(reportTeam)}` : ''}`));
    },
  },

  '#/log': {
    band: () => `<h1>Log time</h1><p>Find the job, say how long, and it's in Tempo.</p>`,
    async render() {
      if (!me.linked) return notLinkedCard();
      if (!logChosen || !logMode) await trackerLoad();
      if (logChosen) return logChosen.contractCheck ? logChoiceHtml() + contractWarnHtml() : logMode === 'manual' || pendingCall ? logFormHtml() : logChoiceHtml();
      return `${trackerPanelHtml()}${await logPickerHtml()}`;
    },
  },

  '#/pow': {
    band: () => `<h1>Point of work</h1><p>${powStep && powStep !== 'home' ? 'Risk assessment' : 'Risk assessments for site visits'}</p>`,
    async render() {
      if (!me.linked) return notLinkedCard();
      if (!powSchema) powSchema = await api('/api/pow/schema');
      return powRender();
    },
  },

  '#/org': {
    band: () => `<h1>Company chart</h1><p>Who reports to whom, built from the employee list.</p>`,
    async render() {
      await loadOrgLogo();
      orgData = await api('/api/org');
      return orgHtml(orgData);
    },
  },

  '#/obs': {
    band: () => `<h1>Obsolescence</h1><p>${obsConfig?.sales && obsView === 'sales' ? 'Surveys waiting to be read' : 'Site surveys and equipment condition'}</p>`,
    async render() {
      if (!me.linked) return notLinkedCard();
      if (!obsConfig) obsConfig = await api('/api/obs/config');
      // Sales people can do either job, so they pick first.
      if (obsConfig.sales && !obsView && !obsSurvey) return obsChooserHtml();
      if (obsView === 'sales') return obsSalesHtml(await api('/api/obs/sales'));
      if (obsSurvey?.picking) {
        if (!obsReports) obsReports = (await api('/api/obs/reports')).reports;
        return obsPickHtml();
      }
      return obsSurvey ? obsSurveyHtml() : obsHomeHtml(await api('/api/obs/surveys'));
    },
  },

  '#/shop': {
    band: () => `<h1>XP shop</h1><p>A working example while the rewards are agreed.</p>`,
    async render() {
      if (!me.user.can?.shop) return `<div class="card"><p>The shop is still being worked on.</p></div>`;
      return shopSimulation ? shopSimulationHtml() : shopHtml(await api('/api/shop'));
    },
  },

  '#/calls': {
    band: () => `<h1>8x8 calls</h1><p>Turn the calls you took into time and tickets.</p>`,
    async render() {
      if (!me.linked) return notLinkedCard();
      return callsRender();
    },
  },

  '#/quotes': {
    band: () => `<h1>Quotes</h1><p>${quotesView?.kind === 'answer' ? 'Your view on how long it will take and how hard it is.' : 'What the job involves, how long it should take and how hard it is.'}</p>`,
    async render() {
      if (quotesView?.kind === 'new') return quoteNewHtml();
      if (quotesView?.kind === 'quote') return quoteHtml();
      if (quotesView?.kind === 'answer') return quoteAnswerHtml();
      return quotesHomeHtml();
    },
  },

  '#/psc': {
    band: () => '<h1>PSC</h1><p>Every support request across the customers and the PSC board.</p>',
    render: () => pscHtml(),
  },

  '#/contracts': {
    band: () => '<h1>Service contracts</h1><p>Each customer\'s contract: its dates, visits and tokens.</p>',
    render: () => contractsHtml(),
  },

  '#/requests': {
    band: () => (me.user.isAdmin || me.user.can?.developer
      ? '<h1>Requests</h1><p>Ideas and problems people have sent about the hub.</p>'
      : '<h1>Requests</h1><p>Ask for a new tile or a change, or tell us about something that isn\'t working.</p>'),
    render: () => requestsHtml(),
  },

  '#/condor': {
    band: () => '<h1>Condor Dev</h1><p>Logging, estimating and planning work on Condor.</p>',
    render: () => condorHtml(),
  },

  '#/jobs': {
    band: () => `<h1>Jobs</h1><p>Open orders, how hard each part is and how its time is going.</p>`,
    async render() {
      if (jobsView?.kind === 'dispute') return jobsDisputeHtml();
      if (jobsView?.kind === 'decide') return jobsDecideHtml();
      return jobsHomeHtml();
    },
  },

  '#/it': {
    band: () => `<h1>IT support</h1><p>Report a problem or ask for what you need.</p>`,
    async render() {
      if (!me.linked) return notLinkedCard();
      if (!itOptions) itOptions = await api('/api/it/options');
      return itForm ? itFormHtml() : itHomeHtml(await api('/api/it/requests'));
    },
  },

  '#/vehicles': {
    band: () => `<h1>Vehicles</h1><p>Book one, check it over before you drive, report anything wrong.</p>`,
    async render() {
      if (!me.linked) return notLinkedCard();
      if (!checkSchema) checkSchema = await api('/api/vehicles/check-schema');
      if (vehicleView === 'check') return vehicleCheckHtml();
      const [fleet, mine] = await Promise.all([api('/api/vehicles'), api('/api/vehicles/mine')]);
      fleetCache = fleet.vehicles;
      if (vehicleView === 'book') return vehicleBookHtml(fleet.vehicles, await api(`/api/vehicles/week?week=${vehicleWeek()}`));
      if (vehicleView === 'defects') return vehicleDefectsHtml(await api('/api/vehicles/defects'));
      return vehicleHomeHtml(fleet.vehicles, mine.bookings);
    },
  },

  '#/admin': {
    band: () => `<h1>Admin</h1><p>People, sync and alerts.</p>`,
    async render() {
      if (!me.user.isAdmin && me.user.can?.developer) return developerAdminHtml();
      if (!me.user.isAdmin) return `<div class="card"><p>Only admins can see this page.</p></div>`;
      const [data, peopleData, elo, reads] = await Promise.all([api('/api/admin/overview'), api('/api/admin/people'), api('/api/admin/elo'), api('/api/admin/reads').catch(() => null)]);
      peopleCache = peopleData;
      if (personEdit) return personEditHtml();
      const s = data.state;
      const options = data.employees.map((e) => `<option value="${esc(e.account_id)}">${esc(e.name)}${e.email ? ` (${esc(e.email)})` : ''}</option>`).join('');
      const when = (v) => (v ? new Date(v).toLocaleString('en-GB') : 'Not yet');
      return `
        ${s.last_error ? `<div class="card notice error" style="margin-bottom:1rem"><p><strong>Last sync problem</strong></p><p>${esc(s.last_error)}</p></div>` : ''}
        <div class="card">
          <dl class="state">
            <dt>Ledger started</dt><dd>${esc(s.ledger_start || 'Not started')}</dd>
            <dt>Last background run</dt><dd>${when(s.last_scheduled_run)}</dd>
            <dt>Profiles refreshed</dt><dd>${when(s.last_profile_refresh)}</dd>
          </dl>
          <div class="row">
            <button class="btn secondary" data-action="sync-now">Sync Tempo now</button>
          </div>
          <div class="result" id="sync-result" role="status"></div>
        </div>

        ${readsHtml(reads)}

        <h2>Start the XP ledger</h2>
        <div class="card">
          <p>This copies everyone's current XP from Jira as their starting balance, then counts XP from Tempo worklogs dated from today onwards. Run it once, before anyone logs time for the day. Running it again wipes the ledger and starts over.</p>
          <div class="row">
            <label>Type START to confirm <input id="confirm-start" autocomplete="off" size="8"></label>
            <button class="btn" data-action="start-ledger">Start ledger</button>
          </div>
          <div class="result" id="start-result" role="status"></div>
        </div>

        ${eloAdminHtml(elo, peopleData.source)}

        <h2>Home screen messages</h2>
        <p class="muted">Alerts and news for the strip at the top of everyone's home screen.</p>
        <div id="home-admin">${sectionLoading()}</div>

        <h2>Audit log</h2>
        <p class="muted">Changes made by hand to employees, vehicles and settings: who changed what, when, and what it was before.</p>
        <div id="audit-log">${sectionLoading()}</div>

        <h2>Alerts</h2>
        <div class="card">
          <p class="muted" style="margin-top:0">${data.mailRelay
            ? 'Alerts are emailed once an hour through the mail relay.'
            : 'No mail relay is set up, so alerts only appear here. Add ALERT_WEBHOOK_URL to send them by email.'}</p>
          ${data.alerts.length ? `<ul class="list" style="box-shadow:none">${data.alerts.map((a) => `<li>
              <span class="title">${esc(a.subject)}</span>
              <span class="sub">${new Date(a.created_at).toLocaleString('en-GB')}. ${a.sent_at ? 'Emailed' : 'Not emailed'}.</span>
              <span class="xp"></span>
            </li>`).join('')}</ul>` : '<p class="muted">Nothing to report.</p>'}
        </div>

        <h2>Employees</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Job title</th><th>Team</th><th>Role</th><th class="num">XP rate</th><th class="num">Level</th><th class="num">ELO</th><th></th></tr></thead>
          <tbody>${peopleData.people.map((p) => `<tr>
            <td>${esc(p.name)}${p.active ? '' : '<br><span class="muted">Left</span>'}${p.pending ? '<br><span class="low">No Jira account yet</span>' : ''}</td>
            <td>${esc(p.jobTitle || '—')}</td>
            <td>${esc(p.department || p.team || '—')}</td>
            <td>${p.role === 'lead' ? 'Team lead' : p.role === 'admin' ? 'Admin' : 'Engineer'}</td>
            <td class="num">${p.xpRate ?? '—'}</td>
            <td class="num">${n(p.level)}</td>
            <td class="num">${p.elo == null ? '—' : n(Math.round(p.elo))}</td>
            <td><button class="linklike" data-person-edit="${esc(p.accountId)}">Edit</button></td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">Nobody yet.</td></tr>'}</tbody>
        </table></div>
        <div class="row" style="margin-top:1rem">
          <button class="btn" data-person-edit="new">Add someone</button>
        </div>
        <div class="result" id="people-result" role="status"></div>

        <h2>Time from people without a profile</h2>
        ${data.unmatched.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Atlassian account ID</th><th class="num">Worklogs</th><th class="num">Time</th><th>Latest</th></tr></thead>
          <tbody>${data.unmatched.map((u) => `<tr><td>${esc(u.account_id)}</td><td class="num">${n(u.worklogs)}</td><td class="num">${duration(u.seconds)}</td><td>${esc(u.latest)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="muted">Add these people under Employees with their Jira account ID. Any of their time from the last two weeks is picked up within about 30 minutes.</p>`
        : '<div class="card"><p class="muted">None. Every worklog belongs to someone with a profile.</p></div>'}

`;
    },
  },
};

// ---------- account panel ----------

// ---------- the strip at the top of the home screen ----------
// It turns through your level, alerts for you, news from admins and your week,
// on its own every few seconds, or by tapping a tab or swiping. It stops turning
// while someone is reading it: pointer over it, focus in it, or just after they
// have moved it themselves.

let homeFeed = null;            // { alerts, news, week } from the server
let homeFeedAt = 0;
let homeSlide = null;           // the slide showing, by name
let homeTimer = null;
let homePausedUntil = 0;
let homeHold = false;           // pointer over it or focus in it
let homeStopped = false;        // the pause button
const HOME_TURN_MS = 5000;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function levelSlideHtml() {
  const e = me.employee;
  if (!me.linked) return '<p class="feed-empty">Your account isn\'t linked to an engineer profile yet, so there\'s no level to show.</p>';
  return `<a class="summary" href="#/xp">
      ${ring(e.progress, 92)}
      <div>
        <strong>${esc(e.progress.title)}</strong>
        <span class="meta">${n(e.progress.xp)} XP. ${n(e.progress.xpToNextLevel)} to level ${n(e.progress.level + 1)}.</span>
        ${e.rank ? `<br><span class="chip">${esc(e.rank.name)}</span>` : ''}
      </div>
    </a>`;
}

const feedWhen = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function feedItemHtml(a, { full = false } = {}) {
  const open = a.link ? `<a class="feed-open" href="${esc(a.link)}"${a.link.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>Open</a>` : '';
  const done = a.id ? `<button class="feed-done" data-feed-dismiss="${a.id}">Got it</button>` : '';
  return `<li class="feed-item${a.tone === 'important' ? ' important' : ''}${full ? ' full' : ''}">
      <span class="feed-dot" aria-hidden="true"></span>
      <div class="feed-text"><strong>${esc(a.title)}</strong>${a.body ? `<span class="feed-body">${esc(a.body)}</span>` : ''}
        ${a.from ? `<span class="feed-from">${esc(a.from)}, ${feedWhen(a.at)}</span>` : ''}</div>
      ${open || done ? `<span class="feed-actions">${open}${done}</span>` : ''}
    </li>`;
}

function weekSlideHtml(w) {
  const pct = Math.min(100, (w.seconds / w.target) * 100);
  const names = w.missing.map((d) => dateOf(d).toLocaleDateString('en-GB', { weekday: 'long' }));
  const words = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `<div class="feed-week">
      <p class="feed-week-head"><strong>${duration(w.seconds)}</strong> logged this week <span>of ${duration(w.target)}</span></p>
      <div class="feed-bar" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></div>
      <ol class="feed-days">${w.days.map((d) => `<li class="${d.seconds ? 'done' : d.past ? 'missing' : ''}${d.today ? ' today' : ''}" title="${esc(longDate(d.date))}: ${d.seconds ? duration(d.seconds) : 'nothing logged'}">
        <span>${dateOf(d.date).toLocaleDateString('en-GB', { weekday: 'short' })}</span><b>${d.seconds ? duration(d.seconds) : d.past ? 'None' : '—'}</b></li>`).join('')}</ol>
      <p class="feed-week-note">${names.length ? `Nothing logged on ${esc(words)} yet. <a href="#/log">Log time</a>` : 'Every day so far this week has time logged.'}</p>
    </div>`;
}

function homeSlides() {
  const f = homeFeed;
  const slides = [{ id: 'you', label: 'You', html: levelSlideHtml() }];
  if (!f) return slides;
  // One at a time on a phone, two side by side in height on a wider screen.
  const room = matchMedia('(max-width: 480px)').matches ? 1 : 2;
  const alerts = f.alerts.slice(0, room).map((a) => feedItemHtml(a)).join('');
  slides.push({ id: 'alerts', label: 'Alerts', count: f.alerts.length,
    html: f.alerts.length ? `<ul class="feed-list">${alerts}</ul>${f.alerts.length > room ? `<button class="feed-more" data-feed-all="alerts">See all ${f.alerts.length}</button>` : ''}`
      : '<p class="feed-empty">Nothing waiting for you. Alerts from admins, and things that need you elsewhere in the hub, show up here.</p>' });
  if (f.news.length) {
    slides.push({ id: 'news', label: 'News', count: f.news.length,
      html: `<ul class="feed-list">${feedItemHtml(f.news[0])}</ul>${f.news.length > 1 ? `<button class="feed-more" data-feed-all="news">See all ${f.news.length}</button>` : ''}` });
  }
  if (f.week) slides.push({ id: 'week', label: 'Week', html: weekSlideHtml(f.week) });
  return slides;
}

function homeFeedHtml() {
  const slides = homeSlides();
  if (!slides.some((x) => x.id === homeSlide)) homeSlide = slides[0].id;
  const tabs = slides.length > 1 ? `<div class="feed-tabs" role="tablist" aria-label="What's shown">
      ${slides.map((x) => `<button class="feed-tab${x.id === homeSlide ? ' on' : ''}" role="tab" aria-selected="${x.id === homeSlide}" aria-controls="feed-${x.id}" data-feed-tab="${x.id}">${x.label}${x.count ? `<span class="feed-count">${x.count}</span>` : ''}</button>`).join('')}
      <button class="feed-pause" data-feed-pause aria-label="${homeStopped ? 'Turn on' : 'Stop'} moving on by itself" title="${homeStopped ? 'Turn on' : 'Stop'} moving on by itself">${homeStopped
        ? svgIcon('<path d="M8 5.5v13l10.5-6.5z"/>') : svgIcon('<path d="M8.5 5.5v13M15.5 5.5v13"/>')}</button>
    </div>` : '';
  return `<div class="feed" id="home-feed" aria-roledescription="carousel" aria-label="Your home screen">${tabs}
      <div class="feed-track">${slides.map((x) => `<section class="feed-slide" id="feed-${x.id}" data-slide="${x.id}" role="tabpanel" aria-label="${x.label}">${x.html}</section>`).join('')}</div>
    </div>`;
}

// Moves to a slide by name, and keeps the strip the height of what's showing.
function homeGo(id, { smooth = true } = {}) {
  const track = document.querySelector('#home-feed .feed-track');
  const slide = track?.querySelector(`[data-slide="${id}"]`);
  if (!slide) return;
  homeSlide = id;
  track.scrollTo({ left: slide.offsetLeft - track.offsetLeft, behavior: smooth && !reducedMotion.matches ? 'smooth' : 'instant' });
  // As tall as the tallest slide, so the tiles underneath don't jump as it turns.
  track.style.height = `${Math.max(...[...track.children].map((x) => x.offsetHeight))}px`;
  document.querySelectorAll('#home-feed [data-feed-tab]').forEach((t) => {
    const on = t.dataset.feedTab === id;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  });
}

function homeTick() {
  if (currentRoute() !== '#/' || !document.getElementById('home-feed')) return;
  if (homeStopped || homeHold || reducedMotion.matches || document.hidden || Date.now() < homePausedUntil || document.querySelector('.tour, .modal-backdrop')) return;
  const ids = homeSlides().map((x) => x.id);
  if (ids.length < 2) return;
  homeGo(ids[(ids.indexOf(homeSlide) + 1) % ids.length]);
}

function homeFeedMount() {
  const host = document.getElementById('home-feed-host');
  if (!host) return;
  host.innerHTML = homeFeedHtml();
  const feed = host.querySelector('#home-feed');
  const track = feed.querySelector('.feed-track');
  requestAnimationFrame(() => homeGo(homeSlide, { smooth: false }));
  feed.addEventListener('pointerenter', () => { homeHold = true; });
  feed.addEventListener('pointerleave', () => { homeHold = false; });
  feed.addEventListener('focusin', () => { homeHold = true; });
  feed.addEventListener('focusout', () => { homeHold = feed.matches(':hover'); });
  // A swipe settles on a slide; that slide becomes the one showing.
  let settle = null;
  track.addEventListener('scroll', () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      const slide = track.children[i];
      if (slide && slide.dataset.slide !== homeSlide) { homePausedUntil = Date.now() + 30_000; homeGo(slide.dataset.slide, { smooth: false }); }
    }, 120);
  }, { passive: true });
  clearInterval(homeTimer);
  homeTimer = setInterval(homeTick, HOME_TURN_MS);
}

async function loadHomeFeed({ force = false } = {}) {
  if (!force && homeFeed && Date.now() - homeFeedAt < 60_000) return homeFeedMount();
  try {
    const first = !homeFeed;
    homeFeed = await api('/api/home');
    homeFeedAt = Date.now();
    // On arrival, anything that needs them comes first.
    if (first && (homeFeed.alerts.some((a) => a.tone === 'important' || a.id))) homeSlide = 'alerts';
  } catch { /* the level still shows */ }
  if (currentRoute() === '#/') homeFeedMount();
}

function homeFeedAll(kind) {
  const list = homeFeed?.[kind] || [];
  const host = document.createElement('div');
  host.className = 'modal-backdrop';
  host.innerHTML = `<div class="modal card feed-all" role="dialog" aria-modal="true" aria-labelledby="feed-all-title">
      <h2 id="feed-all-title" style="margin-top:0">${kind === 'news' ? 'News' : 'Alerts for you'}</h2>
      <ul class="feed-list">${list.map((a) => feedItemHtml(a, { full: true })).join('')}</ul>
      <div class="modal-actions"><button class="btn secondary" data-feed-close>Close</button></div></div>`;
  document.body.appendChild(host);
  host.querySelector('[data-feed-close]').focus();
}

async function homeFeedDismiss(id) {
  try { await api('/api/home/dismiss', { method: 'POST', body: JSON.stringify({ id }) }); } catch (err) { toast(err.message); return; }
  for (const k of ['alerts', 'news']) homeFeed[k] = homeFeed[k].filter((a) => String(a.id) !== String(id));
  const all = document.querySelector('.feed-all');
  if (all) all.querySelector(`[data-feed-dismiss="${id}"]`)?.closest('li')?.remove();
  homeFeedMount();
}

document.addEventListener('click', (event) => {
  const t = (sel) => event.target.closest?.(sel);
  if (t('[data-feed-tab]')) { homePausedUntil = Date.now() + 30_000; return homeGo(t('[data-feed-tab]').dataset.feedTab); }
  if (t('[data-feed-pause]')) { homeStopped = !homeStopped; return homeFeedMount(); }
  if (t('[data-feed-all]')) return homeFeedAll(t('[data-feed-all]').dataset.feedAll);
  if (t('[data-feed-dismiss]')) return homeFeedDismiss(t('[data-feed-dismiss]').dataset.feedDismiss);
  const backdrop = t('.modal-backdrop');
  if (backdrop?.querySelector('.feed-all') && (t('[data-feed-close]') || event.target === backdrop || t('.feed-open'))) backdrop.remove();
});
addEventListener('resize', () => { if (document.getElementById('home-feed')) homeGo(homeSlide, { smooth: false }); });

// ---------- home screen messages, for admins ----------

let homeAdmin = null;
let homeDraft = null;
const blankHomeDraft = () => ({ kind: 'alert', everyone: false, teams: [], people: [], title: '', body: '', link: '', linkWeb: '', tone: 'info', until: '', email: false, find: '' });

function homeAdminHtml() {
  const a = homeAdmin, d = homeDraft;
  const seg = (name, value, options) => `<span class="segment">${options.map(([k, l]) => `<button class="seg${value === k ? ' on' : ''}" data-hm-set="${name}" data-value="${k}">${l}</button>`).join('')}</span>`;
  const pages = [['', 'No link'], ...[...MODULES.filter((m) => m.route), { route: '#/log', name: 'Log time' }].map((m) => [m.route, m.name]).sort((x, y) => x[1].localeCompare(y[1])), ['web', 'A web address']];
  const found = d.find.trim().length > 1 ? a.people.filter((p) => !d.people.includes(p.id) && p.name.toLowerCase().includes(d.find.trim().toLowerCase())).slice(0, 8) : [];
  const form = `<div class="card hm-form">
      <p class="muted">What is it?</p>
      ${seg('kind', d.kind, [['alert', 'An alert'], ['announcement', 'News']])}
      <p class="help">${d.kind === 'alert' ? 'Alerts show under Alerts, for the people you choose. Use them for things someone needs to act on.' : 'News shows under News. Use it for things everyone, or a team, should know.'}</p>
      <p class="muted">Who for?</p>
      ${seg('everyone', d.everyone ? 'yes' : 'no', [['yes', 'Everyone'], ['no', 'Choose teams or people']])}
      ${d.everyone ? '' : `<div class="chips" style="margin-top:.6rem">${a.teams.map((t) => `<button class="chip${d.teams.includes(t) ? ' on' : ''}" data-hm-team="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <div class="hm-people">${d.people.map((id) => `<span class="con-person">${esc(a.people.find((p) => p.id === id)?.name || id)}<button data-hm-unperson="${esc(id)}" aria-label="Remove">×</button></span>`).join('')}</div>
        <label>Add a person <input type="search" data-hm-field="find" value="${esc(d.find)}" placeholder="Type a name" autocomplete="off"></label>
        ${found.length ? `<div class="hm-found">${found.map((p) => `<button class="chip-btn" data-hm-person="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>` : ''}`}
      <label>Title <input data-hm-field="title" maxlength="120" value="${esc(d.title)}" placeholder="For example: Return the van keys to reception"></label>
      <label>Message, optional <textarea data-hm-field="body" rows="3" maxlength="1000">${esc(d.body)}</textarea></label>
      <div class="row">
        <label>Link to <select data-hm-field="link">${pages.map(([v, l]) => `<option value="${esc(v)}"${d.link === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        ${d.link === 'web' ? `<label style="flex:1">Web address <input data-hm-field="linkWeb" value="${esc(d.linkWeb)}" placeholder="https://"></label>` : ''}
      </div>
      <p class="muted">How important?</p>
      ${seg('tone', d.tone, [['info', 'Normal'], ['important', 'Important']])}
      <p class="help">Important ones show first, and the strip opens on Alerts for them.</p>
      <div class="row" style="align-items:end">
        <label>Show until, optional <input type="date" data-hm-field="until" value="${esc(d.until)}" min="${todayIso()}"></label>
        <label class="inline-check"><input type="checkbox" data-hm-field="email"${d.email ? ' checked' : ''}> Email it to them too</label>
      </div>
      <div class="row"><button class="btn" data-hm-send>Send</button></div>
      <div class="result" id="hm-result" role="status"></div>
    </div>`;
  const rows = a.messages.map((m) => `<li>
      <span class="title">${m.tone === 'important' ? '<span class="psc-chip warn">Important</span> ' : ''}${esc(m.title)}</span>
      <span class="xp"><small>${m.kind === 'alert' ? 'Alert' : 'News'}</small></span>
      <span class="sub">${esc(m.audienceText)}. Seen by ${n(m.seen)} of ${n(m.reach)}${m.dismissed ? `, ${n(m.dismissed)} dismissed` : ''}${m.emailed ? ', emailed' : ''}.
        ${esc(m.from || '')}, ${feedWhen(m.at)}. ${m.live ? (m.endsAt ? `Showing until ${feedWhen(m.endsAt)}.` : 'Showing until it\'s ended.') : `Ended ${feedWhen(m.endedAt)}.`}
        ${m.live ? `<button class="linklike" data-hm-end="${m.id}">End it</button>` : ''}</span></li>`).join('');
  return `${form}<h3>Sent</h3>${rows ? `<ul class="list">${rows}</ul>` : '<div class="card"><p class="muted" style="margin:0">Nothing sent yet.</p></div>'}`;
}

async function loadHomeAdmin() {
  const host = document.getElementById('home-admin');
  if (!host) return;
  try {
    homeAdmin = await api('/api/admin/home-messages');
    homeDraft ||= blankHomeDraft();
    host.innerHTML = homeAdminHtml();
  } catch (err) { host.innerHTML = `<div class="card"><p class="bad">${esc(err.message)}</p></div>`; }
}

function homeAdminRedraw(focusField) {
  const host = document.getElementById('home-admin');
  if (!host || !homeAdmin) return;
  host.innerHTML = homeAdminHtml();
  if (focusField) { const el = host.querySelector(`[data-hm-field="${focusField}"]`); if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); } }
}

async function homeAdminClick(event) {
  const t = (sel) => event.target.closest(sel);
  if (!t('#home-admin')) return false;
  const d = homeDraft;
  const set = t('[data-hm-set]');
  if (set) {
    const v = set.dataset.value;
    if (set.dataset.hmSet === 'everyone') d.everyone = v === 'yes'; else d[set.dataset.hmSet] = v;
    homeAdminRedraw(); return true;
  }
  const team = t('[data-hm-team]');
  if (team) { const x = team.dataset.hmTeam; d.teams = d.teams.includes(x) ? d.teams.filter((y) => y !== x) : [...d.teams, x]; homeAdminRedraw(); return true; }
  const person = t('[data-hm-person]');
  if (person) { d.people.push(person.dataset.hmPerson); d.find = ''; homeAdminRedraw('find'); return true; }
  const un = t('[data-hm-unperson]');
  if (un) { d.people = d.people.filter((p) => p !== un.dataset.hmUnperson); homeAdminRedraw(); return true; }
  const end = t('[data-hm-end]');
  if (end) {
    if (!confirm('Take this off everyone\'s home screen?')) return true;
    try { await api('/api/admin/home-messages/end', { method: 'POST', body: JSON.stringify({ id: end.dataset.hmEnd }) }); toast('Ended'); } catch (err) { toast(err.message); }
    homeFeedAt = 0;
    await loadHomeAdmin(); return true;
  }
  const send = t('[data-hm-send]');
  if (send) {
    send.disabled = true;
    const out = document.getElementById('hm-result');
    try {
      const r = await api('/api/admin/home-messages', { method: 'POST', body: JSON.stringify({ ...d, link: d.link === 'web' ? d.linkWeb : d.link }) });
      toast(r.emailed ? `Sent, and emailed to ${n(r.emailed)}` : 'Sent');
      homeDraft = blankHomeDraft();
      homeFeedAt = 0;
      await loadHomeAdmin();
    } catch (err) { out.textContent = err.message; out.className = 'result bad'; send.disabled = false; }
    return true;
  }
  return false;
}

function homeAdminInput(event) {
  const f = event.target.dataset?.hmField;
  if (!f || !homeDraft) return false;
  homeDraft[f] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  if (f === 'find' || f === 'link') homeAdminRedraw(f === 'find' ? 'find' : null);
  return true;
}

// ---------- arranging tiles ----------

let tilePrefs = { order: null, hidden: [] };
let arrangeMode = false;

// 'open', 'locked' (shown greyed out as under construction) or false (not shown).
function tileAccess(m) {
  const u = me.user;
  const needs = m.needs || (m.adminOnly ? 'admin' : m.leadOnly ? 'oversight' : null);
  const hasNeed = !needs || u.isAdmin || [].concat(needs).some((n) => Boolean(u.can?.[n]));
  const inTeams = !m.teams || u.isAdmin || u.isLead || m.teams.some((t) => (u.teams || []).includes(t));
  if (hasNeed && inTeams) return 'open';
  return m.whenLocked === 'construction' ? 'locked' : false;
}
const allowedTile = (m) => Boolean(tileAccess(m));

function orderedTiles() {
  const allowed = MODULES.filter((m) => allowedTile(m) && !tilePrefs.hidden.includes(m.id));
  if (!tilePrefs.order?.length) return allowed;
  const position = new Map(tilePrefs.order.map((id, i) => [id, i]));
  // Anything new since they last arranged goes to the end.
  return allowed.sort((a, b) => (position.get(a.id) ?? 999) - (position.get(b.id) ?? 999));
}

async function saveTilePrefs() {
  tilePrefs.order = orderedTiles().map((m) => m.id);
  try {
    await api('/api/prefs/tiles', { method: 'POST', body: JSON.stringify(tilePrefs) });
  } catch {
    toast('Saved on this device only, just now');
  }
}

async function tileControl(action, id) {
  if (action === 'arrange') { arrangeMode = true; return render(); }
  if (action === 'done') { arrangeMode = false; await saveTilePrefs(); return render(); }

  const order = orderedTiles().map((m) => m.id);
  const index = order.indexOf(id);
  if (action === 'up' && index > 0) order.splice(index - 1, 0, ...order.splice(index, 1));
  if (action === 'down' && index < order.length - 1) order.splice(index + 1, 0, ...order.splice(index, 1));
  if (action === 'hide') tilePrefs.hidden = [...tilePrefs.hidden, id];
  if (action === 'show') tilePrefs.hidden = tilePrefs.hidden.filter((h) => h !== id);
  tilePrefs.order = order;
  await saveTilePrefs();
  return render();
}

// ---------- employees ----------

let peopleCache = null;
let personEdit = null;        // the person being edited, or a blank one

function personEditHtml() {
  const p = personEdit;
  const { people = [], icons = [], departments = [] } = peopleCache || {};
  const field = (key, label, value, extra = '') =>
    `<label style="margin-top:.75rem">${esc(label)} <input data-person="${key}" value="${esc(value ?? '')}" ${extra} autocomplete="off"></label>`;

  return `
    <div class="card">
      <h2 style="margin-top:0">${p.accountId ? esc(p.name || 'Edit employee') : 'Add someone'}</h2>

      <div class="avatar-edit">
        <label class="avatar-circle" for="avatar-input" title="Choose a picture">
          ${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : `<span>${esc(initialsOf(p.name))}</span>`}
        </label>
        <input id="avatar-input" type="file" accept="image/*" hidden>
        <div>
          <label class="linklike" for="avatar-input">${p.avatar ? 'Change picture' : 'Add picture'}</label>
          ${p.avatar ? ' <button class="linklike" data-person-action="remove-avatar">Remove</button>' : ''}
          <p class="muted" style="margin:.25rem 0 0">Shown on the company chart.</p>
        </div>
      </div>

      <p class="muted" style="margin:1rem 0 0">Who they are</p>
      ${field('name', 'Name', p.name)}
      ${field('email', 'Work email', p.email, 'type="email" placeholder="name@promtek.com"')}
      ${field('pronouns', 'Pronouns, optional', p.pronouns, 'placeholder="He/Him"')}
      ${field('jobTitle', 'Job title', p.jobTitle)}

      <p class="muted" style="margin:1.5rem 0 0">Where they sit</p>
      <label style="margin-top:.75rem">Department <select data-person="department">
        <option value="">Not set</option>
        ${departments.map((d) => `<option value="${esc(d.name)}"${d.name === p.department ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select></label>
      <label style="margin-top:.75rem">Reports to <select data-person="managerId">
        <option value="">Nobody, top of the chart</option>
        ${people.filter((m) => m.accountId !== p.accountId && m.active).map((m) =>
          `<option value="${esc(m.accountId)}"${m.accountId === p.managerId ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}
      </select></label>
      <div class="row" style="margin-top:.75rem">
        <label>Order on the chart <input data-person="order" type="number" value="${p.order ?? 50}"></label>
      </div>
      ${personAccessHtml(p)}

      <p class="muted" style="margin:1.5rem 0 0">XP and ELO</p>
      <div class="row" style="margin-top:.75rem">
        <label>XP rate <input data-person="xpRate" type="number" min="0" max="500" value="${p.xpRate ?? 60}"></label>
        <label>ELO <input data-person="elo" type="number" min="0" max="4000" value="${p.elo ?? ''}" placeholder="1099"></label>
      </div>
      <p class="muted">XP rate is the base XP per hour. Engineers are on 60, and their rate rises and falls with the
      difficulty of the job against their own ELO. Admin staff are on 75, since they get no ELO adjustment.</p>

      <p class="muted" style="margin:1.5rem 0 0">Accounts</p>
      ${field('accountId', 'Jira account ID', p.accountId, p.accountId && !p.pending ? 'readonly' : 'placeholder="712020:..."')}
      ${p.accountId && !p.pending ? `<p class="muted">Changing this moves their history too.
        <button class="linklike" data-person-action="change-id">Change it</button></p>` : ''}
      ${field('extension', '8x8 extension', p.extension, 'placeholder="120088"')}

      <p class="muted" style="margin:1.5rem 0 0">Badges on the chart</p>
      <div class="chips" style="margin-top:.5rem">${icons.map((icon) =>
        `<button class="chip${(p.icons || []).includes(icon.id) ? ' on' : ''}" data-person-icon="${esc(icon.id)}">${esc(icon.label)}</button>`).join('')}</div>

      ${field('notes', 'Notes, optional', p.notes)}

      <div class="row" style="margin-top:1.5rem">
        <button class="btn" data-person-action="save">${p.accountId ? 'Save' : 'Add them'}</button>
        <button class="btn secondary" data-person-action="cancel">Cancel</button>
        ${p.accountId ? `<button class="btn secondary" data-person-action="remove">Remove</button>` : ''}
      </div>
      <div class="result" id="person-result" role="status"></div>
    </div>`;
}

const initialsOf = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');

// Pictures are squared off and shrunk in the browser, so what reaches the
// database is a few kilobytes rather than a few megabytes.
async function readAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const size = 128;
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

function collectPerson() {
  document.querySelectorAll('[data-person]').forEach((input) => {
    personEdit[input.dataset.person] = input.value.trim();
  });
  if (document.querySelector('[data-person-group]')) {
    personEdit.groups = [...document.querySelectorAll('[data-person-group]:checked')].map((c) => c.dataset.personGroup);
    personEdit.teams = [...document.querySelectorAll('[data-person-team].on')].map((c) => c.dataset.personTeam);
    personEdit.leadOf = [...document.querySelectorAll('[data-person-lead]:checked')].map((c) => c.dataset.personLead).filter((t) => personEdit.teams.includes(t));
  }
}

async function personAction(action) {
  const out = (text, bad) => {
    const el = document.getElementById('person-result');
    if (el) { el.textContent = text; el.className = `result ${bad ? 'bad' : 'good'}`; }
  };
  if (action === 'cancel') { personEdit = null; return render(); }
  if (action === 'remove-avatar') {
    collectPerson();
    personEdit.avatar = null;
    return render();
  }

  if (action === 'change-id') {
    const current = personEdit.accountId;
    const next = prompt('New Jira account ID', current);
    if (!next || next === current) return;
    try {
      await api('/api/admin/person-id', { method: 'POST', body: JSON.stringify({ from: current, to: next.trim() }) });
      personEdit.accountId = next.trim();
      toast('Account ID changed, history moved with it');
      return render();
    } catch (err) {
      return out(err.message, true);
    }
  }

  if (action === 'remove') {
    const keep = confirm(`Remove ${personEdit.name}?\n\nOK keeps their XP history and hides them.\nCancel removes everything.`);
    try {
      await api('/api/admin/person-remove', {
        method: 'POST',
        body: JSON.stringify({ accountId: personEdit.accountId, keepHistory: keep }),
      });
      personEdit = null;
      toast('Removed');
      return render();
    } catch (err) {
      return out(err.message, true);
    }
  }

  collectPerson();
  try {
    await api('/api/admin/person', { method: 'POST', body: JSON.stringify(personEdit) });
    personEdit = null;
    toast('Saved');
    return render();
  } catch (err) {
    out(err.message, true);
  }
}

// ---------- company chart ----------

let orgData = null;
let orgLogoData = null;

// The logo has to be inlined, or it goes missing when the chart is exported.
async function loadOrgLogo() {
  if (orgLogoData) return;
  try {
    const response = await fetch('/icon-192.png');
    const blob = await response.blob();
    orgLogoData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    orgLogoData = null;
  }
}

const ORG = { boxW: 208, boxH: 62, gapX: 18, gapY: 44, stackY: 10, indent: 26, pad: 28, avatar: 38 };

// Little white glyphs that sit on a nameplate.
const ORG_ICONS = {
  'first-aid': 'M4.6 1h2.8v2.6H10v2.8H7.4V9H4.6V6.4H2V3.6h2.6Z',
  'mental-health': 'M6 10.6 1.9 6.7a2.7 2.7 0 0 1 3.8-3.8L6 3.2l0.3-0.3a2.7 2.7 0 0 1 3.8 3.8Z',
  fire: 'M6 0.6c1.8 2 1 3.4 0.4 4.2-0.5 0.7-0.9 1.4-0.3 2.3 0.3-0.6 0.9-1 1.5-1.1-0.2 1.4 1.6 1.8 1.6 3.4A3.4 3.4 0 0 1 6 11.4a3.4 3.4 0 0 1-3.2-3.5C2.8 4.6 6 4 6 0.6Z',
  evacuation: 'M7.1 0.8a1.2 1.2 0 1 1-1.2 1.2 1.2 1.2 0 0 1 1.2-1.2ZM5.4 4 3 5.6l0.8 1.3 1.7-1.1 0.3 1.6-2 3.4 1.3 0.8 1.9-3.1 1.4 1.5 0.4 2.2 1.5-0.3-0.5-2.7-1.6-1.8 0.6-2 1.2 1.3 1.8-0.2-0.2-1.5-1.3 0.1-1.8-1.9Z',
  defib: 'M1 6.2h2.4l1-2.4 1.6 4.6 1.3-3.2 0.8 1h2.9v1.4H7.4l-1.3 3L4.4 6.2 3.7 7.6H1Z',
  safety: 'M6 0.6 10.8 2.6v3.2c0 3-2 5.2-4.8 6-2.8-0.8-4.8-3-4.8-6V2.6Zm-0.5 7.6 3.2-3.2-1-1-2.2 2.2-1-1-1 1Z',
};

// Laid out like the chart it replaces: the top two levels spread across the
// page, and from there each team stacks vertically under its lead, which keeps
// the whole thing a sensible width.
function layout(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const node of nodes) {
    const key = node.managerId && byId.has(node.managerId) ? node.managerId : '__root';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const kidsOf = (node) => children.get(node.id) || [];

  // How much room a person and everyone under them needs.
  const measure = (node, depth) => {
    const kids = kidsOf(node);
    if (!kids.length) return { width: ORG.boxW, height: ORG.boxH };

    if (depth < 1) {
      const blocks = kids.map((kid) => measure(kid, depth + 1));
      const width = blocks.reduce((sum, b) => sum + b.width, 0) + ORG.gapX * (blocks.length - 1);
      const height = ORG.boxH + ORG.gapY + Math.max(...blocks.map((b) => b.height));
      return { width: Math.max(ORG.boxW, width), height, blocks };
    }

    const blocks = kids.map((kid) => measure(kid, depth + 1));
    const width = ORG.indent + Math.max(...blocks.map((b) => b.width));
    const height = ORG.boxH + ORG.gapY
      + blocks.reduce((sum, b) => sum + b.height, 0) + ORG.stackY * (blocks.length - 1);
    return { width: Math.max(ORG.boxW, width), height, blocks };
  };

  const placed = [];
  const place = (node, depth, left, top, block) => {
    const kids = kidsOf(node);
    const x = depth < 1 && kids.length ? left + (block.width - ORG.boxW) / 2 : left;
    placed.push({ ...node, x, y: top, depth, stacked: depth >= 1 && kids.length > 0 });
    if (!kids.length) return;

    if (depth < 1) {
      let cursor = left;
      kids.forEach((kid, i) => {
        place(kid, depth + 1, cursor, top + ORG.boxH + ORG.gapY, block.blocks[i]);
        cursor += block.blocks[i].width + ORG.gapX;
      });
      return;
    }

    let cursor = top + ORG.boxH + ORG.gapY;
    kids.forEach((kid, i) => {
      place(kid, depth + 1, left + ORG.indent, cursor, block.blocks[i]);
      cursor += block.blocks[i].height + ORG.stackY;
    });
  };

  const roots = children.get('__root') || [];
  let cursor = ORG.pad;
  let tallest = 0;
  for (const root of roots) {
    const block = measure(root, 0);
    place(root, 0, cursor, ORG.pad + 16, block);
    cursor += block.width + ORG.gapX * 2;
    tallest = Math.max(tallest, block.height);
  }

  return {
    placed,
    width: cursor + ORG.pad,
    height: ORG.pad * 2 + 16 + tallest,
    children,
  };
}

function orgSvg(data, label = null) {
  const { placed, width, height, children } = layout(data.nodes);
  const byId = new Map(placed.map((p) => [p.id, p]));

  const stroke = 'fill="none" stroke="#c6d2db" stroke-width="1.5"';
  const lines = placed.flatMap((node) => {
    const kids = (children.get(node.id) || []).map((k) => byId.get(k.id)).filter(Boolean);
    if (!kids.length) return [];

    if (node.depth < 1) {
      const from = node.y + ORG.boxH;
      const mid = from + ORG.gapY / 2;
      const cx = node.x + ORG.boxW / 2;
      return [
        `<path d="M${cx} ${from} V${mid}" ${stroke}/>`,
        ...kids.map((kid) => `<path d="M${cx} ${mid} H${kid.x + ORG.boxW / 2} V${kid.y}" ${stroke}/>`),
      ];
    }

    // A spine down the left of the team, with a short arm into each person.
    const spineX = node.x + 14;
    const last = kids[kids.length - 1];
    return [
      `<path d="M${spineX} ${node.y + ORG.boxH} V${last.y + ORG.boxH / 2}" ${stroke}/>`,
      ...kids.map((kid) => `<path d="M${spineX} ${kid.y + ORG.boxH / 2} H${kid.x}" ${stroke}/>`),
    ];
  });

  const boxes = placed.map((node) => {
    const icons = (node.icons || []).filter((id) => ORG_ICONS[id]).slice(0, 3);
    const textX = node.x + (node.avatar ? ORG.avatar + 18 : 12);
    const room = ORG.boxW - (textX - node.x) - (icons.length ? icons.length * 20 + 8 : 10);
    const titleLines = wrapText(node.title || '', Math.max(12, Math.round(room / 5.1))).slice(0, 2);

    // A white disc behind each badge keeps it readable at chart size.
    const badges = icons.map((id, i) => `<g transform="translate(${node.x + ORG.boxW - 26 - i * 20} ${node.y + 8})">
        <circle cx="8" cy="8" r="8.5" fill="#ffffff" opacity="0.95"/>
        <g transform="translate(2.1 2.1)"><path d="${ORG_ICONS[id]}" fill="${node.colour}"/></g>
      </g>`).join('');

    const avatar = node.avatar ? `
      <clipPath id="clip-${esc(node.id)}"><circle cx="${node.x + 10 + ORG.avatar / 2}" cy="${node.y + ORG.boxH / 2}" r="${ORG.avatar / 2}"/></clipPath>
      <circle cx="${node.x + 10 + ORG.avatar / 2}" cy="${node.y + ORG.boxH / 2}" r="${ORG.avatar / 2 + 1.5}" fill="#ffffff" opacity="0.95"/>
      <image href="${node.avatar}" x="${node.x + 10}" y="${node.y + (ORG.boxH - ORG.avatar) / 2}" width="${ORG.avatar}" height="${ORG.avatar}" clip-path="url(#clip-${esc(node.id)})" preserveAspectRatio="xMidYMid slice"/>` : '';

    return `<g>
      <rect x="${node.x}" y="${node.y}" width="${ORG.boxW}" height="${ORG.boxH}" rx="9" fill="${node.colour}"/>
      ${avatar}
      ${badges}
      <text x="${textX}" y="${node.y + (titleLines.length > 1 ? 22 : 26)}" font-family="Titillium Web, Segoe UI, sans-serif" font-size="12.5" font-weight="700" fill="#ffffff">${esc(node.name)}</text>
      ${titleLines.map((line, i) => `<text x="${textX}" y="${node.y + 37 + i * 12}" font-family="Titillium Web, Segoe UI, sans-serif" font-size="10" fill="#ffffff" opacity="0.9">${esc(line)}</text>`).join('')}
    </g>`;
  });

  const legendY = height + 10;
  const legend = data.departments.map((d, i) => `<g>
      <rect x="${ORG.pad + i * 118}" y="${legendY}" width="11" height="11" rx="3" fill="${d.colour}"/>
      <text x="${ORG.pad + i * 118 + 18}" y="${legendY + 10}" font-family="Titillium Web, Segoe UI, sans-serif" font-size="11" fill="#5b7385">${esc(d.name)}</text>
    </g>`).join('');

  const total = height + 48;
  const logo = orgLogoData
    ? `<image href="${orgLogoData}" x="${ORG.pad}" y="6" width="34" height="34"/>`
    : '';
  return `<svg id="org-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${total}" width="${width}" height="${total}">
      <rect width="${width}" height="${total}" fill="#ffffff"/>
      ${logo}
      <text x="${ORG.pad + (logo ? 44 : 0)}" y="20" font-family="Titillium Web, Segoe UI, sans-serif" font-size="14" font-weight="700" fill="#0f2b3d">Promtek</text>
      <text x="${ORG.pad + (logo ? 44 : 0)}" y="34" font-family="Titillium Web, Segoe UI, sans-serif" font-size="10.5" fill="#5b7385">${esc(label || (data.document ? `${data.document.reference}, issued ${new Date(data.document.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` : `Company chart, ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`))}</text>
      ${lines.join('')}
      ${boxes.join('')}
      ${legend}
    </svg>`;
}

function wrapText(text, perLine) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > perLine && line) { lines.push(line); line = word; } else { line = candidate; }
  }
  if (line) lines.push(line);
  return lines;
}

function orgHtml(data) {
  const missing = data.nodes.filter((n) => !n.title || !n.department).length;
  return `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <span>${data.document ? `<strong>${esc(data.document.reference)}</strong>, issued ${shortDate(data.document.issuedAt.slice(0, 10))}. ` : ''}<span class="muted">${n(data.nodes.length)} people on the chart${missing ? `, ${n(missing)} without a title or team` : ''}</span></span>
        <button class="btn" data-org="download">Download as an image</button>
      </div>
    </div>
    <div class="org-scroll">${orgSvg(data)}</div>`;
}

// The chart is drawn as SVG, so it can be turned straight into a PNG.
async function orgDownload() {
  const svg = document.getElementById('org-svg');
  if (!svg) return;
  const source = new XMLSerializer().serializeToString(svg);
  const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(source)))}`;

  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('The chart could not be turned into an image.'));
    image.src = url;
  });

  const scale = 2;                                       // readable when printed or pasted
  const canvas = document.createElement('canvas');
  canvas.width = image.width * scale;
  canvas.height = image.height * scale;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  canvas.toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Promtek company chart ${todayIso()}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  }, 'image/png');
}

// ---------- settings panels ----------

async function renderSettings(route) {
  settingsData = {
    overview: await api('/api/admin/overview').catch(() => ({ employees: [], alerts: [], state: {}, jobs: {} })),
  };
  if (route === '#/it') settingsData.it = await api('/api/admin/it-types').catch((err) => ({ categories: [], types: [], error: err.message }));
  if (route === '#/vehicles') settingsData.vehicles = await api('/api/admin/vehicles').catch(() => ({ vehicles: [] }));
  if (route === '#/pow') settingsData.ra = await api('/api/admin/ra-library').catch(() => ({ items: [] }));
  if (route === '#/quotes') settingsData.quoteConfig = await api('/api/admin/quote-config');
  if (route === '#/condor') settingsData.bitbucket = await api('/api/admin/bitbucket').catch(() => ({ configured: false, last: null, week: null }));
  if (route === '#/org') settingsData.org = await api('/api/admin/org');
  if (route === '#/psc') settingsData.psc = await api('/api/psc/settings').catch((err) => ({ error: err.message }));
  if (route === '#/contracts') settingsData.contracts = await api('/api/contracts/settings').catch((err) => ({ error: err.message }));
  if (route === '#/obs') settingsData.library = await api('/api/obs/library').catch(() => ({}));
  const back = `<div class="row" style="margin-bottom:1rem"><button class="btn secondary" data-settings="close">Back to the app</button></div>`;
  return back + TILE_SETTINGS[route].render();
}

function settingsQuotesHtml() {
  const c = settingsData.quoteConfig;
  const box = (id, label, value, hint) => `<label style="margin-top:1rem">${label}<small class="muted" style="display:block;font-weight:400">${hint}</small>
    <textarea rows="5" data-qcfg="${id}">${esc(value)}</textarea></label>`;
  const sections = ['software', 'hardware', 'engineering', 'condor'].map((d) => `<div class="card" style="margin-top:1rem">
      <h2 style="margin-top:0">${DISCIPLINE_NAMES[d]}</h2>
      ${d === 'engineering' ? box(`${d}.jobTypes`, 'Kinds of visit', (c[d].jobTypes || []).join('\n'), 'One per line.') : ''}
      ${box(`${d}.counts`, 'Counts', c[d].counts.map(([k, l]) => `${k}: ${l}`).join('\n'), 'One per line, as a short name, a colon, then the label. Keep the short name the same once quotes use it, or their history stops matching.')}
      ${box(`${d}.chips`, 'Conditions', c[d].chips.join('\n'), 'One per line.')}</div>`).join('');
  return `<div class="card"><p style="margin-top:0">These are what the quote builder asks about. The counts and conditions that best explain how long jobs take are the ones worth keeping; the learned estimate uses all of them.</p>
      ${box('common', 'Conditions for every category', (c.common || []).join('\n'), 'One per line.')}</div>
    ${sections}
    <div class="row" style="margin-top:1rem"><button class="btn" data-qcfg-save="1">Save</button></div>
    <div class="result" id="qcfg-result" role="status"></div>`;
}

async function saveQuoteSettings(button) {
  const val = (id) => view.querySelector(`[data-qcfg="${id}"]`)?.value.split('\n').map((x) => x.trim()).filter(Boolean) || [];
  const out = { common: val('common') };
  for (const d of ['software', 'hardware', 'engineering', 'condor']) {
    out[d] = {
      counts: val(`${d}.counts`).map((line) => { const i = line.indexOf(':'); return i > 0 ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] : null; }).filter(Boolean),
      chips: val(`${d}.chips`),
    };
    if (d === 'engineering') out[d].jobTypes = val(`${d}.jobTypes`);
  }
  button.disabled = true;
  try {
    settingsData.quoteConfig = await api('/api/admin/quote-config', { method: 'POST', body: JSON.stringify(out) });
    document.getElementById('qcfg-result').textContent = 'Saved.';
  } catch (err) { document.getElementById('qcfg-result').textContent = err.message; }
  button.disabled = false;
}

function settingsPowHtml() {
  const items = settingsData.ra.items || [];
  return `<div class="card">
      <h2 style="margin-top:0">Risk assessments and safe systems of work</h2>
      <p class="muted">What engineers can pick from when filling in an assessment.</p>
      <ul class="list" style="box-shadow:none">${items.map((r) => `<li>
          <span class="title">${esc(r.title)}</span>
          <span class="sub">${r.active ? 'In the list' : 'Hidden'}</span>
          <span class="xp"><button class="linklike" data-ra-toggle="${esc(r.id)}" data-ra-active="${r.active ? 0 : 1}" data-ra-title="${esc(r.title)}">${r.active ? 'Hide' : 'Show'}</button></span>
        </li>`).join('') || '<li><span class="muted">Nothing yet.</span></li>'}</ul>
      <div class="row" style="margin-top:1rem">
        <label style="flex:1">Add one <input id="ra-title" placeholder="RA - 1021 - Working at Height" autocomplete="off"></label>
        <button class="btn" data-action="ra-add">Add</button>
      </div>
      <div class="result" id="ra-result" role="status"></div>
    </div>`;
}

function settingsVehiclesHtml() {
  const vehicles = settingsData.vehicles.vehicles || [];
  return `<div class="card">
      <h2 style="margin-top:0">The fleet</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Registration</th><th>Vehicle</th><th>Status</th><th>MOT</th><th>Insurance</th><th>Tax</th><th>Service</th><th class="num">Miles</th></tr></thead>
        <tbody>${vehicles.map((v) => `<tr>
          <td><button class="linklike" data-admin-vehicle="${esc(v.id)}">${esc(v.registration)}</button></td>
          <td>${esc([v.make, v.model, v.kind].filter(Boolean).join(' '))}</td>
          <td>${v.active ? (v.offRoad ? '<span class="bad">Off the road</span>' : 'Available') : '<span class="muted">Retired</span>'}</td>
          <td>${esc(v.mot_due || '—')}</td><td>${esc(v.insurance_due || '—')}</td>
          <td>${esc(v.tax_due || '—')}</td><td>${esc(v.service_due || '—')}</td>
          <td class="num">${v.mileage ? n(v.mileage) : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">No vehicles yet.</td></tr>'}</tbody>
      </table></div>
      <div class="row" style="margin-top:1rem">
        <button class="btn" data-admin-vehicle="">Add a vehicle</button>
        <button class="btn secondary" data-action="vehicle-expiries">Check expiry dates now</button>
      </div>
      <div id="vehicle-form"></div>
      <div class="result" id="vehicle-result" role="status"></div>
    </div>`;
}

function settingsCallsHtml() {
  const people = (settingsData.overview.employees || []).filter((e) => e.active !== 0);
  return `<div class="card">
      <h2 style="margin-top:0">8x8 connection</h2>
      <p class="muted">Calls are only fetched when someone asks for them.</p>
      <button class="btn secondary" data-action="test-8x8">Test the connection</button>
      <button class="btn secondary" data-action="test-live-calls">Test live calls</button>
      <div class="result" id="eight8-result" role="status"></div>
    </div>
    <h2>Extensions</h2>
    <p class="muted" style="margin-top:-.5rem">Calls are matched to people by extension, or by the name on the call if this is blank.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Engineer</th><th>Extension</th></tr></thead>
      <tbody>${people.map((e) => `<tr>
        <td>${esc(e.name)}</td>
        <td><input class="tiny" data-extension="${esc(e.account_id)}" value="${esc(e.extension || '')}" placeholder="—" autocomplete="off"></td>
      </tr>`).join('') || '<tr><td colspan="2" class="muted">No engineers yet.</td></tr>'}</tbody>
    </table></div>`;
}

function settingsItHtml() {
  const it = settingsData.it;
  itServiceDeskId = it.serviceDeskId || itServiceDeskId;
  return `<div class="card">
      <h2 style="margin-top:0">Request types</h2>
      <p class="muted">What the hub offers, and the Jira request type each one raises.</p>
      ${it.error ? `<p class="bad">${esc(it.error)}</p>` : `
        <div class="table-wrap"><table>
          <thead><tr><th>In the hub</th><th>Raises in Jira</th></tr></thead>
          <tbody>${it.categories.map((c) => `<tr>
            <td>${esc(c.label)}</td>
            <td><select data-it-map="${esc(c.id)}">
              <option value="">Not set up</option>
              ${it.types.map((t) => `<option value="${esc(t.id)}"${t.id === c.mapped ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
            </select></td>
          </tr>`).join('')}</tbody>
        </table></div>`}
      <div class="result" id="it-map-result" role="status"></div>
    </div>`;
}

function settingsObsHtml() {
  const library = settingsData.library || {};
  const kinds = [['vdus', 'VDUs'], ['controlPCs', 'Control PCs'], ['lcAmps', 'Amplifiers'], ['loadCells', 'Load cells'],
    ['plcCards', 'PLC cards'], ['software', 'Software'], ['criticalSpares', 'Critical spares']];
  return `<div class="card">
      <h2 style="margin-top:0">Equipment library</h2>
      <p class="muted">What the survey suggests as engineers type. It grows on its own from every finished survey.</p>
      <div class="stats" style="margin:0">${kinds.map(([key, label]) => `<div>
          <dt>${esc(label)}</dt><dd>${n((library[key] || []).length)}</dd>
        </div>`).join('')}</div>
    </div>
    <div class="card" style="margin-top:1rem">
      <p style="margin-top:0">The library came from the master sheet and keeps itself up to date, so there is usually
      nothing to do here. Entries can be removed if something wrong gets in.</p>
      <div class="row">
        <label>Type <select id="lib-kind">${kinds.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
        <button class="btn secondary" data-action="lib-list">Show entries</button>
      </div>
      <div id="lib-list"></div>
      <div class="result" id="lib-result" role="status"></div>
    </div>`;
}

function settingsReportsHtml() {
  const jobs = settingsData.overview.jobs || {};
  const state = settingsData.overview.state || {};
  return `<div class="card">
      <h2 style="margin-top:0">Completed job tracking</h2>
      <p style="margin-top:0">Finished customer work is recorded for quoting. Each category is recorded as soon as it is done, and that is what the ELO engine rates.</p>
      <dl class="state">
        <dt>Items recorded</dt><dd>${n(jobs.rows || 0)} (${n(jobs.epics || 0)} orders, ${n(jobs.categories || 0)} categories, ${n(jobs.stages || 0)} stages)</dd>
        <dt>Covering</dt><dd>${jobs.earliest ? `${esc(jobs.earliest)} to ${esc(jobs.latest)}` : 'Nothing yet'}</dd>
        <dt>Backfill</dt><dd>${!jobs.until ? 'Not started'
          : jobs.done ? `Finished, back to ${esc(jobs.until)}`
          : `Working backwards, reached ${esc(jobs.before)} of ${esc(jobs.until)}`}</dd>
        <dt>Finished categories</dt><dd>${jobs.categoryCursor ? `Checked up to ${esc(jobs.categoryCursor.replace(/\//g, '-'))}` : 'Not checked yet'}</dd>
      </dl>
      <div class="row">
        <button class="btn secondary" data-action="scan-jobs">Scan finished jobs now</button>
        <label>Backfill <select id="backfill-months">
          <option value="12">12 months</option><option value="24" selected>24 months</option><option value="36">36 months</option>
        </select></label>
        <button class="btn" data-action="backfill-start">Start backfill</button>
        <button class="btn secondary" data-action="recompute-stages">Rebuild stage names</button>
      </div>
      <div class="result" id="jobs-result" role="status"></div>
    </div>
    <div class="card" style="margin-top:1rem">
      <h2 style="margin-top:0">Weekly snapshots</h2>
      <p class="muted">Recorded automatically every Monday morning, so progress survives as the numbers move.</p>
      <dl class="state"><dt>Last recorded</dt><dd>${state.last_scheduled_run ? new Date(state.last_scheduled_run).toLocaleString('en-GB') : 'Not yet'}</dd></dl>
      <button class="btn secondary" data-action="snapshot">Record last week now</button>
      <div class="result" id="sync-result" role="status"></div>
    </div>`;
}

// ---------- obsolescence ----------

let obsConfig = null;
let obsView = null;          // 'sales' or null for the engineer view
let obsSurvey = null;        // the survey being filled in
let obsSection = 0;
let obsLibrary = null;
let obsReports = null;
let obsReading = null;       // the report a salesperson is deciding on

function obsChooserHtml() {
  return `<div class="card">
      <h2 style="margin-top:0">What are you here for?</h2>
      <p class="muted">You can do either. Sales usually read, but the survey form is here whenever you need it.</p>
    </div>
    <div style="height:1rem"></div>
    <div class="options">
      <button class="option" data-obs="survey-view">
        <span class="option-main"><strong>Survey a site</strong><span class="muted">Record equipment and produce the report</span></span>
        <span class="chev">›</span>
      </button>
      <button class="option" data-obs="sales">
        <span class="option-main"><strong>Review surveys</strong><span class="muted">Read finished surveys and decide on quotes</span></span>
        <span class="chev">›</span>
      </button>
    </div>`;
}

// Unfinished drafts can be thrown away, with one tap to confirm.
let draftDeleting = null;   // the draft waiting for "Delete it"
function draftActionsHtml(kind, id) {
  if (draftDeleting === `${kind}:${id}`) {
    return `<span class="draft-confirm">Delete this draft?
      <button class="chip-btn danger" data-draft-delete-yes="${kind}" data-id="${esc(id)}">Delete it</button>
      <button class="linklike" data-draft-delete-no>Keep it</button></span>`;
  }
  return `<button class="linklike" data-${kind}-open="${esc(id)}">Continue</button>
    <button class="linklike muted-link" data-draft-delete="${kind}" data-id="${esc(id)}" aria-label="Delete this draft">Delete</button>`;
}

async function draftDeleteClick(event) {
  const t = (sel) => event.target.closest(sel);
  const ask = t('[data-draft-delete]');
  if (ask) { draftDeleting = `${ask.dataset.draftDelete}:${ask.dataset.id}`; render(); return true; }
  if (t('[data-draft-delete-no]')) { draftDeleting = null; render(); return true; }
  const yes = t('[data-draft-delete-yes]');
  if (!yes) return false;
  const kind = yes.dataset.draftDeleteYes, id = yes.dataset.id;
  yes.disabled = true;
  try {
    await api(`/api/${kind}/delete`, { method: 'POST', body: JSON.stringify({ id }) });
    if (kind === 'pow') localDrafts.remove(id);
    draftDeleting = null;
    toast('Draft deleted');
    render();
  } catch (err) { toast(err.message); yes.disabled = false; }
  return true;
}

function obsHomeHtml(data) {
  const drafts = data.surveys.filter((s) => s.status === 'draft');
  const done = data.surveys.filter((s) => s.status !== 'draft');
  const row = (s) => `<li>
      <span class="title">${esc(s.client || 'No client')} ${s.report_key ? `<span class="muted">${esc(s.report_key)}</span>` : ''}</span>
      <span class="sub">${s.status === 'draft' ? `Draft, last touched ${shortDate((s.updated_at || '').slice(0, 10))}`
        : `Completed ${shortDate((s.submitted_at || '').slice(0, 10))}`}${s.delivery_note ? ', needs filing by hand' : ''}</span>
      <span class="xp draft-actions">${s.status === 'draft'
        ? draftActionsHtml('obs', s.id)
        : `<a class="linklike" href="/api/obs/pdf?id=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">PDF</a>`}</span>
    </li>`;
  return `
    ${obsConfig.sales ? `<div class="row" style="justify-content:flex-end;margin-bottom:.75rem">
      <button class="btn secondary" data-obs="chooser">Switch to reviewing</button></div>` : ''}
    <div class="card">
      <p style="margin-top:0">Walk the site, record what's there, and the hub makes the report, files it and moves the job on.</p>
      <button class="btn" data-obs="new">Start a survey</button>
    </div>
    ${drafts.length ? `<h2>Unfinished</h2><ul class="list">${drafts.map(row).join('')}</ul>` : ''}
    ${done.length ? `<h2>Finished</h2><ul class="list">${done.map(row).join('')}</ul>` : ''}`;
}

function obsSalesHtml(data) {
  if (obsReading) {
    const r = obsReading;
    return `
      <div class="card">
        <p class="muted" style="margin:0">Survey for</p>
        <h2 style="margin:.2rem 0 .2rem">${esc(r.client)}</h2>
        <p class="muted" style="margin:0">Surveyed ${esc(shortDate(r.surveyDate))}. ${esc(r.key)}.</p>
      </div>
      <div class="card" style="margin-top:1rem">
        <h3 style="margin-top:0">Does this need a quote?</h3>
        <p class="muted">Either way the report is marked up to date. A quote is created in ${esc(r.projectKey)}, assigned to you, and linked to the report.</p>
        <div class="row">
          <button class="btn" data-obs-quote="yes">Quote required</button>
          <button class="btn secondary" data-obs-quote="no">No quote needed</button>
        </div>
        <div class="result" id="obs-quote-result" role="status"></div>
      </div>
      <div class="row" style="margin-top:1rem"><button class="btn secondary" data-obs="back-to-queue">Back to the list</button></div>`;
  }

  const rows = data.reports.map((r) => `<li class="call">
      <span class="title">${esc(r.client)}</span>
      <span class="sub">Surveyed ${esc(shortDate(r.surveyDate))}. ${esc(r.key)}${r.serviceContract ? `, ${esc(r.serviceContract)} contract` : ''}${r.siteContact ? `, ${esc(r.siteContact)}` : ''}</span>
      <span class="row" style="gap:.4rem;margin-top:.6rem">
        ${r.survey ? `<a class="chip-btn" href="/api/obs/pdf?id=${encodeURIComponent(r.survey.id)}" target="_blank" rel="noopener">Read the survey</a>`
          : r.reportLink ? `<a class="chip-btn" href="${esc(r.reportLink)}" target="_blank" rel="noopener">Read the survey</a>` : ''}
        <button class="chip-btn" data-obs-read="${esc(r.key)}">Finished reading</button>
        <a class="chip-btn" href="${esc(r.url)}" target="_blank" rel="noopener">Jira</a>
      </span>
    </li>`).join('');

  return `
    <div class="row" style="justify-content:flex-end;margin-bottom:.75rem">
      <button class="btn secondary" data-obs="chooser">Switch to surveying</button>
    </div>
    ${data.reports.length ? `<ul class="list">${rows}</ul>`
      : '<div class="card"><p class="muted">Nothing waiting. Completed surveys appear here for review.</p></div>'}`;
}

function obsPickHtml() {
  return `
    <div class="card"><h2 style="margin-top:0">Which site are you surveying?</h2>
      <p class="muted">From the obsolescence reports in Jira.</p>
      <input id="obs-search" type="search" placeholder="Start typing a client name" autocomplete="off">
    </div>
    <div style="height:1rem"></div>
    <div class="options">${(obsReports || []).map((r) => `<button class="option" data-obs-client="${esc(r.key)}">
        <span class="option-main"><strong>${esc(r.client)}</strong>
        <span class="muted">${esc(r.key)}, ${esc(r.status)}${r.serviceContract ? `, ${esc(r.serviceContract)}` : ''}</span></span>
        <span class="chev">›</span>
      </button>`).join('') || '<div class="card"><p class="muted">No obsolescence report items found in Jira.</p></div>'}</div>
    <div class="row" style="margin-top:1rem"><button class="btn secondary" data-obs="back">Cancel</button></div>`;
}

function newSurvey(report) {
  const section = (id) => obsConfig.sections.find((s) => s.id === id);
  return {
    id: `obs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    reportKey: report?.key || null,
    projectKey: report?.projectKey || null,
    title: {
      client: report?.client || '', contractNo: report?.contractNo || '',
      siteContact: report?.siteContact || '', engineer: me.employee.name,
      date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    },
    controlServers: (section('controlServers').fixed || []).map((label) => ({ label, status: '', comments: '' })),
    vdus: [], lcAmps: [], loadCells: [], software: [],
    plcCards: [],
    criticalSpares: [],
    notes: '',
  };
}

function obsField(path, label, value, list) {
  return `<label style="margin-top:.6rem">${esc(label)}
    <input data-obs-field="${esc(path)}" value="${esc(value || '')}"${list ? ` list="${esc(list)}"` : ''} autocomplete="off"></label>`;
}

// ---- Library suggestions: each field only offers what fits the fields above it ----

const obsNorm = (v) => String(v ?? '').trim().toLowerCase();
const obsListId = (path) => `dl-${path.replace(/[^\w]/g, '-')}`;
const obsUnique = () => obsConfig.uniqueFields || ['serialNo', 'ip', 'subnet', 'gateway'];

function obsColumn(section, key) {
  if (key === 'comments') return 'Comments';
  return section.columns?.[key] || null;
}

// The order fields appear in on an item, which is the order they filter in.
function obsOrder(section) {
  return [...(section.columns?.label ? ['label'] : []), ...section.fields.map(([key]) => key), 'comments'];
}

function obsValue(item, key) {
  if (key === 'cardType') return item.cardType || item.title || '';
  return item[key] || '';
}

// Library rows narrowed by the given fields. A value the library has never
// seen is skipped rather than emptying the list.
function obsMatches(section, item, keys) {
  let rows = obsLibrary?.[section.library] || [];
  for (const key of keys) {
    const value = obsNorm(obsValue(item, key));
    const column = obsColumn(section, key);
    if (!value || !column) continue;
    const narrowed = rows.filter((row) => obsNorm(row[column]) === value);
    if (narrowed.length) rows = narrowed;
  }
  return rows;
}

function obsSuggestions(section, item, key) {
  const column = obsColumn(section, key);
  if (!column || !obsLibrary || obsUnique().includes(key)) return [];
  const order = obsOrder(section);
  const filters = key === 'comments' && section.commentsBy ? section.commentsBy : order.slice(0, order.indexOf(key));
  const seen = new Map();
  for (const row of obsMatches(section, item, filters)) {
    const value = String(row[column] || '').trim();
    if (value && !seen.has(obsNorm(value))) seen.set(obsNorm(value), value);
  }
  return [...seen.values()].slice(0, 200);
}

function obsOptions(values) {
  return values.map((v) => `<option value="${esc(v)}"></option>`).join('');
}

// A field with its own suggestion list, so the list can follow the fields above it.
function obsLibField(section, item, base, key, label) {
  const path = `${base}.${key}`;
  if (!obsColumn(section, key) || obsUnique().includes(key)) return obsField(path, label, item[key]);
  const id = obsListId(path);
  return `${obsField(path, label, item[key], id)}<datalist id="${esc(id)}">${obsOptions(obsSuggestions(section, item, key))}</datalist>`;
}

// Works out which item a field path belongs to: vdus[2].cpu, plcCards[0].cards[1].partNo
function obsLocate(path) {
  const match = path.match(/^(\w+)\[(\d+)\](?:\.cards\[(\d+)\])?\.(\w+)$/);
  if (!match) return null;
  const section = obsConfig.sections.find((s) => s.id === match[1]);
  if (!section || section.spares) return null;
  const parent = obsSurvey[match[1]]?.[Number(match[2])];
  const item = match[3] != null ? parent?.cards?.[Number(match[3])] : parent;
  if (!item) return null;
  if (section.cards && match[3] == null) return null;          // the panel's own name
  const base = path.slice(0, path.length - match[4].length - 1);
  return { section, item, base, key: match[4] };
}

// Refreshes the suggestion lists on one item after a field changes.
function obsRefreshLists(base, section, item) {
  for (const key of obsOrder(section)) {
    const list = document.getElementById(obsListId(`${base}.${key}`));
    if (!list) continue;
    const values = obsSuggestions(section, item, key);
    list.innerHTML = obsOptions(key === 'cardType' ? [...new Set([...obsConfig.cardTypes, ...values])] : values);
  }
}

// A part number the library knows fills in the details it always comes with.
// Only empty fields are filled, and only where every matching row agrees.
function obsAutofill(location) {
  const { section, item, base, key } = location;
  if (section.fillFrom !== key) return;
  const column = obsColumn(section, key);
  const value = obsNorm(item[key]);
  if (!value || !column) return;
  const rows = (obsLibrary?.[section.library] || []).filter((row) => obsNorm(row[column]) === value);
  if (!rows.length) return;
  for (const other of obsOrder(section)) {
    if (other === key || other === 'label' || other === 'cardType' || obsUnique().includes(other)) continue;
    const otherColumn = obsColumn(section, other);
    if (!otherColumn || String(item[other] || '').trim()) continue;
    const values = [...new Set(rows.map((row) => String(row[otherColumn] || '').trim()).filter(Boolean))];
    if (values.length !== 1) continue;
    item[other] = values[0];
    const input = document.querySelector(`[data-obs-field="${CSS.escape(`${base}.${other}`)}"]`);
    if (input) input.value = values[0];
  }
}

function obsFieldChanged(path, picked) {
  const location = obsLocate(path);
  if (!location) return;
  if (location.key === 'cardType') location.item.title = location.item.cardType;
  if (picked) obsAutofill(location);
  obsRefreshLists(location.base, location.section, location.item);
}

// A value that exactly matches a suggestion counts as picked.
function obsIsPick(input) {
  const list = suggestionsFor(input);
  if (!list) return false;
  const value = obsNorm(input.value);
  return Boolean(value) && [...list.options].some((o) => obsNorm(o.value) === value);
}

function conditionPicker(path, value) {
  return `<div class="segment" style="margin-top:.6rem">${obsConfig.conditions.map((c) =>
    `<button class="seg${value === c ? ' on' : ''}" data-obs-status="${esc(path)}" data-value="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
}

function itemCard(section, item, index) {
  const base = `${section.id}[${index}]`;
  const nameList = section.columns?.label ? obsListId(`${base}.label`) : '';
  return `<div class="card obs-item" style="margin-top:.85rem" data-obs-item="${base}">
      <div class="row" style="justify-content:space-between;align-items:center">
        <input class="hdr" data-obs-field="${base}.label" value="${esc(item.label || '')}" placeholder="Name" autocomplete="off"${nameList ? ` list="${esc(nameList)}"` : ''}>
        ${nameList ? `<datalist id="${esc(nameList)}">${obsOptions(obsSuggestions(section, item, 'label'))}</datalist>` : ''}
        <span class="obs-item-actions">
          <button class="linklike" data-obs-dup="${base}">Duplicate</button>
          <button class="linklike" data-obs-remove="${base}">Remove</button>
        </span>
      </div>
      ${conditionPicker(`${base}.status`, item.status)}
      ${section.fields.map(([key, label]) => obsLibField(section, item, base, key, label)).join('')}
      ${obsLibField(section, item, base, 'comments', 'Comments')}
    </div>`;
}

// Cards picked to copy into another panel. Held by reference so removing or
// duplicating cards doesn't upset the selection.
const obsPicked = new Set();

function panelCard(section, panel, index) {
  const base = `plcCards[${index}]`;
  const cardFields = section.fields.filter(([key]) => key !== 'cardType');
  return `<div class="card obs-item" style="margin-top:.85rem" data-obs-item="${base}">
      <div class="row" style="justify-content:space-between;align-items:center">
        <input class="hdr" data-obs-field="${base}.label" value="${esc(panel.label || '')}" autocomplete="off">
        <span class="obs-item-actions">
          <button class="linklike" data-obs-dup="${base}">Duplicate panel</button>
          <button class="linklike" data-obs-remove="${base}">Remove</button>
        </span>
      </div>
      ${(panel.cards || []).map((card, c) => {
        const cardBase = `${base}.cards[${c}]`;
        const listId = obsListId(`${cardBase}.cardType`);
        return `<div class="sig obs-card${obsPicked.has(card) ? ' picked' : ''}" data-obs-item="${cardBase}">
          <div class="obs-card-head">
            <input class="hdr small" data-obs-field="${cardBase}.cardType" value="${esc(card.cardType || card.title || '')}" placeholder="Card type" autocomplete="off" list="${esc(listId)}">
            <datalist id="${esc(listId)}">${obsOptions([...new Set([...obsConfig.cardTypes, ...obsSuggestions(section, card, 'cardType')])])}</datalist>
            <span class="obs-item-actions">
              <label class="obs-pick"><input type="checkbox" data-obs-pick="${cardBase}"${obsPicked.has(card) ? ' checked' : ''}> Copy</label>
              <button class="linklike" data-obs-dup="${cardBase}">Duplicate</button>
              <button class="linklike" data-obs-remove="${cardBase}">Remove</button>
            </span>
          </div>
          ${conditionPicker(`${cardBase}.status`, card.status)}
          ${cardFields.map(([key, label]) => obsLibField(section, card, cardBase, key, label)).join('')}
          ${obsLibField(section, card, cardBase, 'comments', 'Comments')}
        </div>`;
      }).join('') || '<p class="muted">No cards in this panel.</p>'}
      <div class="row" style="margin-top:.75rem">
        <select data-obs-addcard="${index}" aria-label="Add a card">
          <option value="">Add a card…</option>
          ${obsConfig.cardTypes.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
        </select>
      </div>
    </div>`;
}

// Shown while cards are picked: where to copy them.
function obsCopyBar() {
  const panels = obsSurvey.plcCards || [];
  const count = panels.reduce((sum, p) => sum + (p.cards || []).filter((c) => obsPicked.has(c)).length, 0);
  if (!count) return '';
  const target = panels.findIndex((p) => !(p.cards || []).some((c) => obsPicked.has(c)));   // the first panel they aren't from
  return `<div class="card obs-copybar">
      <strong>${count} card${count === 1 ? '' : 's'} picked</strong>
      <label class="inline">Copy to
        <select id="obs-copy-target">
          ${panels.map((p, i) => `<option value="${i}"${i === target ? ' selected' : ''}>${esc(p.label || `PLC Panel ${i + 1}`)}</option>`).join('')}
          <option value="new"${target === -1 ? ' selected' : ''}>A new panel</option>
        </select></label>
      <span class="row" style="gap:.5rem">
        <button class="btn" data-obs="copy-cards">Copy</button>
        <button class="btn secondary" data-obs="clear-picks">Clear</button>
      </span>
    </div>`;
}

// The next free number after the last label like "VDU 3", or "… copy".
function obsNextLabel(list, label, fallback) {
  const match = String(label || '').match(/^(.*?)(\d+)$/);
  if (!match) return label ? `${label} copy` : fallback;
  const prefix = match[1];
  let top = 0;
  for (const other of list) {
    const m = String(other.label || '').match(/^(.*?)(\d+)$/);
    if (m && m[1] === prefix) top = Math.max(top, Number(m[2]));
  }
  return `${prefix}${top + 1}`;
}

function obsClone(item) {
  const copy = JSON.parse(JSON.stringify(item));
  for (const key of obsUnique()) if (key in copy) copy[key] = '';
  for (const card of copy.cards || []) for (const key of obsUnique()) if (key in card) card[key] = '';
  return copy;
}

// Duplicates an item, a whole panel, or one card in a panel.
function obsDuplicate(path) {
  const card = path.match(/^plcCards\[(\d+)\]\.cards\[(\d+)\]$/);
  if (card) {
    const cards = obsSurvey.plcCards[Number(card[1])].cards;
    cards.splice(Number(card[2]) + 1, 0, obsClone(cards[Number(card[2])]));
    return `plcCards[${card[1]}].cards[${Number(card[2]) + 1}]`;
  }
  const match = path.match(/^(\w+)\[(\d+)\]$/);
  if (!match) return null;
  const list = obsSurvey[match[1]];
  const index = Number(match[2]);
  const copy = obsClone(list[index]);
  copy.label = obsNextLabel(list, list[index].label, list[index].label);
  // Numbered items go on the end so the numbering stays in order.
  const at = /\d+$/.test(String(list[index].label || '')) ? list.length : index + 1;
  list.splice(at, 0, copy);
  return `${match[1]}[${at}]`;
}

function obsScrollTo(path) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-obs-item="${CSS.escape(path)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function obsBlankCard(type) {
  return { title: type, cardType: type, manufacturer: '', partNo: '', voltage: '', density: '', comments: '', status: '' };
}

function obsCopyPicked(target) {
  const panels = obsSurvey.plcCards || [];
  const picked = [];
  panels.forEach((p) => (p.cards || []).forEach((c) => { if (obsPicked.has(c)) picked.push(c); }));
  if (!picked.length) return null;
  let index = Number(target);
  if (target === 'new' || !panels[index]) {
    panels.push({ label: obsNextLabel(panels, panels[panels.length - 1]?.label || 'PLC Panel 0', 'PLC Panel 1'), cards: [] });
    index = panels.length - 1;
  }
  panels[index].cards ||= [];
  panels[index].cards.push(...picked.map(obsClone));
  obsPicked.clear();
  return { index, count: picked.length, label: panels[index].label };
}

function obsSurveyHtml() {
  const sections = obsConfig.sections;
  const step = obsSection;
  const progress = `<div class="card" style="padding:.85rem 1rem">
      <div class="row" style="justify-content:space-between">
        <strong>${step === 0 ? 'Site details' : step > sections.length ? 'Anything else?' : sections[step - 1].name}</strong>
        <span class="muted">${step + 1} of ${sections.length + 2}</span>
      </div>
      <div class="bar" style="margin-bottom:0"><span style="width:${((step + 1) / (sections.length + 2) * 100).toFixed(0)}%"></span></div>
    </div><div style="height:1rem"></div>`;

  const nav = `<div class="row" style="margin-top:1rem">
      <button class="btn secondary" data-obs="back">${step === 0 ? 'Leave' : 'Back'}</button>
      <button class="btn" data-obs="next">${step === sections.length + 1 ? 'Finish and file' : 'Next'}</button>
    </div>`;

  if (step === 0) {
    const t = obsSurvey.title;
    return `${progress}<div class="card">
        <h2 style="margin-top:0">Site details</h2>
        ${obsField('title.client', 'Client', t.client)}
        ${obsField('title.contractNo', 'Contract number', t.contractNo)}
        ${obsField('title.siteContact', 'Site contact', t.siteContact)}
        ${obsField('title.engineer', 'Engineer', t.engineer)}
        ${obsField('title.date', 'Date of survey', t.date)}
      </div>${nav}`;
  }

  if (step === sections.length + 1) {
    return `${progress}<div class="card">
        <h2 style="margin-top:0">Anything else?</h2>
        <p class="muted">A short summary for whoever reads the report. Optional.</p>
        ${obsField('notes', 'Notes', obsSurvey.notes)}
        <div class="result" id="obs-result" role="status"></div>
      </div>${nav}`;
  }

  const section = sections[step - 1];
  const items = obsSurvey[section.id] || [];

  if (section.spares) {
    const addRow = `<div class="row obs-add-row"><button class="btn secondary" data-obs="add-spares">${items.length ? 'Add any missing standard spares' : 'Add the standard spares list'}</button>
        <button class="btn secondary" data-obs="add-${esc(section.id)}">Add one</button></div>`;
    const descList = obsOptions([...new Set((obsLibrary?.criticalSpares || []).map((r) => String(r.Description || '').trim()).filter(Boolean))]);
    const areaList = obsOptions([...new Set((obsLibrary?.criticalSpares || []).map((r) => String(r.Area || '').trim()).filter(Boolean))]);
    return `${progress}<div class="card">
        <h2 style="margin-top:0">${esc(section.name)}</h2>
        <p class="muted">Tick what's on the shelf. Add anything missing from the list.</p>
        ${addRow}
        ${items.map((sp, i) => `<div class="qrow" data-obs-item="criticalSpares[${i}]">
            <span>${sp.custom
              ? `<input data-obs-field="criticalSpares[${i}].description" value="${esc(sp.description || '')}" placeholder="What is it?" list="dl-spare-desc" autocomplete="off">
                 <input data-obs-field="criticalSpares[${i}].area" value="${esc(sp.area || '')}" placeholder="Area" list="dl-spare-area" autocomplete="off" style="margin-top:.35rem">`
              : `${esc(sp.description)}<br><span class="muted">${esc(sp.area || '')}</span>`}</span>
            <span class="segment">${['Yes', 'No', 'N/A'].map((v) =>
              `<button class="seg${sp.inStock === v ? ' on' : ''}" data-obs-status="criticalSpares[${i}].inStock" data-value="${v}">${v}</button>`).join('')}</span>
            ${sp.custom ? `<button class="linklike" data-obs-remove="criticalSpares[${i}]">Remove</button>` : ''}
          </div>`).join('') || '<p class="muted">Nothing added yet.</p>'}
        ${items.length > 6 ? addRow : ''}
        <datalist id="dl-spare-desc">${descList}</datalist><datalist id="dl-spare-area">${areaList}</datalist>
      </div>${nav}`;
  }

  const addButton = `<button class="btn secondary" data-obs="add-${esc(section.id)}">Add ${esc(section.addLabel ? (section.cards ? 'a panel' : `another ${section.addLabel}`) : 'item')}</button>`;
  return `${progress}
    <div class="card">
      <h2 style="margin-top:0">${esc(section.name)}</h2>
      <div class="row obs-add-row">${addButton}</div>
    </div>
    ${items.map((item, i) => (section.cards ? panelCard(section, item, i) : itemCard(section, item, i))).join('')}
    ${items.length ? `<div class="row obs-add-row" style="margin-top:.85rem">${addButton}</div>` : ''}
    ${section.cards ? obsCopyBar() : ''}${nav}`;
}

function setPath(target, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) node = node[part];
  node[parts[parts.length - 1]] = value;
}

function removePath(path) {
  const card = path.match(/^plcCards\[(\d+)\]\.cards\[(\d+)\]$/);
  if (card) {
    const removed = obsSurvey.plcCards[Number(card[1])].cards.splice(Number(card[2]), 1)[0];
    obsPicked.delete(removed);
    return;
  }
  const match = path.match(/^(\w+)\[(\d+)\]$/);
  if (match) obsSurvey[match[1]].splice(Number(match[2]), 1);
}

async function obsSaveDraft() {
  if (!obsSurvey) return;
  try { await api('/api/obs/draft', { method: 'POST', body: JSON.stringify(obsSurvey) }); } catch { /* kept on screen */ }
}

async function obsControl(action, value) {
  if (action === 'sales') { obsView = 'sales'; obsReading = null; return render(); }
  if (action === 'survey-view') { obsView = 'survey'; return render(); }
  if (action === 'chooser') { obsView = null; obsReading = null; obsSurvey = null; return render(); }
  if (action === 'back-to-queue') { obsReading = null; return render(); }

  if (action === 'new') {
    obsSurvey = { picking: true };
    return render();                                 // the render shows a spinner while Jira answers
  }
  if (action === 'back') {
    if (obsSection === 0) {
      obsSurvey = null;
      obsSection = 0;
      if (obsConfig.sales && !obsView) obsView = 'survey';
      return render();
    }
    obsSection--;
    obsPicked.clear();
    await obsSaveDraft();
    return render();
  }
  if (action === 'next') {
    if (obsSection === obsConfig.sections.length + 1) return obsSubmit();
    obsSection++;
    obsPicked.clear();
    await obsSaveDraft();
    return render();
  }
  if (action === 'add-spares') {
    // The standard list is the master sheet's, once each, keeping anything already ticked.
    const have = new Set((obsSurvey.criticalSpares || []).map((sp) => obsNorm(sp.description)));
    const standard = [];
    for (const sp of obsLibrary?.criticalSpares || []) {
      if (sp.source !== 'master sheet') continue;
      const description = String(sp.Description || '').trim();
      if (!description || have.has(obsNorm(description))) continue;
      have.add(obsNorm(description));
      standard.push({ description, area: sp.Area || '', inStock: '', comments: '' });
    }
    (obsSurvey.criticalSpares ||= []).push(...standard);
    if (!standard.length) toast('Every standard spare is already on the list');
    return render();
  }
  if (action === 'copy-cards') {
    const result = obsCopyPicked(document.getElementById('obs-copy-target')?.value ?? 'new');
    if (!result) return render();
    toast(`${result.count} card${result.count === 1 ? '' : 's'} copied to ${result.label}`);
    await render();
    obsScrollTo(`plcCards[${result.index}]`);
    return obsSaveDraft();
  }
  if (action === 'clear-picks') { obsPicked.clear(); return render(); }
  if (action.startsWith('add-')) {
    const id = action.slice(4);
    const section = obsConfig.sections.find((s) => s.id === id);
    const list = (obsSurvey[id] ||= []);
    if (section.cards) {
      list.push({ label: obsNextLabel(list, list[list.length - 1]?.label || 'PLC Panel 0', 'PLC Panel 1'), cards: obsConfig.cardTypes.map(obsBlankCard) });
    } else if (section.spares) {
      list.push({ description: '', area: '', inStock: '', comments: '', custom: true });
    } else {
      list.push({ label: obsNextLabel(list, list[list.length - 1]?.label || `${section.addLabel || 'Item'} 0`, `${section.addLabel || 'Item'} 1`), status: '', comments: '' });
    }
    await render();
    return obsScrollTo(`${id}[${list.length - 1}]`);
  }
}

async function obsPickClient(reportKey) {
  const report = obsReports.find((r) => r.key === reportKey);
  obsSurvey = newSurvey(report);
  obsSection = 0;
  if (!obsLibrary) obsLibrary = await api('/api/obs/library').catch(() => ({}));
  await obsSaveDraft();
  return render();
}

async function obsSubmit() {
  const out = document.getElementById('obs-result');
  if (out) { out.textContent = 'Making the report…'; out.className = 'result'; }
  try {
    const result = await api('/api/obs/submit', { method: 'POST', body: JSON.stringify(obsSurvey) });
    obsSurvey = null;
    obsSection = 0;
    toast(result.notes?.length ? 'Survey saved, but filing needs a hand' : 'Survey filed and the job moved on');
    return render();
  } catch (err) {
    if (out) { out.textContent = err.message; out.className = 'result bad'; }
  }
}

async function obsDecide(needed) {
  const out = document.getElementById('obs-quote-result');
  out.textContent = 'Updating Jira…';
  out.className = 'result';
  try {
    const result = await api('/api/obs/quote', {
      method: 'POST',
      body: JSON.stringify({ reportKey: obsReading.key, projectKey: obsReading.projectKey, surveyDate: obsReading.surveyDate, needed }),
    });
    obsReading = null;
    toast(result.quoteKey ? `${result.quoteKey} raised and linked` : 'Report marked up to date');
    if (result.notes?.length) toast(result.notes.join(' '));
    return render();
  } catch (err) {
    out.textContent = err.message;
    out.className = 'result bad';
  }
}

// ---------- XP shop (demonstration) ----------

let shopSimulation = null;

const hoursText = (hours) => (hours >= 100 ? `${n(Math.round(hours / 10) * 10)} hours` : `${n(hours)} hours`);

function shopHtml(data) {
  const card = (r) => {
    const tone = r.eligible ? '' : ' short';
    const status = r.eligible
      ? `<span class="good">You could take this</span>`
      : `<span class="muted">${n(r.levelsShort)} more level${r.levelsShort === 1 ? '' : 's'} to qualify</span>`;
    return `<li class="reward${tone}">
        <span class="title">${esc(r.name)}</span>
        <span class="sub">${r.fixedPrice
          ? `${n(r.xpCost)} XP${r.eligible ? `, ${n(r.levelsLost)} level${r.levelsLost === 1 ? '' : 's'} at your level` : ''}`
          : `${n(r.levels)} levels`}, from level ${n(r.minimumLevel)}${r.cooldown ? `, ${esc(r.cooldown).toLowerCase()}` : ''}. ${status}</span>
        <span class="xp">${r.eligible ? `<button class="linklike" data-shop="${esc(r.id)}">What would it cost?</button>` : ''}</span>
      </li>`;
  };
  const money = data.rewards.filter((r) => r.kind === 'money');
  const time = data.rewards.filter((r) => r.kind === 'time');

  return `
    <div class="card notice">
      <p style="margin:0"><strong>Demonstration only.</strong> Nothing here spends anything. There is no button that
      takes levels off anyone, and the hub has no way to do it, so this is safe to show people.</p>
    </div>
    <div class="card" style="margin-top:1rem">
      <p class="muted" style="margin:0">Where you are</p>
      <h2 style="margin:.2rem 0 0">Level ${n(data.you.level)}, ${esc(data.you.title)}</h2>
      <p class="muted" style="margin:.2rem 0 0">${n(data.you.xp)} XP earned</p>
    </div>
    <h2>Cash and career</h2>
    <ul class="list">${money.map(card).join('')}</ul>
    <h2>Time off</h2>
    <ul class="list">${time.map(card).join('')}</ul>
    <div class="card" style="margin-top:1rem">
      <p class="muted" style="margin:0">Cash and career rewards cost a set number of levels, so they get dearer the
      further up you are. Time off costs a fixed amount of XP, so it stays within reach however senior you get,
      and costs fewer levels the higher you climb.</p>
    </div>`;
}

function shopSimulationHtml() {
  const s = shopSimulation;
  return `
    <div class="card">
      <p class="muted" style="margin:0">If you took</p>
      <h2 style="margin:.2rem 0 1rem">${esc(s.name)}</h2>
      <dl class="stats" style="margin:0">
        <div><dt>Costs</dt><dd>${s.fixedPrice ? n(s.xpCost) : n(s.levels)}<small>${s.fixedPrice ? `XP, a fixed price` : 'levels'}</small></dd></div>
        <div><dt>You are</dt><dd>${n(s.before.level)}<small>${esc(s.before.title)}</small></dd></div>
        <div><dt>You would be</dt><dd>${n(s.after.level)}<small>${esc(s.after.title)}</small></dd></div>
        <div><dt>${s.fixedPrice ? 'Levels lost' : 'XP spent'}</dt><dd>${s.fixedPrice ? n(s.levelsLost) : n(s.xpCost)}</dd></div>
      </dl>
      <p style="margin:1.25rem 0 0">Earning that back takes about <strong>${hoursText(s.regainSlowHours)}</strong>
      of ordinary work, or <strong>${hoursText(s.regainFastHours)}</strong> on hard, well rated jobs.</p>
      <p class="muted">${s.cooldown ? `${esc(s.cooldown)}.` : 'No cooldown on this one.'}</p>
      <div class="card notice" style="margin-top:1rem">
        <p style="margin:0"><strong>Nothing has changed.</strong> Your level is still ${n(s.before.level)}.</p>
      </div>
      <div class="row" style="margin-top:1rem">
        <button class="btn secondary" data-shop="back">Back to the shop</button>
      </div>
    </div>`;
}

async function shopControl(id) {
  if (id === 'back') { shopSimulation = null; return render(); }
  shopSimulation = await api(`/api/shop/simulate?reward=${encodeURIComponent(id)}`);
  return render();
}

// ---------- 8x8 calls ----------

let callsDate = null;
let callsData = null;
let callsAll = false;
let callsError = null;
let callsLoading = false;
let callFlow = null;        // { call, step, projectKey, options }
let pendingCall = null;     // a call waiting for its time to be logged

const callTime = (call) => (call.started || '').slice(11, 16);

function callsRender() {
  if (callFlow) return callFlowHtml();
  const date = callsDate || todayIso();
  const head = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:flex-end">
        <label>Day <input id="calls-date" type="date" value="${date}" max="${todayIso()}"></label>
        <button class="btn" data-calls="load">${callsData ? 'Refresh' : 'Show my calls'}</button>
      </div>
      <p class="muted" style="margin:.85rem 0 0">Nothing is fetched from 8x8 until you ask for it.</p>
    </div>`;

  if (callsLoading) return `${head}<div style="height:1rem"></div>${spinner('Asking 8x8 for your calls')}`;
  if (callsError) return `${head}<div class="card notice error" style="margin-top:1rem"><p style="margin:0">${esc(callsError)}</p></div>`;
  if (!callsData) return head;

  const rows = callsData.calls.map((call) => {
    const known = call.customer ? `<span class="badge">${esc(call.customer.label || call.customer.project_key)}</span>` : '';
    const done = call.handled
      ? `<span class="sub good">${call.handled.action === 'discarded' ? 'Discarded' : `Logged against ${esc(call.handled.issue_key || 'a job')}`}</span>`
      : `<span class="row" style="gap:.4rem;margin-top:.5rem">
          <button class="chip-btn" data-call="job" data-value="${esc(call.callId)}">Job</button>
          <button class="chip-btn" data-call="psc" data-value="${esc(call.callId)}">Existing PSC</button>
          <button class="chip-btn" data-call="new-psc" data-value="${esc(call.callId)}">New PSC</button>
          <button class="chip-btn" data-call="discard" data-value="${esc(call.callId)}">Discard</button>
        </span>`;
    return `<li class="call">
        <span class="title">${call.direction === 'in' ? '↙' : '↗'} ${esc(call.otherName || call.otherRaw)} ${known}</span>
        <span class="sub">${callTime(call)}, ${call.talkTime || 'not connected'}${call.otherName ? `, ${esc(call.otherRaw)}` : ''}${call.sharedLine ? ', via a shared line' : ''}${callsData.showingAll && call.handledBy ? `. <strong>${esc(call.handledBy)}</strong>` : ''}</span>
        ${done}
      </li>`;
  }).join('');

  return `${head}
    <h2>${esc(shortDate(callsData.date))}</h2>
    <p class="muted" style="margin-top:-.5rem">${callsData.showingAll
      ? `Showing all ${n(callsData.total)} calls on the system.`
      : `${n(callsData.matched)} of ${n(callsData.total)} calls matched to you.`}
      <button class="linklike" data-calls="toggle-all">${callsData.showingAll ? 'Just mine' : 'Show everyone\'s'}</button></p>
    ${callsData.calls.length ? `<ul class="list">${rows}</ul>`
      : `<div class="card"><p class="muted">No calls found. ${callsData.total ? 'None of them matched you, so try showing everyone\'s.' : ''}</p></div>`}`;
}

function callFlowHtml() {
  const { call, step, options } = callFlow;
  const header = `<div class="card">
      <p class="muted" style="margin:0">${call.direction === 'in' ? 'Call from' : 'Call to'}</p>
      <h2 style="margin:.2rem 0 0">${esc(call.otherName || call.otherRaw)}</h2>
      <p class="muted" style="margin:.2rem 0 0">${callTime(call)}, ${call.talkTime || 'not connected'}${call.handledBy ? `, ${esc(call.handledBy)}` : ''}</p>
    </div><div style="height:1rem"></div>`;

  if (step === 'customer') {
    return `${header}
      <div class="card">
        <h3 style="margin-top:0">Which customer was this?</h3>
        <p class="muted">The number is saved against them, so next time it's recognised.</p>
        <input id="call-customer-search" type="search" placeholder="Start typing a customer name" autocomplete="off">
      </div>
      <div style="height:1rem"></div>
      <div class="options">${(options || []).slice(0, 25).map((c) => `<button class="option" data-call-customer="${esc(c.key)}" data-label="${esc(c.name)}">
          <span class="option-main"><strong>${esc(c.name)}</strong><span class="muted">${esc(c.key)}</span></span>
          <span class="chev">›</span>
        </button>`).join('')}</div>
      <div class="card" style="margin-top:1rem">
        <p style="margin-top:0">Not a customer?</p>
        <button class="btn secondary" data-call="not-customer">It's not work related</button>
      </div>`;
  }

  if (step === 'psc') {
    return `${header}
      <div class="card">
        <h3 style="margin-top:0">Does it relate to one of these?</h3>
        <p class="muted">Open service items for ${esc(callFlow.projectKey)}.</p>
      </div>
      <div style="height:1rem"></div>
      <div class="options">${(options || []).map(optionRow).join('')
        || '<div class="card"><p class="muted">Nothing open for them.</p></div>'}</div>
      <div class="card" style="margin-top:1rem">
        <button class="btn secondary" data-call="new-psc-here">None of these, raise a new one</button>
      </div>`;
  }

  return `${header}${pscFormHtml(callFlow.projectKey)}`;
}

async function callsControl(action, value) {
  if (action === 'load' || action === 'toggle-all') {
    if (action === 'toggle-all') callsAll = !callsAll;
    callsDate = document.getElementById('calls-date')?.value || todayIso();
    callsError = null;
    callsData = null;
    callsLoading = true;
    await render();
    try {
      callsData = await api(`/api/calls?date=${callsDate}${callsAll ? '&all=1' : ''}`);
    } catch (err) {
      callsError = err.message;
    }
    callsLoading = false;
    return render();
  }
  if (action === 'not-customer') {
    await api('/api/calls/link', {
      method: 'POST',
      body: JSON.stringify({ phone: callFlow.call.other, kind: 'not-work', projectKey: '', label: 'Not work related' }),
    });
    await api('/api/calls/handled', { method: 'POST', body: JSON.stringify({ callId: callFlow.call.callId, action: 'discarded' }) });
    callFlow = null;
    toast('Noted. That number will not be suggested again.');
    return callsControl('load');
  }
  if (action === 'new-psc-here') {
    callFlow.step = 'new-psc';
    logPscProject = callFlow.projectKey;
    return render();
  }
}

// Starting point for each of the four buttons on a call.
async function callAction(action, callId) {
  const call = callsData.calls.find((c) => c.callId === callId);
  if (!call) return;

  if (action === 'discard') {
    await api('/api/calls/handled', { method: 'POST', body: JSON.stringify({ callId, action: 'discarded' }) });
    toast('Discarded');
    return callsControl('load');
  }

  callFlow = { call, intent: action, projectKey: call.customer?.project_key || null };
  if (!callFlow.projectKey) {
    callFlow.step = 'customer';
    callFlow.options = (await api('/api/calls/customers').catch(() => ({ customers: [] }))).customers;
    return render();
  }
  return callContinue();
}

// Once the customer is known, each intent goes its own way.
async function callContinue() {
  const { call, intent, projectKey } = callFlow;
  pendingCall = {
    callId: call.callId,
    seconds: Math.max(300, call.seconds || 0),
    description: `${call.direction === 'in' ? 'Support call from' : 'Call to'} ${call.otherName || call.otherRaw}`,
  };

  if (intent === 'job') {
    callFlow = null;
    logNode = `customer:uk:${projectKey}`;
    logTrail = [{ node: null, label: 'Calls' }];
    logChosen = null;
    location.hash = '#/log';
    return;
  }
  if (intent === 'psc') {
    callFlow.step = 'psc';
    callFlow.options = (await api(`/api/calls/pscs?projectKey=${encodeURIComponent(projectKey)}`)).options;
    return render();
  }
  callFlow.step = 'new-psc';
  logPscProject = projectKey;
  return render();
}

// ---------- IT support ----------

let itOptions = null;
let itServiceDeskId = null;
let itForm = null;
let itAssets = [];

function itHomeHtml(data) {
  const row = (r) => `<li>
      <span class="title"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.key)}</a> ${esc(r.summary)}</span>
      <span class="sub">${esc(r.status)}${r.priority ? `, ${esc(r.priority)}` : ''}, with ${esc(r.assignee)}</span>
      <span class="xp">${r.done ? '<span class="good">Done</span>' : ''}</span>
    </li>`;
  const open = data.requests.filter((r) => !r.done);
  const closed = data.requests.filter((r) => r.done).slice(0, 5);
  return `
    <div class="card">
      <p style="margin-top:0">Anything from a broken laptop to a licence you need. It goes straight to IT with your name on it.</p>
      <button class="btn" data-it="new">Raise a request</button>
    </div>
    <h2>Open</h2>
    ${open.length ? `<ul class="list">${open.map(row).join('')}</ul>`
      : `<div class="card"><p class="muted">${data.error ? esc(data.error) : 'Nothing open.'}</p></div>`}
    ${closed.length ? `<h2>Recently closed</h2><ul class="list">${closed.map(row).join('')}</ul>` : ''}`;
}

function itFormHtml() {
  const f = itForm;
  if (!f.category) {
    return `<div class="card">
        <h2 style="margin-top:0">What do you need?</h2>
      </div>
      <div style="height:1rem"></div>
      <div class="options">${itOptions.categories.map((c) => `<button class="option" data-it-cat="${esc(c.id)}">
          <span class="option-main"><strong>${esc(c.label)}</strong><span class="muted">${esc(c.hint)}</span></span>
          <span class="chev">›</span>
        </button>`).join('')}</div>`;
  }
  const category = itOptions.categories.find((c) => c.id === f.category);
  const assets = itAssets.length ? `<div class="options" style="margin-top:.5rem">${itAssets.map((a) => `
      <button class="option${f.assetKey === a.key ? ' on' : ''}" data-it-asset="${esc(a.key)}">
        <span class="option-main"><strong>${esc(a.label)} ${esc(a.title)}</strong><span class="muted">${esc(a.sublabel)}</span></span>
      </button>`).join('')}</div>` : '<p class="muted" style="margin:.5rem 0 0">Nothing assigned to you. Search above if it relates to a particular piece of kit.</p>';

  return `<div class="card">
      <p class="muted" style="margin:0">${esc(category.label)}</p>
      <h2 style="margin:.2rem 0 1rem">Tell IT what's happening</h2>
      <label>Summary <input id="it-summary" value="${esc(f.summary || '')}" placeholder="Laptop won't charge" autocomplete="off"></label>
      <label style="margin-top:.75rem">Detail <input id="it-detail" value="${esc(f.description || '')}" placeholder="What happens, and when it started" autocomplete="off"></label>

      <p class="muted" style="margin:1.25rem 0 .4rem">How much is it holding you up?</p>
      <div class="chips stack">${itOptions.urgencies.map((u) =>
        `<button class="chip${f.urgency === u.id ? ' on' : ''}" data-it-urgency="${esc(u.id)}">${esc(u.label)}</button>`).join('')}</div>

      <p class="muted" style="margin:1.25rem 0 .4rem">Which piece of kit? Optional.</p>
      <input id="it-asset-search" type="search" placeholder="Search assets by name" autocomplete="off">
      ${assets}

      <p class="muted" style="margin:1.25rem 0 .4rem">Photos, if they help. Optional.</p>
      <input id="it-photos" type="file" accept="image/*" multiple>
      ${f.attachments?.length ? `<p class="muted">${f.attachments.length} photo${f.attachments.length > 1 ? 's' : ''} attached.</p>` : ''}

      <div class="row" style="margin-top:1.25rem">
        <button class="btn" data-it="send">Send to IT</button>
        <button class="btn secondary" data-it="cancel">Cancel</button>
      </div>
      <div class="result" id="it-result" role="status"></div>
    </div>`;
}

async function itControl(action, value) {
  const collect = () => {
    itForm.summary = document.getElementById('it-summary')?.value.trim() ?? itForm.summary;
    itForm.description = document.getElementById('it-detail')?.value.trim() ?? itForm.description;
  };
  if (action === 'new') { itForm = { attachments: [] }; itAssets = []; return render(); }
  if (action === 'cancel') { itForm = null; return render(); }
  if (action === 'category') {
    itForm.category = value;
    itAssets = (await api('/api/it/assets').catch(() => ({ assets: [] }))).assets;
    return render();
  }
  if (action === 'urgency') { collect(); itForm.urgency = value; return render(); }
  if (action === 'asset') { collect(); itForm.assetKey = itForm.assetKey === value ? null : value; return render(); }
  if (action === 'send') {
    collect();
    const out = document.getElementById('it-result');
    if (!itForm.summary) { out.textContent = 'A short summary is needed.'; out.className = 'result bad'; return; }
    if (!itForm.urgency) { out.textContent = 'Say how much it is holding you up.'; out.className = 'result bad'; return; }
    out.textContent = 'Sending…';
    out.className = 'result';
    try {
      const created = await api('/api/it/raise', { method: 'POST', body: JSON.stringify(itForm) });
      itForm = null;
      toast(`${created.key} raised with IT`);
      if (created.notes?.length) toast(created.notes.join(' '));
      return render();
    } catch (err) {
      out.textContent = err.message;
      out.className = 'result bad';
    }
  }
}

// Photos are read in the browser and sent with the request.
async function readPhotos(files) {
  const out = [];
  for (const file of [...files].slice(0, 5)) {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    out.push({ name: file.name, type: file.type, base64 });
  }
  return out;
}

// ---------- vehicles ----------

let vehicleView = 'home';
let checkSchema = null;
let fleetCache = [];
let checkForm = null;
let weekOffsetVehicles = 0;

const vehicleWeek = () => {
  const monday = mondayOf(todayIso());
  return addDays(monday, weekOffsetVehicles * 7);
};

const expiryChip = (expiry) => {
  if (!expiry) return '';
  const tone = expiry.days < 0 ? 'bad' : expiry.days <= 30 ? 'low' : 'muted';
  const when = expiry.days < 0 ? `${expiry.label} overdue` : `${expiry.label} in ${expiry.days} days`;
  return `<span class="${tone}">${esc(when)}</span>`;
};

function vehicleTabs(current) {
  const tabs = [['home', 'Fleet'], ['book', 'Book'], ['check', 'Check'], ...(me.user.isLead ? [['defects', 'Defects']] : [])];
  return `<div class="tabs" style="margin-bottom:1rem">${tabs.map(([id, label]) =>
    `<button class="tab${id === current ? ' on' : ''}" data-veh-view="${id}">${label}</button>`).join('')}</div>`;
}

function vehicleHomeHtml(vehicles, bookings) {
  const mine = bookings.map((b) => `<li>
      <span class="title">${esc(b.registration)} ${esc([b.make, b.model].filter(Boolean).join(' '))}</span>
      <span class="sub">${esc(b.starts_at.replace('T', ' '))} to ${esc(b.ends_at.replace('T', ' '))}${b.issue_key ? `, ${esc(b.issue_key)}` : ''}</span>
      <span class="xp"><button class="linklike" data-veh-cancel="${esc(b.id)}">Cancel</button></span>
    </li>`).join('');

  const fleet = vehicles.map((v) => `<li>
      <span class="title">${esc(v.registration)} ${esc([v.make, v.model].filter(Boolean).join(' '))}</span>
      <span class="sub">${v.offRoad ? '<span class="bad">Off the road</span>' : 'Available'}${v.openDefects ? `, ${v.openDefects} open defect${v.openDefects > 1 ? 's' : ''}` : ''}${v.mileage ? `, ${n(v.mileage)} miles` : ''}. ${expiryChip(v.soonest)}</span>
      <span class="xp"><button class="linklike" data-veh-check="${esc(v.id)}">Check</button></span>
    </li>`).join('');

  return `${vehicleTabs('home')}
    ${bookings.length ? `<h2 style="margin-top:0">Your bookings</h2><ul class="list">${mine}</ul>` : ''}
    <h2${bookings.length ? '' : ' style="margin-top:0"'}>The fleet</h2>
    ${vehicles.length ? `<ul class="list">${fleet}</ul>`
      : '<div class="card"><p class="muted">No vehicles yet. An admin can add them on the Admin page.</p></div>'}`;
}

function vehicleBookHtml(vehicles, week) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(week.weekStart, i));
  const byVehicle = new Map(vehicles.map((v) => [v.id, []]));
  week.bookings.forEach((b) => byVehicle.get(b.vehicle_id)?.push(b));

  const grid = vehicles.map((v) => `<tr>
      <td>${esc(v.registration)}${v.offRoad ? '<br><span class="bad">Off road</span>' : ''}</td>
      ${days.map((day) => {
        const on = (byVehicle.get(v.id) || []).filter((b) => b.starts_at.slice(0, 10) === day);
        return `<td class="num">${on.length
          ? on.map((b) => `<span class="slot">${esc(b.starts_at.slice(11, 16))}–${esc(b.ends_at.slice(11, 16))}<br><small>${esc((b.engineer || '').split(' ')[0])}</small></span>`).join('')
          : '<span class="muted">—</span>'}</td>`;
      }).join('')}
    </tr>`).join('');

  const hours = Array.from({ length: 13 }, (_, i) => `${String(i + 6).padStart(2, '0')}:00`);
  return `${vehicleTabs('book')}
    <div class="card">
      <div class="week-nav">
        <button class="icon-btn" data-veh-week="-1" aria-label="Previous week">${svgIcon('<path d="M15 5l-7 7 7 7"/>')}</button>
        <strong>Week of ${shortDate(week.weekStart)}</strong>
        <button class="icon-btn" data-veh-week="1" aria-label="Next week">${svgIcon('<path d="M9 5l7 7-7 7"/>')}</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Vehicle</th>${days.map((d) => `<th class="num">${shortDate(d)}</th>`).join('')}</tr></thead>
        <tbody>${grid || '<tr><td colspan="8" class="muted">No vehicles yet.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="card" style="margin-top:1rem">
      <h2 style="margin-top:0">Book a vehicle</h2>
      <div class="row">
        <label>Vehicle <select id="veh-id">${vehicles.filter((v) => !v.offRoad).map((v) =>
          `<option value="${esc(v.id)}">${esc(v.registration)} ${esc([v.make, v.model].filter(Boolean).join(' '))}</option>`).join('')}</select></label>
        <label>Date <input id="veh-date" type="date" value="${todayIso()}"></label>
      </div>
      <div class="row" style="margin-top:.75rem">
        <label>From <select id="veh-from">${hours.map((h) => `<option${h === '08:00' ? ' selected' : ''}>${h}</option>`).join('')}</select></label>
        <label>Until <select id="veh-to">${hours.map((h) => `<option${h === '17:00' ? ' selected' : ''}>${h}</option>`).join('')}</select></label>
      </div>
      <label style="margin-top:.75rem">Job it's for, optional <input id="veh-job" placeholder="WYNNL-712" autocomplete="off"></label>
      <label style="margin-top:.75rem">What for, optional <input id="veh-purpose" placeholder="Commissioning visit" autocomplete="off"></label>
      <div class="row" style="margin-top:1rem"><button class="btn" data-veh="book">Book it</button></div>
      <div class="result" id="veh-result" role="status"></div>
    </div>`;
}

function vehicleCheckHtml() {
  if (!checkForm) {
    return `${vehicleTabs('check')}
      <div class="card">
        <h2 style="margin-top:0">Which vehicle are you taking?</h2>
        <p class="muted">Do this before you drive. It takes a minute and covers you.</p>
      </div>
      <div style="height:1rem"></div>
      <div class="options">${fleetCache.map((v) => `<button class="option" data-veh-check="${esc(v.id)}">
          <span class="option-main"><strong>${esc(v.registration)} ${esc([v.make, v.model].filter(Boolean).join(' '))}</strong>
          <span class="muted">${v.offRoad ? 'Off the road, defects outstanding' : 'Available'}</span></span>
          <span class="chev">›</span>
        </button>`).join('') || '<div class="card"><p class="muted">No vehicles yet.</p></div>'}</div>`;
  }

  const vehicle = fleetCache.find((v) => v.id === checkForm.vehicleId);
  const rows = checkSchema.items.map((item) => {
    const entry = checkForm.results[item.id] || {};
    return `<div class="qrow">
        <span><strong>${esc(item.label)}</strong><br><span class="muted">${esc(item.hint)}</span></span>
        ${segment(`check.${item.id}`, entry.result, [['pass', 'Pass'], ['fail', 'Fail']])}
        ${entry.result === 'fail' ? `<input class="wide" data-check-note="${esc(item.id)}" value="${esc(entry.note || '')}" placeholder="What's wrong with it?" autocomplete="off">` : ''}
      </div>`;
  }).join('');

  const fails = Object.values(checkForm.results).filter((r) => r.result === 'fail').length;
  return `${vehicleTabs('check')}
    <div class="card">
      <h2 style="margin-top:0">${esc(vehicle?.registration || 'Vehicle')} check</h2>
      <p class="muted">Anything failed goes to management with your note. If it isn't safe, say so and it comes off the road straight away.</p>
      ${rows}
      <label style="margin-top:1rem">Current mileage <input id="check-mileage" type="number" inputmode="numeric" value="${checkForm.mileage || vehicle?.mileage || ''}"></label>
      <label style="margin-top:.75rem">Job you're driving to, optional <input id="check-job" value="${esc(checkForm.issueKey || '')}" placeholder="WYNNL-712" autocomplete="off"></label>
      <p class="muted" style="margin:1.25rem 0 .4rem">Is it fit to drive?</p>
      ${segment('fit.drive', checkForm.fitToDrive === false ? 'no' : 'yes', [['yes', 'Yes, safe to drive'], ['no', 'No, not fit to drive']])}
      ${fails ? `<p class="muted" style="margin-top:.75rem">${fails} item${fails > 1 ? 's' : ''} failed.</p>` : ''}
      <div class="row" style="margin-top:1.25rem">
        <button class="btn" data-veh="submit-check">Finish the check</button>
        <button class="btn secondary" data-veh="cancel-check">Back</button>
      </div>
      <div class="result" id="check-result" role="status"></div>
    </div>`;
}

function vehicleDefectsHtml(data) {
  const rows = data.defects.map((d) => `<li>
      <span class="title">${esc(d.registration)} ${esc(d.item)}${d.severity === 'not-fit' ? ' <span class="bad">not fit to drive</span>' : ''}</span>
      <span class="sub">${esc(d.note || 'No detail given')}. Reported by ${esc(d.reporter || 'someone')} on ${shortDate((d.created_at || '').slice(0, 10))}</span>
      <span class="xp"><button class="linklike" data-veh-resolve="${esc(d.id)}">Clear</button></span>
    </li>`).join('');
  return `${vehicleTabs('defects')}
    ${data.defects.length ? `<ul class="list">${rows}</ul>`
      : '<div class="card"><p class="muted">Nothing outstanding.</p></div>'}`;
}

async function vehicleControl(action, value) {
  const out = (id, text, bad) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; el.className = `result ${bad ? 'bad' : 'good'}`; }
  };
  try {
    if (action === 'view') { vehicleView = value; checkForm = value === 'check' ? null : checkForm; return render(); }
    if (action === 'week') { weekOffsetVehicles += Number(value); return render(); }
    if (action === 'start-check') {
      checkForm = { vehicleId: value, results: {}, fitToDrive: true };
      vehicleView = 'check';
      return render();
    }
    if (action === 'cancel-check') { checkForm = null; vehicleView = 'home'; return render(); }
    if (action === 'cancel-booking') {
      await api('/api/vehicles/cancel', { method: 'POST', body: JSON.stringify({ id: value }) });
      toast('Booking cancelled');
      return render();
    }
    if (action === 'resolve') {
      await api('/api/vehicles/resolve-defect', { method: 'POST', body: JSON.stringify({ id: value }) });
      toast('Defect cleared');
      return render();
    }
    if (action === 'book') {
      const date = document.getElementById('veh-date').value;
      await api('/api/vehicles/book', {
        method: 'POST',
        body: JSON.stringify({
          vehicleId: document.getElementById('veh-id').value,
          startsAt: `${date}T${document.getElementById('veh-from').value}:00`,
          endsAt: `${date}T${document.getElementById('veh-to').value}:00`,
          issueKey: document.getElementById('veh-job').value.trim() || null,
          purpose: document.getElementById('veh-purpose').value.trim() || null,
        }),
      });
      toast('Vehicle booked');
      vehicleView = 'home';
      return render();
    }
    if (action === 'submit-check') {
      document.querySelectorAll('[data-check-note]').forEach((input) => {
        const entry = checkForm.results[input.dataset.checkNote];
        if (entry) entry.note = input.value.trim();
      });
      const result = await api('/api/vehicles/check', {
        method: 'POST',
        body: JSON.stringify({
          ...checkForm,
          mileage: document.getElementById('check-mileage').value,
          issueKey: document.getElementById('check-job').value.trim() || null,
        }),
      });
      checkForm = null;
      vehicleView = 'home';
      toast(result.defects
        ? `Check done, ${result.defects} fault${result.defects > 1 ? 's' : ''} reported`
        : 'Check done, have a good trip');
      if (result.transitionNote) toast(`The job wasn't moved on: ${result.transitionNote}`);
      return render();
    }
  } catch (err) {
    out(action === 'book' ? 'veh-result' : 'check-result', err.message, true);
  }
}

// ---------- point of work ----------

const POW_STEPS = ['job', 'details', 'before', 'ppe', 'hazards', 'significant', 'ras', 'review', 'signoff'];
let powSchema = null;
let powStep = 'home';
let powForm = null;
let powNode = 'root';
let powTrail = [];
let powSaved = null;

// In practice, drafts live in memory so they never mix with real ones on this device.
const practiceDrafts = {};
const localDrafts = {
  read() {
    if (PRACTICE) return practiceDrafts;
    try { return JSON.parse(localStorage.getItem('pow-drafts') || '{}'); } catch { return {}; }
  },
  write(map) {
    if (PRACTICE) return;
    try { localStorage.setItem('pow-drafts', JSON.stringify(map)); } catch { /* full or blocked */ }
  },
  put(form) { const map = this.read(); map[form.id] = { form, savedAt: Date.now() }; this.write(map); },
  remove(id) { const map = this.read(); delete map[id]; this.write(map); },
  pending() { return Object.values(this.read()).filter((d) => d.form.queued); },
};

function newPowForm() {
  return {
    id: `pow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    issueKey: null, issueId: null, projectKey: null, jobMissing: false, branch: null,
    details: {
      engineer: me.employee.name, customer: '', site: '', contact: '', contactPhone: '', contactEmail: '',
      date: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      jobNo: '',
    },
    before: {}, ppe: [], hazards: [], significant: [], ras: [], review: {}, signoff: {},
  };
}

async function powSaveDraft({ quiet = true } = {}) {
  if (!powForm) return;
  localDrafts.put(powForm);
  try {
    await api('/api/pow/draft', { method: 'POST', body: JSON.stringify(powForm) });
    if (!quiet) toast('Saved');
  } catch {
    if (!quiet) toast('Saved on this device. It will sync when you are back online.');
  }
}

const stepNumber = () => POW_STEPS.indexOf(powStep) + 1;

function powProgress() {
  const step = stepNumber();
  if (step < 1) return '';
  return `<div class="card" style="padding:.85rem 1rem">
      <div class="row" style="justify-content:space-between">
        <strong>Step ${step} of ${POW_STEPS.length}</strong>
        <span class="muted">${esc(powForm?.issueKey || (powForm?.jobMissing ? 'No job number yet' : 'No job picked'))}</span>
      </div>
      <div class="bar" style="margin-bottom:0"><span style="width:${(step / POW_STEPS.length * 100).toFixed(0)}%"></span></div>
    </div>`;
}

const powNav = (backLabel = 'Back', nextLabel = 'Next') => `<div class="row" style="margin-top:1rem">
    <button class="btn secondary" data-pow="back">${backLabel}</button>
    <button class="btn" data-pow="next">${nextLabel}</button>
  </div>`;

function powHomeHtml(forms) {
  const queued = localDrafts.pending().length;
  const row = (f) => `<li>
      <span class="title">${esc(f.issue_key || 'No job number')} ${esc(f.customer || '')}</span>
      <span class="sub">${f.status === 'draft' ? 'Draft' : `Submitted ${shortDate((f.submitted_at || '').slice(0, 10))}`}${f.job_missing ? ', job not in Jira' : ''}${f.delivery_note ? ', needs filing by hand' : ''}</span>
      <span class="xp draft-actions">${f.status === 'draft'
        ? draftActionsHtml('pow', f.id)
        : `<a class="linklike" href="/api/pow/pdf?id=${encodeURIComponent(f.id)}" target="_blank" rel="noopener">PDF</a>`}</span>
    </li>`;
  return `
    ${queued ? `<div class="card notice"><p style="margin:0"><strong>${queued} assessment${queued > 1 ? 's' : ''} waiting to send.</strong> They will go through on their own once you have signal.</p></div>` : ''}
    <div class="card">
      <p style="margin-top:0">Fill this in on site before you start work. It takes a couple of minutes and produces the signed PDF for the job.</p>
      <button class="btn" data-pow="new">Start an assessment</button>
    </div>
    <h2>Yours</h2>
    ${forms.length ? `<ul class="list">${forms.map(row).join('')}</ul>`
      : '<div class="card"><p class="muted">Nothing yet.</p></div>'}`;
}

function powJobHtml(step) {
  const crumbs = powTrail.length ? `<button class="linklike" data-pow-crumb="-1">Start again</button>` : '';
  return `
    <div class="card">
      <div class="row">${crumbs}</div>
      <h2 style="margin:${crumbs ? '.85rem' : '0'} 0 0">${esc(step.title)}</h2>
      ${step.subtitle ? `<p class="muted" style="margin:.2rem 0 0">${esc(step.subtitle)}</p>` : ''}
    </div>
    <div style="height:1rem"></div>
    <div class="options">${step.options.map(optionRow).join('')
      || '<div class="card"><p class="muted">Nothing open here.</p></div>'}</div>
    ${step.allowMissing ? `<div class="card" style="margin-top:1rem">
      <p style="margin-top:0"><strong>Not seeing your visit?</strong> It usually means the job hasn't been moved on in Jira yet.</p>
      <button class="btn secondary" data-pow="missing">My visit isn't listed</button>
      <p class="muted" style="margin-bottom:0">Your team lead is told, you carry on with the assessment, and the job number is added later.</p>
    </div>` : ''}`;
}

function field(label, id, value, { type = 'text', placeholder = '' } = {}) {
  return `<label style="margin-top:.75rem">${label}
    <input id="${id}" type="${type}" value="${esc(value || '')}" placeholder="${esc(placeholder)}" autocomplete="off"></label>`;
}

function powDetailsHtml() {
  const d = powForm.details;
  return `<div class="card">
      <h2 style="margin-top:0">Details</h2>
      <p class="muted">Filled in from Jira where possible. Correct anything that's wrong.</p>
      ${field('Engineer', 'pow-engineer', d.engineer)}
      ${field('Customer', 'pow-customer', d.customer)}
      ${field('Site', 'pow-site', d.site, { placeholder: 'Address or plant' })}
      ${field('Contact', 'pow-contact', d.contact)}
      ${field('Contact phone', 'pow-phone', d.contactPhone, { type: 'tel' })}
      ${field('Date on site', 'pow-date', d.date)}
    </div>${powNav()}`;
}

function segment(name, value, options) {
  return `<span class="segment">${options.map(([key, label]) =>
    `<button class="seg${value === key ? ' on' : ''}" data-set="${name}" data-value="${key}">${label}</button>`).join('')}</span>`;
}

function powBeforeHtml() {
  const rows = powSchema.before.map((q) => `<div class="qrow">
      <span>${esc(q.text)}</span>
      ${segment(`before.${q.id}`, powForm.before[q.id], [['yes', 'Yes'], ['no', 'No'], ['na', 'N/A']])}
    </div>`).join('');
  const unanswered = powSchema.before.filter((q) => !powForm.before[q.id]).length;
  const noes = powSchema.before.filter((q) => powForm.before[q.id] === 'no').length;
  return `<div class="card">
      <h2 style="margin-top:0">Before you start</h2>
      <p class="muted">${unanswered ? `${unanswered} left to answer.` : 'All answered.'}</p>
      ${rows}
      ${noes ? `<div class="notice" style="margin-top:1rem;border-radius:10px"><p style="margin:0">
        You answered No ${noes} time${noes > 1 ? 's' : ''}. Take the action needed or speak to your manager. If in doubt, stop and ask.</p></div>` : ''}
    </div>${powNav()}`;
}

function chipGrid(items, selected, setName) {
  return `<div class="chips">${items.map((item) =>
    `<button class="chip${selected.includes(item.id) ? ' on' : ''}" data-toggle="${setName}" data-value="${item.id}">${esc(item.label)}</button>`).join('')}</div>`;
}

function powPpeHtml() {
  return `<div class="card">
      <h2 style="margin-top:0">PPE you are using</h2>
      <p class="muted">Tap everything you have on.</p>
      ${chipGrid(powSchema.ppe, powForm.ppe, 'ppe')}
    </div>${powNav()}`;
}

function powHazardsHtml() {
  return `<div class="card">
      <h2 style="margin-top:0">Hazards present</h2>
      <p class="muted">Tap anything present on this job.</p>
      ${chipGrid(powSchema.hazards, powForm.hazards, 'hazards')}
    </div>${powNav()}`;
}

function powSignificantHtml() {
  if (!powForm.hazards.length) {
    return `<div class="card"><h2 style="margin-top:0">Significant hazards</h2>
      <p class="muted">You marked no hazards, so there's nothing to assess here.</p></div>${powNav()}`;
  }
  const rows = powForm.hazards.map((id) => {
    const label = powSchema.hazards.find((h) => h.id === id)?.label || id;
    const entry = powForm.significant.find((e) => e.hazard === id);
    return `<div class="sig">
        <div class="row" style="justify-content:space-between;align-items:center">
          <strong>${esc(label)}</strong>
          ${segment(`sig.${id}`, entry ? 'yes' : 'no', [['no', 'Controlled'], ['yes', 'Significant']])}
        </div>
        ${entry ? `
          <label style="margin-top:.6rem">Control measures and precautions
            <input data-sigcontrol="${id}" value="${esc(entry.control || '')}" placeholder="What you did to make it safe"></label>
          <div style="margin-top:.6rem">${segment(`risk.${id}`, entry.risk || 'Low', powSchema.risks.map((r) => [r, r]))}</div>` : ''}
      </div>`;
  }).join('');
  return `<div class="card">
      <h2 style="margin-top:0">Which of those are significant?</h2>
      <p class="muted">Significant means there are no controls, or the ones in place aren't enough. Say what you did and what risk is left.</p>
      ${rows}
    </div>${powNav()}`;
}

function powRasHtml() {
  return `<div class="card">
      <h2 style="margin-top:0">Risk assessments and safe systems of work</h2>
      <p class="muted">Tap the ones you are working to.</p>
      <div class="chips stack">${powSchema.ras.map((title) =>
        `<button class="chip${powForm.ras.includes(title) ? ' on' : ''}" data-toggle="ras" data-value="${esc(title)}">${esc(title)}</button>`).join('')}</div>
    </div>${powNav()}`;
}

function powReviewHtml() {
  const rows = powSchema.review.map((q) => `<div class="qrow">
      <span>${esc(q.text)}</span>
      ${segment(`review.${q.id}`, powForm.review[q.id], [['yes', 'Yes'], ['no', 'No']])}
    </div>`).join('');
  const anyYes = powSchema.review.some((q) => powForm.review[q.id] === 'yes');
  return `<div class="card">
      <h2 style="margin-top:0">End of job review</h2>
      ${rows}
      ${anyYes ? field('Tell us briefly', 'pow-note', powForm.review.note, { placeholder: 'What changed, or what needs amending' }) : ''}
    </div>${powNav()}`;
}

function powSignoffHtml() {
  const s = powForm.signoff;
  return `<div class="card">
      <h2 style="margin-top:0">Sign off</h2>
      <p class="muted">Yours</p>
      ${field('Name', 'pow-pname', s.promtekName || powForm.details.engineer)}
      ${field('Position', 'pow-prole', s.promtekPosition || 'Engineer')}
      <p class="muted" style="margin-top:1.25rem">Customer</p>
      ${field('Name', 'pow-cname', s.customerName)}
      ${field('Position', 'pow-crole', s.customerPosition)}
      ${field('Email', 'pow-cemail', s.customerEmail || powForm.details.contactEmail, { type: 'email', placeholder: 'For the feedback form afterwards' })}
      <div class="result" id="pow-result" role="status"></div>
    </div>${powNav('Back', 'Finish and send')}`;
}

function powDoneHtml() {
  const r = powSaved || {};
  return `<div class="card">
      <h2 style="margin-top:0">${r.queued ? 'Saved on this device' : 'Done'}</h2>
      <p>${r.queued
        ? 'No signal right now. The assessment is safe on your phone and sends itself as soon as you are back online.'
        : `The PDF is made${r.jiraAttached ? ' and attached to the job in Jira' : ''}${r.driveFileId ? ', and filed in the shared drive' : ''}.`}</p>
      ${r.notes?.length ? `<div class="notice" style="border-radius:10px"><p style="margin:0">Filing didn't complete: ${esc(r.notes.join(' '))} Your team lead has been told, and you can download it below.</p></div>` : ''}
      <div class="row" style="margin-top:1rem">
        ${r.id && !r.queued ? `<a class="btn" href="/api/pow/pdf?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">Open the PDF</a>` : ''}
        <button class="btn secondary" data-pow="home">Back to assessments</button>
      </div>
    </div>`;
}

async function powControl(action) {
  if (action === 'new') {
    powForm = newPowForm();
    powStep = 'job';
    powNode = 'root';
    powTrail = [];
    return render();
  }
  if (action === 'home') { powStep = 'home'; powForm = null; return render(); }
  if (action === 'next') return powAdvance(1);
  if (action === 'back') return powAdvance(-1);
  if (action === 'missing') {
    powForm.jobMissing = true;
    powForm.branch = powNode.split(':')[2] || null;
    powForm.projectKey = powNode.split(':')[1] || null;
    powForm.details.customer = powForm.details.customer || powForm.projectKey || '';
    powStep = 'details';
    await powSaveDraft();
    toast('Your team lead will be told. Carry on and add the job number later.');
    return render();
  }
}

async function powPickVisit(option) {
  powForm.issueKey = option.label;
  powForm.issueId = option.issueId;
  powForm.details.jobNo = option.label;
  powForm.jobMissing = false;
  try {
    const details = await api(`/api/pow/visit?issueKey=${encodeURIComponent(option.label)}`);
    powForm.projectKey = details.projectKey;
    Object.assign(powForm.details, {
      customer: details.customer, site: details.site, contact: details.contact,
      contactPhone: details.contactPhone, contactEmail: details.contactEmail,
    });
  } catch { /* the engineer can type it in */ }
  powStep = 'details';
  await powSaveDraft();
  return render();
}

async function powOpenDraft(id) {
  const local = localDrafts.read()[id];
  if (local) powForm = local.form;
  else {
    const record = await api(`/api/pow/form?id=${encodeURIComponent(id)}`);
    powForm = record.data;
  }
  powStep = powForm.issueKey || powForm.jobMissing ? 'details' : 'job';
  return render();
}

function powToggle(set, value) {
  const list = powForm[set];
  const index = list.indexOf(value);
  if (index >= 0) {
    list.splice(index, 1);
    if (set === 'hazards') powForm.significant = powForm.significant.filter((e) => e.hazard !== value);
  } else {
    list.push(value);
  }
  powSaveDraft();
  return render();
}

function powSet(name, value) {
  const [group, key] = name.split('.');
  if (group === 'check') {
    checkForm.results[key] = { ...(checkForm.results[key] || {}), result: value };
    return render();
  }
  if (group === 'fit') {
    checkForm.fitToDrive = value === 'yes';
    return render();
  }
  if (group === 'before') powForm.before[key] = value;
  if (group === 'review') powForm.review[key] = value;
  if (group === 'sig') {
    powCollect();
    if (value === 'yes' && !powForm.significant.some((e) => e.hazard === key)) {
      powForm.significant.push({ hazard: key, control: '', risk: 'Low' });
    }
    if (value === 'no') powForm.significant = powForm.significant.filter((e) => e.hazard !== key);
  }
  if (group === 'risk') {
    powCollect();
    const entry = powForm.significant.find((e) => e.hazard === key);
    if (entry) entry.risk = value;
  }
  powSaveDraft();
  return render();
}

async function powRender() {
  if (powStep === 'home') {
    let forms = [];
    try { forms = (await api('/api/pow/forms')).forms; } catch { forms = []; }
    return powHomeHtml(forms);
  }
  if (powStep === 'done') return powDoneHtml();
  const body = powStep === 'job' ? powJobHtml(await api(`/api/pow/browse?node=${encodeURIComponent(powNode)}`))
    : powStep === 'details' ? powDetailsHtml()
    : powStep === 'before' ? powBeforeHtml()
    : powStep === 'ppe' ? powPpeHtml()
    : powStep === 'hazards' ? powHazardsHtml()
    : powStep === 'significant' ? powSignificantHtml()
    : powStep === 'ras' ? powRasHtml()
    : powStep === 'review' ? powReviewHtml()
    : powSignoffHtml();
  return `${powProgress()}<div style="height:1rem"></div>${body}`;
}

// Reads whatever is on screen back into the form before moving on.
function powCollect() {
  const value = (id) => document.getElementById(id)?.value?.trim();
  if (powStep === 'details') {
    Object.assign(powForm.details, {
      engineer: value('pow-engineer'), customer: value('pow-customer'), site: value('pow-site'),
      contact: value('pow-contact'), contactPhone: value('pow-phone'), date: value('pow-date'),
    });
  }
  if (powStep === 'significant') {
    document.querySelectorAll('[data-sigcontrol]').forEach((input) => {
      const entry = powForm.significant.find((e) => e.hazard === input.dataset.sigcontrol);
      if (entry) entry.control = input.value.trim();
    });
  }
  if (powStep === 'review') powForm.review.note = value('pow-note') || '';
  if (powStep === 'signoff') {
    Object.assign(powForm.signoff, {
      promtekName: value('pow-pname'), promtekPosition: value('pow-prole'),
      customerName: value('pow-cname'), customerPosition: value('pow-crole'), customerEmail: value('pow-cemail'),
    });
  }
}

function powProblem() {
  if (powStep === 'job' && !powForm.issueKey && !powForm.jobMissing) return 'Pick the visit you are on.';
  if (powStep === 'details' && !powForm.details.customer) return 'The customer is needed.';
  if (powStep === 'before' && powSchema.before.some((q) => !powForm.before[q.id])) return 'Answer every question before moving on.';
  if (powStep === 'significant' && powForm.significant.some((e) => !e.control)) return 'Say what you did about each significant hazard.';
  if (powStep === 'review' && powSchema.review.some((q) => !powForm.review[q.id])) return 'Answer all three.';
  if (powStep === 'signoff' && !document.getElementById('pow-pname')?.value?.trim()) return 'Your name is needed.';
  return null;
}

async function powAdvance(direction) {
  powCollect();
  if (direction > 0) {
    const problem = powProblem();
    if (problem) return toast(problem);
  }
  const index = POW_STEPS.indexOf(powStep);
  if (direction < 0 && index === 0) { powStep = 'home'; return render(); }
  if (direction > 0 && index === POW_STEPS.length - 1) return powSubmit();
  powStep = POW_STEPS[index + direction];
  await powSaveDraft();
  return render();
}

async function powSubmit() {
  try {
    powSaved = { ...(await api('/api/pow/submit', { method: 'POST', body: JSON.stringify(powForm) })) };
    localDrafts.remove(powForm.id);
  } catch (err) {
    powForm.queued = true;
    localDrafts.put(powForm);
    powSaved = { id: powForm.id, queued: true };
  }
  powStep = 'done';
  powForm = null;
  return render();
}

// Sends anything that was completed without signal.
async function powFlushQueue() {
  for (const { form } of localDrafts.pending()) {
    try {
      await api('/api/pow/submit', { method: 'POST', body: JSON.stringify(form) });
      localDrafts.remove(form.id);
      toast(`Risk assessment for ${form.issueKey || form.details.customer} sent`);
    } catch { return; }
  }
}

// ---------- logging time ----------

let logNode = null;            // where we are in the tree, null = the front screen
let logTrail = [];             // breadcrumb of {node, label}
let logChosen = null;          // the item picked
let logMode = null;            // 'manual' once they've chosen to log time already done
let logSearch = '';
let logResults = null;
let logPscProject = null;

function optionRow(option) {
  const data = option.next ? `data-node="${esc(option.next)}"` : `data-pick='${esc(JSON.stringify(option))}'`;
  return `<button class="option" ${data}>
      <span class="option-main">
        <strong>${esc(option.title ? `${option.label} ${option.title}` : option.label)}</strong>
        ${option.sublabel ? `<span class="muted">${esc(option.sublabel)}</span>` : ''}
      </span>
      ${option.note ? `<span class="badge">${esc(option.note)}</span>` : ''}
      ${option.next ? '<span class="chev">›</span>' : ''}
    </button>`;
}

async function logPickerHtml() {
  if (logPscProject) return pscFormHtml(logPscProject);
  if (logNode) {
    const step = await api(`/api/log/browse?node=${encodeURIComponent(logNode)}`);
    const crumbs = logTrail.map((c, i) => `<button class="linklike" data-crumb="${i}">${esc(c.label)}</button>`).join(' › ');
    return `
      <div class="card">
        <div class="row" style="align-items:center">
          <button class="btn secondary" data-crumb="-1">Start again</button>
          ${crumbs ? `<span class="crumbs muted">${crumbs}</span>` : ''}
        </div>
        <h2 style="margin:.85rem 0 0">${esc(step.title)}</h2>
        ${step.subtitle ? `<p class="muted" style="margin:.2rem 0 0">${esc(step.subtitle)}</p>` : ''}
      </div>
      <div style="height:1rem"></div>
      <div class="options">${step.options.map(optionRow).join('') || '<div class="card"><p class="muted">Nothing here. Step back and try another branch.</p></div>'}</div>
      ${step.canCreatePsc ? `<div class="card" style="margin-top:1rem">
        <p style="margin-top:0">Took a call or did work with no item for it?</p>
        <button class="btn" data-psc="${esc(step.canCreatePsc.projectKey)}">Raise a service item</button>
      </div>` : ''}`;
  }

  const { recent, assigned } = await api('/api/log/shortcuts');
  const group = (title, options, empty) => `<h2>${title}</h2>
    <div class="options">${options.length ? options.map(optionRow).join('') : `<div class="card"><p class="muted">${empty}</p></div>`}</div>`;

  return `
    <div class="card">
      <label>Search by Jira key or words from the summary
        <input id="log-search" type="search" placeholder="WYNNL-704, or graphics" value="${esc(logSearch)}" autocomplete="off">
      </label>
      ${logResults ? `<div class="options" style="margin-top:.85rem">${
        logResults.options.length ? logResults.options.map(optionRow).join('')
          : `<p class="muted">${esc(logResults.error || 'Nothing matched.')}</p>`}</div>` : ''}
    </div>
    <h2>Browse</h2>
    <div class="options"><button class="option" data-node="root">
      <span class="option-main"><strong>Find it step by step</strong><span class="muted">Internal or customer, then down to the stage</span></span>
      <span class="chev">›</span>
    </button></div>
    ${group('Logged recently', recent, 'Nothing yet. Your last few jobs appear here once you have logged some time.')}
    ${group('Assigned to you', assigned, 'Nothing assigned to you in Jira right now.')}`;
}

function xpPreview(minutes) {
  const e = me.employee;
  const rate = logChosen.jobElo
    ? (logChosen.rate ?? 1) * Math.max(0.5, 1 + (logChosen.jobElo - (e.elo ?? 1100)) / 800)
    : (logChosen.rate ?? 1) * ((e.baseline ?? 60) / 60);
  return Math.round(rate * minutes);
}

function logFormHtml() {
  const today = todayIso();
  const prefill = pendingCall;
  const part = logChosen.rate != null && logChosen.rate !== 1 && logChosen.rate !== 0;
  return `
    <div class="card">
      <p class="muted" style="margin:0 0 .35rem">Logging against</p>
      <h3 style="margin:0">${esc(logChosen.label)} ${esc(logChosen.title || '')}</h3>
      <p class="muted" style="margin:.25rem 0 0">${esc(logChosen.sublabel || '')}</p>
      <div id="log-hint" class="muted" style="margin-top:.5rem"></div>
      ${part ? `<div class="notice" style="margin:1rem 0 0;border-radius:10px">
        <p style="margin:0"><strong>This earns ${Math.round(logChosen.rate * 100)}% XP.</strong> Stages earn the full amount.</p>
        <p style="margin:.35rem 0 0"><button class="linklike" data-flag="1">No stage matched what I did</button></p>
        <div id="flag-box" hidden style="margin-top:.6rem">
          <label>What did you actually do? <input id="flag-note" placeholder="Rewired the mixer feed" autocomplete="off"></label>
          <button class="btn secondary" data-action="flag-stage" style="margin-top:.5rem">Tell my team lead</button>
          <div class="result" id="flag-result" role="status"></div>
        </div>
      </div>` : ''}
    </div>

    <div class="card" style="margin-top:1rem">
      <div class="row">
        <label>Date <input id="log-date" type="date" value="${today}" max="${today}"></label>
        <label>Started <input id="log-start" type="time" value="09:00"></label>
      </div>
      <p class="muted" style="margin:1rem 0 .35rem">How long?</p>
      <div class="row quick">${[15, 30, 60, 90, 120, 240, 450].map((m) =>
        `<button class="chip-btn" data-mins="${m}">${m < 60 ? `${m}m` : `${m / 60}h`.replace('.5', '½')}</button>`).join('')}</div>
      <div class="row" style="margin-top:.75rem">
        <label>Hours <input id="log-hours" type="number" min="0" max="16" step="1" value="${Math.floor((prefill?.seconds || 3600) / 3600)}" inputmode="numeric"></label>
        <label>Minutes <input id="log-minutes" type="number" min="0" max="59" step="5" value="${Math.round(((prefill?.seconds || 3600) % 3600) / 60)}" inputmode="numeric"></label>
      </div>
      <label style="margin-top:.75rem">What did you do? <input id="log-note" value="${esc(prefill?.description || '')}" placeholder="Optional" autocomplete="off"></label>
      <p id="log-xp" class="xp-preview"></p>
      <div class="row">
        <button class="btn" data-action="save-log">Log this time</button>
        <button class="btn secondary" data-action="cancel-log">Pick something else</button>
      </div>
      <div class="result" id="log-result" role="status"></div>
    </div>`;
}

function pscFormHtml(projectKey) {
  const types = ['Service Request', 'PSC', 'Incident', 'Problem', 'Snag', 'Change', 'Further Investigation'];
  return `<div class="card">
      <h2 style="margin-top:0">New service item for ${esc(projectKey)}</h2>
      <p class="muted">It's created in ${esc(projectKey)} and assigned to you, then you can log time against it.</p>
      <div class="row">
        <label>Type <select id="psc-type">${types.map((t) => `<option>${t}</option>`).join('')}</select></label>
      </div>
      <label style="margin-top:.75rem">Summary <input id="psc-summary" placeholder="Weigher stopped mid-batch" autocomplete="off"></label>
      <label style="margin-top:.75rem">Details <input id="psc-description" placeholder="Optional" autocomplete="off"></label>
      <div class="row" style="margin-top:.85rem">
        <button class="btn" data-action="create-psc">Create and log time</button>
        <button class="btn secondary" data-action="cancel-psc">Back</button>
      </div>
      <div class="result" id="psc-result" role="status"></div>
    </div>`;
}

function updateXpPreview() {
  const el = document.getElementById('log-xp');
  if (!el) return;
  const mins = (Number(document.getElementById('log-hours')?.value) || 0) * 60
    + (Number(document.getElementById('log-minutes')?.value) || 0);
  el.textContent = mins ? `Worth about ${n(xpPreview(mins))} XP` : '';
}

async function loadStageHint() {
  const el = document.getElementById('log-hint');
  if (!el || !logChosen?.label) return;
  try {
    const hint = await api(`/api/log/hint?issueKey=${encodeURIComponent(logChosen.label)}`);
    if (hint.times) el.textContent = `This kind of stage has taken ${hint.typicalHours.toFixed(1)} hours on average, across ${hint.times} jobs.`;
  } catch { /* a hint is optional */ }
}

// ---------- reports ----------

let reportWeeks = 8;
let reportAccount = null;
let reportView = 'team';
let reportTeam;
let quotingDiscipline = '';
let quotingAll = false;

const hoursOf = (seconds) => (seconds || 0) / 3600;
const lag = (days) => (days == null ? '—' : days < 1 ? 'same day' : `${days.toFixed(1)} days`);

function teamReportHtml(data) {
  const weeks = data.weeks;
  const header = weeks.map((w) => `<th class="num">${shortDate(w)}</th>`).join('');
  const rows = data.people.map((p) => {
    const cells = weeks.map((w) => {
      const week = p.weeks[w];
      const hrs = hoursOf(week?.seconds);
      const short = hrs > 0 && hrs < 20;
      return `<td class="num${hrs === 0 ? ' muted' : short ? ' low' : ''}">${hrs ? hrs.toFixed(1) : '—'}
        ${week ? `<small>${n(week.xp)} XP</small>` : ''}</td>`;
    }).join('');
    const recent = weeks.slice(-4).map((w) => p.weeks[w]).filter(Boolean);
    const avgLag = recent.length ? recent.reduce((a, r) => a + (r.avg_lag_days || 0), 0) / recent.length : null;
    return `<tr>
      <td><button class="linklike" data-engineer="${esc(p.account_id)}">${esc(p.name)}</button>
        ${p.team ? `<small class="muted"> ${esc(p.team)}</small>` : ''}</td>
      ${cells}
      <td class="num">${lag(avgLag)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div class="tabs">${[8, 13, 26].map((w) =>
          `<button class="tab${w === reportWeeks ? ' on' : ''}" data-weeks="${w}">${w} weeks</button>`).join('')}</div>
        <div class="row">
          <a class="btn secondary" href="/api/reports/export?type=weekly">Weekly CSV</a>
          <a class="btn secondary" href="/api/reports/export?type=ledger">All time logs CSV</a>
          <a class="btn secondary" href="/api/reports/export?type=snapshots">Snapshots CSV</a>
        </div>
      </div>
      <p class="muted" style="margin:.85rem 0 0">Hours logged per week, with XP underneath. A standard week is 37.5 hours.
      The last column is how long after doing the work people record it, averaged over the last four weeks.</p>
    </div>
    <div class="table-wrap" style="margin-top:1rem"><table>
      <thead><tr><th>Engineer</th>${header}<th class="num">Logging delay</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="99" class="muted">No time logged yet.</td></tr>'}</tbody>
    </table></div>`;
}

const DISCIPLINE_NAMES = { software: 'Software', hardware: 'Hardware', engineering: 'Site visit', condor: 'Condor' };

function quotingHtml(data) {
  const ratioCell = (ratio) => {
    if (ratio == null) return '<td class="num muted">—</td>';
    const over = ratio > 1.25, under = ratio < 0.75;
    return `<td class="num${over ? ' bad' : under ? ' low' : ' good'}">${ratio.toFixed(2)}×</td>`;
  };
  const bands = data.byBand.map((b) => `<tr>
      <td>${esc(DISCIPLINE_NAMES[b.discipline] || b.discipline)}</td>
      <td>${esc(b.size)}</td>
      <td class="num">${n(b.jobs)}</td>
      <td class="num">${b.medianEstimateHours == null ? '—' : b.medianEstimateHours.toFixed(1)}</td>
      <td class="num">${b.medianActualHours == null ? '—' : b.medianActualHours.toFixed(1)}</td>
      ${ratioCell(b.medianRatio)}
      <td class="num muted">${b.spreadHours ? `${b.spreadHours[0].toFixed(1)}–${b.spreadHours[1].toFixed(1)}h` : '—'}</td>
    </tr>`).join('');

  const groupTable = (title, rows) => `<h2>${title}</h2>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Name</th><th class="num">Jobs</th><th class="num">Actual vs estimate</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${n(r.jobs)}</td>${ratioCell(r.medianRatio)}</tr>`).join('')}</tbody>
    </table></div>` : '<div class="card"><p class="muted">Not enough finished work with an estimate yet.</p></div>'}`;

  const counted = data.coverage.reduce((a, c) => a + c.n, 0);
  const good = data.coverage.filter((c) => c.confidence === 'good').reduce((a, c) => a + c.n, 0);

  const jobs = data.jobs.slice(0, 40).map((j) => `<tr>
      <td>${j.done_date ? shortDate(j.done_date) : '—'}</td>
      <td>${esc(j.project_name || '')}</td>
      <td><a href="${esc(me.jiraBaseUrl)}/browse/${esc(j.issue_key)}" target="_blank" rel="noopener">${esc(j.issue_key)}</a></td>
      <td>${esc(DISCIPLINE_NAMES[j.discipline] || '')}</td>
      <td class="num">${j.job_elo == null ? '—' : n(Math.round(j.job_elo))}</td>
      <td class="num">${j.estimate_seconds ? (j.estimate_seconds / 3600).toFixed(1) : '—'}</td>
      <td class="num">${(j.actual_seconds / 3600).toFixed(1)}</td>
      ${ratioCell(j.estimate_seconds ? j.actual_seconds / j.estimate_seconds : null)}
    </tr>`).join('');

  return `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div class="row">
          ${disciplinePicker()}
          <label class="inline">
            <input type="checkbox" id="quoting-all"${quotingAll ? ' checked' : ''}> Include patchy data
          </label>
        </div>
        <a class="btn secondary" href="/api/reports/export?type=jobs">Completed jobs CSV</a>
      </div>
      <p class="muted" style="margin:.85rem 0 0">Finished work compared with what it was estimated to take.
      ${n(good)} of ${n(counted)} recorded items have an estimate and believable hours; the rest are excluded unless you tick the box.</p>
    </div>

    <h2>How long jobs of each size really take</h2>
    ${data.byBand.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Discipline</th><th>Estimated</th><th class="num">Jobs</th>
        <th class="num">Estimate (median)</th><th class="num">Actual (median)</th><th class="num">Actual vs estimate</th><th class="num">Range</th></tr></thead>
      <tbody>${bands}</tbody>
    </table></div>
    <p class="muted">Where actual and estimate differ consistently for a size of job, estimates of that size are running light or heavy.</p>`
    : '<div class="card"><p class="muted">No finished categories with an estimate yet. Run the historical backfill from the Admin page to build up a starting set.</p></div>'}

    ${groupTable('By customer', data.byCustomer)}
    ${groupTable('By team', data.byTeam)}

    <h2>Recently finished</h2>
    ${jobs ? `<div class="table-wrap"><table>
      <thead><tr><th>Finished</th><th>Customer</th><th>Item</th><th>Discipline</th><th class="num">Job ELO</th>
        <th class="num">Estimate</th><th class="num">Actual</th><th class="num">Ratio</th></tr></thead>
      <tbody>${jobs}</tbody>
    </table></div>` : '<div class="card"><p class="muted">Nothing recorded yet.</p></div>'}`;
}

function disciplinePicker() {
  return `<label>Discipline <select id="quoting-discipline">
      <option value="">All</option>
      ${Object.entries(DISCIPLINE_NAMES).map(([k, v]) =>
        `<option value="${k}"${k === quotingDiscipline ? ' selected' : ''}>${v}</option>`).join('')}
    </select></label>`;
}

let stageCustomer = '';
let stageGroup = 'type';
function stagesHtml(data) {
  const splitLabel = stageGroup === 'customer' ? 'Customer' : stageGroup === 'team' ? 'Team' : null;
  const stages = data.stages.map((st) => `<tr>
      <td>${esc(DISCIPLINE_NAMES[st.discipline] || st.discipline)}</td>
      <td>${esc(st.stage)}</td>${splitLabel ? `<td>${esc(st.by || '')}</td>` : ''}
      <td class="num">${n(st.times)}</td>
      <td class="num">${st.medianHours.toFixed(1)}</td>
      <td class="num muted">${st.lowHours.toFixed(1)}–${st.highHours.toFixed(1)}</td>
      <td class="num">${st.medianShare == null ? '—' : `${(st.medianShare * 100).toFixed(0)}%`}</td>
      <td class="muted">${st.lastSeen ? shortDate(st.lastSeen) : '—'}</td>
    </tr>`).join('');

  const d = data.difficulty;
  const scoreRows = d.byScore.map((b) => `<tr>
      <td class="num">${b.score.toFixed(1)}</td><td class="num">${n(b.jobs)}</td>
      <td class="num">${b.medianHours.toFixed(1)}</td></tr>`).join('');

  const driverRows = d.drivers.map((dr) => `<tr>
      <td>${esc(dr.name)}</td>
      <td class="num">${dr.correlation == null ? '—' : dr.correlation.toFixed(2)}</td>
      <td class="muted">${dr.levels.map((l) => `${l.score}: ${l.medianHours.toFixed(0)}h`).join(', ')}</td>
    </tr>`).join('');

  return `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        ${disciplinePicker()}
        <label>Customer <select data-stage-customer><option value="">All customers</option>${(data.customers || []).map((c) => `<option${c === stageCustomer ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <span class="segment" role="group" aria-label="Group by">${[['type', 'By stage'], ['customer', 'By customer'], ['team', 'By team']].map(([k, l]) =>
          `<button class="seg${stageGroup === k ? ' on' : ''}" data-stage-group="${k}">${l}</button>`).join('')}</span>
        <a class="btn secondary" href="/api/reports/export?${new URLSearchParams({ type: 'stages', ...(quotingDiscipline ? { discipline: quotingDiscipline } : {}), ...(reportTeam ? { team: reportTeam } : {}), ...(stageCustomer ? { customer: stageCustomer } : {}), group: stageGroup })}">Stage library CSV</a>
      </div>
      <p class="muted" style="margin:.85rem 0 0">How long each kind of stage actually takes, built from finished work.
      Stages don't carry their own estimates, so this is the closest thing to one: quote a category, then split it by
      the share column, or add up the stage hours directly. Stages seen fewer than ${data.minJobs} times are left out
      (${n(data.skipped)} of them so far).</p>
    </div>

    <h2>Stage library</h2>
    ${data.stages.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Discipline</th><th>Stage</th>${splitLabel ? `<th>${splitLabel}</th>` : ''}<th class="num">Times done</th><th class="num">Typical hours</th>
        <th class="num">Range</th><th class="num">Share of category</th><th>Last seen</th></tr></thead>
      <tbody>${stages}</tbody>
    </table></div>` : `<div class="card"><p class="muted">No repeated stages recorded yet. This fills up as work finishes, and the historical backfill gives it a head start.</p></div>`}

    <h2>Do the difficulty scores predict the hours?</h2>
    ${d.jobs ? `<div class="two-up">
      <div>
        <div class="table-wrap"><table>
          <thead><tr><th class="num">Weighted score</th><th class="num">Jobs</th><th class="num">Typical hours</th></tr></thead>
          <tbody>${scoreRows}</tbody>
        </table></div>
        <p class="muted">Hours should climb steadily with the score. Where two scores give the same hours, the bands either side are worth merging.</p>
      </div>
      <div>
        <div class="table-wrap"><table>
          <thead><tr><th>Score</th><th class="num">Tracks hours</th><th>Typical hours at each level</th></tr></thead>
          <tbody>${driverRows}</tbody>
        </table></div>
        <p class="muted">"Tracks hours" runs from −1 to 1. The scores near the top are doing the work; ones near zero
        aren't telling you much and their weighting could be reduced. Based on ${n(d.jobs)} finished categories.</p>
      </div>
    </div>` : '<div class="card"><p class="muted">Not enough scored work recorded yet.</p></div>'}`;
}

// ---------- ELO over time ----------

let eloWeeks = 26;
let eloSort = 'elo';
const signedInt = (v) => (v > 0 ? `+${n(v)}` : v < 0 ? `−${n(-v)}` : '0');

function eloSpark(series) {
  const w = 96, h = 26, lo = Math.min(...series), hi = Math.max(...series), span = Math.max(20, hi - lo);
  const x = (i) => (series.length > 1 ? (i / (series.length - 1)) * (w - 4) + 2 : w / 2);
  const y = (v) => h - 3 - ((v - lo + (span - (hi - lo)) / 2) / span) * (h - 6);
  const move = series[series.length - 1] - series[0];
  const colour = move > 0 ? 'var(--ok)' : move < 0 ? 'var(--danger)' : 'var(--muted)';
  return `<svg class="elo-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="${colour}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}

// Everyone's ELO week by week as faint lines, with the team average drawn over them.
function eloTeamChart(data) {
  const all = data.people.flatMap((p) => p.series);
  if (!all.length) return '';
  // Drawn at the card's real width so the labels stay readable on a phone.
  const w = Math.max(280, Math.min(view.clientWidth || 680, 1000) - 42), h = w < 500 ? 200 : 240, padL = 8, padR = w < 500 ? 78 : 92, padT = 12, padB = 26;
  let lo = Math.min(...all), hi = Math.max(...all);
  const span = Math.max(120, hi - lo);
  lo -= span * 0.12; hi += span * 0.12;
  const count = data.weeks.length;
  const x = (i) => padL + (count > 1 ? (i / (count - 1)) * (w - padL - padR) : 0);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const line = (series) => series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ranks = RANK_LINES.filter(([v]) => v > lo && v < hi).map(([v, name]) => `
    <line x1="${padL}" x2="${w - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line)" stroke-dasharray="4 4"/>
    <text x="${w - padR + 8}" y="${(y(v) + 4).toFixed(1)}" font-size="12" fill="var(--muted)">${esc(name)}</text>`).join('');
  const people = data.people.map((p) => `<path d="${line(p.series)}" fill="none" stroke="#9fb4c3" stroke-width="1.2" opacity=".55"><title>${esc(p.name)}: ${n(p.series[0])} to ${n(p.elo)}</title></path>`).join('');
  const ticks = [0, Math.floor((count - 1) / 2), count - 1].filter((v, i, a) => a.indexOf(v) === i)
    .map((i) => `<text x="${x(i).toFixed(1)}" y="${h - 6}" font-size="12" fill="var(--muted)" text-anchor="${i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'}">${shortDate(data.weeks[i])}</text>`).join('');
  return `<svg class="elo-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Team ELO week by week, average now ${n(data.summary.averageNow)}">
      ${ranks}${people}
      <path d="${line(data.average)}" fill="none" stroke="var(--blue-deep)" stroke-width="3" stroke-linejoin="round"><title>Team average</title></path>
      ${ticks}</svg>
    <p class="help" style="padding:.4rem 0 0"><span class="key-dot" style="background:var(--blue-deep)"></span>Team average <span class="key-dot" style="background:#9fb4c3"></span>Each engineer. Dashed lines are where the ranks change.</p>`;
}

function eloReportHtml(data) {
  const s = data.summary;
  const sorts = {
    elo: (a, b) => b.elo - a.elo,
    up: (a, b) => b.change - a.change || b.elo - a.elo,
    down: (a, b) => a.change - b.change || b.elo - a.elo,
    jobs: (a, b) => b.jobs - a.jobs || b.elo - a.elo,
  };
  const people = [...data.people].sort(sorts[eloSort] || sorts.elo);
  const swing = (e) => (e ? `${e.delta > 0 ? '▲' : '▼'} ${n(Math.abs(Math.round(e.delta)))} on ${e.key ? `<a href="${esc(me.jiraBaseUrl)}/browse/${esc(e.key)}" target="_blank" rel="noopener">${esc(e.key)}</a>` : 'a job'}` : '');
  const rows = people.map((p) => `<tr>
      <td><button class="linklike" data-engineer="${esc(p.accountId)}">${esc(p.name)}</button>${p.ratedEver ? '' : '<br><small class="muted">No jobs rated yet</small>'}</td>
      <td>${esc(p.rank || '—')}${p.rankFrom && p.rank && p.rankFrom !== p.rank ? `<br><small class="muted">was ${esc(p.rankFrom)}</small>` : ''}</td>
      <td class="num">${n(p.elo)}</td>
      <td class="num ${p.change > 0 ? 'good' : p.change < 0 ? 'bad' : 'muted'}">${signedInt(p.change)}</td>
      <td class="num">${n(p.jobs)}</td>
      <td>${eloSpark(p.series)}</td>
      <td class="elo-swings">${[swing(p.best), swing(p.worst)].filter(Boolean).join('<br>') || '<span class="muted">—</span>'}</td>
    </tr>`).join('');
  const maxRank = Math.max(1, ...data.ranks.map((r) => r.n));
  return `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div class="tabs">${[13, 26, 52, 104].map((w) => `<button class="tab${w === eloWeeks ? ' on' : ''}" data-elo-weeks="${w}">${w === 104 ? '2 years' : `${w} weeks`}</button>`).join('')}</div>
        <a class="btn secondary" href="/api/reports/export?type=elo&weeks=${eloWeeks}${reportTeam ? `&team=${encodeURIComponent(reportTeam)}` : ''}">ELO by week CSV</a>
      </div>
      <p class="muted" style="margin:.85rem 0 0">Each engineer's ELO week by week. ELO moves when a job they worked on is finished, against its estimate and how hard it was.
      Changes here count finished jobs only, not ratings set by hand on the Admin page.</p>
    </div>
    ${data.people.length ? `<dl class="stats">
      <div><dt>Average ELO</dt><dd>${n(s.averageNow)}<small>${signedInt(s.averageNow - s.averageFrom)} over ${eloWeeks === 104 ? 'two years' : `${eloWeeks} weeks`}</small></dd></div>
      <div><dt>Moved up</dt><dd>${n(s.up)}<small>${n(s.rankUps)} up a rank</small></dd></div>
      <div><dt>Moved down</dt><dd>${n(s.down)}<small>${n(s.rankDowns)} down a rank</small></dd></div>
      <div><dt>Jobs rated</dt><dd>${n(s.jobs)}<small>${n(s.still)} ${s.still === 1 ? 'person' : 'people'} unchanged</small></dd></div>
    </dl>
    <h2>Over time</h2>
    <div class="card">${eloTeamChart(data)}</div>
    <h2>Engineers</h2>
    <div class="row" style="margin-bottom:.75rem"><label>Sort <select data-elo-sort>${[['elo', 'ELO now'], ['up', 'Biggest climb'], ['down', 'Biggest drop'], ['jobs', 'Most jobs rated']].map(([k, l]) =>
      `<option value="${k}"${eloSort === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <div class="table-wrap"><table class="elo-table">
      <thead><tr><th>Engineer</th><th>Rank</th><th class="num">ELO</th><th class="num">Change</th><th class="num">Jobs rated</th><th>Trend</th><th>Biggest moves</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <h2>Ranks now</h2>
    <div class="card"><div class="con-bars">${data.ranks.map((r) => `<div class="psc-bar-row"><span class="con-bar-label">${esc(r.name)}</span>
      <span class="con-bar"><span style="width:${(r.n / maxRank) * 100}%"></span></span><span class="con-bar-value">${r.n}</span></div>`).join('')}</div></div>`
    : '<div class="card"><p style="margin:0">Nobody in this team has an ELO yet.</p></div>'}`;
}

function engineerReportHtml(data) {
  const e = data.employee;
  const maxSeconds = Math.max(37.5 * 3600, ...data.byWeek.map((w) => w.seconds));
  const byWeek = new Map(data.byWeek.map((w) => [w.week_start, w]));
  const chart = data.weeks.map((w) => {
    const week = byWeek.get(w);
    const hrs = hoursOf(week?.seconds);
    return `<div class="col">
      <span class="h">${hrs ? hrs.toFixed(1) : ''}</span>
      <span class="fill${hrs ? '' : ' none'}" style="height:${Math.max(2, (hrs * 3600 / maxSeconds) * 100).toFixed(1)}%"></span>
      <span class="d">${shortDate(w).replace(' ', '')}</span>
    </div>`;
  }).join('');

  const recentWeeks = data.byWeek.slice(-4);
  const avgHours = recentWeeks.length ? recentWeeks.reduce((a, w) => a + hoursOf(w.seconds), 0) / recentWeeks.length : 0;
  const avgLag = recentWeeks.length ? recentWeeks.reduce((a, w) => a + (w.avg_lag_days || 0), 0) / recentWeeks.length : null;

  const snapshots = data.snapshots.slice(0, 12).reverse();
  const trend = snapshots.length > 1 ? `<h2>Weekly snapshots</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Week beginning</th><th class="num">Total XP</th><th class="num">Level</th><th class="num">ELO</th></tr></thead>
      <tbody>${snapshots.map((snap) => `<tr><td>${shortDate(snap.week_start)}</td>
        <td class="num">${n(snap.xp)}</td><td class="num">${n(snap.level)}</td>
        <td class="num">${snap.elo == null ? '—' : n(Math.round(snap.elo))}</td></tr>`).join('')}</tbody>
    </table></div>` : '';

  return `
    <div class="row" style="margin-bottom:1rem">
      <button class="btn secondary" data-engineer="">Back to the team</button>
      <a class="btn secondary" href="/api/reports/export?type=ledger&accountId=${encodeURIComponent(e.accountId)}">This engineer's CSV</a>
    </div>
    <div class="card">
      <h3 style="margin:0 0 .25rem">${esc(e.name)}</h3>
      <p class="muted" style="margin:0">${esc(e.email || 'Not linked')}${e.team ? `. ${esc(e.team)} team` : ''}. ${esc(e.role)}.</p>
    </div>
    <dl class="stats">
      <div><dt>Level</dt><dd>${n(e.progress.level)}<small>${esc(e.progress.title)}</small></dd></div>
      <div><dt>Total XP</dt><dd>${n(e.progress.xp)}</dd></div>
      <div><dt>ELO</dt><dd>${e.elo == null ? '—' : n(Math.round(e.elo))}${e.rank ? `<small>${esc(e.rank.name)}</small>` : ''}</dd></div>
      <div><dt>Average week</dt><dd>${avgHours.toFixed(1)}h<small>logging delay ${lag(avgLag)}</small></dd></div>
    </dl>
    <h2>Hours logged per week</h2>
    <div class="card"><div class="chart wide">${chart}</div></div>
    <h2>ELO history</h2>
    <div id="elo-history">${sectionLoading('Loading ELO history')}</div>
    ${trend}
    <h2>Most time spent on</h2>
    ${data.topJobs.length ? `<ul class="list">${data.topJobs.map((j) => `<li>
        <span class="title">${j.issue_key ? `<a href="${esc(me.jiraBaseUrl)}/browse/${esc(j.issue_key)}" target="_blank" rel="noopener">${esc(j.issue_key)}</a> ` : ''}${esc(j.summary || 'Unknown item')}</span>
        <span class="xp">${hoursOf(j.seconds).toFixed(1)}h<small>${n(j.xp)} XP</small></span>
      </li>`).join('')}</ul>` : '<div class="card"><p class="muted">Nothing logged in this period.</p></div>'}
    <h2>Recent time logs</h2>
    ${xpList(data.recent.slice(0, 25), 'Nothing logged yet.')}`;
}

// ---------- leaderboard ----------

let leaderPeriod = 'week';
let leaderExpanded = false;

function teamPickerHtml(value, attr) {
  return `<div class="row team-picker"><label>Team <select ${attr}>
      <option value="">Everyone</option>${(me.teamsList || []).map((t) => `<option${t === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}
    </select></label></div>`;
}

let leaderTeam = '';
let leaderMetric = 'xp';
const LEADER_PERIODS = {
  xp: [['week', 'This week'], ['month', 'This month'], ['all', 'All time']],
  elo: [['month', 'This month'], ['quarter', 'Last 3 months'], ['all', 'All time']],
};
const eloMove = (change) => (change > 0 ? `<small class="elo-move up">▲ ${n(change)}</small>`
  : change < 0 ? `<small class="elo-move down">▼ ${n(-change)}</small>` : '<small class="elo-move">no change</small>');

function leaderRowHtml(r, extra = '') {
  if (leaderMetric === 'elo') {
    return `<li class="${[r.isYou ? 'you' : '', extra].filter(Boolean).join(' ')}">
      <span class="pos">${r.position}</span>
      <span class="who">${esc(r.name)}</span>
      <span class="lvl">${esc(r.rank || '')}${r.ratedJobs ? '' : ' · no jobs rated yet'}</span>
      <span class="pts">${n(r.elo)}${eloMove(r.change)}</span>
    </li>`;
  }
  const level = r.levelFrom != null && r.levelFrom !== r.level ? `Level ${n(r.levelFrom)} → ${n(r.level)}` : `Level ${n(r.level)}`;
  return `<li class="${[r.isYou ? 'you' : '', extra].filter(Boolean).join(' ')}">
      <span class="pos">${r.position}</span>
      <span class="who">${esc(r.name)}</span>
      <span class="lvl">${level}</span>
      <span class="pts">${n(r.xp)} XP</span>
    </li>`;
}

function leaderboardHtml(data) {
  const rows = (leaderExpanded ? data.all : data.top);
  const youShown = rows.some((r) => r.isYou);
  const list = rows.map((r) => leaderRowHtml(r)).join('');
  const you = !youShown && data.you ? leaderRowHtml(data.you, 'break') : '';
  const what = leaderMetric === 'elo'
    ? `<p class="help">Ranked by ELO now. The arrows show how far finished jobs have moved each person's ELO ${leaderPeriod === 'month' ? 'this month' : leaderPeriod === 'quarter' ? 'in the last three months' : 'since jobs started being rated'}.</p>`
    : leaderPeriod === 'all' ? '' : `<p class="help">XP earned ${leaderPeriod === 'week' ? 'this week' : 'this month'}, and each person's level from the start of the ${leaderPeriod} to now.</p>`;
  return `
    <div class="row leader-head"><span class="segment" role="group" aria-label="Rank by">${[['xp', 'XP'], ['elo', 'ELO']].map(([k, l]) =>
      `<button class="seg${leaderMetric === k ? ' on' : ''}" data-leader-metric="${k}">${l}</button>`).join('')}</span>
      <div class="tabs">${LEADER_PERIODS[leaderMetric].map(([p, label]) =>
        `<button class="tab${p === leaderPeriod ? ' on' : ''}" data-period="${p}">${label}</button>`).join('')}</div></div>
    ${teamPickerHtml(leaderTeam, 'data-leader-team')}
    ${what}
    <ol class="board">${list || '<li><span></span><span class="muted">Nobody here yet.</span></li>'}${you}</ol>
    ${data.total > data.top.length ? `<button class="btn secondary" data-leader="toggle" style="margin-top:.85rem">
      ${leaderExpanded ? 'Show top 10 only' : `Show all ${n(data.total)}`}</button>` : ''}`;
}

async function loadLeaderboard() {
  const host = document.getElementById('leaderboard');
  if (!host) return;
  try {
    const data = await api(`/api/leaderboard?metric=${leaderMetric}&period=${leaderPeriod}${leaderTeam ? `&team=${encodeURIComponent(leaderTeam)}` : ''}`);
    host.innerHTML = leaderboardHtml(data);
  } catch (err) {
    host.innerHTML = `<p class="bad">${esc(err.message)}</p>`;
  }
}

// ---------- ELO history ----------

let eloExpanded = false;
const RANK_LINES = [[800, 'Gram II'], [1100, 'Kilogram I'], [1300, 'Kilogram II'], [1500, 'Tonne I'], [1700, 'Tonne II'],
  [1900, 'Megatonne I'], [2100, 'Megatonne II'], [2300, 'Gigatonne I'], [2500, 'Gigatonne II'], [2800, 'Gigatonne III'], [3100, 'Neutron Star']];
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1).replace(/\.0$/, '')}`;
const jobName = (summary) => String(summary || '').replace(/^category\s*-\s*/i, '');
const hoursText1 = (seconds) => `${(Math.round((seconds || 0) / 360) / 10).toLocaleString('en-GB')}h`;

function eloChart(data, width = 640) {
  const live = data.events;
  const points = [{ elo: data.start, when: null }, ...live.map((e) => ({ elo: e.elo_after, when: (e.done_date || e.created_at || '').slice(0, 10) }))];
  const w = Math.max(280, Math.round(width)), h = w < 500 ? 170 : 210, padL = 6, padR = 84, padT = 14, padB = 24;
  const values = points.map((p) => p.elo);
  let lo = Math.min(...values), hi = Math.max(...values);
  const span = Math.max(80, hi - lo);
  lo -= span * 0.25; hi += span * 0.25;
  const x = (i) => padL + (points.length > 1 ? (i / (points.length - 1)) * (w - padL - padR) : (w - padL - padR) / 2);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const lines = RANK_LINES.filter(([v]) => v > lo && v < hi).map(([v, name]) => `
    <line x1="${padL}" x2="${w - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line)" stroke-dasharray="4 4"/>
    <text x="${w - padR + 8}" y="${(y(v) + 4).toFixed(1)}" font-size="12" fill="var(--muted)">${esc(name)}</text>`).join('');
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.elo).toFixed(1)}`).join(' ');
  const area = `${path} L${x(points.length - 1).toFixed(1)},${h - padB} L${x(0).toFixed(1)},${h - padB} Z`;
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.elo).toFixed(1)}" r="${i === points.length - 1 ? 5 : 3}" fill="${i === points.length - 1 ? 'var(--blue)' : '#fff'}" stroke="var(--blue-deep)" stroke-width="2"/>`).join('');
  const first = points.find((p) => p.when)?.when;
  const last = points[points.length - 1].when;
  return `<svg class="elo-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="ELO over time, now ${n(Math.round(data.elo ?? data.start))}">
    <defs><linearGradient id="eloFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(0,141,198)" stop-opacity=".22"/><stop offset="1" stop-color="rgb(0,141,198)" stop-opacity="0"/></linearGradient></defs>
    ${lines}
    <path d="${area}" fill="url(#eloFill)"/>
    <path d="${path}" fill="none" stroke="var(--blue-deep)" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
    ${first ? `<text x="${padL}" y="${h - 6}" font-size="12" fill="var(--muted)">${shortDate(first)}</text>` : ''}
    ${last && last !== first ? `<text x="${w - padR}" y="${h - 6}" font-size="12" fill="var(--muted)" text-anchor="end">${shortDate(last)}</text>` : ''}
  </svg>`;
}

function eloEventItem(e, { canUndo, self }) {
  const issue = e.issue_key
    ? `<a href="${esc(me.jiraBaseUrl)}/browse/${esc(e.issue_key)}" target="_blank" rel="noopener">${esc(e.issue_key)}</a> `
    : '';
  const change = `<span class="xp${e.delta < 0 ? ' down' : ''}">${signed(e.delta)}<small>${n(Math.round(e.elo_after))}</small></span>`;
  if (e.kind === 'adjustment') {
    return `<li><span class="title">Set by hand</span>${change}
      <span class="sub">${shortDate(e.created_at.slice(0, 10))}. ${esc(e.note || '')}</span></li>`;
  }
  if (e.kind === 'reversal') {
    return `<li><span class="title">${issue}${esc(jobName(e.summary) || 'Job rating')} undone</span>${change}
      <span class="sub">${shortDate(e.created_at.slice(0, 10))}. ${esc(e.note || '')}</span></li>`;
  }
  const how = e.actual_seconds <= e.estimate_seconds ? 'inside' : 'over';
  const detail = `Finished ${shortDate(e.done_date)}. ${hoursText1(e.actual_seconds)} against ${hoursText1(e.estimate_seconds)} estimated, ${how} by ${hoursText1(Math.abs(e.estimate_seconds - e.actual_seconds))}.
    ${self ? 'Your' : 'Their'} share ${Math.round(e.share * 100)}% (${hoursText1(e.seconds)}). Job ELO ${n(Math.round(e.job_elo))}.${e.modifier_factor != null ? ` Counted at ${Math.round(e.modifier_factor * 100)}% while something was taken into account.` : ''}`;
  const undo = canUndo && !e.reversed_at
    ? ` <button class="linklike" data-elo-undo="${e.id}">Undo</button>` : '';
  return `<li${e.reversed_at ? ' class="undone"' : ''}><span class="title">${issue}${esc(jobName(e.summary) || 'Finished job')}</span>${change}
    <span class="sub">${detail}${e.reversed_at ? ' Undone.' : ''}${undo}</span></li>`;
}

function eloHistoryHtml(data, { canUndo = false, width, self = true } = {}) {
  const events = [...data.events].reverse();
  const shown = eloExpanded ? events : events.slice(0, 10);
  const held = data.rank?.heldFrom
    ? `<p class="help" style="padding:.35rem 0 0"><strong>${esc(data.rank.name)}</strong> is held from ${n(Math.round(data.rank.heldFrom))}, the best in the last three months.</p>` : '';
  const chart = data.events.length
    ? `<div class="card">${eloChart(data, width)}
        <p class="help" style="padding:.5rem 0 0">Each finished job compares its time with the estimate, allowing for how hard it was against ${self ? 'your' : 'their'} ELO. ${self ? 'Your' : 'Their'} share of the hours sets how much it counts.</p>
        ${held}</div>`
    : `<div class="card"><p style="margin-top:0"><strong>No finished jobs rated yet.</strong></p>
        <p class="muted" style="margin-bottom:0">ELO moves when a job with an estimate and a difficulty is finished, a few days after it closes so late time logs still count. Each job compares the time it took with its estimate, allowing for how hard it was rated.</p></div>`;
  const list = events.length ? `<ul class="list elo-list" style="margin-top:1rem">${shown.map((e) => eloEventItem(e, { canUndo, self })).join('')}</ul>
    ${events.length > 10 ? `<button class="btn secondary" data-elo-more="1" style="margin-top:.85rem">${eloExpanded ? 'Show the latest 10' : `Show all ${n(events.length)}`}</button>` : ''}` : '';
  return chart + list;
}

let eloHistoryFor = null;
async function loadEloHistory(accountId = null) {
  const host = document.getElementById('elo-history');
  if (!host) return;
  eloHistoryFor = accountId;
  try {
    const data = await api(`/api/elo/history${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`);
    // Nothing rated yet: the section stays out of the way rather than showing an empty chart.
    const heading = host.previousElementSibling?.tagName === 'H2' ? host.previousElementSibling : null;
    const empty = !data.events.length;
    host.hidden = empty;
    if (heading) heading.hidden = empty;
    if (empty) return;
    // Drawn at the card's real width so the labels stay readable on a phone.
    const width = host.clientWidth - 2 * parseFloat(getComputedStyle(host.querySelector('.card') || host).paddingLeft || 0);
    host.innerHTML = eloHistoryHtml(data, { canUndo: me.user.isAdmin && Boolean(accountId), width, self: !accountId });
  } catch (err) {
    host.innerHTML = `<div class="card"><p class="bad">${esc(err.message)}</p></div>`;
  }
}

// ---------- Jobs: difficulty, estimates, disputes ----------

let jobsScope = 'mine';
let jobsView = null;        // null, { kind: 'dispute', id } or { kind: 'decide', id }
let jobsDraft = null;       // the dispute or decision being filled in
const SCORE_LABELS = [['tech', 'Technical complexity'], ['scope', 'Scope and size'], ['risk', 'Uncertainty and risk'], ['dep', 'Dependencies and coordination']];
const SCORE_WEIGHTS = { tech: 0.4, scope: 0.3, risk: 0.2, dep: 0.1 };
const eloFromScores = (s) => 750 + 250 * SCORE_LABELS.reduce((a, [k]) => a + (Number(s[k]) || 0) * SCORE_WEIGHTS[k], 0);
const hoursShort = (seconds) => (seconds == null ? '—' : `${n(Math.round(seconds / 360) / 10)}h`);

function scoreRow(key, label, value, { quoted, name = 'jobs-score' } = {}) {
  return `<div class="score-row"><span class="score-label">${label}${quoted != null ? `<small>Quoted ${n(quoted)}</small>` : ''}</span>
    <span class="segment">${[1, 2, 3, 4, 5].map((v) =>
      `<button class="seg${Number(value) === v ? ' on' : ''}" data-${name}="${key}" data-value="${v}">${v}</button>`).join('')}</span></div>`;
}

function jobsCategoryRow(c) {
  const pct = c.pct ?? 0;
  const state = pct >= 1 ? ' over' : pct >= 0.9 ? ' near' : '';
  const label = DISCIPLINE_NAMES[c.discipline] || '';
  const extra = jobName(c.summary);
  const name = `${label}${extra && extra.toLowerCase() !== label.toLowerCase() ? `, ${esc(extra)}` : ''}`;
  const notes = [
    c.pendingDispute ? (c.pendingIsMine ? 'Your dispute is with the team lead' : 'A dispute is with the team lead') : '',
    c.disputed ? `Agreed after a dispute, quoted ${n(Math.round(c.quotedElo || 0))}` : '',
  ].filter(Boolean).join('. ');
  const prompt = c.mine && !c.done && !c.pendingDispute && pct >= 0.9
    ? `<p class="job-prompt">${pct >= 1 ? 'This has passed its estimate.' : 'This is close to its estimate.'} Does the difficulty still look right?</p>` : '';
  const action = !c.done && !c.pendingDispute
    ? `<button class="chip-btn" data-jobs-dispute="${esc(c.id)}">Dispute</button>` : '';
  return `<li class="job-cat${state}">
    <div class="job-cat-head"><span class="title"><a href="${esc(me.jiraBaseUrl)}/browse/${esc(c.key)}" target="_blank" rel="noopener">${esc(c.key)}</a> ${name}</span>
      <span class="elo-pill" title="Job ELO">${c.jobElo ? n(Math.round(c.jobElo)) : '—'}</span></div>
    <div class="bar"><span style="width:${Math.min(100, Math.round(pct * 100))}%"></span></div>
    <div class="job-cat-foot"><span class="sub">${hoursShort(c.loggedSeconds)} of ${hoursShort(c.estimateSeconds)}${c.estimateSeconds ? `, ${Math.round(pct * 100)}%` : ''}${c.done ? '. Done' : ''}${notes ? `. ${notes}` : ''}</span>${action}</div>
    ${prompt}
  </li>`;
}

function approvalsHtml(a) {
  const disputes = a.disputes.map((d) => `<li>
      <span class="title">${esc(d.raised_by || 'Someone')} disputes <a href="${esc(me.jiraBaseUrl)}/browse/${esc(d.category_key)}" target="_blank" rel="noopener">${esc(d.category_key)}</a></span>
      <span class="sub">${esc(d.order_summary || '')}, ${esc(DISCIPLINE_NAMES[d.discipline] || '')}. Job ELO ${n(Math.round(d.before_elo || 0))} to ${n(Math.round(d.proposed_elo))}${d.proposed_estimate_seconds ? `, estimate ${hoursShort(d.before_estimate_seconds)} to ${hoursShort(d.proposed_estimate_seconds)}` : ''}.</span>
      <button class="btn secondary" data-jobs-decide="${d.id}" style="margin-top:.6rem">Review</button></li>`).join('');
  const mods = a.modifiers.map((m) => `<li>
      <span class="title">${esc(m.name || 'Someone')}: ${esc(m.kind)}</span>
      <span class="sub">From ${shortDate(m.start_date)}${m.end_date ? ` to ${shortDate(m.end_date)}` : ', until it ends'}. Jobs count for less towards their ELO while it applies. A good moment to check in and see whether they need any support.</span>
      <div class="row" style="margin-top:.6rem"><button class="btn" data-mod-decide="${m.id}" data-decision="approve">Approve</button>
      <button class="btn secondary" data-mod-decide="${m.id}" data-decision="decline">Decline</button></div></li>`).join('');
  if (!disputes && !mods) return '';
  return `<h2>Waiting for you</h2><ul class="list approvals">${disputes}${mods}</ul>`;
}

function supervisedHtml(list) {
  if (!list.length) return '';
  return `<h2>Taken into account for your team</h2><ul class="list supervised">${list.map((m) => `<li>
    <span class="title">${esc(m.name)}: ${esc(m.kind)}</span>
    <span class="sub">Since ${shortDate(m.start_date)}${m.end_date ? `, until ${shortDate(m.end_date)}` : ''}. <button class="linklike" data-mod-end="${m.id}">End it</button></span></li>`).join('')}</ul>`;
}

async function jobsHomeHtml() {
  const [data, approvals] = await Promise.all([api(`/api/jobs?scope=${jobsScope}`), api('/api/approvals')]);
  const scopes = [['mine', 'Mine'], ['team', 'My team'], ['all', 'All']];
  const orders = data.orders.map((o) => `<div class="card job-order" data-job-order>
      <p class="job-order-head"><strong><a href="${esc(me.jiraBaseUrl)}/browse/${esc(o.key)}" target="_blank" rel="noopener">${esc(o.key)}</a> ${esc(o.summary)}</strong>
        <span class="muted">${esc(o.customer || '')}${o.team ? `, ${esc(o.team)}` : ''}</span></p>
      <ul class="list plain">${o.categories.map(jobsCategoryRow).join('')}</ul></div>`).join('');
  const empty = jobsScope === 'mine'
    ? '<div class="card"><p style="margin:0">Nothing open that you have logged time on in the last six months. My team and All show everything else.</p></div>'
    : '<div class="card"><p style="margin:0">No open orders here.</p></div>';
  return `${approvalsHtml(approvals)}
    ${countChecksHtml(approvals.countChecks)}
    ${supervisedHtml(approvals.supervised)}
    <h2>Open jobs</h2>
    <div class="row jobs-tools"><span class="segment">${scopes.map(([k, l]) =>
      `<button class="seg${jobsScope === k ? ' on' : ''}" data-jobs-scope="${k}">${l}</button>`).join('')}</span>
      <input type="search" id="jobs-search" placeholder="Search orders, customers or keys" aria-label="Search jobs"></div>
    <p class="help">Each category shows its job ELO and the time logged against its estimate. If a job has turned out harder than quoted, dispute it and your team lead will take a look.</p>
    ${orders || empty}`;
}

async function jobsDisputeHtml() {
  const c = await api(`/api/jobs/category?id=${encodeURIComponent(jobsView.id)}`);
  if (!jobsDraft || jobsDraft.id !== c.id) {
    jobsDraft = { id: c.id, scores: Object.fromEntries(SCORE_LABELS.map(([k]) => [k, c.current[k]])), estimateHours: '', reasons: [], comment: '' };
  }
  const elo = eloFromScores(jobsDraft.scores);
  const reasons = c.reasons.map((r) =>
    `<button class="chip${jobsDraft.reasons.includes(r) ? ' on' : ''}" data-jobs-reason="${esc(r)}">${esc(r)}</button>`).join('');
  const past = c.history.length ? `<h2>Earlier disputes</h2><ul class="list">${c.history.map((d) => `<li>
      <span class="title">${esc(d.raised_by || 'Someone')}, ${shortDate(d.created_at.slice(0, 10))}</span>
      <span class="sub">${{ pending: 'With the team lead', approved: `Agreed at ${n(Math.round(d.approved_elo))}`, declined: 'Not agreed', withdrawn: 'Withdrawn' }[d.status]}${d.decision_note ? `. ${esc(d.decision_note)}` : ''}</span></li>`).join('')}</ul>` : '';
  return `<div class="card">
      <p style="margin-top:0"><strong><a href="${esc(me.jiraBaseUrl)}/browse/${esc(c.key)}" target="_blank" rel="noopener">${esc(c.key)}</a> ${esc(DISCIPLINE_NAMES[c.discipline] || '')}</strong><br>
        <span class="muted">${esc(c.epicKey)} ${esc(c.orderSummary)}, ${esc(c.customer || '')}</span></p>
      <p class="muted">${hoursShort(c.loggedSeconds)} logged of ${hoursShort(c.current.estimateSeconds)} estimated.</p>
      <h3>How hard is it really?</h3>
      ${SCORE_LABELS.map(([k, l]) => scoreRow(k, l, jobsDraft.scores[k], { quoted: c.quoted[k] })).join('')}
      <p class="elo-change">Job ELO <strong>${n(Math.round(c.current.elo || 0))}</strong> to <strong>${n(Math.round(elo))}</strong></p>
      <label>A better estimate, in hours <span class="muted">(optional)</span>
        <input type="number" min="0" step="0.5" inputmode="decimal" data-jobs-field="estimateHours" value="${esc(jobsDraft.estimateHours)}" placeholder="${Math.round((c.current.estimateSeconds || 0) / 360) / 10}"></label>
      <h3>What changed?</h3>
      <div class="chips">${reasons}</div>
      <label style="margin-top:1rem">In your words
        <textarea rows="4" data-jobs-field="comment" placeholder="What made it harder than it looked when it was quoted?">${esc(jobsDraft.comment)}</textarea></label>
      <p class="help">Your team lead sees this and can agree, adjust or decline it. The quoted difficulty is kept too, so future quotes can learn from it.</p>
      <div class="row"><button class="btn" data-jobs-send="1">Send to the team lead</button>
        <button class="btn secondary" data-jobs-back="1">Back to jobs</button></div>
      <div class="result" id="jobs-result" role="status"></div>
    </div>${past}`;
}


async function jobsDecideHtml() {
  const approvals = await api('/api/approvals');
  const d = approvals.disputes.find((x) => String(x.id) === String(jobsView.id));
  if (!d) { jobsView = null; return jobsHomeHtml(); }
  if (!jobsDraft || jobsDraft.decide !== d.id) {
    jobsDraft = { decide: d.id, scores: { tech: d.proposed_tech, scope: d.proposed_scope, risk: d.proposed_risk, dep: d.proposed_dep },
      estimateHours: d.proposed_estimate_seconds ? String(Math.round(d.proposed_estimate_seconds / 360) / 10) : '', note: '' };
  }
  const elo = eloFromScores(jobsDraft.scores);
  const compare = SCORE_LABELS.map(([k, l]) => `<tr><td>${l}</td><td class="num">${n(d[`quoted_${k}`])}</td><td class="num">${n(d[`proposed_${k}`])}</td></tr>`).join('');
  return `<div class="card">
      <p style="margin-top:0"><strong>${esc(d.raised_by || 'Someone')} disputes <a href="${esc(me.jiraBaseUrl)}/browse/${esc(d.category_key)}" target="_blank" rel="noopener">${esc(d.category_key)}</a></strong><br>
        <span class="muted">${esc(d.epic_key)} ${esc(d.order_summary || '')}, ${esc(DISCIPLINE_NAMES[d.discipline] || '')}. ${hoursShort(d.logged_seconds)} logged of ${hoursShort(d.before_estimate_seconds)} when raised.</span></p>
      ${d.reasons.length ? `<div class="chips">${d.reasons.map((r) => `<span class="chip on">${esc(r)}</span>`).join('')}</div>` : ''}
      <blockquote class="dispute-words">${esc(d.comment)}</blockquote>
      <div class="table-wrap"><table><thead><tr><th>Area</th><th class="num">Quoted</th><th class="num">Suggested</th></tr></thead><tbody>${compare}</tbody></table></div>
      <h3>Agreed difficulty</h3>
      ${SCORE_LABELS.map(([k, l]) => scoreRow(k, l, jobsDraft.scores[k], { name: 'jobs-score' })).join('')}
      <p class="elo-change">Job ELO <strong>${n(Math.round(d.before_elo || 0))}</strong> to <strong>${n(Math.round(elo))}</strong></p>
      <label>Agreed estimate, in hours
        <input type="number" min="0" step="0.5" inputmode="decimal" data-jobs-field="estimateHours" value="${esc(jobsDraft.estimateHours)}" placeholder="${Math.round((d.before_estimate_seconds || 0) / 360) / 10}"></label>
      <label style="margin-top:1rem">Note for ${esc((d.raised_by || 'them').split(' ')[0])} <span class="muted">(optional)</span>
        <textarea rows="3" data-jobs-field="note">${esc(jobsDraft.note)}</textarea></label>
      <p class="help">Agreeing it recalculates the XP already earned on this category at the new ELO, and the ELO engine judges it against the agreed difficulty and estimate. Jira is updated to match.</p>
      <div class="row"><button class="btn" data-jobs-verdict="approve">Agree</button>
        <button class="btn secondary" data-jobs-verdict="decline">Decline</button>
        <button class="btn secondary" data-jobs-back="1">Back to jobs</button></div>
      <div class="result" id="jobs-result" role="status"></div></div>`;
}

async function jobsClick(event) {
  const t = (sel) => event.target.closest(sel);
  if (t('[data-jobs-scope]')) { jobsScope = t('[data-jobs-scope]').dataset.jobsScope; return render(); }
  if (t('[data-jobs-dispute]')) { jobsView = { kind: 'dispute', id: t('[data-jobs-dispute]').dataset.jobsDispute }; jobsDraft = null; window.scrollTo(0, 0); return render(); }
  if (t('[data-jobs-decide]')) { jobsView = { kind: 'decide', id: t('[data-jobs-decide]').dataset.jobsDecide }; jobsDraft = null; window.scrollTo(0, 0); return render(); }
  if (t('[data-jobs-back]')) { jobsView = null; jobsDraft = null; return render(); }
  const seg = t('[data-jobs-score]');
  if (seg && jobsDraft) {
    jobsDraft.scores[seg.dataset.jobsScore] = Number(seg.dataset.value);
    seg.parentElement.querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b === seg));
    const strong = view.querySelectorAll('.elo-change strong');
    if (strong[1]) strong[1].textContent = n(Math.round(eloFromScores(jobsDraft.scores)));
    return true;
  }
  const reason = t('[data-jobs-reason]');
  if (reason && jobsDraft) {
    const r = reason.dataset.jobsReason;
    jobsDraft.reasons = jobsDraft.reasons.includes(r) ? jobsDraft.reasons.filter((x) => x !== r) : [...jobsDraft.reasons, r];
    reason.classList.toggle('on');
    return true;
  }
  const send = t('[data-jobs-send]');
  if (send && jobsDraft) {
    send.disabled = true;
    try {
      await api('/api/jobs/dispute', { method: 'POST', body: JSON.stringify({ categoryId: jobsDraft.id, scores: jobsDraft.scores,
        estimateHours: jobsDraft.estimateHours, reasons: jobsDraft.reasons, comment: jobsDraft.comment }) });
      jobsView = null; jobsDraft = null; toast('Sent to your team lead');
      return render();
    } catch (err) { document.getElementById('jobs-result').textContent = err.message; send.disabled = false; }
    return true;
  }
  const verdict = t('[data-jobs-verdict]');
  if (verdict && jobsDraft) {
    verdict.disabled = true;
    try {
      const r = await api('/api/jobs/dispute-decide', { method: 'POST', body: JSON.stringify({ id: jobsDraft.decide, decision: verdict.dataset.jobsVerdict,
        scores: jobsDraft.scores, estimateHours: jobsDraft.estimateHours, note: jobsDraft.note }) });
      jobsView = null; jobsDraft = null;
      toast(r.status === 'approved' ? (r.jiraSynced ? 'Agreed' : 'Agreed. Jira will catch up shortly') : 'Declined');
      return render();
    } catch (err) { document.getElementById('jobs-result').textContent = err.message; verdict.disabled = false; }
    return true;
  }
  const countBtn = t('[data-count-save]') || t('[data-count-skip]');
  if (countBtn) {
    const id = countBtn.dataset.countSave || countBtn.dataset.countSkip;
    const row = view.querySelector(`[data-count-check="${CSS.escape(id)}"]`);
    const counts = Object.fromEntries([...row.querySelectorAll('[data-count-key]')].map((i) => [i.dataset.countKey, i.value]));
    try {
      await api('/api/quotes/check-counts', { method: 'POST', body: JSON.stringify({ categoryId: id, counts, skip: Boolean(countBtn.dataset.countSkip) }) });
      toast(countBtn.dataset.countSkip ? 'Skipped' : 'Saved');
    } catch (err) { toast(err.message); }
    return render();
  }
  const modDecide = t('[data-mod-decide]');
  if (modDecide) {
    modDecide.disabled = true;
    try { await api('/api/modifiers/decide', { method: 'POST', body: JSON.stringify({ id: modDecide.dataset.modDecide, decision: modDecide.dataset.decision }) }); toast(modDecide.dataset.decision === 'approve' ? 'Approved' : 'Declined'); }
    catch (err) { toast(err.message); }
    return render();
  }
  const modEnd = t('[data-mod-end]');
  if (modEnd) {
    if (!confirm('End this now? Jobs count fully again from tomorrow.')) return true;
    try { await api('/api/modifiers/end', { method: 'POST', body: JSON.stringify({ id: modEnd.dataset.modEnd }) }); toast('Ended'); }
    catch (err) { toast(err.message); }
    return render();
  }
  return false;
}

// ---------- Modifiers on the XP page ----------

let modDraft = null;
async function modifiersHtml() {
  const data = await api('/api/modifiers');
  const current = data.modifiers.filter((m) => ['pending', 'approved'].includes(m.status) && (!m.end_date || m.end_date >= todayIso()));
  const status = { pending: 'Waiting for your supervisor', approved: 'Agreed', declined: 'Not agreed', withdrawn: 'Withdrawn' };
  const list = current.length ? `<ul class="list">${current.map((m) => `<li><span class="title">${esc(m.kind)}</span>
      <span class="sub">${status[m.status]}. From ${shortDate(m.start_date)}${m.end_date ? ` to ${shortDate(m.end_date)}` : ', until you end it'}. <button class="linklike" data-mod-end="${m.id}">${m.status === 'pending' ? 'Withdraw' : 'End it'}</button></span></li>`).join('')}</ul>` : '';
  const form = modDraft ? `<div class="card" style="margin-top:1rem">
      <div class="chips">${data.kinds.map((k) => `<button class="chip${modDraft.kind === k ? ' on' : ''}" data-mod-kind="${esc(k)}">${esc(k)}</button>`).join('')}</div>
      <div class="row" style="margin-top:1rem">
        <label>From <input type="date" data-mod-field="from" value="${esc(modDraft.from)}"></label>
        <label>Until <span class="muted">(optional)</span> <input type="date" data-mod-field="until" value="${esc(modDraft.until)}"></label></div>
      <p class="help">No details are needed. ${data.supervisor ? esc(data.supervisor) : 'Your supervisor'} is asked to agree it and may check in to see whether there is anything that would help.</p>
      <div class="row"><button class="btn" data-mod-send="1">Ask</button><button class="btn secondary" data-mod-cancel="1">Cancel</button></div>
      <div class="result" id="mod-result" role="status"></div></div>`
    : '<button class="btn secondary" data-mod-new="1" style="margin-top:.85rem">Ask for something to be taken into account</button>';
  return `<div class="card"><p style="margin:0">If something is making work harder for a while, such as being unwell, a heavy workload or bringing on an apprentice, your supervisor can agree for your jobs to count for less towards ELO while it applies.</p></div>
    ${list}${form}`;
}

async function loadModifiers() {
  const host = document.getElementById('modifiers');
  if (!host) return;
  try { host.innerHTML = await modifiersHtml(); } catch (err) { host.innerHTML = `<div class="card"><p class="bad">${esc(err.message)}</p></div>`; }
}

async function modifiersClick(event) {
  const t = (sel) => event.target.closest(sel);
  if (t('[data-mod-new]')) { modDraft = { kind: null, from: todayIso(), until: '' }; return loadModifiers(); }
  if (t('[data-mod-cancel]')) { modDraft = null; return loadModifiers(); }
  const kind = t('[data-mod-kind]');
  if (kind && modDraft) { modDraft.kind = kind.dataset.modKind; return loadModifiers(); }
  const send = t('[data-mod-send]');
  if (send && modDraft) {
    send.disabled = true;
    try {
      await api('/api/modifiers/request', { method: 'POST', body: JSON.stringify(modDraft) });
      modDraft = null; toast('Sent to your supervisor');
      return loadModifiers();
    } catch (err) { document.getElementById('mod-result').textContent = err.message; send.disabled = false; }
    return true;
  }
  const end = t('#modifiers [data-mod-end]');
  if (end) {
    if (!confirm('End this now?')) return true;
    try { await api('/api/modifiers/end', { method: 'POST', body: JSON.stringify({ id: end.dataset.modEnd }) }); } catch (err) { toast(err.message); }
    return loadModifiers();
  }
  return false;
}

// ---------- Quote builder ----------

let quotesView = null;      // null, { kind: 'new' }, { kind: 'quote', id } or { kind: 'answer', id }
let quotesScope = 'open';
let quotesTab = 'builder';   // 'builder' (quotes made here) or 'open' (every open quote in Jira)
let quotesTeam = '';         // team filter for the builder list
let quotesOpen = { customer: '', team: '', status: '', q: '', sort: 'new' };
let quotesOpenData = null;
let quotesOpenRefresh = false;
const QUOTE_TEAMS = ['Projecting', 'Service', 'Condor'];
// Condor work is Projecting work too.
const teamMatches = (filter, team) => !filter || team === filter || (filter === 'Projecting' && team === 'Condor');
const suggestTeam = (ds = []) => (ds.includes('condor') ? 'Condor' : ds.length && ds.every((d) => d === 'engineering') ? 'Service' : 'Projecting');
const teamFilterLabel = (t) => (t === 'Projecting' ? 'Projecting (with Condor)' : t);
let quoteData = null;       // the open quote, with each section as edited
let quoteNew = null;
let quotePeople = null;
let quoteCustomers = null;
const quoteTimers = {};
const Q_SCORES = [['tech', 'Technical complexity', '1 is routine for us, 5 is something we have never built'],
  ['risk', 'Uncertainty and risk', '1 is all known, 5 is a lot unknown or likely to change'],
  ['dep', 'Dependencies and coordination', '1 is all in our hands, 5 relies on several others']];
const NOVELTY_OPTS = [['exact', 'Done this exact thing'], ['similar', 'Done something similar'], ['never', 'Never done it']];
const SPEC_OPTS = [['clear', 'Clear'], ['partly', 'Partly clear'], ['vague', 'Vague']];
const qDisc = (d) => DISCIPLINE_NAMES[d] || d;
const qHours = (h) => (h == null ? '—' : `${n(Math.round(h * 10) / 10)}h`);

function qSeg(name, options, value, d) {
  return `<span class="segment stack">${options.map(([k, l]) =>
    `<button class="seg${value === k ? ' on' : ''}" data-q-set="${name}" data-q-disc="${d}" data-value="${esc(k)}">${esc(l)}</button>`).join('')}</span>`;
}

function qHelpHtml(s) {
  const h = s.help || {};
  const lines = [];
  if (h.pert != null) lines.push(`Three-point estimate ${qHours(h.pert)}.`);
  if (h.refFactor) lines.push(`Similar jobs took ${h.refFactor >= 1 ? `${Math.round((h.refFactor - 1) * 100)}% more` : `${Math.round((1 - h.refFactor) * 100)}% less`} than estimated.`);
  if (h.bias) lines.push(`${esc(s.estimator || 'This estimator')}'s likely hours have ${h.bias.ratio >= 1 ? `run ${Math.round((h.bias.ratio - 1) * 100)}% light` : `run ${Math.round((1 - h.bias.ratio) * 100)}% heavy`} over ${h.bias.jobs} jobs.`);
  lines.push(h.model ? `Learned from ${h.model.jobs} quoted jobs: ${qHours(h.model.hours)}${h.model.elo ? `, job ELO ${n(Math.round(h.model.elo))}` : ''}.`
    : `The learned estimate starts once ${h.modelNeeds} more quoted ${qDisc(s.discipline).toLowerCase()} jobs have finished.`);
  const refs = (h.references || []).map((r) => `<li>
      <span class="title"><a href="${esc(me.jiraBaseUrl)}/browse/${esc(r.key)}" target="_blank" rel="noopener">${esc(r.key)}</a> ${esc(r.customer || '')}</span>
      <span class="sub">${r.estimateHours ? `${qHours(r.estimateHours)} estimated, ` : ''}${qHours(r.actualHours)} taken${r.learnedElo ? `, job ELO ${n(Math.round(r.learnedElo))}` : ''}. Finished ${shortDate(r.doneDate)}.</span>
      ${quoteData?.canEdit ? `<span class="row ref-compare">${['easier', 'same', 'harder'].map((c) =>
        `<button class="chip${s.reference_id === r.id && s.reference_compare === c ? ' on' : ''}" data-q-ref="${esc(r.id)}" data-q-disc="${s.discipline}" data-value="${c}">${{ easier: 'Easier than this', same: 'About the same', harder: 'Harder than this' }[c]}</button>`).join('')}</span>` : ''}
    </li>`).join('');
  return `<div class="q-suggest">
      <div class="q-figures"><div><span>Suggested</span><strong>${qHours(h.suggestedHours)}</strong></div>
        <div><span>Job ELO</span><strong>${h.jobElo ? n(Math.round(h.jobElo)) : '—'}</strong></div></div>
      <p class="help" style="padding:.4rem 0 0">${lines.join(' ')}</p></div>
    <h3>Similar finished jobs</h3>
    ${refs ? `<ul class="list plain refs">${refs}</ul>` : '<p class="muted">None close enough yet. They appear as counts and conditions are filled in.</p>'}`;
}

function qSectionFields(s, cfg, editable, key = s.discipline) {
  const c = cfg[s.discipline] || { counts: [], chips: [] };
  const dis = editable ? '' : ' disabled';
  const counts = c.counts.map(([k, l]) => `<label class="q-count">${esc(l)}
      <input type="number" min="0" step="1" inputmode="numeric" data-q-count="${esc(k)}" data-q-disc="${key}" value="${esc(s.counts?.[k] ?? '')}"${dis}></label>`).join('');
  const chips = [...(cfg.common || []), ...c.chips].map((x) =>
    `<button class="chip${(s.chips || []).includes(x) ? ' on' : ''}" data-q-chip="${esc(x)}" data-q-disc="${key}"${dis}>${esc(x)}</button>`).join('');
  const hours = [['best_hours', 'Best case'], ['likely_hours', 'Likely'], ['worst_hours', 'Worst case']].map(([k, l]) =>
    `<label>${l}<input type="number" min="0" step="0.5" inputmode="decimal" data-q-field="${k}" data-q-disc="${key}" value="${esc(s[k] ?? '')}"${dis}></label>`).join('');
  return `${s.discipline === 'engineering' ? `<h3>Kind of visit</h3>${qSeg('job_type', (c.jobTypes || []).map((t) => [t, t]), s.job_type, key)}` : ''}
    <h3>How much</h3><div class="q-counts">${counts}</div>
    <h3>Conditions</h3><div class="chips">${chips}</div>
    <h3>Done it before?</h3>${qSeg('novelty', NOVELTY_OPTS, s.novelty, key)}
    <h3>How clear is the spec?</h3>${qSeg('spec', SPEC_OPTS, s.spec, key)}
    <h3>Hours</h3><div class="q-hours">${hours}</div>
    <h3>Difficulty</h3>
    ${Q_SCORES.map(([k, l, hint]) => `<div class="score-row"><span class="score-label">${l}<small>${hint}</small></span>
      <span class="segment">${[1, 2, 3, 4, 5].map((v) => `<button class="seg${Number(s[k]) === v ? ' on' : ''}" data-q-set="${k}" data-q-disc="${key}" data-value="${v}">${v}</button>`).join('')}</span></div>`).join('')}`;
}

function qSectionHtml(s, data) {
  const asks = data.requests.filter((r) => r.discipline === s.discipline);
  const people = (quotePeople || []).map((p) => `<option value="${esc(p.account_id)}">${esc(p.name)}${p.team ? `, ${esc(p.team)}` : ''}</option>`).join('');
  const askHtml = data.canEdit ? `<h3>Ask an engineer</h3>
      ${asks.length ? `<ul class="list plain">${asks.map((r) => `<li><span class="title">${esc(r.name || 'Someone')}</span>
        <span class="sub">${r.status === 'pending' ? 'Asked, waiting for an answer' : `Best ${qHours(r.answer?.best_hours)}, likely ${qHours(r.answer?.likely_hours)}, worst ${qHours(r.answer?.worst_hours)}${r.comment ? `. "${esc(r.comment)}"` : ''}`}</span>
        ${r.status === 'answered' && s.estimator_id !== r.account_id ? `<button class="chip-btn" data-q-use="${r.id}" style="margin-top:.4rem">Use these figures</button>` : ''}</li>`).join('')}</ul>` : ''}
      <div class="row q-ask"><select data-q-ask-who="${s.discipline}" aria-label="Who to ask"><option value="">Choose someone</option>${people}</select>
        <input type="text" data-q-ask-note="${s.discipline}" placeholder="Anything they should know (optional)">
        <button class="btn secondary" data-q-ask="${s.discipline}">Ask</button></div>` : '';
  return `<section class="card q-section" data-q-section="${s.discipline}">
      <h2 style="margin-top:0">${qDisc(s.discipline)}${s.estimator ? `<small class="muted"> estimated by ${esc(s.estimator)}</small>` : ''}</h2>
      <div class="q-grid"><div>${qSectionFields(s, data.config, data.canEdit && !data.quote.epic_key)}</div>
        <div class="q-side"><div id="q-help-${s.discipline}">${qHelpHtml(s)}</div>
          ${data.canEdit ? `<label style="margin-top:1rem">Hours to quote
            <input type="number" min="0" step="0.5" inputmode="decimal" data-q-field="quoted_hours" data-q-disc="${s.discipline}" value="${esc(s.quoted_hours ?? '')}"
              placeholder="${s.help?.suggestedHours ? Math.round(s.help.suggestedHours * 10) / 10 : ''}"${data.quote.epic_key ? ' disabled' : ''}></label>` : ''}
          ${askHtml}</div></div>
      <div class="result" id="q-result-${s.discipline}" role="status"></div></section>`;
}

async function quoteHtml() {
  quoteData = await api(`/api/quotes/get?id=${encodeURIComponent(quotesView.id)}`);
  if (quoteData.canEdit && !quotePeople) quotePeople = (await api('/api/quotes/people')).people;
  const q = quoteData.quote;
  const status = { open: 'Being worked on', ready: 'Ready to send', won: `Became order ${q.epic_key || ''}`, lost: 'Not going ahead' }[q.status];
  const jira = q.quote_key
    ? `<a href="${esc(quoteData.jiraUrl)}" target="_blank" rel="noopener">${esc(q.quote_key)}</a>`
    : `<span class="bad">Not in Jira yet</span> <button class="linklike" data-q-retry="${q.id}">Try again</button>`;
  const actions = quoteData.canEdit && !q.epic_key ? `<div class="row" style="margin-top:.75rem">
      ${q.status !== 'ready' ? '<button class="btn" data-q-status="ready">Ready to send</button>' : '<button class="btn secondary" data-q-status="open">Back to working on it</button>'}
      ${q.status !== 'lost' ? '<button class="btn secondary" data-q-status="lost">Not going ahead</button>' : ''}</div>` : '';
  const teamRow = quoteData.canEdit && !q.epic_key
    ? `<div class="q-team-row"><span class="muted">Promtek team</span><span class="segment" role="group" aria-label="Promtek team">${(quoteData.teams || QUOTE_TEAMS).map((t) =>
        `<button class="seg${q.team === t ? ' on' : ''}" data-q-team="${t}">${t}</button>`).join('')}</span></div>`
    : q.team ? `<p class="muted" style="margin:.4rem 0 0">Promtek team: ${esc(q.team)}</p>` : '';
  return `<div class="card"><p style="margin:0"><strong>${esc(q.title)}</strong><br>
      <span class="muted">${esc(q.customer || q.project_key)}. Quote ${jira}. ${status}.</span></p>
      ${teamRow}
      ${q.jira_error && !q.quote_key ? `<p class="help">${esc(q.jira_error)}. Everything here is saved; it goes to Jira when it can.</p>` : ''}
      ${q.handoff_error ? `<p class="help">The order's figures are waiting to go into Jira: ${esc(q.handoff_error)}</p>` : ''}
      ${actions}<div class="result" id="q-status-result" role="status"></div></div>
    ${quoteDescriptionHtml(q)}
    ${quoteData.sections.map((s) => qSectionHtml(s, quoteData)).join('')}
    <div class="row"><button class="btn secondary" data-q-back="1">Back to quotes</button></div>`;
}

function quoteDescriptionHtml(q) {
  const editable = quoteData.canEdit && !q.epic_key;
  const waiting = q.description_synced === 0 ? '<p class="help">Saved here; Jira will be updated shortly.</p>' : '';
  if (!editable) {
    return q.description ? `<div class="card"><h3 style="margin-top:0">Description</h3><p class="pre-wrap" style="margin:0">${esc(q.description)}</p></div>` : '';
  }
  return `<div class="card"><label style="margin:0">Description
      <textarea rows="6" data-q-description placeholder="What the customer wants, where, any deadlines, and anything the engineers should know">${esc(q.description || '')}</textarea></label>
    <p class="help">This is the description on the Quote in Jira. When the quote is ready to send, the estimates are added underneath it there.</p>${waiting}
    <div class="row"><button class="btn secondary" data-q-description-save>Save description</button></div>
    <div class="result" id="q-description-result" role="status"></div></div>`;
}

async function quoteNewHtml() {
  if (!quoteCustomers) quoteCustomers = (await api('/api/quotes/customers')).customers;
  quoteNew = quoteNew || { projectKey: '', customer: '', title: '', disciplines: [] };
  const picked = quoteCustomers.find((c) => c.key === quoteNew.projectKey);
  return `<div class="card">
      <label>Customer
        <input type="search" id="q-customer-search" placeholder="Search customers" value="${esc(picked ? picked.name : '')}"></label>
      <ul class="list plain q-customers" ${picked ? 'hidden' : ''}>${quoteCustomers.map((c) =>
        `<li data-q-customer-row><button class="linklike" data-q-customer="${esc(c.key)}" data-name="${esc(c.name)}">${esc(c.name)}</button> <span class="muted">${esc(c.key)}</span></li>`).join('')}</ul>
      <label style="margin-top:1rem">Title<input type="text" data-q-new="title" value="${esc(quoteNew.title)}" placeholder="What the customer is asking for"></label>
      <label style="margin-top:1rem">Description
        <textarea rows="6" data-q-new="description" placeholder="What the customer wants, where, any deadlines, and anything the engineers should know">${esc(quoteNew.description || '')}</textarea></label>
      <h3>Categories</h3>
      <div class="chips">${['software', 'hardware', 'engineering', 'condor'].map((d) =>
        `<button class="chip${quoteNew.disciplines.includes(d) ? ' on' : ''}" data-q-new-disc="${d}">${qDisc(d)}</button>`).join('')}</div>
      <h3>Promtek team</h3>
      <span class="segment" role="group" aria-label="Promtek team" data-q-team-group>${QUOTE_TEAMS.map((t) =>
        `<button class="seg${(quoteNew.team || suggestTeam(quoteNew.disciplines)) === t ? ' on' : ''}" data-q-new-team="${t}">${t}</button>`).join('')}</span>
      <p class="help">Set in the Promtek Team field in Jira. ${quoteNew.team ? '' : 'Chosen from the categories until you pick one: Condor for anything with Condor in it. '}Condor quotes count as Projecting too when filtering.</p>
      <p class="help">The quote is created in Jira under the customer's quote list, with this description, and its key is the quote number in Quoter.</p>
      <div class="row"><button class="btn" data-q-create="1">Start the quote</button><button class="btn secondary" data-q-back="1">Cancel</button></div>
      <div class="result" id="q-new-result" role="status"></div></div>`;
}

let answerDraft = null;
async function quoteAnswerHtml() {
  const list = await api('/api/quotes');
  const r = list.requests.find((x) => String(x.id) === String(quotesView.id));
  if (!r) { quotesView = null; return quotesHomeHtml(); }
  const data = await api(`/api/quotes/get?id=${r.quote_id}`);
  if (!answerDraft || answerDraft.requestId !== r.id) {
    const s = data.sections.find((x) => x.discipline === r.discipline) || {};
    answerDraft = { requestId: r.id, discipline: r.discipline, counts: { ...(s.counts || {}) }, chips: [...(s.chips || [])], comment: '' };
  }
  return `<div class="card"><p style="margin-top:0"><strong>${esc(r.requested_name || 'Someone')} would like your estimate</strong><br>
      <span class="muted">${esc(r.title)} for ${esc(r.customer || '')}, ${qDisc(r.discipline)}${r.quote_key ? `, ${esc(r.quote_key)}` : ''}.</span></p>
      ${data.quote.description ? `<h3>About the job</h3><p class="pre-wrap">${esc(data.quote.description)}</p>` : ''}
      ${r.note ? `<h3>From ${esc(r.requested_name || 'sales')}</h3><blockquote class="dispute-words">${esc(r.note)}</blockquote>` : ''}
      <div data-q-section="answer">${qSectionFields({ ...answerDraft, discipline: r.discipline }, data.config, true, 'answer')}</div>
      <label style="margin-top:1rem">Anything else <span class="muted">(optional)</span>
        <textarea rows="3" data-q-answer-comment="1" placeholder="What the estimate depends on, or what worries you">${esc(answerDraft.comment)}</textarea></label>
      <div class="row"><button class="btn" data-q-answer="1">Send my estimate</button><button class="btn secondary" data-q-back="1">Back</button></div>
      <div class="result" id="q-answer-result" role="status"></div></div>`;
}

async function quotesHomeHtml() {
  const data = await api(`/api/quotes?scope=${quotesScope}`);
  const tabs = data.canCreate ? `<div class="tabs q-tabs">${[['builder', 'Quote builder'], ['open', 'Open quotes']].map(([k, l]) =>
    `<button class="tab${quotesTab === k ? ' on' : ''}" data-q-tab="${k}">${l}</button>`).join('')}</div>` : '';
  if (data.canCreate && quotesTab === 'open') return `${tabs}${await quotesOpenHtml()}`;
  const asks = data.requests.length ? `<h2>Waiting for your estimate</h2><ul class="list approvals">${data.requests.map((r) => `<li>
      <span class="title">${esc(r.title)}, ${qDisc(r.discipline)}</span>
      <span class="sub">${esc(r.customer || '')}. Asked by ${esc(r.requested_name || 'someone')}.</span>
      <button class="btn secondary" data-q-answer-open="${r.id}" style="margin-top:.6rem">Give my estimate</button></li>`).join('')}</ul>` : '';
  const scopes = [['open', 'Open'], ['mine', 'Mine'], ['all', 'All']];
  const status = { open: 'Being worked on', ready: 'Ready to send', won: 'Became an order', lost: 'Not going ahead' };
  const shown = data.quotes.filter((q) => teamMatches(quotesTeam, q.team));
  const rows = shown.map((q) => `<li data-q-row><button class="linklike title" data-q-open="${q.id}">${esc(q.title)}</button>
      <span class="sub">${esc(q.customer || q.project_key)}${q.quote_key ? `, ${esc(q.quote_key)}` : ''}. ${status[q.status]}${q.team ? ` · ${esc(q.team)}` : ''}${q.created_name ? `. ${esc(q.created_name)}` : ''}.</span></li>`).join('');
  const teamSeg = `<span class="segment" role="group" aria-label="Promtek team">${[['', 'All teams'], ...QUOTE_TEAMS.map((t) => [t, t])].map(([k, l]) =>
    `<button class="seg${quotesTeam === k ? ' on' : ''}" data-q-team-filter="${k}"${k === 'Projecting' ? ' title="Includes Condor quotes"' : ''}>${l}</button>`).join('')}</span>`;
  return `${tabs}${asks}
    ${data.canCreate ? `<div class="row" style="margin:1rem 0"><button class="btn" data-q-new-open="1">Start a quote</button></div>
      <div class="row jobs-tools q-tools"><span class="segment">${scopes.map(([k, l]) => `<button class="seg${quotesScope === k ? ' on' : ''}" data-q-scope="${k}">${l}</button>`).join('')}</span>
      ${teamSeg}
      <input type="search" id="q-search" placeholder="Search quotes" aria-label="Search quotes"></div>
      ${quotesTeam === 'Projecting' ? '<p class="help" style="margin-top:0">Projecting includes Condor quotes.</p>' : ''}` : ''}
    ${rows ? `<ul class="list q-list">${rows}</ul>` : `<div class="card"><p style="margin:0">${data.canCreate ? (quotesTeam ? `No ${esc(quotesTeam)} quotes here.` : 'No quotes here yet.') : 'When someone asks for your estimate on a quote, it appears here.'}</p></div>`}`;
}

// Every open quote in Jira, wherever it was made, to filter and search.
const ageText = (iso) => {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? 'today' : days === 1 ? 'yesterday' : days < 14 ? `${days} days ago` : days < 60 ? `${Math.floor(days / 7)} weeks ago` : `${Math.floor(days / 30)} months ago`;
};

function quotesOpenList() {
  const d = quotesOpenData;
  const f = quotesOpen;
  const q = f.q.trim().toLowerCase();
  let list = d.quotes.filter((x) => (!f.customer || x.project === f.customer) && teamMatches(f.team, x.team) && (!f.status || x.status === f.status)
    && (!q || `${x.key} ${x.summary} ${x.customer} ${x.assignee || ''} ${x.reporter || ''}`.toLowerCase().includes(q)));
  if (f.sort === 'old') list = [...list].reverse();
  if (f.sort === 'customer') list = [...list].sort((a, b) => a.customer.localeCompare(b.customer) || String(b.created).localeCompare(String(a.created)));
  const customers = new Set(list.map((x) => x.project)).size;
  const filtered = f.customer || f.team || f.status || q;
  return `<p class="muted q-open-count">${n(list.length)} open ${list.length === 1 ? 'quote' : 'quotes'}${customers > 1 ? ` for ${n(customers)} customers` : list.length ? ` for ${esc(list[0].customer)}` : ''}${filtered ? ` <button class="linklike" data-qo-clear>Clear the filters</button>` : ''}</p>
    ${list.length ? `<ul class="list q-open-list">${list.map((x) => `<li>
        <span class="title"><a href="${esc(me.jiraBaseUrl)}/browse/${esc(x.key)}" target="_blank" rel="noopener">${esc(x.key)}</a> ${esc(x.summary)}</span>
        <span class="sub">${esc(x.customer)} · <span class="q-status">${esc(x.status || 'Open')}</span>${x.team ? ` · ${esc(x.team)}` : ' · <span class="muted">No team</span>'}${x.assignee ? ` · ${esc(x.assignee)}` : ''} · opened ${ageText(x.created)}</span>
        ${x.hubId ? `<button class="chip-btn" data-q-open="${x.hubId}" style="margin-top:.4rem">Open in the quote builder</button>` : ''}</li>`).join('')}</ul>`
      : `<div class="card"><p style="margin:0">${filtered ? 'No open quotes match.' : 'No open quotes in Jira.'}</p></div>`}`;
}

async function quotesOpenHtml() {
  if (!quotesOpenData) quotesOpenData = await api(`/api/quotes/open${quotesOpenRefresh ? '?refresh=1' : ''}`);
  quotesOpenRefresh = false;
  const d = quotesOpenData;
  const byCustomer = new Map();
  for (const x of d.quotes) byCustomer.set(x.project, { name: x.customer, n: (byCustomer.get(x.project)?.n || 0) + 1 });
  const customers = [...byCustomer].sort((a, b) => a[1].name.localeCompare(b[1].name));
  const statuses = [...new Set(d.quotes.map((x) => x.status).filter(Boolean))].sort();
  const f = quotesOpen;
  const sel = (key, label, options) => `<label>${label}<select data-qo="${key}">${options.map(([v, l]) => `<option value="${esc(v)}"${f[key] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const moved = d.movedThisWeek?.quotes || 0;
  return `<div class="card q-filters">
      ${sel('customer', 'Customer', [['', `All customers (${n(customers.length)})`], ...customers.map(([k, v]) => [k, `${v.name} (${v.n})`])])}
      ${sel('team', 'Promtek team', [['', 'All teams'], ...QUOTE_TEAMS.map((t) => [t, teamFilterLabel(t)])])}
      ${sel('status', 'Status', [['', 'Any open status'], ...statuses.map((x) => [x, x])])}
      ${sel('sort', 'Order', [['new', 'Newest first'], ['old', 'Oldest first'], ['customer', 'By customer']])}
      <label class="q-filter-search">Search<input type="search" data-qo="q" value="${esc(f.q)}" placeholder="Key, title, customer or person"></label>
    </div>
    <div id="q-open-results">${quotesOpenList()}</div>
    <p class="help">${d.readAt ? `Read from Jira at ${hhmm(new Date(d.readAt).toISOString())}. ` : 'Jira is read every 10 minutes. '}New quotes are moved under their customer's Quote List, and the list shows Active Quotes or No Open Quotes to match.${moved ? ` ${n(moved)} moved this week.` : ''}
      <button class="linklike" data-qo-reload>Read Jira now</button></p>
    ${d.notMoved?.length ? `<div class="card notice"><p style="margin-top:0"><strong>Couldn't be moved under their Quote List</strong></p><ul class="plain">${d.notMoved.map((m) => `<li>${esc(m.issue_key)}: ${esc(m.error || '')}</li>`).join('')}</ul></div>` : ''}`;
}

function qSectionOf(d) { return d === 'answer' ? answerDraft : quoteData?.sections.find((s) => s.discipline === d); }

function qQueueSave(d) {
  if (d === 'answer' || !quoteData?.canEdit) return;
  clearTimeout(quoteTimers[d]);
  quoteTimers[d] = setTimeout(async () => {
    const s = qSectionOf(d);
    try {
      const { help, estimator, ...data } = s;
      const r = await api('/api/quotes/section', { method: 'POST', body: JSON.stringify({ quoteId: quoteData.quote.id, discipline: d, data }) });
      s.help = r.help;
      const host = document.getElementById(`q-help-${d}`);
      if (host) host.innerHTML = qHelpHtml(s);
      const quoted = view.querySelector(`[data-q-field="quoted_hours"][data-q-disc="${d}"]`);
      if (quoted && r.help.suggestedHours) quoted.placeholder = Math.round(r.help.suggestedHours * 10) / 10;
      const out = document.getElementById(`q-result-${d}`);
      if (out) out.textContent = '';
    } catch (err) {
      const out = document.getElementById(`q-result-${d}`);
      if (out) out.textContent = `Not saved: ${err.message}`;
    }
  }, 600);
}

async function quotesClick(event) {
  const t = (sel) => event.target.closest(sel);
  if (t('[data-q-scope]')) { quotesScope = t('[data-q-scope]').dataset.qScope; return render(); }
  if (t('[data-q-new-open]')) { quotesView = { kind: 'new' }; quoteNew = null; return render(); }
  if (t('[data-q-open]')) { quotesView = { kind: 'quote', id: t('[data-q-open]').dataset.qOpen }; window.scrollTo(0, 0); return render(); }
  if (t('[data-q-answer-open]')) { quotesView = { kind: 'answer', id: t('[data-q-answer-open]').dataset.qAnswerOpen }; answerDraft = null; window.scrollTo(0, 0); return render(); }
  if (t('[data-q-back]')) { quotesView = null; quoteData = null; return render(); }
  const cust = t('[data-q-customer]');
  if (cust) {
    quoteNew.projectKey = cust.dataset.qCustomer; quoteNew.customer = cust.dataset.name;
    document.getElementById('q-customer-search').value = cust.dataset.name;
    document.querySelector('.q-customers').hidden = true;
    return true;
  }
  const nd = t('[data-q-new-disc]');
  if (nd) {
    const d = nd.dataset.qNewDisc;
    quoteNew.disciplines = quoteNew.disciplines.includes(d) ? quoteNew.disciplines.filter((x) => x !== d) : [...quoteNew.disciplines, d];
    nd.classList.toggle('on');
    // Until a team is picked, it follows the categories.
    if (!quoteNew.team) view.querySelectorAll('[data-q-new-team]').forEach((b) => b.classList.toggle('on', b.dataset.qNewTeam === suggestTeam(quoteNew.disciplines)));
    return true;
  }
  const nt = t('[data-q-new-team]');
  if (nt) { quoteNew.team = nt.dataset.qNewTeam; view.querySelectorAll('[data-q-new-team]').forEach((b) => b.classList.toggle('on', b === nt)); return true; }
  const qt = t('[data-q-team]');
  if (qt) {
    try {
      const r = await api('/api/quotes/team', { method: 'POST', body: JSON.stringify({ id: quoteData.quote.id, team: qt.dataset.qTeam }) });
      toast(r.jiraUpdated === false ? `Promtek team set to ${qt.dataset.qTeam}. Jira couldn't be updated` : `Promtek team set to ${qt.dataset.qTeam}`);
      return render();
    } catch (err) { toast(err.message); }
    return true;
  }
  if (t('[data-q-tab]')) { quotesTab = t('[data-q-tab]').dataset.qTab; if (quotesTab === 'open') quotesOpenData = null; return render(); }
  if (t('[data-q-team-filter]')) { quotesTeam = t('[data-q-team-filter]').dataset.qTeamFilter; return render(); }
  if (t('[data-qo-clear]')) { quotesOpen = { customer: '', team: '', status: '', q: '', sort: quotesOpen.sort }; return render(); }
  if (t('[data-qo-reload]')) { quotesOpenData = null; quotesOpenRefresh = true; return render(); }
  const create = t('[data-q-create]');
  if (create) {
    create.disabled = true;
    try {
      const r = await api('/api/quotes/create', { method: 'POST', body: JSON.stringify({ ...quoteNew, team: quoteNew.team || suggestTeam(quoteNew.disciplines) }) });
      toast(r.quoteKey ? `Quote ${r.quoteKey} started` : 'Quote started. Jira will catch up');
      quotesView = { kind: 'quote', id: r.id }; quoteNew = null; return render();
    } catch (err) { document.getElementById('q-new-result').textContent = err.message; create.disabled = false; }
    return true;
  }
  const set = t('[data-q-set]');
  if (set) {
    const s = qSectionOf(set.dataset.qDisc); if (!s || set.disabled) return true;
    const key = set.dataset.qSet; const raw = set.dataset.value;
    s[key] = ['tech', 'risk', 'dep'].includes(key) ? Number(raw) : raw;
    set.parentElement.querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b === set));
    qQueueSave(set.dataset.qDisc); return true;
  }
  const chip = t('[data-q-chip]');
  if (chip) {
    const s = qSectionOf(chip.dataset.qDisc); if (!s || chip.disabled) return true;
    const x = chip.dataset.qChip;
    s.chips = (s.chips || []).includes(x) ? s.chips.filter((c) => c !== x) : [...(s.chips || []), x];
    chip.classList.toggle('on'); qQueueSave(chip.dataset.qDisc); return true;
  }
  const ref = t('[data-q-ref]');
  if (ref) {
    const s = qSectionOf(ref.dataset.qDisc);
    s.reference_id = ref.dataset.qRef; s.reference_compare = ref.dataset.value;
    ref.parentElement.parentElement.parentElement.querySelectorAll('[data-q-ref]').forEach((b) => b.classList.toggle('on', b === ref));
    qQueueSave(ref.dataset.qDisc); return true;
  }
  const ask = t('[data-q-ask]');
  if (ask) {
    const d = ask.dataset.qAsk;
    const who = view.querySelector(`[data-q-ask-who="${d}"]`).value;
    if (!who) { document.getElementById(`q-result-${d}`).textContent = 'Choose who to ask.'; return true; }
    ask.disabled = true;
    try {
      await api('/api/quotes/ask', { method: 'POST', body: JSON.stringify({ quoteId: quoteData.quote.id, discipline: d, accountId: who, note: view.querySelector(`[data-q-ask-note="${d}"]`).value }) });
      toast('Asked'); return render();
    } catch (err) { document.getElementById(`q-result-${d}`).textContent = err.message; ask.disabled = false; }
    return true;
  }
  const use = t('[data-q-use]');
  if (use) { try { await api('/api/quotes/use-answer', { method: 'POST', body: JSON.stringify({ requestId: use.dataset.qUse }) }); toast('Figures used'); } catch (err) { toast(err.message); } return render(); }
  const st = t('[data-q-status]');
  if (st) {
    st.disabled = true;
    try {
      const r = await api('/api/quotes/status', { method: 'POST', body: JSON.stringify({ id: quoteData.quote.id, status: st.dataset.qStatus }) });
      if (r.jiraUpdated === false) toast('Saved. The Jira description could not be updated');
      return render();
    } catch (err) { document.getElementById('q-status-result').textContent = err.message; st.disabled = false; }
    return true;
  }
  const descSave = t('[data-q-description-save]');
  if (descSave) {
    descSave.disabled = true;
    const out = document.getElementById('q-description-result');
    try {
      const r = await api('/api/quotes/description', { method: 'POST', body: JSON.stringify({ id: quoteData.quote.id, description: view.querySelector('[data-q-description]').value }) });
      out.textContent = r.jiraUpdated === false ? 'Saved here. Jira couldn\'t be reached, so it will be updated shortly.' : r.jiraUpdated ? 'Saved, and updated in Jira.' : 'Saved. It goes to Jira when the quote has a Jira key.';
    } catch (err) { out.textContent = err.message; }
    descSave.disabled = false;
    return true;
  }
  const retry = t('[data-q-retry]');
  if (retry) { await api('/api/quotes/retry-jira', { method: 'POST', body: JSON.stringify({ id: retry.dataset.qRetry }) }).catch(() => {}); return render(); }
  const send = t('[data-q-answer]');
  if (send) {
    send.disabled = true;
    try {
      const r = await api('/api/quotes/answer', { method: 'POST', body: JSON.stringify({ requestId: answerDraft.requestId, data: answerDraft, comment: answerDraft.comment }) });
      toast(r.commented ? 'Sent, and noted on the Jira quote' : 'Sent'); quotesView = null; answerDraft = null; return render();
    } catch (err) { document.getElementById('q-answer-result').textContent = err.message; send.disabled = false; }
    return true;
  }
  return false;
}

function quotesInput(event) {
  const el = event.target;
  if (el.dataset.qo != null && quotesOpenData) {
    quotesOpen[el.dataset.qo] = el.value;
    // Only the results redraw, so typing in the search box keeps its place.
    const host = document.getElementById('q-open-results');
    if (host) host.innerHTML = quotesOpenList();
    return true;
  }
  if (el.dataset.qNew && quoteNew) { quoteNew[el.dataset.qNew] = el.value; return true; }
  if (el.id === 'q-customer-search') {
    const query = el.value.toLowerCase(); const list = document.querySelector('.q-customers');
    if (list) list.hidden = false;
    if (quoteNew) quoteNew.projectKey = '';
    document.querySelectorAll('[data-q-customer-row]').forEach((row) => { row.hidden = query.length > 0 && !row.textContent.toLowerCase().includes(query); });
    return true;
  }
  if (el.id === 'q-search') {
    const query = el.value.toLowerCase();
    document.querySelectorAll('[data-q-row]').forEach((row) => { row.hidden = query.length > 1 && !row.textContent.toLowerCase().includes(query); });
    return true;
  }
  if (el.dataset.qAnswerComment && answerDraft) { answerDraft.comment = el.value; return true; }
  const d = el.dataset.qDisc;
  const s = d && qSectionOf(d);
  if (!s) return false;
  if (el.dataset.qCount) { s.counts = { ...(s.counts || {}), [el.dataset.qCount]: el.value === '' ? '' : Number(el.value) }; }
  else if (el.dataset.qField) { s[el.dataset.qField] = el.value === '' ? null : Number(el.value); }
  else return false;
  qQueueSave(d); return true;
}

function countChecksHtml(list) {
  if (!list?.length) return '';
  return `<h2>Were the counts right?</h2><ul class="list approvals">${list.map((k) => `<li data-count-check="${esc(k.category_id)}">
      <span class="title"><a href="${esc(me.jiraBaseUrl)}/browse/${esc(k.category_key)}" target="_blank" rel="noopener">${esc(k.category_key)}</a> ${qDisc(k.discipline)}, ${esc(k.customer || '')}</span>
      <span class="sub">Finished. If the job turned out bigger or smaller than quoted, correct the counts so future quotes learn from it.</span>
      <div class="q-counts" style="margin-top:.5rem">${Object.entries(k.quoted).map(([key, v]) => `<label class="q-count">${esc(k.labels[key] || key)}
        <input type="number" min="0" step="1" data-count-key="${esc(key)}" value="${esc(v)}"></label>`).join('')}</div>
      <div class="row" style="margin-top:.6rem"><button class="btn" data-count-save="${esc(k.category_id)}">Save</button>
        <button class="btn secondary" data-count-skip="${esc(k.category_id)}">Skip</button></div></li>`).join('')}</ul>`;
}

// ---------- Your day, from Bitbucket ----------

let dayDrafts = null;
const quarterHours = (s) => Math.round((s / 3600) * 4) / 4;
const hoursLabel = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };

function dayLabel(day) {
  const today = todayIso();
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  return longDate(day);
}

function dayCardHtml(d) {
  const total = d.drafts.reduce((a, x) => a + x.seconds, 0);
  const rows = d.drafts.map((x, i) => `<li data-draft="${i}">
      <span class="title"><a href="${esc(me.jiraBaseUrl)}/browse/${esc(x.key)}" target="_blank" rel="noopener">${esc(x.key)}</a> ${esc(x.summary)}</span>
      <span class="draft-fields">
        <label>From <input type="time" data-draft-start value="${esc(x.start)}"></label>
        <label>Hours <input type="number" min="0.25" max="12" step="0.25" inputmode="decimal" data-draft-hours value="${quarterHours(x.seconds)}"></label>
        <button class="linklike" data-draft-dismiss>Not work time</button>
      </span>
      ${x.alreadyLogged ? `<span class="sub">${hoursLabel(quarterHours(x.alreadyLogged))} already logged on this ticket that day is left off.</span>` : ''}
    </li>`).join('');
  return `<div class="card day-card" data-day="${esc(d.day)}">
      <p class="day-head"><strong>${esc(dayLabel(d.day))}, from your Bitbucket activity</strong>
        <span class="muted">${d.drafts.length} ${d.drafts.length === 1 ? 'ticket' : 'tickets'}, about ${hoursLabel(quarterHours(total))}</span></p>
      <ul class="list plain">${rows}</ul>
      <div class="row"><button class="btn" data-day-log>Log ${hoursLabel(quarterHours(total))} to Tempo</button></div>
      <div class="result" role="status"></div></div>`;
}

async function loadDayDrafts() {
  const host = document.getElementById('day-drafts');
  if (!host || !me.linked) return;
  try {
    dayDrafts = await api('/api/devtime/drafts');
    host.innerHTML = dayDrafts.days.length
      ? `<h2>Waiting to be logged</h2>${dayDrafts.days.map(dayCardHtml).join('')}`
      : `<h2>Waiting to be logged</h2><div class="card"><p style="margin:0">Nothing waiting. Work pushed to MES branches in Bitbucket appears here as draft time, ready to check and log in one go.</p></div>`;
  } catch (err) { host.innerHTML = `<div class="card"><p class="bad" style="margin:0">${esc(err.message)}</p></div>`; }
}

function readDayCard(card) {
  const d = dayDrafts.days.find((x) => x.day === card.dataset.day);
  card.querySelectorAll('[data-draft]').forEach((row) => {
    const x = d.drafts[Number(row.dataset.draft)];
    x.start = row.querySelector('[data-draft-start]').value || x.start;
    const h = Number(row.querySelector('[data-draft-hours]').value);
    if (h > 0) x.seconds = Math.round(h * 4) * 900;
  });
  return d;
}

async function dayClick(event) {
  const card = event.target.closest('.day-card');
  if (!card || !dayDrafts) return false;
  const out = card.querySelector('.result');
  const dismiss = event.target.closest('[data-draft-dismiss]');
  if (dismiss) {
    const d = readDayCard(card);
    const x = d.drafts[Number(dismiss.closest('[data-draft]').dataset.draft)];
    try { await api('/api/devtime/dismiss', { method: 'POST', body: JSON.stringify({ day: d.day, key: x.key }) }); }
    catch (err) { out.textContent = err.message; return true; }
    await loadDayDrafts(); return true;
  }
  const log = event.target.closest('[data-day-log]');
  if (log) {
    const d = readDayCard(card);
    log.disabled = true; log.innerHTML = '<span class="spinner" aria-hidden="true"></span> Logging';
    try {
      const r = await api('/api/devtime/log', { method: 'POST', body: JSON.stringify({ day: d.day, items: d.drafts }) });
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) {
        await loadDayDrafts();
        const again = document.querySelector(`.day-card[data-day="${CSS.escape(d.day)}"] .result`);
        if (again) again.textContent = `${r.logged ? `${r.logged} logged. ` : ''}Tempo didn't take ${failed.map((x) => x.key).join(', ')}: ${failed[0].error}`;
      } else {
        toast(`${dayLabel(d.day)} logged`);
        await loadDayDrafts();
      }
    } catch (err) { out.textContent = err.message; log.disabled = false; log.textContent = 'Try again'; }
    return true;
  }
  return false;
}

function bitbucketAdminHtml(b) {
  const when = (iso) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const last = b.last
    ? `${when(b.last.at)}. ${n(b.last.repos || 0)} ${b.last.repos === 1 ? 'repository' : 'repositories'} with new work, ${n(b.last.added || 0)} new pieces of activity.${b.last.waiting ? ` Part-way through: ${n(b.last.waiting)} ${b.last.waiting === 1 ? 'piece' : 'pieces'} left, carried on every few minutes.` : ''}`
    : 'Not yet';
  return `<h2>Bitbucket</h2>
    <div class="card"><dl class="state">
        <dt>Workspace</dt><dd>${b.workspace ? esc(b.workspace) : '<span class="bad">Not set. Add BITBUCKET_WORKSPACE to the vars in wrangler.jsonc.</span>'}</dd>
        <dt>Token</dt><dd>${b.configured || b.workspace ? (b.configured ? 'Set' : '<span class="bad">Not set. Add BITBUCKET_API_TOKEN as a secret on the Worker.</span>') : 'Not set'}</dd>
        <dt>Last check</dt><dd>${last}</dd>
        ${b.last?.error ? `<dt>Problem</dt><dd class="bad">${esc(b.last.error)}</dd>` : ''}
        <dt>Last 7 days</dt><dd>${n(b.week?.n || 0)} pieces of activity from ${n(b.week?.people || 0)} ${b.week?.people === 1 ? 'person' : 'people'}</dd>
      </dl>
      <p class="muted">Repositories with new work are checked about every 15 minutes, a few at a time so each run stays inside Cloudflare's limits. Commits on MES branches, and pull request reviews, approvals and comments, become draft worklogs that developers check and log in one go from Condor Dev.</p>
      <div class="row"><button class="btn secondary" data-bb="test">Test connection</button><button class="btn secondary" data-bb="poll">Check now</button></div>
      <div class="result" id="bb-result" role="status"></div></div>`;
}

// ---------- Condor Dev: estimating, triage and ratings ----------

let condorTab = 'day';
let mesFilter = 'unestimated';
let mesEst = null;          // the estimate in progress
let mesTriage = { versionId: null, mode: null, skipped: [], notes: {}, assignee: {}, changeWho: [] };
const freshTriage = (versionId, mode = null) => ({ versionId, mode, skipped: [], notes: {}, assignee: {}, changeWho: [] });
let mesRatingFor = null;

function condorTabs() {
  const tabs = [['day', 'My day'], ['estimate', 'Estimate'], ...(me.user.can?.condorPlan ? [['triage', 'Triage']] : []), ['plan', 'Plan'], ['notes', 'Release notes'], ['ratings', 'Ratings']];
  return `<div class="tabs condor-tabs">${tabs.map(([k, l]) => `<button class="tab${condorTab === k ? ' on' : ''}" data-condor-tab="${k}">${l}</button>`).join('')}</div>`;
}

const mesMeta = (t) => [t.type, t.module].filter(Boolean).map(esc).join(', ');
const mesLink = (key) => `<a href="${esc(me.jiraBaseUrl)}/browse/${esc(key)}" target="_blank" rel="noopener">${esc(key)}</a>`;

function mesReadingHtml(data) {
  if (!data.catchingUp) return '';
  return `<div class="card notice"><p style="margin:0"><span class="spinner" aria-hidden="true"></span> MES is still being read from Jira${data.readUpTo ? `, up to tickets last changed on ${shortDate(data.readUpTo)} ${data.readUpTo.slice(0, 4)}` : ''}. ${n(data.known)} ${data.known === 1 ? 'ticket' : 'tickets'} so far; the rest arrive over the next hour or so.</p></div>`;
}

async function mesListHtml() {
  const data = await api(`/api/mes/outstanding?filter=${mesFilter}`);
  const rows = data.tickets.map((t) => `<li data-mes-row>
      <span class="title">${mesLink(t.issue_key)} ${esc(t.summary)}</span>
      <span class="sub">${mesMeta(t)}. ${t.hours != null ? `${t.timebox ? 'Time-boxed at' : 'Estimated'} ${hoursLabel(t.hours)}, difficulty ${n(t.difficulty)}` : 'No estimate yet'}${t.priority ? `. ${esc(t.priority === 'Not this time' ? 'Not this time' : `${t.priority} for ${t.version_name}`)}` : ''}.</span>
      ${data.canEstimate ? `<button class="chip-btn" data-mes-estimate="${esc(t.issue_id)}" style="margin-top:.4rem">${t.hours != null ? 'Re-estimate' : 'Estimate'}</button>` : ''}</li>`).join('');
  return `<div class="row jobs-tools"><span class="segment">${[['unestimated', 'Needs an estimate'], ['all', 'All open']].map(([k, l]) =>
      `<button class="seg${mesFilter === k ? ' on' : ''}" data-mes-filter="${k}">${l}</button>`).join('')}</span>
      <input type="search" id="mes-search" placeholder="Search MES" aria-label="Search MES"></div>
    <p class="help">Estimates come from comparing each ticket with finished ones of the same kind: a few smaller, same or bigger questions.</p>
    ${mesReadingHtml(data)}
    ${rows ? `<ul class="list mes-list">${rows}</ul>${data.total > data.tickets.length ? `<p class="muted">Showing ${data.tickets.length} of ${data.total}. Search to narrow it down.</p>` : ''}`
      : data.catchingUp && !data.known ? '' : `<div class="card"><p style="margin:0">${mesFilter === 'unestimated' ? 'Every open ticket has an estimate.' : 'No open tickets.'}</p></div>`}`;
}

async function mesEstimateHtml() {
  const e = mesEst;
  // Only needed when estimating, so a problem here never stops My day loading.
  if (!me._mesTags) {
    const d = await api('/api/mes/outstanding?filter=none').catch(() => null);
    if (d) { me._mesTags = d.tags; me._mesHints = d.hints; }
  }
  const q = await api('/api/mes/question', { method: 'POST', body: JSON.stringify({ issueId: e.issueId, answers: e.answers }) });
  e.ticket = q.ticket;
  const isBug = q.ticket.type === 'Bug';
  let step;
  if (e.method === 'timebox') {
    step = `<h3>Time to find the cause</h3>
      <label>Hours to spend investigating<input type="number" min="0.5" max="40" step="0.5" data-mes-field="timeboxHours" value="${esc(e.timeboxHours)}"></label>
      <p class="help">Once the cause is known, re-estimate the fix itself. Time-boxed tickets don't count towards anyone's rating.</p>`;
  } else if (e.method === 'three-point' || (!q.poolSize && !e.answers.length)) {
    e.method = 'three-point';
    step = `<p class="help">There aren't finished tickets with time on them to compare with yet, so give your own hours. Comparisons take over as tickets are finished and logged.</p>
      <div class="q-hours">${[['best', 'Best case'], ['likely', 'Likely'], ['worst', 'Worst case']].map(([k, l]) =>
        `<label>${l}<input type="number" min="0" step="0.5" data-mes-field="${k}" value="${esc(e[k] ?? '')}"></label>`).join('')}</div>`;
  } else if (q.next) {
    e.method = 'compare';
    step = `<p class="muted" style="margin-top:0">Question ${q.asked + 1} of up to ${q.maxQuestions}</p>
      <div class="mes-compare">
        <p>Compared with ${mesLink(q.next.key)} <strong>${esc(q.next.summary)}</strong>,<br><span class="muted">${mesMeta(q.next)}, ${q.next.done === false ? `which has had ${hoursLabel(Math.round(q.next.hours * 4) / 4)} logged so far` : `which took ${hoursLabel(Math.round(q.next.hours * 4) / 4)}`}</span></p>
        <p style="margin-bottom:.5rem"><strong>is ${esc(q.ticket.issue_key)}</strong></p>
        <div class="row mes-answers">${[['smaller', 'Smaller'], ['same', 'About the same'], ['bigger', 'Bigger']].map(([k, l]) =>
          `<button class="btn${k === 'same' ? '' : ' secondary'}" data-mes-answer="${k}" data-ref="${esc(q.next.id)}">${l}</button>`).join('')}</div></div>`;
  } else {
    e.result = q.estimate;
    step = `<div class="q-suggest"><div class="q-figures"><div><span>Estimate</span><strong>${hoursLabel(q.estimate.hours)}</strong></div>
        <div><span>Likely range</span><strong style="font-size:1.15rem">${hoursLabel(q.estimate.low)} to ${hoursLabel(q.estimate.high)}</strong></div></div></div>
      <button class="linklike" data-mes-restart="1" style="margin-top:.5rem">Answer again</button>`;
  }
  const ready = e.method === 'timebox' || e.method === 'three-point' || Boolean(q.estimate);
  const alt = [];
  if (isBug && e.method !== 'timebox') alt.push('<button class="linklike" data-mes-method="timebox">Cause not known yet: time-box the investigation</button>');
  if (e.method !== 'three-point' && q.poolSize) alt.push('<button class="linklike" data-mes-method="three-point">Give hours instead</button>');
  if (e.method !== 'compare' && q.poolSize) alt.push('<button class="linklike" data-mes-method="compare">Compare with finished tickets</button>');
  const hint = me._mesHints?.[e.difficulty] || '';
  if (e.embedded) {
    // Inside the triage card: the same questions, without leaving the ticket.
    return `<div class="tri-est">${step}
      ${alt.length ? `<p class="mes-alt">${alt.join(' · ')}</p>` : ''}
      ${ready ? `<p class="tri-label">How hard is it to do well?</p>
        <div class="segment">${[1, 2, 3, 4, 5].map((v) => `<button class="seg${Number(e.difficulty) === v ? ' on' : ''}" data-mes-difficulty="${v}">${v}</button>`).join('')}</div>
        <p class="help" id="mes-hint">${esc(hint)}</p>
        <div class="chips">${(me._mesTags || []).map((t) => `<button class="chip${e.tags.includes(t) ? ' on' : ''}" data-mes-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <div class="row" style="margin-top:.75rem"><button class="btn" data-mes-save="1">Save the estimate</button>
          ${e.hadEstimate ? '<button class="linklike" data-mes-back="1">Keep the current estimate</button>' : ''}</div>`
        : e.hadEstimate ? '<p style="margin-bottom:0"><button class="linklike" data-mes-back="1">Keep the current estimate</button></p>' : ''}
      <div class="result" id="mes-result" role="status"></div></div>`;
  }
  return `<div class="card">
      <p style="margin-top:0"><strong>${mesLink(q.ticket.issue_key)} ${esc(q.ticket.summary)}</strong><br><span class="muted">${mesMeta(q.ticket)}</span></p>
      ${step}
      ${alt.length ? `<p class="mes-alt">${alt.join(' · ')}</p>` : ''}
      ${ready ? `<h3>How hard is it to do well?</h3>
        <div class="segment">${[1, 2, 3, 4, 5].map((v) => `<button class="seg${Number(e.difficulty) === v ? ' on' : ''}" data-mes-difficulty="${v}">${v}</button>`).join('')}</div>
        <p class="help" id="mes-hint">${esc(hint)}</p>
        <div class="chips">${(me._mesTags || []).map((t) => `<button class="chip${e.tags.includes(t) ? ' on' : ''}" data-mes-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <div class="row" style="margin-top:1rem"><button class="btn" data-mes-save="1">Save the estimate</button></div>` : ''}
      <div class="row" style="margin-top:.75rem"><button class="btn secondary" data-mes-back="1">Back</button></div>
      <div class="result" id="mes-result" role="status"></div></div>`;
}

let mesNewRelease = null;
const NOTE_KINDS = [['none', 'Not included'], ['sentence', 'Single sentence'], ['paragraph', 'Paragraph'], ['photo', 'Paragraph with photo']];
const noteKindLabel = (k) => NOTE_KINDS.find(([id]) => id === k)?.[1] || 'Not chosen';

function newReleaseHtml(versions) {
  mesNewRelease = mesNewRelease || { name: '', startDate: todayIso(), releaseDate: '' };
  return `<div class="card"><h2 style="margin-top:0">Start a new release</h2>
      <label>Name<input type="text" data-new-release="name" value="${esc(mesNewRelease.name)}" placeholder="For example Gobi"></label>
      <div class="row" style="margin-top:.75rem">
        <label>Starts<input type="date" data-new-release="startDate" value="${esc(mesNewRelease.startDate)}"></label>
        <label>Released<input type="date" data-new-release="releaseDate" value="${esc(mesNewRelease.releaseDate)}"></label></div>
      <p class="help">The release is made in Jira as a version of MES. Triage then decides what goes in it, and its board and three sprints are made from that.</p>
      <div class="row"><button class="btn" data-release-create>Start the release</button>${versions.length ? '<button class="btn secondary" data-release-cancel>Cancel</button>' : ''}</div>
      <div class="result" id="mes-result" role="status"></div></div>`;
}

// The three things to settle before deciding: how long, who, and the release notes.
async function triageTicketHtml(t, data, { mid, version, next, progress }) {
  const id = t.issue_id;
  let estimate;
  const estimating = mesEst?.embedded && mesEst.issueId === id;
  if (t.hours == null && !estimating && data.canEstimate) {
    mesEst = { issueId: id, answers: [], tags: [], difficulty: null, timeboxHours: 4, from: 'triage', embedded: true };
  }
  if (mesEst?.embedded && mesEst.issueId === id) estimate = await mesEstimateHtml();
  else if (t.hours != null) {
    estimate = `<p class="tri-done">${t.timebox ? 'Time-boxed at' : 'Estimated at'} <strong>${hoursLabel(t.hours)}</strong>${t.difficulty ? `, difficulty ${n(t.difficulty)}` : ''}
      <button class="linklike" data-tri-estimate="${esc(id)}">Re-estimate</button></p>`;
  } else {
    estimate = `<p class="tri-done muted">No estimate. <button class="linklike" data-tri-estimate="${esc(id)}">Estimate it</button></p>`;
  }
  const chosen = mesTriage.assignee[id];
  const who = t.assignee_id && !mesTriage.changeWho.includes(id)
    ? `<p class="tri-done"><strong>${esc(t.assignee_name || 'Someone outside the hub')}</strong> <button class="linklike" data-tri-who="${esc(id)}">Change</button></p>`
    : `<select data-tri-assignee="${esc(id)}" aria-label="Who will do it"><option value="">Choose someone</option>${data.team.map((p) =>
        `<option value="${esc(p.id)}"${(chosen || t.assignee_id) === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      ${t.assignee_id ? '' : '<small class="tri-need">Nobody is assigned in Jira</small>'}`;
  // Not included unless someone says otherwise.
  const kind = mesTriage.notes[id] || t.notes_kind || 'none';
  const notes = `<select data-tri-notes="${esc(id)}" aria-label="In the release notes">${NOTE_KINDS.map(([k, l]) =>
      `<option value="${k}"${kind === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const moveLabel = mid ? (next ? `Move to ${esc(next.name)}` : 'Take it out') : 'Not this time';
  return `<div class="triage-ticket" data-tri-ticket="${esc(id)}">
      <div class="tri-head">
        <p class="tri-title">${mesLink(t.issue_key)} ${esc(t.summary)}</p>
        <p class="muted tri-meta">${mesMeta(t) || 'No module'}${mid && t.status ? ` · <span class="tri-status">${esc(t.status)}</span>` : ''}</p>
        <p class="tri-progress">${progress}</p>
      </div>
      <ol class="tri-steps">
        <li><span class="tri-label">How long</span>${estimate}</li>
        <li><span class="tri-label">Who's doing it</span>${who}</li>
        <li><span class="tri-label">Release notes</span>${notes}</li>
      </ol>
      <div class="row triage-actions">${data.priorities.map((p) => `<button class="btn" data-mes-triage="${p}" data-issue="${esc(id)}">${p}</button>`).join('')}
        <button class="btn secondary" data-mes-triage="none" data-issue="${esc(id)}">${moveLabel}</button>
        <button class="btn secondary" data-mes-skip="${esc(id)}">Skip for now</button></div>
      <p class="help">${mid
        ? `Must, Should and Could keep it in ${esc(version.name)}. ${next ? `${moveLabel} puts it in ${esc(next.name)} for that release's triage.` : 'There is no later release in Jira yet, so taking it out leaves it without one.'}`
        : `Must, Should and Could put it in ${esc(version.name)} and set its Fix Version in Jira. Not this time leaves it for the next release's triage.`} Keeping a ticket needs all three steps, so the plan knows how long it takes and who it's for.</p>
      <div class="result" id="tri-result" role="status"></div></div>`;
}

async function mesTriageHtml() {
  const first = await api('/api/mes/outstanding?filter=none');
  const versions = first.versions;
  if (mesNewRelease || !versions.length) return newReleaseHtml(versions);
  if (!mesTriage.versionId || !versions.some((v) => v.id === mesTriage.versionId)) mesTriage.versionId = versions[0].id;
  const version = versions.find((v) => v.id === mesTriage.versionId);
  const started = version.startDate && version.startDate <= todayIso();
  if (!mesTriage.mode) mesTriage.mode = started ? 'mid' : 'new';
  const mid = mesTriage.mode === 'mid';
  const top = `<div class="card tri-top">
      <label>Release<select data-mes-version>${versions.map((v) => `<option value="${esc(v.id)}"${v.id === version.id ? ' selected' : ''}>${esc(v.name)}${v.releaseDate ? `, due ${shortDate(v.releaseDate)}` : ''}</option>`).join('')}
        <option value="new">Start a new release</option></select></label>
      <span class="segment" role="group" aria-label="What to triage">${[['new', 'New tickets'], ['mid', 'Mid-release review']].map(([k, l]) =>
        `<button class="seg${mesTriage.mode === k ? ' on' : ''}" data-tri-mode="${k}" aria-pressed="${mesTriage.mode === k}">${l}</button>`).join('')}</span>
      <p class="help" style="margin:0">${mid
        ? `What's left of ${esc(version.name)}, one ticket at a time, furthest along first, to reassess what still fits before ${version.releaseDate ? shortDate(version.releaseDate) : 'the release'}.`
        : `Open tickets not yet decided for ${esc(version.name)}.`}</p></div>`;

  if (mid) {
    const data = await api(`/api/mes/mid-release?versionId=${encodeURIComponent(version.id)}`);
    const queue = data.tickets.filter((t) => !t.reviewed && !mesTriage.skipped.includes(t.issue_id));
    const t = queue[0];
    if (!data.total) return `${top}<div class="card"><p style="margin:0">Nothing unfinished is in ${esc(version.name)}.</p></div>`;
    if (!t) {
      return `${top}<div class="card"><p style="margin-top:0"><strong>Review done.</strong> All ${n(data.total)} unfinished ${data.total === 1 ? 'ticket' : 'tickets'} in ${esc(version.name)} have been looked at${mesTriage.skipped.length ? `, apart from ${n(mesTriage.skipped.length)} skipped. <button class="linklike" data-mes-unskip="1">Go back to them</button>` : '.'}</p>
        <div class="row"><button class="btn" data-condor-tab="plan">See what fits in the plan</button><button class="btn secondary" data-tri-restart>Start the review again</button></div></div>`;
    }
    const sameStatus = queue.filter((x) => x.status === t.status).length;
    const progress = `${esc(t.status || 'Not started')}: ${n(sameStatus)} left · ${n(data.reviewed)} of ${n(data.total)} reviewed`;
    return `${top}<div class="card">${await triageTicketHtml(t, data, { mid: true, version, next: data.next, progress })}</div>`;
  }

  const data = await api(`/api/mes/outstanding?filter=untriaged&release=${encodeURIComponent(version.id)}`);
  const queue = data.tickets.filter((t) => !mesTriage.skipped.includes(t.issue_id));
  const t = queue[0];
  const sprints = data.release?.sprints || [];
  const sprintCard = `<div class="card" style="margin-top:1rem">
      ${sprints.length
        ? `<p style="margin-top:0"><strong>${esc(version.name)}</strong> has ${sprints.length} ${sprints.length === 1 ? 'sprint' : 'sprints'}: ${sprints.map((s) => `${esc(s.name)} (${s.start ? `${shortDate(s.start)} to ${shortDate(s.end)}` : 'no dates'}${s.state === 'active' ? ', running' : s.state === 'closed' ? ', finished' : ''})`).join('; ')}.</p>
          <p class="help">Placing the tickets again puts each one in the sprint its plan starts in. Tickets in a sprint that has started stay where they are.</p>`
        : `<p style="margin-top:0">${n(data.inRelease)} ${data.inRelease === 1 ? 'ticket is' : 'tickets are'} in ${esc(version.name)}. When triage is done, make its board and sprints in Jira and place the tickets in them.</p>`}
      <button class="btn${t ? ' secondary' : ''}" data-make-sprints>${sprints.length ? 'Place the tickets in the sprints' : `Make the sprints for ${esc(version.name)}`}</button>
      <div class="result" id="sprint-result" role="status"></div></div>`;
  if (!t && data.catchingUp) return `${top}${mesReadingHtml(data)}<div class="card"><p style="margin:0">Tickets to triage appear here as MES is read.</p></div>${sprintCard}`;
  if (!t) return `${top}<div class="card"><p style="margin:0">Everything open has been triaged for ${esc(version.name)}.${mesTriage.skipped.length ? ` ${mesTriage.skipped.length} skipped for now. <button class="linklike" data-mes-unskip="1">Go back to them</button>` : ''}</p></div>${sprintCard}`;
  const progress = `${n(queue.length)} left to triage${data.catchingUp ? ' so far' : ''} · ${n(data.inRelease)} in ${esc(version.name)}`;
  return `${top}${mesReadingHtml(data)}<div class="card">${await triageTicketHtml(t, data, { mid: false, version, progress })}</div>${sprintCard}`;
}

async function mesRatingsHtml() {
  const isLead = Boolean(me.user.can?.condorPlan);
  const team = isLead ? (await api('/api/mes/team')).team : [];
  const teamHtml = team.length ? `<h2>The team</h2><ul class="list">${team.map((p) => `<li><button class="linklike title" data-mes-rating="${esc(p.account_id)}">${esc(p.name)}</button>
      <span class="xp">${n(Math.round(p.condor_elo))}<small>${n(p.jobs)} ${p.jobs === 1 ? 'ticket' : 'tickets'}</small></span></li>`).join('')}</ul>` : '';
  const who = mesRatingFor || null;
  const data = await api(`/api/mes/rating${who ? `?accountId=${encodeURIComponent(who)}` : ''}`);
  if (!data) return teamHtml || '<div class="card"><p style="margin:0">Your account isn\'t linked to a profile yet.</p></div>';
  const width = Math.min(view.clientWidth || 640, 1000) - 40;
  return `<h2>${who ? `${esc(data.name)}'s` : 'Your'} Condor rating</h2>
    <div class="card"><p style="margin:0"><strong style="font-size:1.6rem">${n(Math.round(data.elo))}</strong> <span class="muted">Condor development, kept separate from customer ELO</span></p></div>
    <div style="margin-top:1rem">${eloHistoryHtml({ ...data, rank: null }, { self: !who, width })}</div>
    ${who ? '<div class="row" style="margin-top:1rem"><button class="btn secondary" data-mes-rating="">Back to yours</button></div>' : ''}
    ${teamHtml}`;
}

async function condorHtml() {
  if (!me.linked) return notLinkedCard();
  const asked = location.hash.split('?')[1];
  if (asked && ['day', 'estimate', 'triage', 'plan', 'notes', 'ratings'].includes(asked)) {
    condorTab = asked; mesEst = null;
    if (asked === 'notes') { rn.stale = true; rn.view = 'write'; rn.mine = true; }
    history.replaceState(null, '', '#/condor');
  }
  let body;
  if (mesEst && !mesEst.embedded) body = await mesEstimateHtml();
  else if (condorTab === 'estimate') body = await mesListHtml();
  else if (condorTab === 'triage') body = await mesTriageHtml();
  else if (condorTab === 'ratings') body = await mesRatingsHtml();
  else if (condorTab === 'plan') body = await mesPlanHtml();
  else if (condorTab === 'notes') body = await rnHtml();
  else body = `<div id="day-drafts">${sectionLoading('Loading your days')}</div>`;
  return `${mesEst && !mesEst.embedded ? '' : condorTabs()}${body}`;
}

async function condorClick(event) {
  const t = (sel) => event.target.closest(sel);
  if (condorTab === 'plan' && !mesEst && await planClick(event) !== false) return true;
  if (condorTab === 'notes' && !mesEst && await rnClick(event) !== false) return true;
  if (t('[data-condor-tab]')) {
    condorTab = t('[data-condor-tab]').dataset.condorTab; mesRatingFor = null;
    if (mesEst?.embedded) mesEst = null;
    if (condorTab === 'notes') rn.stale = true;
    return render();
  }
  if (t('[data-mes-filter]')) { mesFilter = t('[data-mes-filter]').dataset.mesFilter; return render(); }
  const est = t('[data-mes-estimate]');
  if (est) { mesEst = { issueId: est.dataset.mesEstimate, answers: [], tags: [], difficulty: null, timeboxHours: 4, from: est.dataset.from || null }; window.scrollTo(0, 0); return render(); }
  if (t('[data-mes-back]')) {
    mesEst = null; return render();
  }
  if (!mesEst && t('[data-mes-rating]')) { mesRatingFor = t('[data-mes-rating]').dataset.mesRating || null; return render(); }
  if (mesEst) {
    const ans = t('[data-mes-answer]');
    if (ans) { mesEst.answers.push({ refId: ans.dataset.ref, answer: ans.dataset.mesAnswer }); return render(); }
    if (t('[data-mes-restart]')) { mesEst.answers = []; mesEst.method = 'compare'; return render(); }
    const m = t('[data-mes-method]');
    if (m) { mesEst.method = m.dataset.mesMethod; mesEst.answers = []; return render(); }
    const d = t('[data-mes-difficulty]');
    if (d) {
      mesEst.difficulty = Number(d.dataset.mesDifficulty);
      d.parentElement.querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b === d));
      document.getElementById('mes-hint').textContent = me._mesHints?.[mesEst.difficulty] || '';
      return true;
    }
    const tag = t('[data-mes-tag]');
    if (tag) { const x = tag.dataset.mesTag; mesEst.tags = mesEst.tags.includes(x) ? mesEst.tags.filter((y) => y !== x) : [...mesEst.tags, x]; tag.classList.toggle('on'); return true; }
    const save = t('[data-mes-save]');
    if (save) {
      save.disabled = true;
      try {
        const r = await api('/api/mes/estimate', { method: 'POST', body: JSON.stringify({ issueId: mesEst.issueId, method: mesEst.method, answers: mesEst.answers,
          difficulty: mesEst.difficulty, tags: mesEst.tags, timeboxHours: mesEst.timeboxHours, best: mesEst.best, likely: mesEst.likely, worst: mesEst.worst }) });
        toast(r.jiraSynced ? `Estimated at ${hoursLabel(r.hours)}` : `Estimated at ${hoursLabel(r.hours)}. Jira will catch up`);
        if (mesEst.from === 'triage') condorTab = 'triage';
        if (mesEst.from === 'plan') condorTab = 'plan';
        mesEst = null; return render();
      } catch (err) { document.getElementById('mes-result').textContent = err.message; save.disabled = false; }
      return true;
    }
  }
  const mode = t('[data-tri-mode]');
  if (mode) { mesTriage = freshTriage(mesTriage.versionId, mode.dataset.triMode); if (mesEst?.embedded) mesEst = null; return render(); }
  const reEst = t('[data-tri-estimate]');
  if (reEst) {
    mesEst = { issueId: reEst.dataset.triEstimate, answers: [], tags: [], difficulty: null, timeboxHours: 4, from: 'triage', embedded: true, hadEstimate: true };
    return render();
  }
  const whoBtn = t('[data-tri-who]');
  if (whoBtn) { mesTriage.changeWho.push(whoBtn.dataset.triWho); return render(); }
  if (t('[data-tri-restart]')) {
    try { await api('/api/mes/mid-release/restart', { method: 'POST', body: JSON.stringify({ versionId: mesTriage.versionId }) }); } catch (err) { toast(err.message); }
    mesTriage = freshTriage(mesTriage.versionId, 'mid'); return render();
  }
  const tri = t('[data-mes-triage]');
  if (tri) {
    tri.disabled = true;
    try {
      const id = tri.dataset.issue;
      const card = tri.closest('[data-tri-ticket]');
      const assigneeId = card?.querySelector('[data-tri-assignee]')?.value || null;
      const notes = card?.querySelector('[data-tri-notes]')?.value || undefined;
      const r = await api('/api/mes/triage', { method: 'POST', body: JSON.stringify({ issueId: id, priority: tri.dataset.mesTriage,
        versionId: tri.dataset.mesTriage === 'none' ? null : mesTriage.versionId, releaseId: mesTriage.versionId, mode: mesTriage.mode,
        ...(assigneeId ? { assigneeId } : {}), ...(notes ? { notes } : {}) }) });
      if (mesEst?.embedded) mesEst = null;
      const key = card?.querySelector('.tri-title a')?.textContent || 'Ticket';
      toast(r.movedTo ? `${key} moved to ${r.movedTo}` : r.outOfRelease ? `${key} taken out of the release` : `${key} saved${r.jiraSynced ? '' : '. Jira will catch up'}`);
      return render();
    } catch (err) { document.getElementById('tri-result').textContent = err.message; tri.disabled = false; }
    return true;
  }
  if (t('[data-release-cancel]')) { mesNewRelease = null; return render(); }
  const createRel = t('[data-release-create]');
  if (createRel) {
    createRel.disabled = true;
    try {
      const r = await api('/api/mes/release', { method: 'POST', body: JSON.stringify(mesNewRelease) });
      mesNewRelease = null; mesTriage = freshTriage(r.id); toast(`${r.name} started`); return render();
    } catch (err) { document.getElementById('mes-result').textContent = err.message; createRel.disabled = false; }
    return true;
  }
  const make = t('[data-make-sprints]');
  if (make) {
    make.disabled = true; make.innerHTML = '<span class="spinner" aria-hidden="true"></span> Working in Jira';
    try {
      const r = await api('/api/mes/make-sprints', { method: 'POST', body: JSON.stringify({ versionId: mesTriage.versionId }) });
      toast(`${r.moved} ${r.moved === 1 ? 'ticket' : 'tickets'} placed${r.board.created ? `, on the new board ${r.board.name}` : ''}`);
      return render();
    } catch (err) { document.getElementById('sprint-result').textContent = err.message; make.disabled = false; make.textContent = 'Try again'; }
    return true;
  }
  if (t('[data-mes-skip]')) { mesTriage.skipped.push(t('[data-mes-skip]').dataset.mesSkip); return render(); }
  if (t('[data-mes-unskip]')) { mesTriage.skipped = []; return render(); }
  return false;
}

function condorInput(event) {
  const el = event.target;
  if (condorTab === 'notes' && rnInput(event)) return true;
  if (el.dataset.mesField && mesEst) { mesEst[el.dataset.mesField] = el.value; return true; }
  if (el.matches('[data-mes-version]')) {
    if (el.value === 'new') mesNewRelease = { name: '', startDate: todayIso(), releaseDate: '' };
    else { mesTriage = freshTriage(el.value); if (mesEst?.embedded) mesEst = null; }
    render(); return true;
  }
  if (el.dataset.newRelease && mesNewRelease) { mesNewRelease[el.dataset.newRelease] = el.value; return true; }
  if (el.dataset.triAssignee != null) { mesTriage.assignee[el.dataset.triAssignee] = el.value || null; return true; }
  if (el.dataset.triNotes != null) { mesTriage.notes[el.dataset.triNotes] = el.value || null; return true; }
  if (el.matches('[data-plan-version]')) { planVersion = el.value; planCapacityOpen = null; render(); return true; }
  if (el.id === 'mes-search') {
    const q = el.value.toLowerCase();
    document.querySelectorAll('[data-mes-row]').forEach((r) => { r.hidden = q.length > 1 && !r.textContent.toLowerCase().includes(q); });
    return true;
  }
  return false;
}

// ---------- Condor Dev: release notes ----------
// Triage decides what kind of note each ticket gets; whoever is assigned the
// ticket writes it here. Then a live preview of the release notes, every ticket
// in the release, and the downloads.

let rn = { versionId: null, view: 'write', mine: true, data: null, stale: true, refresh: false, editing: null, draft: null, intro: null, number: null, drafts: {}, uploading: {} };

const rnImg = (issueId, b) => b.src || `/api/mes/notes/image?issue=${encodeURIComponent(issueId)}&att=${encodeURIComponent(b.attachmentId)}`;
const rnItem = (id) => rn.data?.items.find((i) => i.id === id);
const RN_NEEDS = { sentence: 'One sentence for the list of smaller changes under its heading.',
  paragraph: 'A section of its own on the release notes page: a short heading, then what changed and how it helps.',
  photo: 'A section of its own: a short heading, what changed and how it helps, and at least one screenshot with a caption.' };

async function rnLoad() {
  const q = new URLSearchParams();
  if (rn.versionId) q.set('versionId', rn.versionId);
  if (rn.refresh) q.set('refresh', '1');
  rn.data = await api(`/api/mes/notes?${q}`);
  rn.versionId = rn.data.version?.id || null;
  rn.stale = false; rn.refresh = false;
}

function rnNoteHtml(item, blocks) {
  const [head, ...rest] = blocks;
  const para = (t) => esc(t).replace(/\n/g, '<br>');
  return `${head?.type === 'text' ? `<p class="rn-bullet${head.fromSummary ? ' rn-from-summary' : ''}">${para(head.text)}</p>` : ''}
    ${(head?.type === 'text' ? rest : blocks).map((b) => b.type === 'text' ? `<p>${para(b.text)}</p>`
      : b.type === 'image' ? `<img src="${esc(rnImg(item.id, b))}" alt="Screenshot for ${esc(item.key)}" loading="lazy">` : '').join('')}`;
}

function rnKindSelect(item, attr = 'data-rn-kind') {
  return `<select ${attr}="${esc(item.id)}" aria-label="Release note for ${esc(item.key)}">${item.kind ? '' : '<option value="" selected>Not decided</option>'}${NOTE_KINDS.map(([k, l]) =>
    `<option value="${k}"${item.kind === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
}

// ----- To write -----

function rnDraftFor(item) {
  if (!rn.drafts[item.id]) {
    const blocks = item.blocks.filter((b) => !b.hidden);
    rn.drafts[item.id] = {
      title: item.title || '',
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n'),
      images: blocks.filter((b) => b.type === 'image').map((b) => ({ attachmentId: b.attachmentId, filename: b.filename, caption: b.caption || '', src: b.src || null })),
    };
  }
  return rn.drafts[item.id];
}

function rnWriteCardHtml(item, showWho) {
  const d = rnDraftFor(item);
  const kind = item.kind;
  const id = esc(item.id);
  const field = kind === 'sentence'
    ? `<input type="text" maxlength="300" data-rn-wtext="${id}" value="${esc(d.text.replace(/\s*\n+\s*/g, ' '))}" placeholder="For example: Stock locations can now be removed through the user interface." aria-label="The sentence">`
    : `<label class="rn-field">Heading<input type="text" maxlength="120" data-rn-wtitle="${id}" value="${esc(d.title)}" placeholder="For example: Multiple scales per station"></label>
       <label class="rn-field">What changed<textarea rows="5" data-rn-wtext="${id}" placeholder="What changed and how it helps people using Condor. Start a line with - for a list.">${esc(d.text)}</textarea></label>`;
  const ups = rn.uploading[item.id] || 0;
  const pictures = kind === 'photo' ? `<div class="rn-pics">
      ${d.images.map((im, i) => `<figure class="rn-pic-card"><div class="rn-pic"><img src="${esc(im.src || rnImg(item.id, im))}" alt="">
          <button class="rn-pic-x" data-rn-unpic="${i}" data-issue="${id}" aria-label="Remove this picture">×</button></div>
        <input type="text" maxlength="200" data-rn-caption="${i}" data-issue="${id}" value="${esc(im.caption)}" placeholder="Caption, such as: Invitation form with site access" aria-label="Caption for picture ${i + 1}"></figure>`).join('')}
      ${ups ? `<div class="rn-pic rn-pic-wait"><span class="spinner" aria-hidden="true"></span> Adding ${ups === 1 ? 'picture' : `${ups} pictures`}</div>` : ''}
      <label class="rn-drop" data-rn-drop="${id}"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple data-rn-file="${id}">
        <span><strong>Add pictures</strong><br><small>or drop them here, or paste a screenshot</small></span></label></div>` : '';
  return `<li class="card rn-w" data-rn-w="${id}">
      <div class="rn-w-head"><p class="rn-w-title">${mesLink(item.key)} ${esc(item.summary)}</p>
        <p class="muted rn-w-meta">${esc(item.heading)} · ${esc(item.status || '')}${showWho ? ` · ${esc(item.assigneeName || 'Nobody assigned')}` : ''}</p></div>
      <div class="rn-w-kind"><span class="tri-label">Release note</span>${rnKindSelect(item)}</div>
      <p class="help rn-w-help">${RN_NEEDS[kind] || ''}</p>
      ${field}${pictures}
      <div class="row rn-w-foot"><button class="btn" data-rn-wsave="${id}">Save</button>
        <small class="muted">The words go to the ticket's Release Note in Jira${kind === 'photo' ? ', and the pictures to its attachments' : ''}.</small></div>
      <div class="result" data-rn-wresult="${id}" role="status"></div></li>`;
}

function rnWriteHtml(data) {
  const all = data.items.filter((i) => i.kind && i.kind !== 'none' && i.missing.length);
  const mine = all.filter((i) => data.me && i.assigneeId === data.me);
  const list = rn.mine ? mine : all;
  const done = data.items.filter((i) => i.kind && i.kind !== 'none' && !i.missing.length).length;
  const toggle = `<span class="segment" role="group" aria-label="Whose notes">${[[true, `Mine (${n(mine.length)})`], [false, `Everyone (${n(all.length)})`]].map(([k, l]) =>
    `<button class="seg${rn.mine === k ? ' on' : ''}" data-rn-mine="${k ? 1 : 0}" aria-pressed="${rn.mine === k}">${l}</button>`).join('')}</span>`;
  const empty = rn.mine
    ? `<div class="card"><p style="margin:0">Nothing of yours to write for ${esc(data.version.name)}.${all.length ? ` <button class="linklike" data-rn-mine="0">View all ${n(all.length)} still to write</button>` : ''}</p></div>`
    : `<div class="card"><p style="margin:0">Every note for ${esc(data.version.name)} has been written.${done ? ' <button class="linklike" data-rn-view="preview">See the preview</button>' : ''}</p></div>`;
  return `<div class="row rn-w-bar">${toggle}<small class="muted">${n(done)} written, ${n(all.length)} to go</small></div>
    ${list.length ? `<ul class="rn-w-list">${list.map((i) => rnWriteCardHtml(i, !rn.mine)).join('')}</ul>` : empty}`;
}

// ----- Preview -----

function rnHeadingSelect(current) {
  const list = [...new Set([...rn.data.headings, current].filter(Boolean))];
  return `<select data-rn-module>${list.map((m) => `<option${m === current ? ' selected' : ''}>${esc(m)}</option>`).join('')}<option value="__other">Another heading…</option></select>`;
}

function rnEditorHtml(item) {
  const d = rn.draft;
  const sentence = item.kind === 'sentence';
  return `<div class="rn-editor" data-rn-item="${esc(item.id)}">
      <p class="rn-editor-head">${mesLink(item.key)} ${esc(item.summary)}</p>
      ${item.changedInJira ? `<p class="notice-line">The Release Note in Jira has changed since this was tidied. <button class="linklike" data-rn-reset>Use the wording from Jira</button></p>` : ''}
      ${sentence ? '' : `<label class="rn-field">Heading<input type="text" maxlength="120" data-rn-title value="${esc(d.title)}"></label>`}
      ${d.blocks.map((b, i) => b.type === 'text'
        ? `<label class="rn-field">${sentence ? 'The sentence' : 'Paragraph'}<textarea rows="${Math.min(8, Math.max(2, Math.ceil(b.text.length / 70)))}" data-rn-text="${i}">${esc(b.text)}</textarea></label>`
        : sentence ? '' : `<figure class="rn-thumb${b.hidden ? ' off' : ''}"><img src="${esc(rnImg(item.id, b))}" alt="">
            <figcaption><input type="text" maxlength="200" data-rn-ecaption="${i}" value="${esc(b.caption || '')}" placeholder="Caption" aria-label="Caption">
            <label class="inline-check"><input type="checkbox" data-rn-show="${i}"${b.hidden ? '' : ' checked'}> Show this picture</label></figcaption></figure>`).join('')}
      ${sentence ? '' : '<button class="linklike" data-rn-addtext>Add a paragraph</button>'}
      <div class="row rn-where"><label>Under the heading${rnHeadingSelect(d.module)}</label>
        ${d.otherHeading ? `<label>New heading<input type="text" maxlength="80" data-rn-other value="${esc(d.otherHeading === true ? '' : d.otherHeading)}" placeholder="For example: Condor Sense — coming soon"></label>` : ''}</div>
      <p class="help">Tidying here changes the release notes only. The ticket in Jira keeps its own wording.</p>
      <div class="row"><button class="btn" data-rn-save>Save</button><button class="btn secondary" data-rn-cancel>Cancel</button>
        ${item.edited && !item.changedInJira ? '<button class="linklike" data-rn-reset>Use the wording from Jira</button>' : ''}</div>
      <p style="margin-bottom:0"><button class="linklike danger" data-rn-kind-set="none" data-issue="${esc(item.id)}">Leave this ticket out of the release notes</button></p>
      <div class="result" id="rn-result" role="status"></div></div>`;
}

// A paragraph's words, with lines starting "- " shown as a list.
function rnParaHtml(text) {
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(esc).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<ul class="rn-list">${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`); list = null; };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const item = /^[-•*]\s+(.*)$/.exec(line);
    if (item) { flushPara(); (list ||= []).push(item[1]); } else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('');
}

const rnVersionTitle = (v) => (v.number ? `v${v.number} (${v.displayName || v.name})` : v.displayName || v.name);
const rnAdditional = (name) => `Additional ${/^[A-Z][a-z]/.test(name) && !/[A-Z]/.test(name.slice(1)) ? name[0].toLowerCase() + name.slice(1) : name} improvements`;

function rnPreviewHtml(data) {
  const intro = data.intro ?? data.introDefault;
  const v = data.version;
  const top = rn.intro != null
    ? `<div class="rn-editor"><label class="rn-field">Version number<input type="text" maxlength="20" data-rn-number value="${esc(rn.number ?? v.number ?? '')}" placeholder="For example 2026.07"></label>
        <label class="rn-field">Introduction<textarea rows="4" data-rn-intro-text>${esc(rn.intro)}</textarea></label>
        <div class="row"><button class="btn" data-rn-intro-save>Save</button><button class="btn secondary" data-rn-intro-cancel>Cancel</button>
        ${data.intro != null ? '<button class="linklike" data-rn-intro-default>Use the suggested introduction</button>' : ''}</div></div>`
    : `<div class="rn-hover"><h2>${esc(rnVersionTitle(v))}</h2><p>${intro ? esc(intro) : '<span class="muted">No introduction yet.</span>'}</p>
        <button class="rn-edit" data-rn-intro aria-label="Edit the version number and introduction">Edit</button></div>`;
  const editBtn = (it) => `<button class="rn-edit" data-rn-edit="${esc(it.id)}" aria-label="Edit the note for ${esc(it.key)}">Edit</button>`;
  const body = data.document.length ? data.document.map((m) => `<h2>${esc(m.name)}</h2>
      ${m.features.map((f) => {
        const item = rnItem(f.id);
        if (rn.editing === f.id && item) return rnEditorHtml(item);
        return `<section class="rn-feature rn-hover" data-rn-item="${esc(f.id)}"><h3${f.titleFromSummary ? ' class="rn-from-summary"' : ''}>${esc(f.title)}</h3>
          ${f.blocks.map((b) => b.type === 'text' ? `<div class="${b.fromSummary ? 'rn-from-summary' : ''}">${rnParaHtml(b.text)}</div>`
            : `<figure class="rn-figure"><img src="${esc(rnImg(f.id, b))}" alt="${esc(b.caption || f.title)}" loading="lazy">${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`).join('')}
          ${editBtn(f)}</section>`;
      }).join('')}
      ${m.bullets.length ? `${m.features.length ? `<h3>${esc(rnAdditional(m.name))}</h3>` : ''}<ul class="rn-bullets">${m.bullets.map((b) => {
        const item = rnItem(b.id);
        if (rn.editing === b.id && item) return `<li class="rn-editing">${rnEditorHtml(item)}</li>`;
        return `<li class="rn-item rn-hover" data-rn-item="${esc(b.id)}"><p class="rn-bullet${b.fromSummary ? ' rn-from-summary' : ''}">${esc(b.text)}</p>${editBtn(b)}</li>`;
      }).join('')}</ul>` : ''}`).join('')
    : '<p class="rn-empty">Nothing is in the release notes yet. Tickets appear here once they\'re finished and marked for the release notes.</p>';
  return `<div class="rn-downloads"><button class="btn" data-rn-pdf${data.counts.inDocument ? '' : ' disabled'}>Download PDF</button>
      <button class="btn secondary" data-rn-md${data.counts.inDocument ? '' : ' disabled'}>Download for the help pages</button></div>
    <div class="result" id="rn-export" role="status"></div>
    <article class="rn-doc" aria-label="Release notes preview">
      <header class="rn-band"><img src="/release-notes-header.jpg" alt="Promtek"><h1>Condor Release Notes - ${esc(v.displayName || v.name)}</h1></header>
      <div class="rn-page">
        ${v.releaseDate ? `<p class="rn-date">Expected Release Date: ${esc(v.releaseDate)}</p>` : ''}
        ${top}
        ${body}
      </div></article>`;
}

// ----- All tickets -----

function rnTicketsHtml(data) {
  const groups = [
    ['Not decided yet', data.items.filter((i) => !i.kind)],
    ['Still to write', data.items.filter((i) => i.kind && i.kind !== 'none' && i.missing.length)],
    ['Written', data.items.filter((i) => i.kind && i.kind !== 'none' && !i.missing.length)],
    ['Not included', data.items.filter((i) => i.kind === 'none')],
  ].filter(([, list]) => list.length);
  if (!groups.length) return `<div class="card"><p style="margin:0">There are no tickets in ${esc(data.version.name)} yet.</p></div>`;
  return groups.map(([title, list]) => `<h3>${title} <small class="muted">${n(list.length)}</small></h3><ul class="list rn-tickets">${list.map((i) => {
    const notes = [];
    if (i.kind && i.kind !== 'none') {
      if (i.missing.length) notes.push(`needs ${i.missing.join(' and ')}`);
      if (!i.done) notes.push('shows once finished');
      if (!i.moduleSet) notes.push(`no module in Jira, so under ${i.heading}`);
      if (i.blocks.some((b) => b.type === 'missing')) notes.push('a picture couldn\'t be found in its attachments');
    }
    if (i.kindWaiting || i.notePending) notes.push('waiting to reach Jira');
    return `<li><span class="title">${mesLink(i.key)} ${esc(i.summary)}</span>
      <span class="sub">${esc(i.type || 'Ticket')} under ${esc(i.heading)}. ${esc(i.status || '')}${i.assigneeName ? ` · ${esc(i.assigneeName)}` : ''}${notes.length ? `<br><span class="rn-warn">${esc(notes.join('; '))}</span>` : ''}</span>
      <span class="rn-kind-cell">${rnKindSelect(i)}</span></li>`;
  }).join('')}</ul>`).join('');
}

async function rnHtml() {
  if (rn.stale || !rn.data) await rnLoad();
  const data = rn.data;
  if (!data.version) return `<div class="card"><p style="margin:0">${esc(data.error || 'There are no releases to show.')}</p></div>`;
  const picker = `<label>Release<select data-rn-version>${data.releases.map((v) => `<option value="${esc(v.id)}"${v.id === data.version.id ? ' selected' : ''}>${esc(v.name)}${v.released ? ', released' : v.releaseDate ? `, due ${shortDate(v.releaseDate)}` : ''}</option>`).join('')}</select></label>`;
  const c = data.counts;
  const tabs = [['write', `To write${c.toWrite ? ` (${n(c.toWrite)})` : ''}`], ['preview', 'Preview'], ['tickets', 'All tickets']];
  return `<div class="row rn-tools">${picker}
      <button class="btn secondary" data-rn-read>Read from Jira again</button></div>
    <p class="muted rn-status">${data.readAt ? `Read from Jira at ${hhmm(data.readAt)}${new Date(data.readAt).toDateString() !== new Date().toDateString() ? ` on ${shortDate(data.readAt.slice(0, 10))}` : ''}. ` : ''}${n(c.inDocument)} ${c.inDocument === 1 ? 'note' : 'notes'} in the preview${c.undecided ? `, ${n(c.undecided)} ${c.undecided === 1 ? 'ticket' : 'tickets'} not decided` : ''}.</p>
    ${data.error ? `<div class="card notice"><p style="margin:0">Jira couldn't be read just now, so this is from the last time it was. ${esc(data.error)}</p></div>` : ''}
    <div class="rn-bar"><span class="segment" role="tablist">${tabs.map(([k, l]) => `<button class="seg${rn.view === k ? ' on' : ''}" data-rn-view="${k}" aria-pressed="${rn.view === k}">${l}</button>`).join('')}</span></div>
    ${rn.view === 'tickets' ? rnTicketsHtml(data) : rn.view === 'preview' ? rnPreviewHtml(data) : rnWriteHtml(data)}`;
}

function rnSave(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

async function rnExport(kind, btn) {
  const label = btn.textContent;
  const status = document.getElementById('rn-export');
  btn.disabled = true;
  const progress = (done, total) => { btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> Pictures ${done} of ${total}`; };
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Making it';
  try {
    const R = await import('/release-notes.js');
    const srcFor = (it, b) => rnImg(it.id, b);
    if (kind === 'pdf') {
      const header = await fetch('/release-notes-header.jpg').then((r) => (r.ok ? r.blob() : null)).catch(() => null);
      const r = await R.makePdf(rn.data, { srcFor, header, onProgress: progress });
      rnSave(new Blob([r.bytes], { type: 'application/pdf' }), `${R.fileBase(R.versionTitle(rn.data.version))}.pdf`);
      status.textContent = r.failed ? `${r.failed} ${r.failed === 1 ? 'picture' : 'pictures'} couldn't be fetched from Jira and ${r.failed === 1 ? 'is' : 'are'} missing from the PDF.` : '';
    } else {
      const r = await R.makeMarkdownZip(rn.data, { srcFor, onProgress: progress });
      rnSave(r.blob, `Release notes ${R.folderFor(rn.data.version)}.zip`);
      status.textContent = r.failed ? `${r.failed} ${r.failed === 1 ? 'picture' : 'pictures'} couldn't be fetched from Jira and ${r.failed === 1 ? 'is' : 'are'} missing.` : '';
    }
  } catch (err) { status.textContent = err.message; }
  btn.disabled = false; btn.textContent = label;
}

// Large pictures are made smaller before they go to Jira; screenshots stay sharp.
async function rnPrepare(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error(`${file.name || 'That file'} isn't a picture Condor can show.`);
  if (file.size <= 4 * 1024 * 1024) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2400 / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  return new File([blob], (file.name || 'picture').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

async function rnUpload(issueId, files) {
  const list = [...files].filter((f) => f && f.type?.startsWith('image/'));
  if (!list.length) return;
  const item = rnItem(issueId);
  if (!item || item.kind !== 'photo') return;
  const d = rnDraftFor(item);
  rn.uploading[issueId] = (rn.uploading[issueId] || 0) + list.length;
  rnRefreshCard(issueId);
  for (const f of list) {
    try {
      const file = await rnPrepare(f);
      const name = file.name || `screenshot-${Date.now()}.png`;
      const att = await api(`/api/mes/notes/upload?issue=${encodeURIComponent(issueId)}`, { method: 'POST', body: file,
        headers: { 'content-type': file.type, 'x-filename': encodeURIComponent(name) } });
      d.images.push({ attachmentId: att.id, filename: att.filename, src: att.src || null });
    } catch (err) { toast(err.message); }
    rn.uploading[issueId]--;
    rnRefreshCard(issueId);
  }
}

// Redraws one card in place, keeping what's been typed.
function rnRefreshCard(issueId) {
  const el = view.querySelector(`[data-rn-w="${CSS.escape(issueId)}"]`);
  const item = rnItem(issueId);
  if (!el || !item) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = rnWriteCardHtml(item, !rn.mine);
  el.replaceWith(tmp.firstElementChild);
}

async function rnClick(event) {
  const t = (sel) => event.target.closest(sel);
  if (t('[data-rn-view]')) { rn.view = t('[data-rn-view]').dataset.rnView; rn.editing = null; return render(); }
  if (t('[data-rn-mine]')) { rn.mine = t('[data-rn-mine]').dataset.rnMine === '1'; rn.view = 'write'; return render(); }
  if (t('[data-rn-read]')) { rn.refresh = true; rn.stale = true; rn.editing = null; rn.drafts = {}; return render(); }
  if (t('[data-rn-pdf]')) { await rnExport('pdf', t('[data-rn-pdf]')); return true; }
  if (t('[data-rn-md]')) { await rnExport('md', t('[data-rn-md]')); return true; }

  const unpic = t('[data-rn-unpic]');
  if (unpic) { rnDraftFor(rnItem(unpic.dataset.issue)).images.splice(Number(unpic.dataset.rnUnpic), 1); rnRefreshCard(unpic.dataset.issue); return true; }
  const wsave = t('[data-rn-wsave]');
  if (wsave) {
    const id = wsave.dataset.rnWsave, item = rnItem(id), d = rnDraftFor(item);
    const out = view.querySelector(`[data-rn-wresult="${CSS.escape(id)}"]`);
    if (rn.uploading[id]) { out.textContent = 'Wait for the pictures to finish adding.'; return true; }
    wsave.disabled = true;
    try {
      const r = await api('/api/mes/notes/write', { method: 'POST', body: JSON.stringify({ issueId: id, title: d.title, text: d.text,
        images: d.images.map((im) => ({ id: im.attachmentId, caption: im.caption })) }) });
      delete rn.drafts[id]; rn.stale = true;
      toast(`${item.key} written${r.jiraSynced ? '' : '. Jira will catch up'}`);
      return render();
    } catch (err) { out.textContent = err.message; wsave.disabled = false; }
    return true;
  }

  const edit = t('[data-rn-edit]');
  if (edit) {
    const item = rnItem(edit.dataset.rnEdit);
    let blocks = item.blocks.filter((b) => b.type !== 'missing').map((b) => ({ ...b }));
    if (item.kind === 'sentence') blocks = blocks.filter((b) => b.type === 'text').slice(0, 1);
    if (!blocks.some((b) => b.type === 'text')) blocks.unshift({ type: 'text', text: item.summary || '' });
    rn.editing = item.id; rn.intro = null;
    rn.draft = { blocks, module: item.heading, title: item.title || item.summary || '', otherHeading: false };
    render(); return true;
  }
  if (t('[data-rn-cancel]')) { rn.editing = null; rn.draft = null; return render(); }
  if (t('[data-rn-addtext]')) { rn.draft.blocks.push({ type: 'text', text: '' }); render(); return true; }
  const show = t('[data-rn-show]');
  if (show) { const b = rn.draft.blocks[Number(show.dataset.rnShow)]; b.hidden = !show.checked; show.closest('.rn-thumb').classList.toggle('off', b.hidden); return true; }
  const save = t('[data-rn-save]');
  if (save) {
    const item = rnItem(rn.editing);
    save.disabled = true;
    const body = { issueId: item.id, key: item.key, blocks: rn.draft.blocks.filter((b) => b.type === 'image' || b.text.trim()) };
    if (item.kind === 'sentence') body.blocks = [...body.blocks, ...item.blocks.filter((b) => b.type === 'image')];
    const heading = rn.draft.otherHeading ? String(rn.draft.otherHeading === true ? '' : rn.draft.otherHeading).trim() : rn.draft.module;
    if (rn.draft.otherHeading && !heading) { document.getElementById('rn-result').textContent = 'Type the new heading.'; return true; }
    if (heading !== item.heading) body.module = heading;
    if (item.kind !== 'sentence' && rn.draft.title.trim() !== (item.title || '')) body.title = rn.draft.title.trim();
    try {
      await api('/api/mes/notes/item', { method: 'POST', body: JSON.stringify(body) });
      rn.editing = null; rn.draft = null; rn.stale = true; toast(`${item.key} saved`); return render();
    } catch (err) { document.getElementById('rn-result').textContent = err.message; save.disabled = false; }
    return true;
  }
  if (t('[data-rn-reset]')) {
    const item = rnItem(rn.editing);
    try {
      await api('/api/mes/notes/item', { method: 'POST', body: JSON.stringify({ issueId: item.id, blocks: null }) });
      rn.editing = null; rn.draft = null; rn.stale = true; return render();
    } catch (err) { document.getElementById('rn-result').textContent = err.message; }
    return true;
  }
  const out = t('[data-rn-kind-set]');
  if (out) { await rnSetKind(out.dataset.issue, out.dataset.rnKindSet); return true; }
  if (t('[data-rn-intro]')) { rn.intro = rn.data.intro ?? rn.data.introDefault ?? ''; rn.number = rn.data.version.number || ''; rn.editing = null; render(); document.querySelector('[data-rn-intro-text]')?.focus(); return true; }
  if (t('[data-rn-intro-cancel]')) { rn.intro = null; rn.number = null; return render(); }
  const introSave = t('[data-rn-intro-save]') || t('[data-rn-intro-default]');
  if (introSave) {
    introSave.disabled = true;
    const intro = introSave.matches('[data-rn-intro-default]') ? null : rn.intro.trim();
    try {
      await api('/api/mes/notes/intro', { method: 'POST', body: JSON.stringify({ versionId: rn.data.version.id, intro, number: rn.number ?? rn.data.version.number }) });
      rn.intro = null; rn.number = null; rn.stale = true; return render();
    } catch (err) { toast(err.message); introSave.disabled = false; }
    return true;
  }
  return false;
}

async function rnSetKind(issueId, kind) {
  const item = rnItem(issueId);
  if (!item || item.kind === kind || !kind) return;
  try {
    const r = await api('/api/mes/notes/item', { method: 'POST', body: JSON.stringify({ issueId: item.id, key: item.key, kind }) });
    toast(`${item.key}: ${noteKindLabel(kind)}${r.jiraSynced ? '' : '. Jira will catch up'}`);
    if (rn.editing === item.id) { rn.editing = null; rn.draft = null; }
    rn.stale = true; render();
  } catch (err) { toast(err.message); }
}

function rnInput(event) {
  const el = event.target;
  if (el.matches('[data-rn-version]')) { rn.versionId = el.value; rn.stale = true; rn.editing = null; rn.intro = null; rn.drafts = {}; render(); return true; }
  if (el.dataset.rnKind != null) { rnSetKind(el.dataset.rnKind, el.value); return true; }
  if (el.dataset.rnWtext != null) { rnDraftFor(rnItem(el.dataset.rnWtext)).text = el.value; return true; }
  if (el.dataset.rnWtitle != null) { rnDraftFor(rnItem(el.dataset.rnWtitle)).title = el.value; return true; }
  if (el.dataset.rnCaption != null) { rnDraftFor(rnItem(el.dataset.issue)).images[Number(el.dataset.rnCaption)].caption = el.value; return true; }
  if (el.dataset.rnEcaption != null && rn.draft) { rn.draft.blocks[Number(el.dataset.rnEcaption)].caption = el.value; return true; }
  if (el.matches('[data-rn-title]') && rn.draft) { rn.draft.title = el.value; return true; }
  if (el.matches('[data-rn-other]') && rn.draft) { rn.draft.otherHeading = el.value || true; return true; }
  if (el.matches('[data-rn-number]')) { rn.number = el.value; return true; }
  if (el.dataset.rnFile != null) { rnUpload(el.dataset.rnFile, el.files); el.value = ''; return true; }
  if (el.dataset.rnText != null && rn.draft) { rn.draft.blocks[Number(el.dataset.rnText)].text = el.value; return true; }
  if (el.matches('[data-rn-module]') && rn.draft) {
    if (el.value === '__other') { rn.draft.otherHeading = true; render(); return true; }
    rn.draft.module = el.value; if (rn.draft.otherHeading) { rn.draft.otherHeading = false; render(); }
    return true;
  }
  if (el.matches('[data-rn-intro-text]')) { rn.intro = el.value; return true; }
  return el.matches('[data-rn-show]');
}

// Screenshots can be pasted straight into a note, or dropped on it.
view.addEventListener('paste', (event) => {
  if (currentRoute() !== '#/condor' || condorTab !== 'notes') return;
  const card = event.target.closest?.('[data-rn-w]');
  const files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!card || !files.length || rnItem(card.dataset.rnW)?.kind !== 'photo') return;
  event.preventDefault();
  rnUpload(card.dataset.rnW, files);
});
view.addEventListener('dragover', (event) => {
  const drop = event.target.closest?.('[data-rn-drop]');
  if (!drop) return;
  event.preventDefault(); drop.classList.add('over');
});
view.addEventListener('dragleave', (event) => { event.target.closest?.('[data-rn-drop]')?.classList.remove('over'); });
view.addEventListener('drop', (event) => {
  const drop = event.target.closest?.('[data-rn-drop]');
  if (!drop) return;
  event.preventDefault(); drop.classList.remove('over');
  rnUpload(drop.dataset.rnDrop, event.dataTransfer?.files || []);
});

// ---------- Condor Dev: release plan ----------

let planVersion = null;
let planCapacityOpen = null;
const PRIORITY_COLOURS = { Must: 'var(--blue-deep)', Should: 'rgb(0,141,198)', Could: 'rgb(140,196,224)' };
const WEEKDAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri']];
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

function planTimeline(p) {
  const rows = [...new Set(p.schedule.filter((s) => s.start).map((s) => s.personId))];
  if (!rows.length) return '';
  const start = p.schedule.reduce((m, s) => (s.start && s.start < m ? s.start : m), p.version.releaseDate);
  const end = p.schedule.reduce((m, s) => (s.due && s.due > m ? s.due : m), p.version.releaseDate);
  const days = dayDiff(start, end) + 1;
  const dw = 14, label = 96, rowH = 34, top = 24;
  const w = label + days * dw + 10, h = top + rows.length * rowH + 8;
  const x = (d) => label + dayDiff(start, d) * dw;
  let ticks = '';
  for (let i = 0; i < days; i += 7) {
    const d = new Date(Date.parse(`${start}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    ticks += `<line x1="${x(d)}" x2="${x(d)}" y1="${top - 4}" y2="${h}" stroke="var(--line)"/><text x="${x(d) + 3}" y="14" font-size="11" fill="var(--muted)">${shortDate(d)}</text>`;
  }
  const bars = p.schedule.filter((s) => s.start).map((s) => {
    const y = top + rows.indexOf(s.personId) * rowH + 6;
    const bw = Math.max(dw - 2, (dayDiff(s.start, s.due) + 1) * dw - 2);
    return `<g><title>${esc(s.key)} ${esc(s.summary)}: ${shortDate(s.start)} to ${shortDate(s.due)}, ${hoursLabel(s.hours)}</title>
      <rect x="${x(s.start) + 1}" y="${y}" width="${bw}" height="${rowH - 12}" rx="5" fill="${s.fits ? PRIORITY_COLOURS[s.priority] || 'var(--muted)' : 'var(--danger)'}" opacity="${s.fits ? 1 : 0.75}"/>
      ${bw > 52 ? `<text x="${x(s.start) + 6}" y="${y + 15}" font-size="11" fill="#fff">${esc(s.key)}</text>` : ''}</g>`;
  }).join('');
  const names = rows.map((id, i) => `<text x="0" y="${top + i * rowH + 21}" font-size="12" fill="var(--ink)">${esc((p.names[id] || 'Unassigned').split(' ')[0])}</text>`).join('');
  const rel = x(p.version.releaseDate) + dw;
  const sprintMarks = (p.sprints || []).filter((sp) => sp.start && sp.start >= start && sp.start <= end).map((sp) =>
    `<line x1="${x(sp.start)}" x2="${x(sp.start)}" y1="${top - 6}" y2="${h}" stroke="var(--blue)" stroke-width="1.5" stroke-dasharray="2 3"/>
     <text x="${x(sp.start) + 3}" y="${h - 4}" font-size="10.5" fill="var(--blue-deep)">${esc(sp.name.replace(`${p.version.name} `, ''))}</text>`).join('');
  return `<div class="plan-timeline"><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Timeline of planned tickets">
      ${ticks}${sprintMarks}${names}${bars}
      <line x1="${rel}" x2="${rel}" y1="${top - 6}" y2="${h}" stroke="var(--danger)" stroke-width="2" stroke-dasharray="4 3"/>
      <text x="${rel + 3}" y="${top + 4}" font-size="11" fill="var(--danger)">Release</text></svg></div>
    <p class="help">${Object.entries(PRIORITY_COLOURS).map(([k, c]) => `<span class="key-dot" style="background:${c}"></span>${k}`).join(' ')} <span class="key-dot" style="background:var(--danger)"></span>After the release</p>`;
}

function planRowsHtml(list, p) {
  const sprintCol = (p.sprints || []).length > 0;
  return `<div class="table-wrap"><table><thead><tr><th>Ticket</th><th>Priority</th>${p.canPlan ? '<th>Who</th>' : ''}${sprintCol ? '<th>Sprint</th>' : ''}<th>Starts</th><th>Due</th><th class="num">Hours left</th></tr></thead>
    <tbody>${list.map((s) => `<tr${s.fits ? '' : ' class="unfit"'}>
      <td>${mesLink(s.key)}<br><span class="muted">${esc(s.summary)}</span></td><td>${esc(s.priority || 'To triage')}</td>
      ${p.canPlan ? `<td>${esc(p.names[s.personId] || '—')}${s.plannedAssignee && s.personId ? '<br><span class="muted">suggested</span>' : ''}</td>` : ''}
      ${sprintCol ? `<td>${esc(s.sprint ? s.sprint.replace(`${p.version.name} `, '') : '—')}</td>` : ''}
      <td>${s.start ? shortDate(s.start) : '—'}</td><td>${s.due ? shortDate(s.due) : '—'}${s.fits ? '' : '<br><span class="bad">after the release</span>'}</td>
      <td class="num">${hoursLabel(Math.round(s.hours * 4) / 4)}${s.overrun ? '<br><span class="bad">over estimate</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function capacityListHtml(p) {
  const rows = p.people.map((c) => {
    const open = planCapacityOpen === c.id;
    const days = WEEKDAYS.filter(([d]) => c.days.includes(d)).map(([, l]) => l).join(', ');
    return `<li data-cap="${esc(c.id)}">
      <span class="title">${esc(c.name)}</span>
      <span class="sub">${c.included ? `${n(c.hoursPerWeek)}h a week on Condor, ${days || 'no days'}${c.away.length ? `. Away ${c.away.map((a) => `${shortDate(a.from)}${a.until !== a.from ? ` to ${shortDate(a.until)}` : ''}${a.note ? ` (${esc(a.note)})` : ''}`).join(', ')}` : ''}` : 'Not planned for'}
        <button class="linklike" data-cap-edit="${esc(c.id)}">${open ? 'Close' : 'Change'}</button></span>
      ${open ? `<div class="cap-edit">
        <label class="inline-check"><input type="checkbox" data-cap-included ${c.included ? 'checked' : ''}> Plan work for ${esc(c.name.split(' ')[0])}</label>
        <label>Hours a week on Condor<input type="number" min="0" max="60" step="0.5" data-cap-hours value="${c.hoursPerWeek}"></label>
        <div class="chips">${WEEKDAYS.map(([d, l]) => `<button class="chip${c.days.includes(d) ? ' on' : ''}" data-cap-day="${d}">${l}</button>`).join('')}</div>
        <p class="help">Days away, such as leave, university blocks or time on customer work</p>
        <ul class="list plain cap-away">${c.away.map((a, i) => `<li>${shortDate(a.from)}${a.until !== a.from ? ` to ${shortDate(a.until)}` : ''}${a.note ? `, ${esc(a.note)}` : ''} <button class="linklike" data-cap-away-remove="${i}">Remove</button></li>`).join('')}</ul>
        <div class="row cap-away-add"><label>From<input type="date" data-cap-away-from></label><label>Until<input type="date" data-cap-away-until></label>
          <label>Note<input type="text" data-cap-away-note placeholder="Optional"></label><button class="btn secondary" data-cap-away-add>Add</button></div>
        <div class="row" style="margin-top:.75rem"><button class="btn" data-cap-save>Save</button></div></div>` : ''}
    </li>`;
  }).join('');
  return `<ul class="list cap-list">${rows}</ul>`;
}

function capacityHtml(p) {
  return `<h2>Capacity</h2>
    <div class="card"><div class="row" style="align-items:end;gap:.75rem"><label>Kept free for emergencies<input type="number" min="0" max="50" step="5" id="plan-reserve" value="${Math.round(p.reserve * 100)}"></label>
      <span style="padding-bottom:.6rem">%</span><button class="btn secondary" data-plan-reserve>Save</button></div>
      <p class="help">Planned work fills each person's time up to this point, so emergencies have somewhere to go without moving everything.</p></div>
    ${capacityListHtml(p)}`;
}

function renderPlanFrom(p) {
  // Keeps unsaved capacity edits while the away list changes.
  const host = view.querySelector(`[data-cap="${CSS.escape(planCapacityOpen)}"]`);
  const hours = host?.querySelector('[data-cap-hours]')?.value;
  const included = host?.querySelector('[data-cap-included]')?.checked;
  const person = p.people.find((x) => x.id === planCapacityOpen);
  if (person && hours !== undefined) { person.hoursPerWeek = Number(hours); person.included = included; }
  const list = view.querySelector('.cap-list');
  if (list) list.outerHTML = capacityListHtml(p);
  return true;
}

async function mesPlanHtml() {
  const p = await api(`/api/mes/plan${planVersion ? `?versionId=${encodeURIComponent(planVersion)}` : ''}`);
  planCache = p;
  if (!p.version) return '<div class="card"><p style="margin:0">There are no open releases in MES. Create the next version in Jira, with its start and release dates, and it appears here.</p></div>';
  planVersion = p.version.id;
  const picker = `<label>Release<select data-plan-version>${p.versions.map((v) => `<option value="${esc(v.id)}"${v.id === p.version.id ? ' selected' : ''}>${esc(v.name)}${v.releaseDate ? `, due ${shortDate(v.releaseDate)}` : ''}</option>`).join('')}</select></label>`;
  const fitting = p.schedule.filter((s) => s.fits);
  if (!p.canPlan) {
    return `<div class="card">${picker}</div>
      <h2>Your planned tickets</h2>
      ${fitting.length || p.schedule.length ? planRowsHtml(p.schedule, p) : '<div class="card"><p style="margin:0">Nothing planned for you in this release yet.</p></div>'}`;
  }
  const free = p.usable - p.planned;
  const unfit = p.schedule.filter((s) => !s.fits);
  const unfitHours = unfit.reduce((t, s) => t + s.hours, 0);
  const stats = `<dl class="stats">
      <div><dt>Release</dt><dd>${shortDate(p.version.releaseDate)}<small>${p.noRelease ? 'no date in Jira, 90 days assumed' : esc(p.version.name)}</small></dd></div>
      <div><dt>Time to plan</dt><dd>${hoursLabel(Math.round(p.usable))}<small>of ${hoursLabel(Math.round(p.capacity))}, ${Math.round(p.reserve * 100)}% kept free</small></dd></div>
      <div><dt>Planned</dt><dd>${hoursLabel(Math.round(p.planned))}<small>${n(fitting.length)} ${fitting.length === 1 ? 'ticket' : 'tickets'}</small></dd></div>
      ${unfit.length
        ? `<div><dt>Doesn't fit</dt><dd class="bad">${hoursLabel(Math.round(unfitHours))}<small>${n(unfit.length)} ${unfit.length === 1 ? 'ticket' : 'tickets'} past the release</small></dd></div>
           <div><dt>Likely ready</dt>${p.projected?.finish
             ? `<dd class="bad">${shortDate(p.projected.finish)}<small>if nothing is taken out, ${n(p.projected.lateDays)} working ${p.projected.lateDays === 1 ? 'day' : 'days'} late</small></dd>`
             : '<dd class="bad">Over a year<small>some work has nobody with time for it</small></dd>'}</div>`
        : `<div><dt>Room left</dt><dd>${hoursLabel(Math.round(Math.max(0, free)))}<small>before the reserve</small></dd></div>`}</dl>
    ${p.readError ? `<p class="help">Jira couldn't be read just now, so this uses what the hub last knew. ${esc(p.readError)}</p>` : ''}`;
  const sugg = p.suggestions.length ? `<h2>Suggested changes</h2><ul class="list approvals">${p.suggestions.map((s) => `<li>
      <span class="title">Move ${mesLink(s.key)} ${esc(s.summary)}</span>
      <span class="sub">${esc(s.priority)}, ${hoursLabel(Math.round(s.hours * 4) / 4)} left. To ${p.next ? esc(p.next.name) : 'no release'}, ${esc(s.reason)}.</span>
      <div class="row" style="margin-top:.6rem"><button class="btn" data-plan-suggest="accept" data-issue="${esc(s.id)}">Move it</button>
        <button class="btn secondary" data-plan-suggest="decline" data-issue="${esc(s.id)}">Keep it in</button></div></li>`).join('')}</ul>` : '';
  const stuck = p.stillOut.length ? `<div class="card notice"><p style="margin:0">${p.stillOut.map((s) => mesLink(s.key)).join(', ')} still ${p.stillOut.length === 1 ? "doesn't" : "don't"} fit before the release, even with the suggested changes. Their time may need more people, a later release date, or using some of the reserve.</p></div>` : '';
  const needs = p.needsEstimate.length ? `<h2>Needs an estimate first</h2><ul class="list mes-list">${p.needsEstimate.map((t) => `<li>
      <span class="title">${mesLink(t.key)} ${esc(t.summary)}</span><span class="sub">${esc(t.priority || 'To triage')}</span>
      <button class="chip-btn" data-mes-estimate="${esc(t.id)}" data-from="plan" style="margin-top:.4rem">Estimate</button></li>`).join('')}</ul>` : '';
  const accepted = p.accepted.count
    ? `Accepted ${new Date(p.accepted.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}, ${n(p.accepted.count)} tickets${p.accepted.waiting ? `, ${n(p.accepted.waiting)} still to reach Jira` : ', all in Jira'}.`
    : 'Not accepted yet.';
  return `<div class="card">${picker}</div>
    ${stats}
    ${sugg}${stuck}
    <h2>Timeline</h2><div class="card">${planTimeline(p) || '<p style="margin:0">Nothing to plan yet. Triage tickets into this release and estimate them.</p>'}</div>
    ${p.schedule.length ? `<h2>Tickets</h2>${planRowsHtml(p.schedule, p)}` : ''}
    ${needs}
    <div class="card" style="margin-top:1rem"><p style="margin-top:0">${accepted}</p>
      <p class="help">Accepting writes each planned ticket's start and due dates to Jira for the timeline, puts it in the sprint it starts in, and sets the suggested person where nobody is assigned. Tickets in a sprint that has started stay where they are.</p>
      <button class="btn" data-plan-accept="1">Accept the plan</button><div class="result" id="plan-result" role="status"></div></div>
    ${capacityHtml(p)}`;
}

let planCache = null;
async function planClick(event) {
  const t = (sel) => event.target.closest(sel);
  const sug = t('[data-plan-suggest]');
  if (sug) {
    sug.disabled = true;
    try { await api('/api/mes/suggestion', { method: 'POST', body: JSON.stringify({ issueId: sug.dataset.issue, versionId: planVersion, decision: sug.dataset.planSuggest }) }); }
    catch (err) { toast(err.message); }
    return render();
  }
  const accept = t('[data-plan-accept]');
  if (accept) {
    accept.disabled = true; accept.innerHTML = '<span class="spinner" aria-hidden="true"></span> Updating Jira';
    try {
      const r = await api('/api/mes/accept-plan', { method: 'POST', body: JSON.stringify({ versionId: planVersion }) });
      const placed = r.sprints?.moved ? ` ${r.sprints.moved} placed in their sprints.` : r.sprints?.error ? ` Sprints weren't updated: ${r.sprints.error}` : '';
      toast(r.waiting ? `Plan accepted. ${r.waiting} more go to Jira over the next few minutes.${placed}` : `Plan accepted and in Jira.${placed}`);
      if (!r.startField) toast('Due dates set. No "Start date" field was found in Jira, so start dates stay in the hub');
      return render();
    } catch (err) { document.getElementById('plan-result').textContent = err.message; accept.disabled = false; accept.textContent = 'Accept the plan'; }
    return true;
  }
  if (t('[data-plan-reserve]')) {
    try { await api('/api/mes/reserve', { method: 'POST', body: JSON.stringify({ percent: document.getElementById('plan-reserve').value }) }); return render(); }
    catch (err) { toast(err.message); }
    return true;
  }
  const edit = t('[data-cap-edit]');
  if (edit) {
    planCapacityOpen = planCapacityOpen === edit.dataset.capEdit ? null : edit.dataset.capEdit;
    const list = view.querySelector('.cap-list');
    if (list && planCache) { list.outerHTML = capacityListHtml(planCache); return true; }
    return render();
  }
  const row = t('[data-cap]');
  if (row && planCapacityOpen) {
    const p = planCache?.people.find((x) => x.id === row.dataset.cap);
    if (!p) return false;
    const day = t('[data-cap-day]');
    if (day) {
      // A day on or off Condor is a working day's hours, 7.5, added or taken away.
      const d = day.dataset.capDay;
      const removing = p.days.includes(d);
      p.days = removing ? p.days.replace(d, '') : [...p.days, d].sort().join('');
      day.classList.toggle('on');
      const hours = row.querySelector('[data-cap-hours]');
      const now = Number(hours.value) || 0;
      hours.value = Math.max(0, Math.min(60, removing ? now - 7.5 : now + 7.5));
      p.hoursPerWeek = Number(hours.value);
      return true;
    }
    const add = t('[data-cap-away-add]');
    if (add) {
      const from = row.querySelector('[data-cap-away-from]').value;
      if (!from) { toast('Choose the first day away'); return true; }
      p.away.push({ from, until: row.querySelector('[data-cap-away-until]').value || from, note: row.querySelector('[data-cap-away-note]').value });
      return renderPlanFrom(planCache);
    }
    const rem = t('[data-cap-away-remove]');
    if (rem) { p.away.splice(Number(rem.dataset.capAwayRemove), 1); return renderPlanFrom(planCache); }
    if (t('[data-cap-save]')) {
      try {
        await api('/api/mes/capacity', { method: 'POST', body: JSON.stringify({ accountId: p.id, hoursPerWeek: row.querySelector('[data-cap-hours]').value,
          days: p.days, away: p.away, included: row.querySelector('[data-cap-included]').checked }) });
        planCapacityOpen = null; toast('Saved'); return render();
      } catch (err) { toast(err.message); }
      return true;
    }
  }
  return false;
}

// ---------- Company chart versions ----------

// Draws the chart as it will be issued, with its new reference, and turns it into a JPEG.
async function orgIssueImage(reference) {
  await loadOrgLogo();
  const data = await api('/api/org');
  const label = `${reference}, issued ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const holder = document.createElement('div');
  holder.innerHTML = orgSvg(data, label);
  const source = new XMLSerializer().serializeToString(holder.firstElementChild);
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('The chart could not be turned into an image.'));
    image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(source)))}`;
  });
  // Large enough to read when printed, small enough to keep alongside the version.
  for (const [scale, quality] of [[2, 0.9], [2, 0.75], [1.5, 0.75], [1, 0.7]]) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if (base64.length < 1_800_000) return { image: base64, width: canvas.width, height: canvas.height };
  }
  throw new Error('The chart is too large to issue as an image.');
}

const changesLabel = (major, minor) => `${n(major)} major ${major === 1 ? 'change' : 'changes'}, ${n(minor)} minor ${minor === 1 ? 'change' : 'changes'}`;

function settingsOrgHtml() {
  const o = settingsData.org;
  const majors = o.pending.filter((p) => p.kind === 'major');
  const minors = o.pending.filter((p) => p.kind === 'minor');
  const line = (p, box) => `<li>${box ? `<label class="inline-check"><input type="checkbox" data-org-count="${p.id}" checked>` : ''}
      <span><strong>${esc(p.person_name)}</strong>: ${esc(p.label)}${p.before || p.after ? `, ${p.before ? `${esc(p.before)} to ` : ''}${esc(p.after || 'blank')}` : ''}
      <span class="muted">${shortDate(p.at.slice(0, 10))}</span></span>${box ? '</label>' : ''}</li>`;
  const statusText = { published: 'In Confluence', failed: 'Not in Confluence yet', pending: 'Going to Confluence', none: 'Before the hub' };
  return `<div class="card">
      <p style="margin-top:0"><strong>${esc(o.latest.reference)}</strong> is the current version${o.latest.n > 8 ? `, issued ${shortDate(o.latest.issued_at.slice(0, 10))} by ${esc(o.latest.issued_by_name)}` : ''}.</p>
      <p style="margin-bottom:0"><strong>Since then: ${changesLabel(majors.length, minors.length)}.</strong></p>
      <p class="help">Major changes are people joining or leaving, reporting lines, job titles, departments and names. Minor changes, such as photos and extensions, show on the chart straight away and go out with the next version.</p></div>
    ${majors.length ? `<h2>Major changes</h2><div class="card"><p class="muted" style="margin-top:0">Untick anything that shouldn't count, such as a corrected spelling.</p><ul class="list plain org-changes">${majors.map((p) => line(p, true)).join('')}</ul></div>` : ''}
    ${minors.length ? `<h2>Minor changes</h2><div class="card"><ul class="list plain org-changes">${minors.map((p) => line(p, false)).join('')}</ul></div>` : ''}
    <div class="card" style="margin-top:1rem">
      <button class="btn" data-org-issue="1"${majors.length ? '' : ' disabled'}>Approve and issue ${esc(o.next)}</button>
      <p class="help">You'll be named as the approver. On the Confluence page, Version becomes Issue ${esc(String(o.latest.n + 1))} and Last Reviewed today; Owner and the rest of the table stay as they are. The chart goes underneath as an image and as a PDF in the house style, with the version history and a note of who approved it.</p>
      <div class="result" id="org-result" role="status"></div></div>
    <h2>Versions</h2>
    <div class="table-wrap"><table><thead><tr><th>Reference</th><th>Issued</th><th>Approved by</th><th>Changes</th><th>Confluence</th></tr></thead><tbody>
      ${o.history.map((h, i) => `<tr><td>${esc(h.reference)}</td><td>${shortDate(h.issued_at.slice(0, 10))}</td><td>${esc(h.issued_by_name || '')}</td>
        <td>${esc(h.summary || '')}</td><td>${statusText[h.confluence_status] || ''}${h.confluence_status === 'failed' && i === 0 ? `<br><span class="muted">${esc(h.confluence_error || '')}</span><br><button class="linklike" data-org-publish="${h.n}">Try again</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

async function orgSettingsClick(event) {
  const issueBtn = event.target.closest('[data-org-issue]');
  if (issueBtn) {
    const out = document.getElementById('org-result');
    const excluded = [...view.querySelectorAll('[data-org-count]')].filter((c) => !c.checked).map((c) => Number(c.dataset.orgCount));
    if (!confirm(`Issue ${settingsData.org.next} with you as the approver? It goes to Confluence straight away.`)) return true;
    issueBtn.disabled = true; out.innerHTML = '<span class="spinner" aria-hidden="true"></span> Drawing the chart and sending it to Confluence';
    try {
      const pic = await orgIssueImage(settingsData.org.next);
      const r = await api('/api/admin/org-issue', { method: 'POST', body: JSON.stringify({ ...pic, excluded }) });
      toast(r.published ? `${r.reference} issued and in Confluence` : `${r.reference} issued. Confluence will be updated shortly`);
      settingsData.org = await api('/api/admin/org');
      view.innerHTML = settingsOrgHtml();
    } catch (err) { out.textContent = err.message; issueBtn.disabled = false; }
    return true;
  }
  const pub = event.target.closest('[data-org-publish]');
  if (pub) {
    pub.disabled = true;
    try { const r = await api('/api/admin/org-publish', { method: 'POST', body: JSON.stringify({ n: pub.dataset.orgPublish }) }); toast(r.published ? 'In Confluence' : 'Confluence still refused it'); }
    catch (err) { toast(err.message); }
    settingsData.org = await api('/api/admin/org');
    view.innerHTML = settingsOrgHtml();
    return true;
  }
  return false;
}

// ---------- Audit log ----------

let auditFilter = { area: '', q: '' };
let auditEntries = [];
let auditMore = null;

function auditEntryHtml(e) {
  const when = new Date(e.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return `<li><span class="title">${esc(e.action)}${e.subject_label ? `: ${esc(e.subject_label)}` : ''}</span>
    <span class="sub">${esc(e.area)}. ${esc(e.actor_name || e.actor_email || 'Unknown')}, ${when}.${e.note ? ` ${esc(e.note)}.` : ''}</span>
    ${e.changes.length ? `<table class="audit-changes"><tbody>${e.changes.map((c) => `<tr><th>${esc(c.label)}</th><td>${esc(c.before) || '<span class="muted">blank</span>'}</td><td aria-hidden="true">→</td><td>${esc(c.after) || '<span class="muted">blank</span>'}</td></tr>`).join('')}</tbody></table>` : ''}</li>`;
}

async function loadAudit(append = false) {
  const host = document.getElementById('audit-log');
  if (!host) return;
  const qs = new URLSearchParams({ area: auditFilter.area, q: auditFilter.q, ...(append && auditMore ? { before: auditMore } : {}) });
  const r = await api(`/api/admin/audit?${qs}`).catch((err) => ({ error: err.message }));
  if (r.error) { host.innerHTML = `<div class="card"><p class="bad">${esc(r.error)}</p></div>`; return; }
  // The search box stays put while results change, so typing isn't interrupted.
  if (!host.querySelector('[data-audit-q]')) {
    host.innerHTML = `<div class="row jobs-tools">
        <select data-audit-area aria-label="Area"><option value="">Everything</option>${r.areas.map((a) => `<option${a === auditFilter.area ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select>
        <input type="search" data-audit-q value="${esc(auditFilter.q)}" placeholder="Search people, vehicles or values" aria-label="Search the audit log">
        <a class="btn secondary" data-audit-csv href="#">Download CSV</a></div>
      <div id="audit-results"></div>`;
  }
  host.querySelector('[data-audit-csv]').href = `/api/admin/audit.csv?${new URLSearchParams(auditFilter)}`;
  auditEntries = append ? [...auditEntries, ...r.entries] : r.entries;
  auditMore = r.more;
  host.querySelector('#audit-results').innerHTML = `${auditEntries.length ? `<ul class="list audit-list">${auditEntries.map(auditEntryHtml).join('')}</ul>` : '<div class="card"><p style="margin:0">Nothing recorded yet.</p></div>'}
    ${auditMore ? '<button class="btn secondary" data-audit-more style="margin-top:.85rem">Show older</button>' : ''}`;
}

// ---------- Dragging tiles ----------

// Pointer events cover mouse, touch and pen alike. The tile under the pointer
// makes room as a lifted copy follows the finger; dropping saves the order.
let tileDrag = null;
const TILE_DRAG_START = 6;          // pixels moved before a press becomes a drag
const TILE_EDGE = 70;               // near the top or bottom, the page scrolls

function tileOrderFromDom() {
  return [...document.querySelectorAll('.arranging-grid [data-tile-id]')].map((t) => t.dataset.tileId);
}

// Slides the other tiles from where they were to where they now are.
function tileFlip(grid, move) {
  const tiles = [...grid.querySelectorAll('[data-tile-id]')];
  const before = new Map(tiles.map((t) => [t, t.getBoundingClientRect()]));
  move();
  for (const t of tiles) {
    if (t === tileDrag?.tile) continue;
    const a = before.get(t), b = t.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (!dx && !dy) continue;
    t.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 180, easing: 'ease-out' });
  }
}

function tileDragMove(x, y) {
  const d = tileDrag;
  d.ghost.style.transform = `translate(${x - d.offsetX}px, ${y - d.offsetY}px) scale(1.04)`;
  const over = document.elementFromPoint(x, y)?.closest('.arranging-grid [data-tile-id]');
  if (!over || over === d.tile) return;
  const tiles = [...d.grid.querySelectorAll('[data-tile-id]')];
  const from = tiles.indexOf(d.tile), to = tiles.indexOf(over);
  tileFlip(d.grid, () => over.insertAdjacentElement(from < to ? 'afterend' : 'beforebegin', d.tile));
}

function tileAutoScroll() {
  if (!tileDrag?.active) return;
  const { lastY } = tileDrag;
  const step = lastY < TILE_EDGE ? -12 : lastY > innerHeight - TILE_EDGE ? 12 : 0;
  if (step) { scrollBy(0, step); tileDragMove(tileDrag.lastX, lastY); }
  tileDrag.raf = requestAnimationFrame(tileAutoScroll);
}

async function tileDragEnd(cancelled = false) {
  const d = tileDrag;
  tileDrag = null;
  if (!d?.active) return;
  cancelAnimationFrame(d.raf);
  d.ghost.remove();
  d.tile.classList.remove('drag-placeholder');
  document.body.classList.remove('tile-dragging');
  if (cancelled) { render(); return; }
  const order = tileOrderFromDom();
  if (order.join() === d.startOrder.join()) return;
  tilePrefs.order = order;
  const name = d.tile.querySelector('strong')?.textContent || 'Tile';
  document.getElementById('tile-live').textContent = `${name} moved to position ${order.indexOf(d.tile.dataset.tileId) + 1}.`;
  await saveTilePrefs();
}

view.addEventListener('pointerdown', (event) => {
  const tile = event.target.closest('.arranging-grid [data-tile-id]');
  if (!tile || event.target.closest('button') || event.button > 0) return;
  tileDrag = { tile, grid: tile.parentElement, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
    lastX: event.clientX, lastY: event.clientY, active: false, startOrder: tileOrderFromDom() };
  // Keeps the drag going if the pointer leaves the tile; dragging still works without it.
  try { tile.setPointerCapture(event.pointerId); } catch { /* not every pointer can be captured */ }
});

view.addEventListener('pointermove', (event) => {
  const d = tileDrag;
  if (!d || event.pointerId !== d.pointerId) return;
  d.lastX = event.clientX; d.lastY = event.clientY;
  if (!d.active) {
    if (Math.hypot(event.clientX - d.startX, event.clientY - d.startY) < TILE_DRAG_START) return;
    const r = d.tile.getBoundingClientRect();
    d.offsetX = d.startX - r.left; d.offsetY = d.startY - r.top;
    d.ghost = d.tile.cloneNode(true);
    d.ghost.classList.add('drag-ghost');
    d.ghost.removeAttribute('data-tile-id');
    Object.assign(d.ghost.style, { width: `${r.width}px`, height: `${r.height}px` });
    document.body.appendChild(d.ghost);
    d.tile.classList.add('drag-placeholder');
    document.body.classList.add('tile-dragging');
    d.active = true;
    d.raf = requestAnimationFrame(tileAutoScroll);
  }
  event.preventDefault();
  tileDragMove(event.clientX, event.clientY);
});

view.addEventListener('pointerup', (event) => { if (tileDrag && event.pointerId === tileDrag.pointerId) tileDragEnd(); });
view.addEventListener('pointercancel', (event) => { if (tileDrag && event.pointerId === tileDrag.pointerId) tileDragEnd(true); });

// Arrow keys move the focused tile, for anyone not using a mouse or touch.
view.addEventListener('keydown', async (event) => {
  const tile = event.target.closest?.('.arranging-grid [data-tile-id]');
  if (!tile || event.target !== tile) return;
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const tiles = [...tile.parentElement.querySelectorAll('[data-tile-id]')];
  const i = tiles.indexOf(tile), j = i + step;
  if (j < 0 || j >= tiles.length) return;
  tileFlip(tile.parentElement, () => tiles[j].insertAdjacentElement(step > 0 ? 'afterend' : 'beforebegin', tile));
  tile.focus();
  const order = tileOrderFromDom();
  tilePrefs.order = order;
  document.getElementById('tile-live').textContent = `${tile.querySelector('strong')?.textContent || 'Tile'} moved to position ${j + 1} of ${order.length}.`;
  await saveTilePrefs();
});

// ---------- Groups, teams and what they allow ----------

const GROUP_LABELS = [['admin', 'Admin'], ['management', 'Management'], ['lead', 'Team lead'], ['sales', 'Sales'], ['developer', 'Developer']];

function personAccessHtml(p) {
  const groups = p.groups || [], teams = p.teams || [], leads = p.leadOf || [];
  return `<p class="muted" style="margin:1.5rem 0 .5rem">Access</p>
    <div class="access-groups">${GROUP_LABELS.map(([k, l]) => `<label class="inline-check"><input type="checkbox" data-person-group="${k}"${groups.includes(k) ? ' checked' : ''}> ${l}</label>`).join('')}</div>
    <p class="muted" style="margin:1rem 0 .5rem">Teams</p>
    <div class="chips">${(me.teamsList || []).map((t) => `<button type="button" class="chip${teams.includes(t) ? ' on' : ''}" data-person-team="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <div class="access-leads" ${groups.includes('lead') ? '' : 'hidden'}>
      <p class="muted" style="margin:1rem 0 .5rem">Leads</p>
      <div class="access-groups">${(me.teamsList || []).map((t) => `<label class="inline-check"${teams.includes(t) ? '' : ' hidden'} data-lead-for="${esc(t)}"><input type="checkbox" data-person-lead="${esc(t)}"${leads.includes(t) ? ' checked' : ''}> ${esc(t)}</label>`).join('')}</div>
      <p class="help">A team lead can do everything Management can; their own lists, approvals and alerts are for the teams ticked here.</p>
    </div>`;
}

// What the hub has read from the database today, against Cloudflare's free daily limit.
function readsHtml(r) {
  if (!r) return '';
  const today = new Date().toISOString().slice(0, 10);
  const day = r.days.find((d) => d.day === today) || { background: { total: 0, top: [], runs: 0 }, pages: { total: 0, top: [] }, queries: [] };
  const total = day.background.total + day.pages.total;
  const pct = Math.min(100, total / r.limit * 100);
  const rows = (list) => list.length
    ? `<ul class="list" style="box-shadow:none;margin-top:.5rem">${list.map(([name, rows]) => `<li><span class="title">${esc(name)}</span><span class="xp">${n(rows)}</span></li>`).join('')}</ul>`
    : '<p class="muted">Nothing counted yet.</p>';
  const earlier = r.days.filter((d) => d.day !== today);
  return `<h2>Database reads</h2>
    <div class="card">
      <p style="margin-top:0">Cloudflare's free plan allows ${n(r.limit)} rows read a day, reset at midnight UTC (1am UK time in summer).
      Background jobs stop for the day at ${n(r.backgroundLimit)} so there is always plenty left for people using the hub.</p>
      ${r.paused ? `<div class="card notice error" style="margin:0 0 1rem"><p style="margin:0"><strong>Background jobs are paused until midnight UTC.</strong>
        Tempo time still syncs. Jira lists, PSC items, contracts and ratings catch up tomorrow.</p>
        <div class="row" style="margin-top:.75rem"><button class="btn secondary" data-action="reads-carry-on">Let them carry on today</button></div></div>` : ''}
      <dl class="state">
        <dt>Read today</dt><dd>${n(total)} of ${n(r.limit)}</dd>
        <dt>Background jobs</dt><dd>${n(day.background.total)} over ${n(day.background.runs)} runs</dd>
        <dt>Pages</dt><dd>${n(day.pages.total)}</dd>
      </dl>
      <div class="bar" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></div>
      <div class="result" id="reads-result" role="status"></div>
      <h3 style="margin-bottom:0">Busiest background jobs today</h3>${rows(day.background.top)}
      <h3 style="margin-bottom:0">Busiest pages today</h3>${rows(day.pages.top)}
      ${day.queries?.length ? `<details class="reads-queries"><summary>Busiest database queries today</summary>
        <ul class="list" style="box-shadow:none;margin-top:.5rem">${day.queries.map((x) => `<li><span class="title"><code>${esc(x.q)}</code></span>
          <span class="sub">${esc(x.where)}</span><span class="xp">${n(x.n)}</span></li>`).join('')}</ul></details>` : ''}
      ${earlier.length ? `<h3 style="margin-bottom:0">Earlier days</h3>
        <ul class="list" style="box-shadow:none;margin-top:.5rem">${earlier.map((d) => `<li><span class="title">${esc(d.day)}</span>
          <span class="sub">Background ${n(d.background.total)}, pages ${n(d.pages.total)}${d.background.top[0] ? `. Busiest: ${esc(d.background.top[0][0])}` : ''}</span>
          <span class="xp">${n(d.background.total + d.pages.total)}</span></li>`).join('')}</ul>` : ''}
    </div>`;
}

async function developerAdminHtml() {
  const [data, bitbucket, reads] = await Promise.all([api('/api/admin/overview'), api('/api/admin/bitbucket').catch(() => ({ configured: false, last: null, week: null })),
    api('/api/admin/reads').catch(() => null)]);
  const s = data.state;
  const when = (v) => (v ? new Date(v).toLocaleString('en-GB') : 'Not yet');
  return `${s.last_error ? `<div class="card notice error" style="margin-bottom:1rem"><p><strong>Last sync problem</strong></p><p>${esc(s.last_error)}</p></div>` : '<div class="card notice" style="margin-bottom:1rem"><p style="margin:0">No sync problems.</p></div>'}
    <div class="card"><dl class="state">
        <dt>Last background run</dt><dd>${when(s.last_scheduled_run)}</dd>
        <dt>Ledger started</dt><dd>${esc(s.ledger_start || 'Not started')}</dd>
      </dl>
      <div class="row"><button class="btn secondary" data-action="sync-now">Sync Tempo now</button></div>
      <div class="result" id="sync-result" role="status"></div></div>
    ${bitbucketAdminHtml(bitbucket)}
    ${readsHtml(reads)}`;
}

// ---------- Admin sections that open and close ----------

// Each heading on Admin becomes a section that opens and closes. Which ones are
// open is remembered on this device; everything starts closed so the page is short.
const ADMIN_OPEN_KEY = 'promtek-hub-admin-open';
function adminOpenSections() {
  try { return new Set(JSON.parse(localStorage.getItem(ADMIN_OPEN_KEY) || '[]')); } catch { return new Set(); }
}
function adminSections(html) {
  const parts = html.split(/(?=<h2>)/);
  const head = parts[0].startsWith('<h2>') ? '' : parts.shift();
  const open = adminOpenSections();
  return head + parts.map((part) => {
    const m = part.match(/^<h2>([\s\S]*?)<\/h2>/);
    if (!m) return part;
    const title = m[1].replace(/<[^>]+>/g, '').trim();
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `<details class="admin-section" data-section="${slug}"${open.has(slug) ? ' open' : ''}>
      <summary><h2>${m[1]}</h2></summary><div class="admin-section-body">${part.slice(m[0].length)}</div></details>`;
  }).join('');
}
view.addEventListener('toggle', (event) => {
  const d = event.target;
  if (!d.matches?.('details.admin-section')) return;
  const open = adminOpenSections();
  if (d.open) open.add(d.dataset.section); else open.delete(d.dataset.section);
  try { localStorage.setItem(ADMIN_OPEN_KEY, JSON.stringify([...open])); } catch { /* private browsing: just not remembered */ }
}, true);

// ---------- The active time tracker ----------

let tracker = null;          // the latest from the server
let trackerOffset = 0;       // server clock minus this device's clock
let trackerAssist = null;    // 'team' or 'apprentice' while choosing who
let trackerPeople = null;
let trackerModal = null;     // { kind: 'call' | 'ended', ... }
let trackerPollTimer = null;
const TRACKER_POLL_MS = 20_000;

const clockText = (secs) => {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
};
const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const elapsedSince = (iso) => (Date.now() + trackerOffset - Date.parse(iso)) / 1000;
const assistLabel = (kind) => (kind === 'team' ? 'Assisting the team' : kind === 'apprentice' ? 'Assisting an apprentice' : kind === 'call' ? 'On a call' : '');

function trackerApply(data) {
  if (!data) return;
  if (data.serverNow) trackerOffset = Date.parse(data.serverNow) - Date.now();
  tracker = data;
  trackerBar();
  const host = document.getElementById('tracker-panel');
  if (host) host.outerHTML = trackerPanelHtml();
}

async function trackerLoad() {
  if (!me?.linked) return;
  try { trackerApply(await api('/api/tracker')); } catch { /* the panel just stays as it was */ }
}

async function trackerDo(action, body = {}) {
  try {
    const r = await api(`/api/tracker/${action}`, { method: 'POST', body: JSON.stringify(body) });
    trackerApply(r);
    const waiting = (r.saved || []).find((x) => x.status === 'waiting');
    if (waiting) toast('Saved here; Tempo will get it shortly');
    return r;
  } catch (err) { toast(err.message); return null; }
}

function trackerPanelHtml() {
  const t = tracker?.timer;
  const cur = t?.current;
  const stretches = (tracker?.today || []).filter((x) => x.status !== 'too short');
  const statusText = { logged: 'Logged', waiting: 'Waiting for Tempo', 'needs details': 'Needs call details' };
  const list = stretches.length ? `<ul class="list plain tracker-list">${stretches.map((x) => `<li>
      <span>${hhmm(x.started_at)}–${hhmm(x.ended_at)}</span> <strong>${esc(x.issue_key || 'Call')}</strong>
      <span class="muted">${duration(x.seconds)}${x.kind !== 'job' ? `, ${assistLabel(x.kind).toLowerCase()}` : ''}</span>
      <span class="${x.status === 'logged' ? 'good' : 'bad'}">${statusText[x.status] || esc(x.status)}</span>
      ${x.status === 'needs details' ? `<a class="linklike" href="#/calls">Add details in 8x8 calls</a> <button class="linklike" data-tracker="call-done" data-id="${x.id}">Done</button>` : ''}
    </li>`).join('')}</ul>` : '';
  let body;
  if (!t) {
    body = '<p style="margin:0">Choose a job below, then <strong>Start the timer</strong>. Each time you pause, that stretch is logged with its real start and end.</p>';
  } else if (cur) {
    const interrupted = cur.kind !== 'job';
    body = `<p class="tracker-what">${interrupted ? `<strong>${esc(assistLabel(cur.kind))}${cur.whoName ? `: ${esc(cur.whoName)}` : ''}</strong>${t.job ? `<br><span class="muted">${esc(t.job.issueKey)} is paused</span>` : ''}`
        : `<strong>${esc(cur.issueKey)}</strong> ${esc(cur.summary || '')}`}</p>
      <p class="tracker-clock" data-since="${esc(cur.startedAt)}">${clockText(elapsedSince(cur.startedAt))}</p>
      <p class="muted" style="margin-top:0">Since ${hhmm(cur.startedAt)}</p>
      <div class="row tracker-actions">${interrupted
        ? `${t.job ? `<button class="btn" data-tracker="end-resume">Back to ${esc(t.job.issueKey)}</button>` : ''}<button class="btn secondary" data-tracker="end-stop">Finished${t.job ? `, don't carry on` : ''}</button>`
        : `<button class="btn" data-tracker="pause">Pause</button><button class="btn secondary" data-tracker="stop">Stop</button>`}</div>
      ${!interrupted ? `<div class="row tracker-assist"><button class="chip-btn" data-tracker="assist" data-kind="apprentice">Assisting an apprentice</button>
        <button class="chip-btn" data-tracker="assist" data-kind="team">Assisting the team</button></div>` : ''}
      ${trackerAssist ? trackerAssistHtml() : ''}
      ${elapsedSince(cur.startedAt) > 10 * 3600 ? `<div class="notice card" style="margin-top:.75rem"><p style="margin-top:0">This has been running a long time. If you stopped earlier, say when:</p>
        <div class="row"><label>Stopped at <input type="datetime-local" id="tracker-stop-at"></label><button class="btn secondary" data-tracker="stop-at">Stop it then</button></div></div>` : ''}`;
  } else {
    body = `<p class="tracker-what"><strong>${esc(t.job?.issueKey || '')}</strong> ${esc(t.job?.summary || '')}<br><span class="muted">Paused</span></p>
      <div class="row tracker-actions"><button class="btn" data-tracker="resume">Carry on</button><button class="btn secondary" data-tracker="stop">Stop</button></div>`;
  }
  const notify = 'Notification' in window && Notification.permission === 'default'
    ? '<p class="help" style="margin-bottom:0"><button class="linklike" data-tracker="notify">Turn on notifications</button> to hear about calls when the hub isn\'t the window in front.</p>' : '';
  return `<div class="card tracker-panel${cur ? ' running' : ''}" id="tracker-panel">${body}${list}${notify}</div>`;
}

function trackerAssistHtml() {
  const people = (trackerPeople || []).filter((p) => p.id !== me.employee?.accountId);
  return `<div class="tracker-assist-form">
      <label>Who are you helping? <select id="assist-who"><option value="">Not saying</option>${people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <label>Their job, if you know it <input id="assist-job" placeholder="For example MES-412" autocomplete="off"></label>
      <div class="row"><button class="btn" data-tracker="assist-start">Start</button><button class="btn secondary" data-tracker="assist-cancel">Cancel</button></div>
      <p class="help">Logged to ${trackerAssist === 'team' ? 'PMB-37' : 'PMB-39'}; your job pauses until you're back.</p></div>`;
}

// A slim bar at the foot of every page while something is being timed.
function trackerBar() {
  let bar = document.getElementById('tracker-bar');
  const cur = tracker?.timer?.current;
  logFab();
  if (!cur || currentRoute() === '#/log' || currentRoute() === '#/') { if (bar) bar.remove(); document.body.classList.remove('has-tracker-bar'); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'tracker-bar'; document.body.appendChild(bar); }
  document.body.classList.add('has-tracker-bar');
  bar.innerHTML = `<a href="#/log" class="tracker-bar-what"><span class="dot" aria-hidden="true"></span>
      ${esc(cur.kind === 'job' ? cur.issueKey : assistLabel(cur.kind))} <span class="tracker-clock-small" data-since="${esc(cur.startedAt)}">${clockText(elapsedSince(cur.startedAt))}</span></a>
    ${cur.kind === 'job' ? '<button class="btn secondary" data-tracker="pause">Pause</button>' : `<button class="btn secondary" data-tracker="${tracker.timer.job ? 'end-resume' : 'end-stop'}">${tracker.timer.job ? 'Back to job' : 'Finished'}</button>`}`;
}

setInterval(() => {
  document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = clockText(elapsedSince(el.dataset.since)); });
}, 1000);

function trackerModalHtml() {
  const m = trackerModal;
  if (!m) return '';
  if (m.kind === 'call') {
    const c = m.call;
    return `<div class="modal-backdrop"><div class="modal card" role="dialog" aria-modal="true" aria-labelledby="call-title">
      <h2 id="call-title" style="margin-top:0">${c.live ? "You're on a call" : 'You had a call'}</h2>
      <p>${esc(c.otherName || c.other || 'A call')}, ${c.live ? `since ${hhmm(new Date(c.startedAt).toISOString())}` : `${hhmm(new Date(c.startedAt).toISOString())} to ${hhmm(new Date(c.endedAt).toISOString())}`}.
        ${tracker?.timer?.job && tracker.timer.current?.kind === 'job' ? `${esc(tracker.timer.job.issueKey)} pauses from when the call started.` : ''}</p>
      <div class="modal-actions">
        <button class="btn" data-call-choice="call">Log time to this call</button>
        <button class="btn secondary" data-call-choice="team">Assisting the team</button>
        <button class="btn secondary" data-call-choice="apprentice">Assisting an apprentice</button>
        <button class="linklike" data-call-choice="ignore">Not this one</button></div></div></div>`;
  }
  return `<div class="modal-backdrop"><div class="modal card" role="dialog" aria-modal="true" aria-labelledby="ended-title">
    <h2 id="ended-title" style="margin-top:0">${m.callKind === 'call' ? 'Call ended' : 'Call logged'}</h2>
    <p>${m.callKind === 'call' ? 'Add its details in 8x8 calls when you\'re ready.' : 'That time has gone to Tempo.'}${m.job ? ` Carry on with ${esc(m.job.issueKey)}?` : ''}</p>
    <div class="modal-actions">${m.job ? `<button class="btn" data-ended="resume">Carry on with ${esc(m.job.issueKey)}</button><button class="btn secondary" data-ended="no">Not now</button>` : '<button class="btn" data-ended="no">OK</button>'}</div></div></div>`;
}

function trackerShowModal(m) {
  trackerModal = m;
  document.getElementById('tracker-modal')?.remove();
  if (!m) return;
  const host = document.createElement('div');
  host.id = 'tracker-modal';
  host.innerHTML = trackerModalHtml();
  document.body.appendChild(host);
  host.querySelector('button')?.focus();
  if (m.kind === 'call' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(m.call.live ? "You're on a call" : 'You had a call', { body: `${m.call.otherName || m.call.other || 'A call'}. Log the time in Promtek Hub?`, tag: `call-${m.call.callId}` });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers only allow notifications from an installed app */ }
  }
}

async function trackerPoll() {
  if (!me?.linked || trackerModal) return;
  try {
    const r = await api('/api/tracker/poll');
    trackerApply(r);
    if (r.callEnded) trackerShowModal({ kind: 'ended', callKind: r.callEnded.kind, job: r.callEnded.job });
    else if (r.call) trackerShowModal({ kind: 'call', call: r.call });
  } catch { /* try again next time */ }
}

function trackerInit() {
  trackerLoad();
  clearInterval(trackerPollTimer);
  trackerPollTimer = setInterval(trackerPoll, TRACKER_POLL_MS);
}

document.addEventListener('click', async (event) => {
  const t = (sel) => event.target.closest(sel);
  const choice = t('[data-call-choice]');
  if (choice) {
    const c = trackerModal.call;
    trackerShowModal(null);
    await trackerDo('call', { callId: c.callId, choice: choice.dataset.callChoice, startedAt: c.startedAt, endedAt: c.endedAt || null });
    return;
  }
  const ended = t('[data-ended]');
  if (ended) { trackerShowModal(null); if (ended.dataset.ended === 'resume') await trackerDo('resume'); return; }
  const mode = t('[data-log-mode]');
  if (mode && logChosen) {
    if (mode.dataset.logMode === 'manual') { logMode = 'manual'; await render(); updateXpPreview(); return loadStageHint(); }
    mode.disabled = true;
    const r = await trackerDo('start', { issueId: logChosen.issueId, issueKey: logChosen.label, summary: logChosen.title || '' });
    if (r) { logChosen = null; logMode = null; logNode = null; window.scrollTo(0, 0); render(); toast(`Timing ${r.timer.current.issueKey}`); }
    else mode.disabled = false;
    return;
  }
  const b = t('[data-tracker]');
  if (!b) return;
  const a = b.dataset.tracker;
  if (a === 'pause' || a === 'resume' || a === 'stop') { b.disabled = true; await trackerDo(a); return; }
  if (a === 'stop-at') {
    const v = document.getElementById('tracker-stop-at').value;
    if (!v) { toast('Choose when you stopped'); return; }
    await trackerDo('stop', { endedAt: new Date(v).toISOString() }); return;
  }
  if (a === 'end-resume' || a === 'end-stop') { b.disabled = true; await trackerDo('end-interruption', { resume: a === 'end-resume' }); return; }
  if (a === 'assist') {
    trackerAssist = b.dataset.kind;
    if (!trackerPeople) {
      try { trackerPeople = (await api('/api/org')).nodes.map((n) => ({ id: n.id, name: n.name })).sort((x, y) => x.name.localeCompare(y.name)); } catch { trackerPeople = []; }
    }
    trackerApply(tracker); return;
  }
  if (a === 'assist-cancel') { trackerAssist = null; trackerApply(tracker); return; }
  if (a === 'assist-start') {
    const who = document.getElementById('assist-who');
    const kind = trackerAssist; trackerAssist = null;
    await trackerDo('assist', { kind, whoId: who.value || null, whoName: who.value ? who.selectedOptions[0].textContent : null,
      theirKey: document.getElementById('assist-job').value.trim().toUpperCase() || null });
    return;
  }
  if (a === 'call-done') { await trackerDo('call-logged', { stretchId: b.dataset.id }); await trackerLoad(); return; }
  if (a === 'notify') { try { await Notification.requestPermission(); } catch { /* ignored */ } trackerApply(tracker); return; }

});

// After choosing a job: time already done, or time it as you go.
function logChoiceHtml() {
  const running = tracker?.timer?.current;
  const switching = running && running.kind === 'job' && running.issueKey !== logChosen.label;
  return `<div class="card">
      <p class="muted" style="margin:0 0 .35rem">You chose</p>
      <h3 style="margin:0">${esc(logChosen.label)} ${esc(logChosen.title || '')}</h3>
      <p class="muted" style="margin:.25rem 0 0">${esc(logChosen.sublabel || '')}</p>
    </div>
    <div class="log-choices">
      <button class="log-choice" data-log-mode="manual">
        <span class="log-choice-icon" aria-hidden="true">${svgIcon('<path d="M4 5h16v15H4zM4 9h16M9 3v4M15 3v4"/>')}</span>
        <span><strong>Add time already done</strong><span class="muted">Say when you started and how long it took.</span></span>
      </button>
      <button class="log-choice" data-log-mode="timer">
        <span class="log-choice-icon" aria-hidden="true">${svgIcon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>')}</span>
        <span><strong>Start the timer</strong><span class="muted">${switching
          ? `Your timer on ${esc(running.issueKey)} logs what it has so far and moves to this job.`
          : 'Times it as you work; each time you pause is logged with its start and end.'}</span></span>
      </button>
    </div>
    <div class="row" style="margin-top:1rem"><button class="btn secondary" data-action="cancel-log">Pick something else</button></div>`;
}

// The Log time button on the home screen. While a timer runs it shows the job and clock instead.
function logFab() {
  let fab = document.getElementById('log-fab');
  if (currentRoute() !== '#/') { if (fab) fab.remove(); document.body.classList.remove('has-log-fab'); return; }
  if (!fab) { fab = document.createElement('a'); fab.id = 'log-fab'; fab.href = '#/log'; document.body.appendChild(fab); }
  document.body.classList.add('has-log-fab');
  const cur = tracker?.timer?.current;
  fab.className = `log-fab${cur ? ' running' : ''}`;
  fab.setAttribute('aria-label', cur ? `Timer running on ${cur.kind === 'job' ? cur.issueKey : assistLabel(cur.kind)}. Open Log time.` : 'Log time');
  fab.innerHTML = cur
    ? `<span class="dot" aria-hidden="true"></span><span>${esc(cur.kind === 'job' ? cur.issueKey : assistLabel(cur.kind))}</span><span class="tracker-clock-small" data-since="${esc(cur.startedAt)}">${clockText(elapsedSince(cur.startedAt))}</span>`
    : `${svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')}<span>Log time</span>`;
}

// ---------- Requests ----------

let reqFilter = 'open';
let reqDraft = { kind: '', tile: '', title: '', details: '' };
let reqFormOpen = false;
const REQ_STATUS_CLASS = { new: '', working: 'working', complete: 'good', rejected: 'muted' };

function reqFormHtml(data) {
  const tiles = MODULES.filter((m) => allowedTile(m)).map((m) => m.name);
  return `<div class="card req-form">
      <h2 style="margin-top:0">Send a request</h2>
      <p class="muted" style="margin-top:0">What is it?</p>
      <div class="req-kinds">${Object.entries(data.kinds).map(([k, l]) => `<button type="button" class="chip${reqDraft.kind === k ? ' on' : ''}" data-req-kind="${k}">${esc(l)}</button>`).join('')}</div>
      <label>Which part of the hub? <select data-req="tile"><option value="">The hub in general</option>${[...tiles, 'Log time'].sort().map((t) => `<option${t === reqDraft.tile ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label>Title <input data-req="title" maxlength="140" value="${esc(reqDraft.title)}" placeholder="For example: show my hours for the month on My time"></label>
      <label>Details <textarea data-req="details" rows="6" maxlength="5000" placeholder="What would you like, or what happened? For a problem: what you did, what you expected, and what you saw.">${esc(reqDraft.details)}</textarea></label>
      <div class="row"><button class="btn" data-req-send>Send</button>${data.developer ? '<button class="btn secondary" data-req-cancel>Cancel</button>' : ''}</div>
      <div class="result" id="req-result" role="status"></div></div>`;
}

function reqItemHtml(r, data) {
  const when = new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const status = `<span class="req-status ${REQ_STATUS_CLASS[r.status] || ''}">${esc(data.statuses[r.status] || r.status)}</span>`;
  const head = `<div class="req-head"><span class="title">${esc(r.title)}</span>${status}</div>
    <span class="sub">${esc(data.kinds[r.kind] || r.kind)}${r.tile ? `, ${esc(r.tile)}` : ''}. ${data.developer ? `${esc(r.name || r.email)}, ` : ''}${when}.</span>`;
  const details = `<p class="pre-wrap req-details">${esc(r.details)}</p>`;
  if (!data.developer) {
    return `<li>${head}${details}${r.reply ? `<blockquote class="dispute-words"><strong>${esc(r.updated_by || 'Reply')}:</strong> ${esc(r.reply)}</blockquote>` : ''}</li>`;
  }
  return `<li data-req-id="${r.id}">${head}${details}
      <label class="req-reply">Reply to ${esc((r.name || 'them').split(' ')[0])}, optional<textarea rows="2" data-req-reply maxlength="2000" placeholder="They'll see this with the status">${esc(r.reply || '')}</textarea></label>
      <div class="row req-actions">${Object.entries(data.statuses).map(([k, l]) => `<button class="btn${k === r.status ? '' : ' secondary'}" data-req-status="${k}">${esc(l)}</button>`).join('')}</div></li>`;
}

async function requestsHtml() {
  const data = await api(`/api/requests${reqFilter ? `?status=${reqFilter}` : ''}`);
  if (!data.developer) {
    return `${reqFormHtml(data)}<h2>Your requests</h2>
      ${data.requests.length ? `<ul class="list req-list">${data.requests.map((r) => reqItemHtml(r, data)).join('')}</ul>`
        : '<div class="card"><p style="margin:0">Nothing sent yet. Anything you send appears here, with where it has got to.</p></div>'}`;
  }
  const c = data.counts || {};
  const filters = [['open', `Open (${(c.new || 0) + (c.working || 0)})`], ['new', `New (${c.new || 0})`], ['working', `Working on it (${c.working || 0})`],
    ['complete', `Complete (${c.complete || 0})`], ['rejected', `Not going ahead (${c.rejected || 0})`], ['', 'All']];
  return `<div class="row jobs-tools"><span class="segment req-filters">${filters.map(([k, l]) => `<button class="seg${reqFilter === k ? ' on' : ''}" data-req-filter="${k}">${l}</button>`).join('')}</span>
      ${reqFormOpen ? '' : '<button class="btn secondary" data-req-new>Send a request</button>'}</div>
    ${reqFormOpen ? reqFormHtml(data) : ''}
    ${data.requests.length ? `<ul class="list req-list">${data.requests.map((r) => reqItemHtml(r, data)).join('')}</ul>`
      : '<div class="card"><p style="margin:0">Nothing here.</p></div>'}`;
}

function reqReadDraft() {
  view.querySelectorAll('[data-req]').forEach((el) => { reqDraft[el.dataset.req] = el.value; });
}

async function requestsClick(event) {
  const t = (sel) => event.target.closest(sel);
  const kind = t('[data-req-kind]');
  if (kind) {
    reqDraft.kind = kind.dataset.reqKind;
    kind.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === kind));
    return true;
  }
  if (t('[data-req-filter]')) { reqFilter = t('[data-req-filter]').dataset.reqFilter; return render(); }
  if (t('[data-req-new]')) { reqFormOpen = true; return render(); }
  if (t('[data-req-cancel]')) { reqFormOpen = false; return render(); }
  const send = t('[data-req-send]');
  if (send) {
    reqReadDraft();
    send.disabled = true;
    try {
      await api('/api/requests', { method: 'POST', body: JSON.stringify(reqDraft) });
      reqDraft = { kind: '', tile: '', title: '', details: '' }; reqFormOpen = false;
      toast('Sent'); return render();
    } catch (err) { document.getElementById('req-result').textContent = err.message; send.disabled = false; }
    return true;
  }
  const st = t('[data-req-status]');
  if (st) {
    const item = st.closest('[data-req-id]');
    st.disabled = true;
    try {
      await api('/api/requests/update', { method: 'POST', body: JSON.stringify({ id: item.dataset.reqId, status: st.dataset.reqStatus,
        reply: item.querySelector('[data-req-reply]').value }) });
      toast('Updated'); return render();
    } catch (err) { toast(err.message); st.disabled = false; }
    return true;
  }
  return false;
}

// ---------- service contracts ----------

let conTab = 'contracts';      // contracts, insights
let conFilter = 'active';
let conTier = '';
let conOpen = null;            // the contract opened, by key
let conAllFlags = false;

const CON_FILTERS = [
  ['active', 'Active', (c) => ['Contract Confirmed', 'In Contract', 'Required Renewal'].includes(c.status)],
  ['renewal', 'Renewal due', (c) => c.status === 'Required Renewal'],
  ['pending', 'Not yet accepted', (c) => ['New', 'Contract Sent', 'Needs Chasing'].includes(c.status)],
  ['expired', 'Expired', (c) => c.status === 'Contract Expired'],
  ['all', 'All', () => true],
];
const CON_STATUS_CLASS = {
  'New': 'grey', 'Contract Sent': 'grey', 'Needs Chasing': 'amber', 'Contract Confirmed': 'blue',
  'In Contract': 'green', 'Required Renewal': 'amber', 'Contract Expired': 'red',
};
const FLAG_TITLES = {
  dates: 'Dates look wrong', 'start-passed': 'Start date passed, not accepted', 'psc-org': 'PSC with no Organization',
  'org-map': 'Organization matches no customer', write: 'Jira didn\'t take a change', clock: 'Clock and tokens disagree',
};
const fullDate = (iso) => (iso ? dateOf(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const whenText = (isoTime) => (isoTime ? new Date(isoTime).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'not yet');
const jiraLink = (key, label = key) => `<a href="${esc(me.jiraBaseUrl)}/browse/${esc(key)}" target="_blank" rel="noopener">${esc(label)}</a>`;
const bankHolidayIcon = () => `<span class="con-bh" title="Covers bank holidays">${svgIcon('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><path d="M12 12.5l1 2 2.2.3-1.6 1.5.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.5 2.2-.3z"/>')}<span class="visually-hidden">Covers bank holidays</span></span>`;

function conStatus(status) {
  return `<span class="con-status ${CON_STATUS_CLASS[status] || 'grey'}">${esc(status)}</span>`;
}

function conPeriodBar(c, today) {
  if (!c.start || !c.end) return '';
  const span = Math.max(1, (dateOf(c.end) - dateOf(c.start)));
  const pct = (d) => Math.min(100, Math.max(0, ((dateOf(d) - dateOf(c.start)) / span) * 100));
  return `<div class="con-period" aria-hidden="true"><span style="width:${pct(today)}%"></span>
    ${c.renewal ? `<i style="left:${pct(c.renewal)}%" title="Renewal"></i>` : ''}</div>`;
}

function conCount(label, x) {
  if (!x) return '';
  return `<div><b>${x.done} of ${x.total}</b><span>${label}</span></div>`;
}

function conTokensHtml(t) {
  if (!t || !t.total) return '<p class="muted con-none">No tokens on this contract.</p>';
  const w = (v) => `${(v / Math.max(1, t.total)) * 100}%`;
  return `<div class="con-tokens">
      <div class="con-token-bar" aria-hidden="true"><span class="u" style="width:${w(t.spent)}"></span><span class="x" style="width:${w(t.expired)}"></span><span class="a" style="width:${w(t.allocated)}"></span></div>
      <p><b>${t.free}</b> available · <b>${t.allocated}</b> allocated to jobs · <b>${t.spent}</b> used${t.expired ? ` · ${t.expired} expired` : ''} <span class="muted">of ${t.total}</span>
        ${t.overdraft ? `<span class="con-od">${t.overdraft} overdraft</span>` : ''}</p>
    </div>`;
}

function conClockHtml(clock, big = false) {
  if (!clock) return '';
  const pct = (clock.towardsNext / (4 * 3600)) * 100;
  return `<div class="con-clock${big ? ' big' : ''}">
      <div class="con-clock-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <p><b>${duration(clock.towardsNext)}</b> towards the next token <span class="muted">· ${duration(clock.seconds)} on the clock</span></p>
    </div>`;
}

function conCardHtml(c, today) {
  const search = `${c.customer} ${c.key} ${c.project} ${c.tier || ''} ${c.status}`.toLowerCase();
  return `<article class="card con-card" data-con-open="${esc(c.key)}" data-search="${esc(search)}" tabindex="0" role="button" aria-label="${esc(c.customer)}, ${esc(c.status)}">
      <div class="con-head">
        <div class="con-name"><h3>${esc(c.customer)}</h3><p class="muted">${esc(c.key)}${c.tier ? ` · ${esc(c.tier)}` : ''}</p></div>
        <div class="con-tags">${c.bankHoliday ? bankHolidayIcon() : ''}${conStatus(c.status)}</div>
      </div>
      <p class="con-dates">${fullDate(c.start)} to ${fullDate(c.end)} <span class="muted">· renewal ${fullDate(c.renewal)}</span></p>
      ${conPeriodBar(c, today)}
      ${c.live ? `<div class="con-figs">${conCount('Service visits', c.visits)}${conCount('Calibration', c.calibration)}${conCount('Obsolescence', c.obsolescence)}</div>
        ${conTokensHtml(c.tokens)}${conClockHtml(c.clock)}`
        : '<p class="muted con-none">Visits and tokens show once the contract is confirmed.</p>'}
    </article>`;
}

function conFlagsHtml(flags) {
  if (!flags.length) return '';
  const shown = conAllFlags ? flags : flags.slice(0, 4);
  return `<section class="card con-flags notice">
      <h2>Needs attention <span class="muted">(${flags.length})</span></h2>
      <ul class="con-flag-list">${shown.map((f) => `<li>
          <div><strong>${esc(FLAG_TITLES[f.kind] || 'Alert')}</strong>
            <span class="muted">${f.contract_key ? `${esc(f.customer || '')} ${jiraLink(f.contract_key)}` : f.ref_key ? jiraLink(f.ref_key) : ''}</span>
            <p>${esc(f.detail)}</p></div>
          <button class="btn secondary" data-con-resolve="${f.id}">Mark resolved</button></li>`).join('')}</ul>
      ${flags.length > 4 ? `<button class="linklike" data-con-flags="1">${conAllFlags ? 'Show fewer' : `Show all ${flags.length}`}</button>` : ''}
    </section>`;
}

function conTabsHtml(data) {
  if (!data.canInsights) return '';
  return `<div class="tabs con-tabs">${[['contracts', 'Contracts'], ['insights', 'Insights']].map(([k, l]) =>
    `<button class="tab${conTab === k ? ' on' : ''}" data-con-tab="${k}">${l}</button>`).join('')}</div>`;
}

function conTrackingLine(data) {
  if (!data.started) {
    return `<div class="card notice"><p><strong>Contract tracking hasn't started.</strong> Contracts are shown as they are in Jira; statuses, tokens and alerts are handled once an admin starts tracking${data.isAdmin ? ' from the settings cog above' : ''}.</p></div>`;
  }
  return `<p class="help con-tracking">Token clocks count time logged from ${fullDate(data.clockStart)}. Last clock change ${whenText(data.clockChanged)}; read from Jira ${whenText(data.syncedAt)}.</p>`;
}

function conBankHolidayHtml(bh, contracts) {
  if (!bh) return '';
  if (bh.today) {
    const covered = contracts.filter((c) => c.bankHoliday && ['In Contract', 'Required Renewal'].includes(c.status)).length;
    return `<div class="card notice con-bh-today"><p>${bankHolidayIcon()} <strong>Today is a bank holiday: ${esc(bh.today.name)}.</strong>
      Only contracts showing the bank holiday badge are covered today${covered ? ` (${covered} live)` : ''}.</p></div>`;
  }
  return `<p class="help con-bh-line">${bankHolidayIcon()} Today isn't a bank holiday.${bh.next ? ` Next: ${esc(bh.next.name)}, ${longDate(bh.next.date)}.` : ''}</p>`;
}

async function contractsHtml() {
  if (conOpen) return contractDetailHtml();
  const data = await api('/api/contracts');
  if (conTab === 'insights' && data.canInsights) return conTabsHtml(data) + await contractInsightsHtml();
  const today = data.today;
  const count = (fn) => data.contracts.filter(fn).length;
  const tiers = [...new Set(data.contracts.map((c) => c.tier).filter(Boolean))].sort();
  const filter = CON_FILTERS.find((f) => f[0] === conFilter) || CON_FILTERS[0];
  const list = data.contracts.filter(filter[2]).filter((c) => !conTier || c.tier === conTier);
  return `${conTabsHtml(data)}
    ${conTrackingLine(data)}
    ${conBankHolidayHtml(data.bankHoliday, data.contracts)}
    ${conFlagsHtml(data.flags)}
    <dl class="stats con-stats">
      <div><dt>In contract</dt><dd>${count((c) => c.status === 'In Contract')}</dd></div>
      <div><dt>Renewal due</dt><dd>${count((c) => c.status === 'Required Renewal')}</dd></div>
      <div><dt>Needs chasing</dt><dd>${count((c) => c.status === 'Needs Chasing')}</dd></div>
      <div><dt>Confirmed, not started</dt><dd>${count((c) => c.status === 'Contract Confirmed')}</dd></div>
    </dl>
    <div class="row con-tools">
      <span class="segment">${CON_FILTERS.map(([k, l]) => `<button class="seg${conFilter === k ? ' on' : ''}" data-con-filter="${k}">${l}</button>`).join('')}</span>
      ${tiers.length > 1 ? `<label class="con-tier">Tier <select data-con-tier>${['', ...tiers].map((t) => `<option value="${esc(t)}"${t === conTier ? ' selected' : ''}>${t ? esc(t) : 'All tiers'}</option>`).join('')}</select></label>` : ''}
      <input type="search" id="con-search" placeholder="Search customers or keys" aria-label="Search contracts">
    </div>
    <div class="con-grid">${list.map((c) => conCardHtml(c, today)).join('') || '<div class="card"><p style="margin:0">No contracts here.</p></div>'}</div>`;
}

async function contractDetailHtml() {
  const d = await api(`/api/contracts/detail?key=${encodeURIComponent(conOpen)}`);
  const c = d.contract;
  const today = todayIso();
  const kindLabel = { visit: 'Service visit', calibration: 'Calibration visit', obsolescence: 'Obsolescence survey', token: 'Token' };
  const visits = d.items.filter((i) => i.kind !== 'token');
  const tokens = d.items.filter((i) => i.kind === 'token');
  const itemRow = (i) => `<li><span class="title">${jiraLink(i.key)} ${esc(i.summary)}</span>
      <span class="xp${i.done ? ' con-done' : ''}">${esc(i.status)}</span><span class="sub">${kindLabel[i.kind]}</span></li>`;
  return `<div class="row" style="margin-bottom:1rem"><button class="btn secondary" data-con-back="1">All contracts</button></div>
    <section class="card con-detail-head">
      <div class="con-head">
        <div class="con-name"><h2>${esc(c.customer)}</h2><p class="muted">${jiraLink(c.key)}${c.tier ? ` · ${esc(c.tier)}` : ''}${c.bankHoliday ? ' · covers bank holidays' : ''}</p></div>
        <div class="con-tags">${c.bankHoliday ? bankHolidayIcon() : ''}${conStatus(c.status)}</div>
      </div>
      <p class="con-dates">${fullDate(c.start)} to ${fullDate(c.end)} <span class="muted">· renewal ${fullDate(c.renewal)}${c.renewalSet ? '' : ' (worked out: not set in Jira)'}</span></p>
      ${conPeriodBar(c, today)}
      ${d.problems.length ? `<div class="notice con-problem"><p><strong>The dates look wrong.</strong> ${esc(d.problems.join(' '))}</p></div>` : ''}
      ${c.live ? `<div class="con-figs">${conCount('Service visits', c.visits)}${conCount('Calibration', c.calibration)}${conCount('Obsolescence', c.obsolescence)}</div>${conTokensHtml(c.tokens)}` : ''}
    </section>
    ${c.clock ? `<h2>Token clock</h2>
      <section class="card">${conClockHtml(c.clock, true)}
        <p class="muted" style="margin:.4rem 0 0">Time on the contract item, its tokens and this customer's PSC items (not Snags) since ${fullDate(d.clockStart)}. Every 4 hours uses a token; at the end of the contract, an hour or more left over uses one more.</p>
      </section>
      ${d.contributions.length ? `<ul class="list con-list">${d.contributions.map((x) => `<li><span class="title">${x.key ? jiraLink(x.key) : ''} ${esc(x.summary || '')}</span>
        <span class="xp">${duration(x.seconds)}</span></li>`).join('')}</ul>` : ''}` : ''}
    ${d.charges.length ? `<h2>Tokens used by the clock</h2><ul class="list con-list">${d.charges.map((x) => `<li>
        <span class="title">${x.token ? jiraLink(x.token) : 'Choosing a token'}${x.overdraft ? ' <span class="con-od">overdraft</span>' : ''}</span>
        <span class="xp">${x.done ? 'Used' : 'Waiting for Jira'}</span>
        <span class="sub">${x.reason === 'end' ? 'Time left when the contract ended' : `Clock passed ${x.seq * 4}h${x.trigger ? ` on ${esc(x.trigger)}` : ''}`} · ${whenText(x.at)}${x.error ? ` · ${esc(x.error)}` : ''}</span></li>`).join('')}</ul>` : ''}
    ${visits.length ? `<h2>Visits</h2><ul class="list con-list">${visits.map(itemRow).join('')}</ul>` : ''}
    ${tokens.length ? `<h2>Tokens</h2><ul class="list con-list">${tokens.map(itemRow).join('')}</ul>` : ''}
    ${d.events.length ? `<h2>Changes made in Jira</h2><ul class="list con-list">${d.events.map((e) => `<li><span class="title">${esc(e.text)}</span><span class="sub">${whenText(e.at)}</span></li>`).join('')}</ul>` : ''}`;
}

async function contractInsightsHtml() {
  const s = await api('/api/contracts/insights');
  const r = s.renewals;
  const decided = r.renewed + r.lost;
  const rate = decided ? Math.round((r.renewed / decided) * 100) : null;
  const logTable = (logs, { showWho = true, showCustomer = false } = {}) => `<ul class="con-logs">${logs.map((l) => `<li>
      <span class="con-log-date">${shortDate(l.date)}</span>
      <span class="con-log-what">${l.key ? jiraLink(l.key) : ''} ${esc(l.summary || '')}
        <span class="muted">${[showCustomer && l.customer ? esc(l.customer) : '', showWho ? esc(l.who) : ''].filter(Boolean).join(' · ')}</span></span>
      <span class="con-log-time">${duration(l.seconds)}</span></li>`).join('')}</ul>`;
  const hBar = (rows, label, opts) => {
    const max = Math.max(1, ...rows.map((x) => x.seconds));
    return rows.length ? `<div class="con-bars">${rows.map((x) => `<details class="con-bar-row">
      <summary><span class="con-bar-label">${esc(label(x))}</span>
        <span class="con-bar"><span style="width:${(x.seconds / max) * 100}%"></span></span><span class="con-bar-value">${duration(x.seconds)}</span></summary>
      ${logTable(x.logs, opts)}</details>`).join('')}</div>`
      : `<p class="muted">Nothing in the last ${s.time.days} days.</p>`;
  };
  return `
    <h2>Renewals</h2>
    <dl class="stats con-stats">
      <div><dt>Renewal rate, last 12 months</dt><dd>${rate === null ? '—' : `${rate}%`}<small>${r.renewed} renewed, ${r.lost} lost</small></dd></div>
      <div><dt>Ended, no decision yet</dt><dd>${r.undecided}</dd></div>
    </dl>
    <div class="two-up con-two">
      <section class="card"><h3>Ending in the next 90 days</h3>
        ${r.upcoming.length ? `<ul class="con-rows">${r.upcoming.map((u) => `<li><span>${esc(u.customer)} ${jiraLink(u.key)}</span><span class="muted">${fullDate(u.end)} · ${u.days} days</span></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}</section>
      <section class="card"><h3>Waiting to be accepted</h3>
        ${r.chasing.length ? `<ul class="con-rows">${r.chasing.map((u) => `<li><span>${esc(u.customer)} ${jiraLink(u.key)}</span><span class="${u.late ? 'con-late' : 'muted'}">${u.late ? 'Start date passed' : `Starts ${fullDate(u.start)}`}</span></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}</section>
    </div>

    <h2>Tokens</h2>
    <p class="help">How far through each contract is against how many tokens are used. A token bar ahead of the time bar means tokens are going faster than the contract.</p>
    ${s.pace.length ? `<ul class="list con-pace">${s.pace.map((p) => `<li>
        <span class="title">${esc(p.customer)} ${jiraLink(p.key)} ${p.overdraft ? `<span class="con-od">${p.overdraft} overdraft</span>` : ''}</span>
        <span class="xp">${p.used} of ${p.total}${p.allocated ? `<small>+${p.allocated} allocated</small>` : ''}</span>
        <span class="sub con-pace-bars"><span class="con-mini"><span style="width:${Math.round(p.timeShare * 100)}%"></span></span> time
          <span class="con-mini tok${p.tokenShare > p.timeShare + 0.1 ? ' ahead' : ''}"><span style="width:${Math.round(p.tokenShare * 100)}%"></span></span> tokens
          ${p.left <= 0 ? '<b class="con-late">No tokens left</b>' : p.early ? `<b class="con-late">Runs out about ${fullDate(p.runsOut)}, before the contract ends</b>` : ''}</span></li>`).join('')}</ul>` : '<div class="card"><p class="muted" style="margin:0">No live contracts with tokens.</p></div>'}

    <h2>Visits falling behind</h2>
    ${s.behind.length ? `<ul class="list">${s.behind.map((b) => `<li><span class="title">${esc(b.customer)} ${jiraLink(b.key)}</span>
        <span class="xp">${b.done} of ${b.total}</span><span class="sub">${esc(b.label)} · ${b.weeksLeft} ${b.weeksLeft === 1 ? 'week' : 'weeks'} left</span></li>`).join('')}</ul>`
      : '<div class="card"><p class="muted" style="margin:0">Every contract is on track for its visits.</p></div>'}

    <h2>Time not reaching a contract</h2>
    <p class="help">The last 90 days of time that can't count towards a contract's tokens. Tap a customer to see the time logs.</p>
    <div class="two-up con-two">
      <section class="card"><h3>PSC items with no Organization</h3>
        ${s.leaks.noOrg.length ? `<ul class="con-rows">${s.leaks.noOrg.map((x) => `<li><span>${jiraLink(x.key)} ${esc(x.summary || '')}</span><span class="muted">${duration(x.seconds)}</span></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}</section>
      <section class="card"><h3>Customers with no live contract</h3>
        ${s.leaks.noContract.length ? `<div class="con-expand">${s.leaks.noContract.map((x) => `<details>
            <summary><span>${esc(x.customer)}</span><span class="muted">${duration(x.seconds)}</span></summary>
            ${logTable(x.logs)}</details>`).join('')}</div>` : '<p class="muted">None.</p>'}
        ${s.leaks.unmatched.length ? `<h3 style="margin-top:1rem">Organizations matching no customer</h3><ul class="con-rows">${s.leaks.unmatched.map((x) => `<li><span>${esc(x.org)}</span><span class="muted">${duration(x.seconds)}</span></li>`).join('')}</ul>` : ''}</section>
    </div>

    <h2>Bank holidays coming up</h2>
    <div class="con-holidays">${s.holidays.map((h) => `<section class="card"><h3>${esc(h.name)}</h3><p class="muted" style="margin:0">${longDate(h.date)}${h.date.slice(0, 4) !== s.today.slice(0, 4) ? ` ${h.date.slice(0, 4)}` : ''}</p></section>`).join('')}</div>

    <h2>Where service time went</h2>
    <p class="help">Time logged to live contracts and their customers' PSC items in the last ${s.time.days} days. Tap a row to see the time logs behind it.</p>
    <div class="two-up con-two">
      <section class="card"><h3>By customer</h3>${hBar(s.time.customers, (x) => x.customer)}</section>
      <section class="card"><h3>By engineer</h3>${hBar(s.time.people, (x) => x.name, { showWho: false, showCustomer: true })}</section>
    </div>`;
}

async function contractsClick(event) {
  const t = (sel) => event.target.closest(sel);
  if (t('a')) return false;
  const tab = t('[data-con-tab]');
  if (tab) { conTab = tab.dataset.conTab; conOpen = null; return render(); }
  const f = t('[data-con-filter]');
  if (f) { conFilter = f.dataset.conFilter; return render(); }
  if (t('[data-con-flags]')) { conAllFlags = !conAllFlags; return render(); }
  if (t('[data-con-back]')) { conOpen = null; return render(); }
  const res = t('[data-con-resolve]');
  if (res) {
    res.disabled = true;
    try { await api('/api/contracts/resolve', { method: 'POST', body: JSON.stringify({ id: Number(res.dataset.conResolve) }) }); toast('Marked resolved'); }
    catch (err) { toast(err.message); }
    return render();
  }
  const card = t('[data-con-open]');
  if (card) { conOpen = card.dataset.conOpen; return render(); }
  return false;
}

function contractsInput(event) {
  if (event.target.id === 'con-search') {
    const q = event.target.value.trim().toLowerCase();
    for (const card of view.querySelectorAll('.con-card')) card.hidden = Boolean(q) && !card.dataset.search.includes(q);
    return true;
  }
  if (event.target.matches('[data-con-tier]')) { conTier = event.target.value; render(); return true; }
  return false;
}

// Settings, under the cog.
function settingsContractsHtml() {
  const s = settingsData.contracts;
  if (s.error) return `<div class="card notice error"><p>${esc(s.error)}</p></div>`;
  const leads = s.people.filter((p) => p.lead);
  const others = s.people.filter((p) => !p.lead);
  return `<section class="card">
      <h2 style="margin-top:0">Tracking</h2>
      ${s.started
        ? `<p>Started ${whenText(s.started)}. Token clocks count time logged from ${fullDate(s.clockStart)}.</p>
           <p class="muted">Read from Jira ${whenText(s.syncedAt)}. Last clock change ${whenText(s.clockChanged)}. ${n(s.tokens.used)} ${s.tokens.used === 1 ? 'token' : 'tokens'} used by the clocks${s.tokens.waiting ? `, ${s.tokens.waiting} waiting for Jira` : ''}.</p>`
        : `<p>Once started, the hub moves contracts between statuses as their dates arrive, keeps each contract's token clock, uses and expires tokens, keeps the token counts on each contract up to date, and sends contract alerts.</p>
           <p>The clocks count time logged from the day tracking starts. Turn off the matching Jira automations at the same time, so nothing happens twice.</p>
           <p><button class="btn" data-con-start="1">Start tracking</button></p>`}
      ${s.error ? `<div class="notice error" style="margin-top:.75rem"><p>${esc(s.error)}</p></div>` : ''}
      <p><button class="btn secondary" data-con-refresh="1">Read from Jira now</button></p>
    </section>
    <section class="card" style="margin-top:1rem">
      <h2 style="margin-top:0">Who gets contract alerts</h2>
      <p>${leads.length ? `The Service team ${leads.length === 1 ? 'lead always gets them' : 'leads always get them'}: ${leads.map((p) => esc(p.name)).join(', ')}.` : 'No one leads the Service team yet, so alerts go to the hub\'s alert address.'} Also send them to:</p>
      <div class="con-chosen">${s.extra.length ? s.extra.map((email) => {
        const p = s.people.find((x) => x.email === email);
        return `<span class="con-person">${esc(p?.name || email)}<button data-con-remove="${esc(email)}" aria-label="Stop sending alerts to ${esc(p?.name || email)}">×</button></span>`;
      }).join('') : '<span class="muted">No one else yet.</span>'}</div>
      <div class="con-picker">
        <input id="con-person-search" type="search" placeholder="Type a name to add someone" autocomplete="off"
          role="combobox" aria-expanded="false" aria-controls="con-person-list" aria-autocomplete="list">
        <div class="con-drop" id="con-person-list" role="listbox" hidden>
          ${others.filter((p) => !s.extra.includes(p.email)).map((p) => `<button class="con-drop-item" role="option" data-con-add="${esc(p.email)}"
              data-search="${esc(`${p.name} ${p.email}`.toLowerCase())}"><strong>${esc(p.name)}</strong><span class="muted">${esc(p.email)}</span></button>`).join('')}
          <p class="muted con-drop-none" hidden>No one matches.</p>
        </div>
      </div>
    </section>
    <section class="card" style="margin-top:1rem">
      <h2 style="margin-top:0">Organizations</h2>
      <p>PSC items name their customer in the Organization field. Each is matched to the customer's project by name; choose the customer for any that don't match, or that match the wrong one.</p>
      ${s.orgs.length ? `<ul class="con-orgs">${s.orgs.map((o) => `<li><span>${esc(o.org)}</span>
          <select data-con-org="${esc(o.org)}"><option value="">${o.project && !o.manual ? `Matched: ${esc(s.projects.find((p) => p.key === o.project)?.name || o.project)}` : 'No customer'}</option>
            ${s.projects.map((p) => `<option value="${esc(p.key)}"${o.manual === p.key ? ' selected' : ''}>${esc(p.name)} (${esc(p.key)})</option>`).join('')}</select></li>`).join('')}</ul>`
        : '<p class="muted">No PSC time has been looked at yet.</p>'}
    </section>`;
}

async function contractsSettingsClick(event) {
  const t = (sel) => event.target.closest(sel);
  if (t('[data-con-start]')) {
    if (!confirm('Start contract tracking now? Turn off the Jira automations for service contracts at the same time.')) return true;
    try { await api('/api/contracts/start', { method: 'POST', body: '{}' }); toast('Contract tracking started'); } catch (err) { toast(err.message); }
    render(); return true;
  }
  const refresh = t('[data-con-refresh]');
  if (refresh) {
    refresh.disabled = true;
    try { const r = await api('/api/contracts/refresh', { method: 'POST', body: '{}' }); toast(r.partial ? 'Read part of it; the rest follows shortly' : 'Up to date with Jira'); } catch (err) { toast(err.message); }
    render(); return true;
  }
  const add = t('[data-con-add]'), remove = t('[data-con-remove]');
  if (add || remove) {
    const s = settingsData.contracts;
    const emails = add ? [...s.extra, add.dataset.conAdd] : s.extra.filter((e) => e !== remove.dataset.conRemove);
    try {
      await api('/api/contracts/recipients', { method: 'POST', body: JSON.stringify({ emails }) });
      toast(add ? 'Added' : 'Removed');
    } catch (err) { return toast(err.message), true; }
    await render();
    if (add) document.getElementById('con-person-search')?.focus();
    return true;
  }
  return false;
}

// The type-to-filter list of people for contract alerts.
function conPicker(open, query = '') {
  const list = document.getElementById('con-person-list');
  const input = document.getElementById('con-person-search');
  if (!list || !input) return;
  let shown = 0;
  for (const item of list.querySelectorAll('[data-con-add]')) {
    item.hidden = Boolean(query) && !item.dataset.search.includes(query);
    if (!item.hidden) shown++;
  }
  list.querySelector('.con-drop-none').hidden = shown > 0;
  list.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
}

function contractsSettingsInput(event) {
  if (event.target.id !== 'con-person-search') return false;
  conPicker(true, event.target.value.trim().toLowerCase());
  return true;
}

view.addEventListener('focusin', (event) => {
  if (settingsOpen === '#/contracts' && event.target.id === 'con-person-search') conPicker(true, event.target.value.trim().toLowerCase());
});
document.addEventListener('click', (event) => {
  if (settingsOpen === '#/contracts' && !event.target.closest('.con-picker')) conPicker(false);
});
view.addEventListener('keydown', (event) => {
  if (settingsOpen !== '#/contracts' || event.target.id !== 'con-person-search') return;
  if (event.key === 'Escape') conPicker(false);
  if (event.key === 'Enter') {
    event.preventDefault();
    [...document.querySelectorAll('#con-person-list [data-con-add]')].find((b) => !b.hidden)?.click();
  }
  if (event.key === 'ArrowDown') { event.preventDefault(); [...document.querySelectorAll('#con-person-list [data-con-add]')].find((b) => !b.hidden)?.focus(); }
});
document.addEventListener('keydown', (event) => {
  const item = event.target.closest?.('#con-person-list [data-con-add]');
  if (!item || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const items = [...document.querySelectorAll('#con-person-list [data-con-add]')].filter((b) => !b.hidden);
  const i = items.indexOf(item) + (event.key === 'ArrowDown' ? 1 : -1);
  if (i < 0) document.getElementById('con-person-search').focus(); else items[Math.min(i, items.length - 1)].focus();
});

async function contractsSettingsChange(event) {
  const sel = event.target.closest('[data-con-org]');
  if (!sel) return false;
  try { await api('/api/contracts/org', { method: 'POST', body: JSON.stringify({ org: sel.dataset.conOrg, projectKey: sel.value }) }); toast('Saved'); }
  catch (err) { toast(err.message); }
  return true;
}

// Logging time to a Service Contract item: ask first whether it was really a contracted visit.
async function contractCheck() {
  if (!logChosen?.issueId) return;
  try {
    const c = await api(`/api/contracts/check?issueId=${encodeURIComponent(logChosen.issueId)}`);
    if (c.contract) logChosen.contractCheck = { ...c, step: 'warn' };
  } catch { /* no warning rather than no logging */ }
}

function contractWarnHtml() {
  const c = logChosen.contractCheck;
  const body = c.step === 'visits'
    ? `<h2 id="con-warn-title">Which visit?</h2>
       ${c.visits.length ? `<div class="options">${c.visits.map(optionRow).join('')}</div>` : `<p>${esc(c.contract.customer)} has no contracted visits in Jira.</p>`}
       <div class="modal-actions"><button class="btn secondary" data-con-warn="back">Back</button></div>`
    : `<h2 id="con-warn-title">Is this a contracted visit?</h2>
       <p>Do not assign time to this item if you are logging time for a contracted Service, Calibration or Obsolescence Survey visit.</p>
       <div class="modal-actions"><button class="btn" data-con-warn="visits">Log time to contracted visit</button>
         <button class="btn secondary" data-con-warn="continue">Continue</button></div>`;
  return `<div class="modal-backdrop"><div class="modal card con-warn" role="dialog" aria-modal="true" aria-labelledby="con-warn-title">${body}</div></div>`;
}

async function contractWarnClick(event) {
  const b = event.target.closest('[data-con-warn]');
  if (!b || !logChosen?.contractCheck) return false;
  const act = b.dataset.conWarn;
  if (act === 'visits') logChosen.contractCheck.step = 'visits';
  if (act === 'back') logChosen.contractCheck.step = 'warn';
  if (act === 'continue') delete logChosen.contractCheck;
  await render();
  if (act === 'continue' && logMode) { updateXpPreview(); loadStageHint(); }
  return true;
}

// ---------- service items (PSCs) ----------

let pscTab = 'open';            // triage, open, insights
let pscOpen = null;             // the item opened, by key
let pscCustomer = '';
let pscWho = 'all';             // all, mine, unassigned
let pscShow = 'open';           // open, resolved
let pscSnags = false;
let pscSort = 'attention';
let pscTier = '';
let pscOrgs = null;             // the service desk's Organizations, once loaded
let pscData = null;
let pscFetchedAt = 0;
const PSC_KEEP_MS = 5 * 60 * 1000;

// The list is kept on the page and only fetched again when something has
// changed, or after 5 minutes so how long items have waited stays right.
// Switching tabs, filtering and sorting use what is already here.
async function pscLoad({ force = false } = {}) {
  const age = Date.now() - pscFetchedAt;
  if (!force && pscData && age < PSC_KEEP_MS) {
    if (age < 60_000) return pscData;
    const { version } = await api('/api/psc/version').catch(() => ({}));
    if (version && version === pscData.version) return pscData;
  }
  pscData = await api('/api/psc');
  pscFetchedAt = Date.now();
  return pscData;
}

const PSC_STATE = {
  late: ['late', 'Late'], waiting: ['amber', 'Customer waiting'], new: ['blue', 'New'],
  quiet: ['amber', 'Quiet'], active: ['green', 'In hand'], resolved: ['grey', 'Resolved'],
};
const HOW_TEXT = { comment: 'commented', status: 'moved it on', assignee: 'assigned it', 'raised by the team': 'raised it', 'logged time': 'logged time', 'picked it up': 'picked it up', 'closed it': 'closed it' };

function agoText(iso) {
  if (!iso) return '';
  const ahead = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (ahead >= 1) return ahead < 60 ? `in ${ahead}m` : ahead < 1440 ? `in ${Math.round(ahead / 60)}h` : `in ${Math.round(ahead / 1440)}d`;
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 14 ? `${days}d ago` : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
const workText = (msv) => duration(Math.round((msv || 0) / 1000));

function pscStatePill(d) {
  const [cls, label] = PSC_STATE[d.state] || PSC_STATE.active;
  return `<span class="con-status ${cls === 'late' ? 'red' : cls}">${label}</span>`;
}

function pscTierBadge(d) {
  if (d.tier === 'none') return `<span class="psc-tier t-none" title="Chargeable: support is paid for as needed">${d.contract ? esc(d.contract.tier || 'Bronze') : 'No contract'} · chargeable</span>`;
  return `<span class="psc-tier t-${d.tier}" title="${esc(d.contract?.key || '')}">${esc(d.tierName)}</span>${d.contract?.tokensFree != null ? `<span class="psc-chip plain">${d.contract.tokensFree} ${d.contract.tokensFree === 1 ? 'token' : 'tokens'} free</span>` : ''}${d.contract?.bankHoliday ? bankHolidayIcon() : ''}`;
}

const timeOf = (iso) => {
  const t = new Date(iso);
  const sameDay = t.toDateString() === new Date().toDateString();
  return t.toLocaleString('en-GB', sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

function pscResponseChip(d) {
  if (d.state === 'resolved') return '';
  const r = d.response;
  const clock = svgIcon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>');
  if (!r.at && r.late) return `<span class="psc-chip bad">${clock} First look was due ${timeOf(r.dueAt)}, waiting ${workText(r.waitMs)}</span>`;
  if (!r.at) {
    const out = `<span class="psc-chip ${r.leftMs < 3600000 ? 'warn' : 'plain'}">${clock} First look due ${timeOf(r.dueAt)} (${workText(Math.max(0, r.leftMs))} left)</span>`;
    return out + (d.cover.raisedInCover ? '' : `<span class="psc-chip plain" title="Raised outside ${esc(d.tierName)} cover; the clock started when cover began">Raised outside cover</span>`);
  }
  if (r.how === 'raised by the team') return `<span class="psc-chip">Raised by ${esc((r.by || 'the team').split(' ')[0])}</span>`;
  return `<span class="psc-chip${r.late ? ' bad' : ''}">First look ${r.late ? 'took' : 'in'} ${workText(r.waitMs)}${r.by ? ` by ${esc(r.by.split(' ')[0])}` : ''}</span>`;
}

function pscUpdateChips(d) {
  const out = [];
  if (d.customerWaiting) out.push(`<span class="psc-chip warn">${esc((d.customerLast.by || 'Customer').split(' ')[0])} replied ${agoText(d.customerLast.at)}, waiting on us</span>`);
  if (d.lastTeam && d.response.at) out.push(`<span class="psc-chip${d.stale ? ' warn' : ''}">Last update ${agoText(d.lastTeam.at)}: ${esc((d.lastTeam.by || '').split(' ')[0])} ${esc(d.lastTeam.what || '')}</span>`);
  return out.join('');
}

function pscCardHtml(d, { triage = false } = {}) {
  const search = `${d.key} ${d.summary} ${d.customer || ''} ${d.org || ''} ${d.assignee || ''} ${d.type}`.toLowerCase();
  return `<article class="card psc-card s-${d.state}" data-psc-open="${esc(d.key)}" data-search="${esc(search)}" tabindex="0" role="button" aria-label="${esc(d.key)} ${esc(d.summary)}">
      <div class="psc-top"><span class="psc-key">${esc(d.key)}</span><span class="muted">${esc(d.type)}${d.priority ? ` · ${esc(d.priority)}` : ''}${d.copyOf ? ` · from ${esc(d.copyOf)}` : ''}</span>${pscStatePill(d)}</div>
      <h3>${esc(d.summary)}</h3>
      <p class="psc-meta">${pscTierBadge(d)}<span>${d.customer ? esc(d.customer) : '<b class="con-late">No customer</b>'}</span>
        <span class="muted">· ${d.assignee ? esc(d.assignee) : '<b>Unassigned</b>'} · ${esc(d.status)} · raised ${agoText(d.created)}</span></p>
      <div class="psc-chips">${pscResponseChip(d)}${pscUpdateChips(d)}${d.uncopied ? `<span class="psc-chip warn" title="It has an Organization but no copy in the customer's project has been found">Not copied to ${esc(d.customer || 'the customer')}'s project</span>` : ''}</div>
      ${triage ? pscTriageActions(d) : ''}
    </article>`;
}

function pscPeopleSelect(d) {
  const people = pscData?.people || [];
  return `<select data-psc-assign="${esc(d.key)}" aria-label="Assign ${esc(d.key)}"><option value="">${d.assignee ? `Assigned to ${esc(d.assignee)}` : 'Assign to…'}</option>
    ${people.map((p) => `<option value="${esc(p.id)}"${p.id === d.assigneeId ? ' disabled' : ''}>${esc(p.name)}${p.service ? '' : ' (not Service)'}</option>`).join('')}</select>`;
}

function pscOrgSelect(d) {
  if (!pscOrgs) return `<button class="btn secondary" data-psc-load-orgs="1">Set the Organization</button>`;
  if (pscOrgs.error) return `<span class="muted">${esc(pscOrgs.error)}</span>`;
  return `<select data-psc-org="${esc(d.key)}" aria-label="Organization for ${esc(d.key)}"><option value="">${d.org ? esc(d.org) : 'Choose the Organization…'}</option>
    ${pscOrgs.orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>`;
}

function pscTriageActions(d) {
  const need = { org: 'No Organization', assignee: 'No one assigned', response: 'No one has looked at it' };
  return `<div class="psc-triage">
      <p class="psc-needs">${d.missing.map((m) => `<span class="psc-chip bad">${need[m]}</span>`).join('')}</p>
      <div class="psc-actions">
        ${d.missing.includes('response') || d.assigneeId !== pscData?.me ? '<button class="btn" data-psc-pickup="KEY">I\'m on it</button>'.replace('KEY', esc(d.key)) : ''}
        ${pscPeopleSelect(d)}
        ${d.missing.includes('org') ? pscOrgSelect(d) : ''}
      </div>
    </div>`;
}

function pscTabsHtml(data) {
  const triage = data.items.filter((d) => !d.orderWork && d.missing.length).length;
  const open = data.items.filter((d) => !d.orderWork && d.state !== 'resolved').length;
  return `<div class="tabs con-tabs psc-tabs">${[['triage', `Triage${triage ? ` (${triage})` : ''}`], ['open', `Open (${open})`], ['insights', 'Insights']].map(([k, l]) =>
    `<button class="tab${pscTab === k ? ' on' : ''}" data-psc-tab="${k}">${l}</button>`).join('')}</div>`;
}

function pscHeadLine(data) {
  return `<div class="psc-headline"><p class="help">${data.reading ? `Reading everything from Jira: ${data.reading.count} items so far. The rest follows over the next few minutes.` : `Read from Jira ${data.syncedAt ? agoText(data.syncedAt) : 'not yet'}.`}</p>
      <button class="btn secondary" data-psc-refresh="1">Refresh</button></div>
    ${data.pending.length ? `<div class="card notice"><p><strong>Waiting for Jira:</strong> ${data.pending.map((w) => `${esc(w.label || 'A change')} on ${esc(w.issue_key)}`).join('; ')}. The hub keeps trying.</p></div>` : ''}`;
}

async function pscHtml() {
  if (pscOpen) return pscItemHtml();
  const data = await pscLoad();
  if (pscTab === 'insights') return pscTabsHtml(data) + await pscInsightsHtml();
  if (pscTab === 'triage') {
    const list = data.items.filter((d) => !d.orderWork && d.missing.length);
    if (list.some((d) => d.missing.includes('org')) && !pscOrgs) pscOrgs = await api('/api/psc/orgs').catch((err) => ({ orgs: [], error: err.message }));
    return `${pscTabsHtml(data)}${pscHeadLine(data)}
      <p class="help">New items, and any missing an Organization or an owner. Each leaves this list once it has all three.</p>
      <div class="psc-list">${list.map((d) => pscCardHtml(d, { triage: true })).join('') || '<div class="card"><p style="margin:0">Nothing to triage. Every item has a customer, an owner and a first look.</p></div>'}</div>`;
  }
  const base = data.items.filter((d) => (pscSnags || !d.orderWork) && (pscShow === 'resolved' ? d.state === 'resolved' : d.state !== 'resolved'));
  const customers = [...new Set(base.map((d) => d.customer || 'No customer'))].sort();
  let list = base.filter((d) => !pscCustomer || (d.customer || 'No customer') === pscCustomer)
    .filter((d) => !pscTier || d.tier === pscTier)
    .filter((d) => pscWho === 'all' || (pscWho === 'mine' ? d.assigneeId === data.me : !d.assigneeId));
  const order = {
    attention: null,                   // the order the hub works out: late, waiting, then due soonest, higher contracts first
    oldest: (a, b) => Date.parse(a.created) - Date.parse(b.created),
    quiet: (a, b) => Date.parse(a.lastTeam?.at || a.created) - Date.parse(b.lastTeam?.at || b.created),
    customer: (a, b) => String(a.customer || '~').localeCompare(String(b.customer || '~')) || a.rank - b.rank,
  };
  if (order[pscSort]) list = [...list].sort(order[pscSort]);
  const open = data.items.filter((d) => !d.orderWork && d.state !== 'resolved');
  const n = (fn) => open.filter(fn).length;
  return `${pscTabsHtml(data)}${pscHeadLine(data)}
    <dl class="stats con-stats">
      <div><dt>Waiting for a first look</dt><dd>${n((d) => !d.response.at)}<small>${n((d) => d.state === 'late')} late</small></dd></div>
      <div><dt>Customer waiting on us</dt><dd>${n((d) => d.customerWaiting)}</dd></div>
      <div><dt>Quiet for ${data.settings.staleDays}+ days</dt><dd>${n((d) => d.stale)}</dd></div>
      <div><dt>Unassigned</dt><dd>${n((d) => !d.assigneeId)}</dd></div>
    </dl>
    <div class="row con-tools psc-tools">
      <span class="segment">${[['all', 'Everyone\'s'], ['mine', 'Mine'], ['unassigned', 'Unassigned']].map(([k, l]) => `<button class="seg${pscWho === k ? ' on' : ''}" data-psc-who="${k}">${l}</button>`).join('')}</span>
      <label class="con-tier">Contract <select data-psc-tier><option value="">All</option>${Object.entries(data.tiers).map(([k, t]) => `<option value="${k}"${pscTier === k ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="con-tier">Customer <select data-psc-customer><option value="">All customers</option>${customers.map((c) => `<option${c === pscCustomer ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label class="con-tier">Sort <select data-psc-sort>${[['attention', 'Needs attention'], ['oldest', 'Oldest first'], ['quiet', 'Longest without an update'], ['customer', 'Customer']].map(([k, l]) => `<option value="${k}"${pscSort === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <input type="search" id="psc-search" placeholder="Search keys, summaries or people" aria-label="Search PSCs">
      <label class="inline-check psc-check"><input type="checkbox" data-psc-resolved${pscShow === 'resolved' ? ' checked' : ''}> Resolved</label>
      <label class="inline-check psc-check"><input type="checkbox" data-psc-snags${pscSnags ? ' checked' : ''}> Include Snags</label>
    </div>
    <div class="psc-list">${list.map((d) => pscCardHtml(d)).join('') || `<div class="card"><p style="margin:0">${pscShow === 'resolved' ? 'Nothing resolved in the last 30 days here.' : 'Nothing open here.'}</p></div>`}</div>`;
}

async function pscItemHtml() {
  const { item: d, timeline } = await api(`/api/psc/item?key=${encodeURIComponent(pscOpen)}`);
  await pscLoad();
  if (d.project === 'PSC' && !pscOrgs) pscOrgs = await api('/api/psc/orgs').catch((err) => ({ orgs: [], error: err.message }));
  const when = (iso) => (iso ? `${new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} (${agoText(iso)})` : '—');
  const kindText = { comment: 'Comment', status: 'Status', assignee: 'Owner', created: 'Raised', time: 'Time', hub: 'Hub' };
  return `<div class="row" style="margin-bottom:1rem"><button class="btn secondary" data-psc-back="1">All items</button></div>
    <section class="card psc-detail">
      <div class="psc-top"><span class="psc-key">${jiraLink(d.key)}</span><span class="muted">${esc(d.type)}${d.priority ? ` · ${esc(d.priority)}` : ''}${d.copyOf ? ` · copied from ${jiraLink(d.copyOf)}` : ''}</span>${pscStatePill(d)}</div>
      <h2>${esc(d.summary)}</h2>
      <p class="psc-meta">${pscTierBadge(d)}<span>${d.customer ? esc(d.customer) : '<b class="con-late">No customer</b>'}</span><span class="muted">· ${esc(d.status)}</span></p>
      <dl class="psc-facts">
        <div><dt>Raised</dt><dd>${when(d.created)}${d.reporter ? ` by ${esc(d.reporter)}` : ''}</dd></div>
        <div><dt>First look</dt><dd>${d.response.at ? `${when(d.response.at)} by ${esc(d.response.by || 'the team')}, who ${HOW_TEXT[d.response.how] || d.response.how}, ${workText(d.response.waitMs)} after it was raised.`
          : `<b class="${d.response.late ? 'con-late' : ''}">Not yet: waiting ${workText(d.response.waitMs)}.</b>`}</dd></div>
        <div><dt>Last update from the team</dt><dd>${d.lastTeam ? `${when(d.lastTeam.at)}: ${esc(d.lastTeam.by || '')} ${esc(d.lastTeam.what || '')}` : '—'}</dd></div>
        <div><dt>Customer's last word</dt><dd>${d.customerLast ? `${when(d.customerLast.at)} from ${esc(d.customerLast.by || 'the customer')}${d.customerWaiting ? ' <b class="con-late">· waiting on us</b>' : ''}` : '—'}</dd></div>
        <div><dt>Owner</dt><dd>${d.assignee ? esc(d.assignee) : '<b>Unassigned</b>'}</dd></div>
        <div><dt>First look due</dt><dd>${when(d.response.dueAt)}, ${workText(d.response.targetMs)} after ${d.cover.raisedInCover ? 'it was raised' : `${esc(d.tierName)} cover began`}</dd></div>
      </dl>
      ${pscTermsHtml(d)}
      <div class="psc-actions">
        ${d.state !== 'resolved' ? `<button class="btn" data-psc-pickup="${esc(d.key)}">I'm on it</button>` : ''}
        <button class="btn secondary" data-psc-log="${esc(d.key)}">Log time</button>
        ${pscPeopleSelect(d)}
        ${d.project === 'PSC' ? pscOrgSelect(d) : ''}
      </div>
    </section>
    <h2>History</h2>
    <ul class="list psc-timeline">${timeline.map((e) => `<li class="${e.team ? 'team' : 'customer'}${e.internal ? ' internal' : ''}">
        <span class="title"><span class="psc-kind k-${esc(e.kind)}">${kindText[e.kind] || ''}</span> ${esc(e.by || '')}${e.team ? '' : ' <span class="psc-chip plain">customer</span>'}${e.internal ? ' <span class="psc-chip plain">internal note</span>' : ''}</span>
        <span class="xp"><small>${agoText(e.at)}</small></span>
        <span class="sub pre-wrap">${esc(e.text || '')}</span></li>`).join('')}</ul>`;
}

// What the customer's contract gives them, for whoever picks the item up.
function pscTermsHtml(d) {
  const t = pscData?.tiers?.[d.tier];
  if (!t) return '';
  const yes = (v) => (v ? 'Included' : 'Not included');
  const surcharge = pscData?.surcharge || 750;
  if (d.tier === 'none') {
    return `<div class="psc-terms none"><h3>No contract: chargeable</h3>
      <p>${d.customer ? esc(d.customer) : 'This customer'} has no live service contract${d.contract ? ` (${esc(d.contract.tier || 'Bronze')})` : ''}, so support is lowest priority and paid for as needed. Agree the cost before going ahead with any work or callout.</p>
      ${d.cover.raisedInCover ? '' : `<p class="psc-out">Raised outside office hours. A callout out of office hours carries the £${surcharge} breakdown surcharge.</p>`}</div>`;
  }
  return `<div class="psc-terms t-${d.tier}"><h3>${esc(t.name)} contract${d.contract?.end ? ` <span class="muted">until ${fullDate(d.contract.end)}</span>` : ''}</h3>
    <dl>
      <div><dt>Cover</dt><dd>${esc(t.coverText)}${d.contract?.bankHoliday ? ', bank holidays included' : ''}</dd></div>
      <div><dt>Callout response</dt><dd>${esc(t.callout)}</dd></div>
      <div><dt>Callout rates</dt><dd>£${t.calloutRate}/hour, £${t.mileage.toFixed(2)}/mile</dd></div>
      <div><dt>Time and materials</dt><dd>£${t.tmRate}/hour</dd></div>
      <div><dt>Tokens</dt><dd>${d.contract?.tokensFree != null ? `${d.contract.tokensFree} free of ${t.tokens} a year` : `${t.tokens} a year`}${t.rollover ? ', rollover included' : ''}</dd></div>
      <div><dt>Remote access</dt><dd>${yes(t.remote)} where applicable</dd></div>
      <div><dt>Support portal</dt><dd>${yes(t.portal)}</dd></div>
      <div><dt>Dedicated service line</dt><dd>${yes(t.line)}</dd></div>
    </dl>
    ${d.cover.raisedInCover ? '' : `<p class="psc-out">Raised outside ${esc(t.name)} cover. The first-look clock started when cover began, and a callout out of office hours carries the £${surcharge} breakdown surcharge.</p>`}
    <p class="muted psc-terms-note">Software modifications of up to 4 tokens can be done under tokens; anything bigger is quoted at time and materials.</p></div>`;
}

async function pscInsightsHtml() {
  const s = await api('/api/psc/insights');
  const pct = s.response.count ? Math.round((s.response.inTarget / s.response.count) * 100) : null;
  const bars = (rows, label = (x) => x.name) => {
    const max = Math.max(1, ...rows.map((x) => x.n));
    return rows.length ? `<div class="con-bars">${rows.map((x) => `<div class="psc-bar-row"><span class="con-bar-label">${esc(label(x))}</span>
      <span class="con-bar"><span style="width:${(x.n / max) * 100}%"></span></span><span class="con-bar-value">${x.n}</span></div>`).join('')}</div>` : '<p class="muted">None.</p>';
  };
  return `<h2>First response</h2>
    <dl class="stats con-stats">
      <div><dt>Typical first look, last 30 days</dt><dd>${s.response.medianMs == null ? '—' : workText(s.response.medianMs)}<small>median</small></dd></div>
      <div><dt>On time for their contract</dt><dd>${pct == null ? '—' : `${pct}%`}<small>${s.response.inTarget} of ${s.response.count}</small></dd></div>
      <div><dt>Waiting for a first look now</dt><dd>${s.response.unanswered}</dd></div>
      <div><dt>Customers waiting on us</dt><dd>${s.states.waiting}</dd></div>
    </dl>
    <div class="table-wrap"><table class="psc-weeks"><thead><tr><th>Week starting</th><th>Raised</th><th>First look on time</th><th>Resolved</th></tr></thead>
      <tbody>${s.weeks.map((w) => `<tr><td>${shortDate(w.start)}</td><td>${w.raised}</td><td>${w.answered ? `${w.inTarget} of ${w.answered}` : '—'}</td><td>${w.resolved}</td></tr>`).join('')}</tbody></table></div>
    <h2>By contract</h2>
    <div class="table-wrap"><table class="psc-weeks"><thead><tr><th>Contract</th><th>First look target</th><th>Typical first look</th><th>On time</th><th>Open now</th></tr></thead>
      <tbody>${s.byTier.map((t) => `<tr><td><span class="psc-tier t-${t.tier}">${esc(t.name)}</span></td><td>${t.target}h</td><td>${t.medianMs == null ? '—' : workText(t.medianMs)}</td>
        <td>${t.count ? `${t.inTarget} of ${t.count}` : '—'}</td><td>${t.open}</td></tr>`).join('')}</tbody></table></div>
    <h2>Open items</h2>
    <div class="two-up con-two">
      <section class="card"><h3>How old they are</h3>${bars(s.ages, (x) => x.label)}</section>
      <section class="card"><h3>Who has them</h3>${bars(s.byAssignee)}</section>
      <section class="card"><h3>By customer</h3>${bars(s.byCustomer)}</section>
      <section class="card"><h3>Longest without an update</h3>
        ${s.oldestQuiet.length ? `<ul class="con-rows">${s.oldestQuiet.map((x) => `<li><span>${jiraLink(x.key)} ${esc(x.summary)}<span class="muted" style="display:block;font-size:.85rem">${esc(x.customer || 'No customer')} · ${esc(x.lastTeam.by || '')}</span></span><span class="muted">${agoText(x.lastTeam.at)}</span></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}</section>
    </div>`;
}

async function pscClick(event) {
  const t = (sel) => event.target.closest(sel);
  if (t('a') || t('select') || t('input') || t('label')) return false;
  const tab = t('[data-psc-tab]');
  if (tab) { pscTab = tab.dataset.pscTab; pscOpen = null; return render(); }
  const who = t('[data-psc-who]');
  if (who) { pscWho = who.dataset.pscWho; return render(); }
  if (t('[data-psc-back]')) { pscOpen = null; return render(); }
  if (t('[data-psc-refresh]')) {
    const b = t('[data-psc-refresh]'); b.disabled = true;
    try { const r = await api('/api/psc/refresh', { method: 'POST', body: '{}' }); toast(r.skipped ? 'Read from Jira under a minute ago' : r.reading ? `${r.count} read so far; the rest follows shortly` : 'Up to date with Jira'); } catch (err) { toast(err.message); }
    pscFetchedAt = 0;
    return render();
  }
  if (t('[data-psc-load-orgs]')) { pscOrgs = await api('/api/psc/orgs').catch((err) => ({ orgs: [], error: err.message })); return render(); }
  const pick = t('[data-psc-pickup]');
  if (pick) {
    pick.disabled = true;
    try { const r = await api('/api/psc/pickup', { method: 'POST', body: JSON.stringify({ key: pick.dataset.pscPickup }) }); toast(r.saved ? 'It\'s yours' : r.message); } catch (err) { toast(err.message); }
    pscFetchedAt = 0;
    return render();
  }
  const log = t('[data-psc-log]');
  if (log) {
    const d = pscData?.items.find((x) => x.key === log.dataset.pscLog);
    if (!d) return true;
    logChosen = { issueId: d.id, label: d.key, title: d.summary, sublabel: d.customer || '', rate: 1, jobElo: null };
    logMode = null;
    pscOpen = null;
    location.hash = '#/log';
    return true;
  }
  const card = t('[data-psc-open]');
  if (card) { pscOpen = card.dataset.pscOpen; return render(); }
  return false;
}

async function pscChange(event) {
  const el = event.target;
  const send = async (path, body, done) => {
    el.disabled = true;
    try { const r = await api(path, { method: 'POST', body: JSON.stringify(body) }); toast(r.saved ? done : r.message); } catch (err) { toast(err.message); }
    pscFetchedAt = 0;
    render();
  };
  if (el.matches('[data-psc-assign]') && el.value) { await send('/api/psc/assign', { key: el.dataset.pscAssign, accountId: el.value }, 'Assigned'); return true; }
  if (el.matches('[data-psc-org]') && el.value) { await send('/api/psc/org', { key: el.dataset.pscOrg, orgId: el.value }, 'Organization saved'); return true; }
  if (el.matches('[data-psc-customer]')) { pscCustomer = el.value; render(); return true; }
  if (el.matches('[data-psc-tier]')) { pscTier = el.value; render(); return true; }
  if (el.matches('[data-psc-sort]')) { pscSort = el.value; render(); return true; }
  if (el.matches('[data-psc-resolved]')) { pscShow = el.checked ? 'resolved' : 'open'; render(); return true; }
  if (el.matches('[data-psc-snags]')) { pscSnags = el.checked; render(); return true; }
  return false;
}

function pscInput(event) {
  if (event.target.id !== 'psc-search') return false;
  const q = event.target.value.trim().toLowerCase();
  for (const card of view.querySelectorAll('.psc-card')) card.hidden = Boolean(q) && !card.dataset.search.includes(q);
  return true;
}

// The list keeps itself current while it's open: every 2 minutes it asks whether
// anything has changed, which costs almost nothing, and only then reloads.
setInterval(async () => {
  if (currentRoute() !== '#/psc' || settingsOpen || document.visibilityState !== 'visible') return;
  if (document.activeElement?.matches?.('select, input, textarea') || document.querySelector('.tour')) return;
  const before = pscData;
  await pscLoad().catch(() => null);
  if (pscData !== before && currentRoute() === '#/psc') render();
}, 120000);

function settingsPscHtml() {
  const s = settingsData.psc;
  if (s.error && !s.settings) return `<div class="card notice error"><p>${esc(s.error)}</p></div>`;
  const v = s.settings;
  const field = (id, label, value, hint, step = '0.5') => `<label>${label}<small class="muted" style="display:block;font-weight:400">${hint}</small>
    <input type="number" step="${step}" min="0" data-psc-setting="${id}" value="${esc(value)}"></label>`;
  return `<section class="card">
      <h2 style="margin-top:0">First look, by contract</h2>
      <p class="muted">Hours from when the customer's cover starts. Past this, an item shows as late and the Service team lead is emailed.</p>
      <div class="psc-settings">
        ${Object.entries(s.tiers).map(([k, t]) => field(`targets.${k}`, `${t.name} (hours)`, v.targets[k], t.coverText)).join('')}
      </div>
      <h2>Day shift</h2>
      <p class="muted">Silver cover and customers with no contract are covered during the day shift on weekdays.</p>
      <div class="psc-settings">
        ${field('shiftStart', 'Starts (hour)', v.shiftStart, '', '1')}
        ${field('shiftEnd', 'Ends (hour)', v.shiftEnd, '', '1')}
      </div>
      <h2>Quiet items</h2>
      <div class="psc-settings">
        ${field('staleDays', 'Quiet after (days)', v.staleDays, 'An item with no update from the team for this long shows as quiet.')}
      </div>
      <p><button class="btn" data-psc-save-settings="1">Save</button></p>
      <p class="muted">Read from Jira ${s.syncedAt ? whenText(new Date(s.syncedAt).toISOString()) : 'not yet'}.</p>
      ${s.error ? `<div class="notice error"><p>${esc(s.error)}</p></div>` : ''}
    </section>`;
}

async function pscSettingsClick(event) {
  if (!event.target.closest('[data-psc-save-settings]')) return false;
  const body = { targets: {} };
  for (const i of view.querySelectorAll('[data-psc-setting]')) {
    const [a, b] = i.dataset.pscSetting.split('.');
    if (b) body[a][b] = Number(i.value); else body[a] = Number(i.value);
  }
  try { await api('/api/psc/settings', { method: 'POST', body: JSON.stringify(body) }); toast('Saved'); } catch (err) { toast(err.message); }
  render();
  return true;
}

// ---------- guides ----------
// Each page has a guide, offered the first time someone opens it and again from
// the ? in the page header. Most are a walkthrough: the page reloads in practice
// mode with example data, and each step asks the person to do the next thing
// themselves, moving on once they have. "Do it for me" does the step for them.
// A few pages have a short look round the real page instead. Who has seen which
// guide is kept with their account, so it doesn't repeat on another device.

let toursSeen = null;          // null until loaded, so nothing starts before we know
let tour = null;               // { route, steps, i, el, root, practice, token, ready, timer }

const tourDef = (route) => TOURS[route] || null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const isShown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const pageName = (route) => (route === '#/' ? 'the hub' : route === '#/log' ? 'Log time' : MODULES.find((m) => m.route === route)?.name || 'this page');

function tourButton(route) {
  if (!tourDef(route) || settingsOpen === route) return '';
  const beside = me?.user?.isAdmin && TILE_SETTINGS[route] && !PRACTICE ? ' beside-cog' : '';
  const label = tourDef(route).practice ? 'Walk me through this page' : 'Show the guide for this page';
  return `<button class="help-tour${beside}" data-tour="${route}" aria-label="${label}" title="${label}">?</button>`;
}

// A step's target is a selector, a list of them (the first one showing wins),
// or a function that finds the element.
function findTarget(target) {
  if (!target) return null;
  if (typeof target === 'function') {
    try { const el = target(); return el?.isConnected && isShown(el) ? el : null; } catch { return null; }
  }
  for (const sel of [].concat(target)) {
    const el = [...document.querySelectorAll(sel)].find(isShown);
    if (el) return el;
  }
  return null;
}

// The page has settled once nothing is waiting on an answer and it has been drawn.
async function settle() {
  // Quiet for a few frames in a row, since one answer often leads to the next request.
  for (let quiet = 0, i = 0; quiet < 3 && i < 300; i++) {
    await (apiPending > 0 ? sleep(40) : nextFrame());
    quiet = apiPending > 0 ? 0 : quiet + 1;
  }
}

// The step's target as it is now, in case the page has redrawn it.
function liveTarget() {
  if (!tour) return null;
  if (tour.el?.isConnected) return tour.el;
  const el = findTarget(tour.steps[tour.i].target);
  if (el) tour.el = el;
  return el;
}

async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  for (;;) {
    await settle();
    const found = fn();
    if (found || Date.now() >= until) return found;
    await sleep(120);
  }
}

// What "Do it for me" and a step's own doIt() use.
const tourHelp = {
  find: findTarget,
  all: (sel) => [...document.querySelectorAll(sel)].filter(isShown),
  settle,
  sleep,
  async click(target) {
    const el = target instanceof Element ? target : findTarget(target);
    el?.click();
    await settle();
    return el;
  },
  type(target, value) {
    const el = target instanceof Element ? target : findTarget(target);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  pick(target, value) {
    const el = target instanceof Element ? target : findTarget(target);
    if (!el) return;
    el.value = value ?? [...el.options].find((o) => o.value && !o.disabled)?.value ?? '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
};

// Walkthroughs are remembered under their own name, so people who saw the older,
// shorter guides are still offered them once.
const seenKey = (route) => (tourDef(route)?.practice ? `walk:${route}` : route);

const stepsFor = (route) => (tourDef(route)?.steps || []).filter((s) => !s.when || s.when(me));

function maybeTour(route) {
  if (PRACTICE || !toursSeen || toursSeen.has(seenKey(route)) || tour || !tourDef(route) || settingsOpen) return;
  setTimeout(() => {
    if (tour || toursSeen.has(seenKey(route)) || currentRoute() !== route || settingsOpen) return;
    if (document.querySelector('.modal-backdrop') || accountDialog.open) return;
    offerTour(route);
  }, 450);
}

// The ? button, or the first visit: a walkthrough is offered first, since it
// reloads the page with example data; a look round starts straight away.
function offerTour(route) {
  const def = tourDef(route);
  if (!def) return;
  if (PRACTICE) { location.reload(); return; }
  if (!def.practice) { startTour(route); return; }
  const steps = stepsFor(route);
  const minutes = Math.max(1, Math.round(steps.length / 4));
  openTour(route, [{
    offer: true,
    title: `Learn ${pageName(route)}`,
    text: `${def.intro} It takes about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. You do each step yourself on example jobs and customers, so nothing you do reaches Jira, Tempo or anyone else.`,
  }], false);
}

function startTour(route, { practice = false } = {}) {
  const steps = stepsFor(route).filter((s) => practice || !s.optional || findTarget(s.target));
  if (!steps.length) return;
  if (practice) {
    steps.push({ title: 'That\'s it', text: `You've been through everything on ${pageName(route)}. Finish takes you back to your real page. You can go through this again any time from the ? at the top.` });
  }
  openTour(route, steps, practice);
}

function openTour(route, steps, practice) {
  endTour(false);
  const root = document.createElement('div');
  root.className = 'tour waiting';
  root.innerHTML = `<div class="tour-spot" aria-hidden="true"></div>
    <div class="tour-card card" role="dialog" aria-labelledby="tour-title" aria-describedby="tour-text"></div>`;
  document.body.appendChild(root);
  tour = { route, steps, i: 0, el: null, root, practice, token: 0, ready: false };
  root.addEventListener('click', tourClick);
  tour.timer = setInterval(tourTick, 250);
  showStep();
}

function tourStepDone(step) {
  if (step.until) { try { return Boolean(step.until(tourHelp)); } catch { return false; } }
  if (step.act === 'type') return Boolean(findTarget(step.field || step.target)?.value?.trim());
  return true;
}

function tourCardHtml() {
  const { steps, i, practice } = tour;
  const step = steps[i];
  const last = i === steps.length - 1;
  const act = tour.el || !step.target ? step.act : null;     // a step whose target never showed can only be skipped
  const back = i > 0 && !steps[i - 1].act && !step.act
    ? '<button class="btn secondary" data-tour-act="back">Back</button>' : '';
  let right;
  if (step.offer) right = '<button class="btn" data-tour-act="practice">Start the walkthrough</button>';
  else if (act) {
    const label = act === 'type' ? 'Type it for me' : act === 'pick' ? 'Choose for me' : 'Do it for me';
    const next = act === 'type' || act === 'until'
      ? `<button class="btn" data-tour-act="next"${tourStepDone(step) ? '' : ' disabled'}>Next</button>` : '';
    right = `<button class="btn secondary" data-tour-act="do">${label}</button>${next}`;
  } else right = `${back}<button class="btn" data-tour-act="next">${last ? (practice ? 'Finish' : 'Done') : 'Next'}</button>`;
  const left = step.offer ? '<button class="tour-skip" data-tour-act="skip">Not now</button>'
    : last && !act ? '<span></span>'
    : `<button class="tour-skip" data-tour-act="skip">${practice ? 'Leave practice' : 'Skip guide'}</button>`;
  const missing = step.target && !tour.el
    ? '<p class="tour-missing">This isn\'t showing on your screen. Press Next to carry on.</p>' : '';
  return `${step.offer ? '' : `<p class="tour-count">${practice ? '<span class="tour-badge">Practice</span>' : ''}${i + 1} of ${steps.length}</p>`}
    <h2 id="tour-title">${esc(step.title)}</h2>
    ${act ? '<p class="tour-turn">Your turn</p>' : ''}
    <p id="tour-text">${esc(step.text)}</p>${missing}
    <div class="tour-actions">${left}<span class="tour-nav">${missing && step.act ? '<button class="btn" data-tour-act="next">Next</button>' : right}</span></div>`;
}

async function showStep() {
  closeDropdown();                 // a list left open from the last step mustn't cover this one
  const t = tour;
  if (!t) return;
  const token = ++t.token;
  const step = t.steps[t.i];
  t.ready = false;
  t.el = null;
  t.root.classList.add('waiting');
  const el = step.target ? await waitFor(() => findTarget(step.target), t.practice ? (step.wait ?? 8000) : 0) : null;
  if (tour !== t || token !== t.token) return;
  if (step.target && !el && step.optional) {
    if (t.i < t.steps.length - 1) { t.i++; return showStep(); }
    return finishTour();
  }
  if (!step.target && t.practice) await settle();
  if (tour !== t || token !== t.token) return;
  t.el = el;
  t.ready = true;
  t.root.classList.remove('waiting');
  t.root.classList.toggle('act', Boolean(el && step.act));
  t.root.querySelector('.tour-card').innerHTML = tourCardHtml();
  if (el) {
    // Bring it into view below the app bar; a tall one shows from its top.
    const bar = document.querySelector('.appbar')?.offsetHeight || 0;
    const r = el.getBoundingClientRect();
    const room = innerHeight - bar;
    const y = r.height > room * 0.5 ? r.top - bar - 16 : r.top - bar - (room - r.height) / 2;
    if (r.top < bar || r.bottom > innerHeight || r.height > room * 0.5) scrollBy({ top: y, behavior: 'instant' });
    // Inside a row that scrolls sideways, such as filter buttons on a phone.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }
  placeTour();
  const focus = t.root.querySelector('[data-tour-act="practice"], [data-tour-act="next"]:not([disabled]), [data-tour-act="do"]');
  if (!step.act || !el) focus?.focus({ preventScroll: true });
}

// Keeps the highlight on the target as the page redraws, and notices when a
// step that waits on something is done.
function tourTick() {
  if (!tour?.ready) return;
  placeTour();
  const step = tour.steps[tour.i];
  if (!tour.el || !(step.act === 'type' || step.act === 'until')) return;
  const done = tourStepDone(step);
  const next = tour.root.querySelector('[data-tour-act="next"]');
  if (next) next.disabled = !done;
  if (done && step.until && !tour.advancing) {
    tour.advancing = true;
    const t = tour, i = t.i;
    setTimeout(() => { if (tour === t && t.i === i) { t.advancing = false; tourNext(); } }, 450);
  }
}

function placeTour() {
  if (!tour) return;
  const step = tour.steps[tour.i];
  if (tour.el && (!tour.el.isConnected || !isShown(tour.el))) tour.el = findTarget(step.target) || tour.el;   // the page redrew underneath
  const { root, el } = tour;
  const spot = root.querySelector('.tour-spot');
  const card = root.querySelector('.tour-card');
  root.classList.toggle('no-target', !el);
  const vw = innerWidth, vh = innerHeight, gap = 12, pad = 6;
  if (!el) {
    card.style.left = `${Math.max(16, (vw - card.offsetWidth) / 2)}px`;
    card.style.top = `${Math.max(16, (vh - card.offsetHeight) / 2)}px`;
    return;
  }
  const r = el.getBoundingClientRect();
  // A target taller than the screen is cropped to what's in view.
  const ch = card.offsetHeight, cw = card.offsetWidth;
  const top = Math.max(r.top - pad, 8);
  let bottom = Math.min(r.bottom + pad, vh - 8);
  // If neither side has room for the card, light up only the top of the target
  // so the card sits under it rather than covering it.
  if (bottom + gap + ch > vh - 8 && top - gap - ch < 8) bottom = Math.max(top + 48, vh - ch - gap - 16);
  Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${top}px`, width: `${r.width + pad * 2}px`, height: `${Math.max(0, bottom - top)}px` });
  let y;
  if (bottom + gap + ch <= vh - 8) y = bottom + gap;
  else if (top - gap - ch >= 8) y = top - gap - ch;
  else y = vh - ch - 16;                       // no room either side: sit at the bottom
  const x = Math.min(Math.max(16, r.left + r.width / 2 - cw / 2), vw - cw - 16);
  card.style.left = `${x}px`;
  card.style.top = `${Math.max(8, y)}px`;
}

function tourNext() {
  if (!tour) return;
  if (tour.i < tour.steps.length - 1) { tour.i++; return showStep(); }
  return finishTour();
}

async function tourDo() {
  const step = tour.steps[tour.i];
  const el = liveTarget();
  if (step.doIt) return step.doIt(tourHelp, el);
  if (step.act === 'click') return tourHelp.click(step.click ? findTarget(step.click) : el);
  if (step.act === 'type') {
    tourHelp.type(step.field ? findTarget(step.field) : el, step.value);
    if (!step.until) tourNext();
    return;
  }
  if (step.act === 'pick') return tourHelp.pick(step.field ? findTarget(step.field) : el, step.value);
}

function tourClick(event) {
  const act = event.target.closest('[data-tour-act]')?.dataset.tourAct;
  if (!act || !tour) return;
  if (act === 'next') return tourNext();
  if (act === 'back' && tour.i > 0) { tour.i--; return showStep(); }
  if (act === 'do') return tourDo();
  if (act === 'skip') return tour.practice ? leavePractice() : endTour(true);
  if (act === 'practice') return enterPractice(tour.route);
}

function markTourSeen(route) {
  const key = seenKey(route);
  if (!toursSeen || toursSeen.has(key)) return Promise.resolve();
  toursSeen.add(key);
  return serverApi('/api/prefs/tours', { method: 'POST', body: JSON.stringify({ seen: [...toursSeen] }) }).catch(() => {});
}

function endTour(markSeen) {
  if (!tour) return;
  const { route, root, timer, practice } = tour;
  clearInterval(timer);
  root.remove();
  tour = null;
  if (markSeen) markTourSeen(practice ? PRACTICE_ROUTE : route);
}

function finishTour() {
  if (tour?.practice) return leavePractice();
  endTour(true);
}

async function enterPractice(route) {
  endTour(false);
  await Promise.race([markTourSeen(route), sleep(800)]);
  location.assign(`${location.pathname}?practice=${route === '#/' ? 'home' : route.slice(2)}${route}`);
}

async function leavePractice() {
  endTour(false);
  await Promise.race([markTourSeen(PRACTICE_ROUTE), sleep(800)]);
  location.replace(`${location.pathname}${PRACTICE_ROUTE}`);
}

function practiceBar() {
  const bar = document.createElement('div');
  bar.className = 'practice-bar';
  bar.setAttribute('role', 'note');
  bar.innerHTML = `<span><strong>Practice</strong> with example data. Nothing you do here is saved or sent anywhere.</span>
    <button class="btn secondary" data-practice="leave">Leave practice</button>`;
  bar.querySelector('button').addEventListener('click', leavePractice);
  document.body.prepend(bar);
}

// While a walkthrough runs, the page only takes the click the step asks for, so
// the steps and the page stay in step. Clicks the hub makes itself go through.
function tourGate(event) {
  if (!tour || !event.isTrusted) return;
  if (event.target.closest?.('.tour-card, .practice-bar')) return;
  // A drop-down only opens from a field the step allowed, so choosing in it is allowed too.
  if (event.target.closest?.('.dd-panel')) return;
  const step = tour.steps[tour.i];
  const inTarget = tour.ready && step.act && liveTarget()?.contains(event.target);
  if (!inTarget) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'click' && tour.ready) {
      const card = tour.root.querySelector('.tour-card');
      card.classList.remove('nudge');
      void card.offsetWidth;
      card.classList.add('nudge');
    }
  }
}
document.addEventListener('mousedown', tourGate, true);
document.addEventListener('click', tourGate, true);

// A step done by the person themselves moves the guide on.
document.addEventListener('click', (event) => {
  if (!tour?.ready) return;
  const step = tour.steps[tour.i];
  if (step.act !== 'click' || !liveTarget()) return;
  const wanted = step.click ? findTarget(step.click) : liveTarget();
  if (!wanted?.contains(event.target)) return;
  const t = tour, i = t.i;
  t.ready = false;
  setTimeout(() => { if (tour === t && t.i === i) tourNext(); }, 0);
}, true);
document.addEventListener('change', (event) => {
  if (!tour?.ready) return;
  const step = tour.steps[tour.i];
  if (step.act !== 'pick' || !liveTarget()?.contains(event.target)) return;
  const t = tour, i = t.i;
  t.ready = false;
  setTimeout(() => { if (tour === t && t.i === i) tourNext(); }, 0);
}, true);

// In practice, links out to Jira, Tempo or a PDF would open real pages.
document.addEventListener('click', (event) => {
  if (!PRACTICE) return;
  const link = event.target.closest?.('a[target="_blank"], a[href^="/api/"]');
  if (!link) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  toast('In practice, links to Jira, Tempo and PDFs don\'t open');
}, true);

document.addEventListener('keydown', (event) => {
  if (!tour) return;
  if (event.key === 'Escape') { event.preventDefault(); tour.practice ? leavePractice() : endTour(true); return; }
  const step = tour.steps[tour.i];
  if (step.act || step.offer || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  if (event.key === 'ArrowRight') tourNext();
  else if (event.key === 'ArrowLeft' && tour.i > 0 && !tour.steps[tour.i - 1].act) { tour.i--; showStep(); }
});
addEventListener('resize', () => placeTour());
addEventListener('scroll', () => placeTour(), { passive: true });

const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isInstalled = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function renderAccount() {
  const e = me.employee;
  const installItem = isInstalled
    ? ''
    : installPrompt
      ? `<li><button data-account="install">${svgIcon('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>')}Install the app</button></li>`
      : isIos
        ? `<li><p class="help"><strong>Install on iPhone:</strong> tap the Share button in Safari, then Add to Home Screen.</p></li>`
        : `<li><p class="help"><strong>Install on this device:</strong> use the install icon in the address bar, or your browser menu's Install app option.</p></li>`;

  accountDialog.innerHTML = `
    <div class="acct-head">
      <button class="close" data-account="close" aria-label="Close">${svgIcon('<path d="M6 6l12 12M18 6L6 18"/>')}</button>
      <span class="avatar">${esc(initials())}</span>
      <strong>${esc(e?.name || 'Promtek Hub')}</strong>
      <span>${esc(me.user.email)}</span>
    </div>
    <div class="acct-body">
      ${me.linked ? `<section class="acct-section">
        <h4>Profile</h4>
        <ul class="menu">
          <li><a href="#/xp" data-account="close">${svgIcon('<path d="M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.8z"/>')}Level<span class="value">${n(e.progress.level)}</span></a></li>
          <li><a href="#/xp" data-account="close">${svgIcon('<circle cx="12" cy="9" r="5"/><path d="M8.5 13.5L7 21l5-2.5 5 2.5-1.5-7.5"/>')}Rank<span class="value">${esc(e.rank?.name || '—')}</span></a></li>
          ${e.profileKey ? `<li><a href="${esc(me.jiraBaseUrl)}/browse/${esc(e.profileKey)}" target="_blank" rel="noopener">${svgIcon('<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>')}Jira profile<span class="value">${esc(e.profileKey)}</span></a></li>` : ''}
        </ul>
      </section>` : ''}
      <section class="acct-section">
        <h4>Settings</h4>
        <ul class="menu">
          <li><button data-account="refresh">${svgIcon('<path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/>')}Refresh my XP</button></li>
          ${installItem}
          ${me.user.isAdmin || me.user.can?.developer ? `<li><a href="#/admin" data-account="close">${svgIcon('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>')}Admin tools</a></li>` : ''}
        </ul>
      </section>
      <section class="acct-section">
        <ul class="menu">
          <li><a class="danger" href="/cdn-cgi/access/logout">${svgIcon('<path d="M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 16l-4-4 4-4M6 12h10"/>')}Sign out</a></li>
        </ul>
      </section>
    </div>`;
}

// The cog lives in the header, outside the main view, so it needs its own listener.
band.addEventListener('click', (event) => {
  const tourBtn = event.target.closest('[data-tour]');
  if (tourBtn) return offerTour(tourBtn.dataset.tour);
  const settingsBtn = event.target.closest('[data-settings]');
  if (!settingsBtn) return;
  settingsOpen = settingsBtn.dataset.settings === 'close' ? null : settingsBtn.dataset.settings;
  render();
});

document.getElementById('account-btn').addEventListener('click', () => {
  if (!me) return;
  renderAccount();
  accountDialog.showModal();
});

accountDialog.addEventListener('click', async (event) => {
  if (event.target === accountDialog) return accountDialog.close(); // backdrop
  const item = event.target.closest('[data-account]');
  if (!item) return;
  const action = item.dataset.account;
  if (action === 'close') accountDialog.close();
  if (action === 'install' && installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    accountDialog.close();
  }
  if (action === 'refresh') {
    accountDialog.close();
    await syncAndRefresh(true);
  }
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});

// ---------- admin actions ----------

async function logAction(action, button) {
  const out = (id, text, isError) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; el.className = `result ${isError ? 'bad' : 'good'}`; }
  };
  button.disabled = true;
  try {
    if (action === 'cancel-log') { logChosen = null; logMode = null; return render(); }
    if (action === 'cancel-psc') {
      logPscProject = null;
      // Coming from a call, step back to the list it came from rather than
      // re-rendering the same form.
      if (callFlow) {
        if (callFlow.intent === 'new-psc') callFlow = null;
        else callFlow.step = 'psc';
      }
      return render();
    }

    if (action === 'save-log') {
      const seconds = ((Number(document.getElementById('log-hours').value) || 0) * 60
        + (Number(document.getElementById('log-minutes').value) || 0)) * 60;
      const result = await api('/api/log/worklog', {
        method: 'POST',
        body: JSON.stringify({
          issueId: logChosen.issueId,
          issueKey: logChosen.label,
          seconds,
          date: document.getElementById('log-date').value,
          startTime: document.getElementById('log-start').value,
          description: document.getElementById('log-note').value,
        }),
      });
      toast(`${duration(result.seconds)} logged against ${result.issueKey}`);
      if (pendingCall) {
        await api('/api/calls/handled', {
          method: 'POST',
          body: JSON.stringify({ callId: pendingCall.callId, action: 'logged', issueKey: result.issueKey, worklogId: result.worklogId }),
        }).catch(() => {});
        pendingCall = null;
        callsData = null;
      }
      logChosen = null;
      logNode = null;
      logTrail = [];
      me = await api('/api/me');
      location.hash = '#/time';
      return;
    }

    if (action === 'create-psc') {
      const created = await api('/api/log/psc', {
        method: 'POST',
        body: JSON.stringify({
          projectKey: logPscProject,
          issueType: document.getElementById('psc-type').value,
          summary: document.getElementById('psc-summary').value,
          description: document.getElementById('psc-description').value,
        }),
      });
      logChosen = { label: created.key, issueId: created.id, title: document.getElementById('psc-summary').value, sublabel: 'New service item, assigned to you', rate: 1, jobElo: null };
      logMode = 'manual';
      logPscProject = null;
      if (callFlow) { callFlow = null; location.hash = '#/log'; return; }
      await render();
      return updateXpPreview();
    }

    if (action === 'flag-stage') {
      await api('/api/log/flag-stage', {
        method: 'POST',
        body: JSON.stringify({ issueKey: logChosen.label, summary: logChosen.title, note: document.getElementById('flag-note').value }),
      });
      out('flag-result', 'Sent. Your team lead will take a look.');
      return;
    }
  } catch (err) {
    out({ 'save-log': 'log-result', 'create-psc': 'psc-result', 'flag-stage': 'flag-result' }[action] || 'log-result', err.message, true);
  } finally {
    button.disabled = false;
  }
}

const SKIP_PHRASES = {
  'No estimate': 'with no estimate',
  'No time logged': 'with no time logged',
  'No difficulty set': 'with no difficulty set',
  'Nobody with a profile logged time on it': 'logged only by people without a profile',
};

function eloAdminHtml(elo, source) {
  const skipped = elo.skipped.reduce((a, r) => a + r.n, 0);
  const rows = elo.recent.map((m) => `<tr>
      <td><a href="${esc(me.jiraBaseUrl)}/browse/${esc(m.issue_key)}" target="_blank" rel="noopener">${esc(m.issue_key)}</a><br><span class="muted">${esc(jobName(m.summary))}</span></td>
      <td>${m.done_date ? shortDate(m.done_date) : '—'}</td>
      <td class="num">${m.estimate_seconds ? hoursText1(m.estimate_seconds) : '—'}</td>
      <td class="num">${m.actual_seconds ? hoursText1(m.actual_seconds) : '—'}</td>
      <td>${m.status === 'rated'
        ? `${m.people} ${m.people === 1 ? 'person' : 'people'}. Job ${n(Math.round(m.job_elo))} → ${n(Math.round(m.job_elo_after))}`
        : `<span class="muted">Not rated, ${esc(String(m.reason || '').toLowerCase())}</span>`}</td>
    </tr>`).join('');
  const controls = elo.from
    ? `<dl class="state">
        <dt>Rating finished jobs from</dt><dd>${shortDate(elo.from)} ${elo.from.slice(0, 4)}</dd>
        <dt>XP rates use ELO from</dt><dd>${elo.weekOf ? `Monday ${shortDate(elo.weekOf)}` : 'Not frozen yet'}</dd>
        <dt>Rated</dt><dd>${n(elo.rated)} ${elo.rated === 1 ? 'job' : 'jobs'}</dd>
        <dt>Not rated</dt><dd>${skipped ? elo.skipped.map((r) => `${n(r.n)} ${esc(SKIP_PHRASES[r.reason] || r.reason.toLowerCase())}`).join(', ') : 'None'}</dd>
        <dt>Waiting</dt><dd>${n(elo.waiting)}, including anything finished in the last three days</dd>
      </dl>
      <div class="row">
        <button class="btn secondary" data-action="elo-step">Rate the next few now</button>
        <button class="btn secondary" data-action="elo-stop">Pause the engine</button>
      </div>`
    : `<p style="margin-top:0">The engine rates each finished category against the people who worked on it, once its time has settled. ${source !== 'hub' ? '<strong>Switch employees to the hub before starting it.</strong>' : ''}</p>
      <p class="muted">Choose an earlier date to replay jobs already recorded under Completed job tracking, oldest first. Today rates only work finished from now on.</p>
      <div class="row">
        <label>Rate jobs finished from <input type="date" id="elo-from" value="${todayIso()}" max="${todayIso()}"></label>
        <button class="btn" data-action="elo-start">Start the ELO engine</button>
      </div>`;
  return `<h2>ELO engine</h2>
    <div class="card">${controls}<div class="result" id="elo-result" role="status"></div></div>
    ${rows ? `<div class="table-wrap" style="margin-top:1rem"><table>
      <thead><tr><th>Category</th><th>Finished</th><th class="num">Estimate</th><th class="num">Actual</th><th>Result</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : ''}`;
}

async function adminAction(action, button) {
  const out = (id, text, isError) => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = `result ${isError ? 'bad' : ''}`;
  };
  const target = { 'sync-now': 'sync-result', snapshot: 'sync-result',
    'start-ledger': 'start-result', link: 'link-result',
    'scan-jobs': 'jobs-result', 'backfill-start': 'jobs-result', 'recompute-stages': 'jobs-result',
    'vehicle-expiries': 'vehicle-result', 'save-vehicle': 'vehicle-result', 'ra-add': 'ra-result',
    'test-8x8': 'eight8-result', 'test-live-calls': 'eight8-result', 'lib-list': 'lib-result',
    'elo-start': 'elo-result', 'elo-stop': 'elo-result', 'elo-step': 'elo-result', 'reads-carry-on': 'reads-result',
 }[action];
  button.disabled = true;
  try {
    if (action === 'reads-carry-on') {
      await api('/api/admin/reads-carry-on', { method: 'POST' });
      out(target, 'Background jobs will run again from the next run, until midnight UTC.');
    } else if (action === 'sync-now') {
      const r = await api('/api/admin/sync-now', { method: 'POST' });
      out(target, r.skipped ? r.skipped : `Checked ${r.fetched} worklogs, updated ${r.changed}.`);
    } else if (action === 'start-ledger') {
      const confirm = document.getElementById('confirm-start').value.trim();
      const r = await api('/api/admin/start-ledger', { method: 'POST', body: JSON.stringify({ confirm }) });
      out(target, `Ledger started for ${r.ledgerStart} with ${r.employees} engineers.`);
      me = await api('/api/me');
    } else if (action === 'snapshot') {
      const r = await api('/api/admin/snapshot', { method: 'POST', body: JSON.stringify({}) });
      out(target, r.skipped ? r.skipped : `Recorded ${r.engineers} engineers for the week of ${r.week}.`);
    } else if (action === 'scan-jobs') {
      const r = await api('/api/admin/scan-jobs', { method: 'POST', body: JSON.stringify({}) });
      out(target, `Recorded ${r.epics} finished orders, ${r.categories} finished categories and ${r.rows} items.`);
    } else if (action === 'backfill-start') {
      const months = document.getElementById('backfill-months').value;
      const r = await api('/api/admin/backfill-start', { method: 'POST', body: JSON.stringify({ months }) });
      out(target, `Backfill started, working back to ${r.until}. It runs in the background, a batch every couple of minutes.`);
    } else if (action === 'test-live-calls') {
      const r = await api('/api/admin/test-live-calls', { method: 'POST', body: JSON.stringify({}) });
      out(target, r.count
        ? `Live calls work: ${r.count} ${r.count === 1 ? 'call is' : 'calls are'} in progress now. First: ${r.sample.map((c) => `${c.callId}, extensions and numbers seen ${c.parties.slice(0, 6).join(', ')}`).join('; ')}.`
        : 'Live calls work. Nobody is on a call right now; try again while someone is, to check their extension shows up.');
    } else if (action === 'test-8x8') {
      const r = await api('/api/admin/test-8x8', { method: 'POST', body: JSON.stringify({}) });
      out('eight8-result', r.ok
        ? `Connected. ${r.records} call${r.records === 1 ? '' : 's'} on the system today.`
        : r.error, !r.ok);
    } else if (action === 'vehicle-expiries') {
      const r = await api('/api/admin/vehicle-expiries', { method: 'POST', body: JSON.stringify({}) });
      out('vehicle-result', `Checked ${r.vehicles} vehicles, raised ${r.raised} reminder${r.raised === 1 ? '' : 's'}.`);
    } else if (action === 'save-vehicle') {
      const value = (id) => document.getElementById(id).value.trim();
      await api('/api/admin/vehicle', {
        method: 'POST',
        body: JSON.stringify({
          id: value('veh-form-id') || null,
          registration: value('veh-form-reg'), make: value('veh-form-make'), model: value('veh-form-model'),
          kind: value('veh-form-kind'), motDue: value('veh-form-mot'), insuranceDue: value('veh-form-ins'),
          taxDue: value('veh-form-tax'), serviceDue: value('veh-form-service'),
          mileage: value('veh-form-miles'), responsibleEmail: value('veh-form-email'),
          active: document.getElementById('veh-form-active').value === '1',
        }),
      });
      out('vehicle-result', 'Saved.');
    } else if (action === 'lib-list') {
      const kind = document.getElementById('lib-kind').value;
      const entries = (settingsData.library[kind] || []).slice(0, 60);
      document.getElementById('lib-list').innerHTML = entries.length
        ? `<ul class="list" style="box-shadow:none;margin-top:1rem">${entries.map((entry) => {
            const text = Object.entries(entry).filter(([key]) => !['id', 'source'].includes(key))
              .map(([, value]) => value).filter(Boolean).slice(0, 4).join(', ');
            return `<li><span class="title">${esc(text || 'Empty entry')}</span>
              <span class="sub">${esc(entry.source || '')}</span>
              <span class="xp"><button class="linklike" data-lib-remove="${esc(entry.id)}">Remove</button></span></li>`;
          }).join('')}</ul>`
        : '<p class="muted" style="margin-top:1rem">Nothing recorded for that type yet.</p>';
      out('lib-result', `${entries.length} shown.`);
    } else if (action === 'ra-add') {
      const title = document.getElementById('ra-title').value.trim();
      if (!title) return out('ra-result', 'Type the name first.', true);
      await api('/api/admin/ra-save', { method: 'POST', body: JSON.stringify({ title }) });
      out('ra-result', 'Added.');
    } else if (action === 'elo-start') {
      await api('/api/admin/elo-start', { method: 'POST', body: JSON.stringify({ from: document.getElementById('elo-from').value }) });
      return render();
    } else if (action === 'elo-stop') {
      if (!confirm('Pause the ELO engine? Nothing already rated changes, and finished jobs wait until it starts again.')) return;
      await api('/api/admin/elo-stop', { method: 'POST' });
      return render();
    } else if (action === 'elo-step') {
      const r = await api('/api/admin/elo-step', { method: 'POST' });
      if (typeof r.skipped === 'string') out(target, r.skipped);
      else { out(target, `${r.rated} rated, ${r.skipped} not rated.`); setTimeout(render, 900); }
    } else if (action === 'recompute-stages') {
      const r = await api('/api/admin/recompute-stages', { method: 'POST', body: JSON.stringify({}) });
      out(target, `Rebuilt names and shares for ${r.stages} stages.`);
    } else if (action === 'link') {
      await api('/api/admin/link', {
        method: 'POST',
        body: JSON.stringify({ accountId: document.getElementById('link-account').value, email: document.getElementById('link-email').value }),
      });
      out(target, 'Linked.');
    }
    if (!['sync-now', 'snapshot', 'scan-jobs', 'backfill-start', 'recompute-stages', 'vehicle-expiries', 'test-8x8', 'lib-list'].includes(action)) {
      setTimeout(render, 1200);
    }
  } catch (err) {
    out(target, err.message, true);
  } finally {
    button.disabled = false;
  }
}

view.addEventListener('click', async (event) => {
  if (currentRoute() === '#/admin' && await homeAdminClick(event)) return;
  const onPow = currentRoute() === '#/pow';
  if (currentRoute() === '#/log' && await contractWarnClick(event)) return;

  const nodeBtn = event.target.closest('[data-node]');
  if (nodeBtn) {
    if (onPow) {
      powTrail.push(powNode);
      powNode = nodeBtn.dataset.node;
      return render();
    }
    logTrail.push({ node: logNode, label: nodeBtn.querySelector('strong')?.textContent?.trim() || 'Back' });
    logNode = nodeBtn.dataset.node;
    return render();
  }
  const pickBtn = event.target.closest('[data-pick]');
  if (pickBtn) {
    const picked = JSON.parse(pickBtn.dataset.pick);
    if (onPow) return powPickVisit(picked);
    if (callFlow) {
      callFlow = null;
      logChosen = picked;
      logMode = 'manual';
      await contractCheck();
      location.hash = '#/log';
      return;
    }
    logChosen = picked;
    // Logging a call's time goes straight to the form; otherwise ask which way first.
    logMode = pendingCall ? 'manual' : null;
    await contractCheck();
    await render();
    if (logMode && !logChosen.contractCheck) { updateXpPreview(); return loadStageHint(); }
    return;
  }
  const crumbBtn = event.target.closest('[data-crumb]');
  if (crumbBtn) {
    const index = Number(crumbBtn.dataset.crumb);
    if (index < 0) { logNode = null; logTrail = []; }
    else { logNode = logTrail[index].node; logTrail = logTrail.slice(0, index); }
    return render();
  }
  const pscBtn = event.target.closest('[data-psc]');
  if (pscBtn) { logPscProject = pscBtn.dataset.psc; return render(); }
  const minsBtn = event.target.closest('[data-mins]');
  if (minsBtn) {
    const mins = Number(minsBtn.dataset.mins);
    document.getElementById('log-hours').value = Math.floor(mins / 60);
    document.getElementById('log-minutes').value = mins % 60;
    return updateXpPreview();
  }
  if (event.target.closest('[data-flag]')) {
    document.getElementById('flag-box').hidden = false;
    return;
  }

  if (event.target.closest('[data-retry]')) return render();

  const settingsBtn = event.target.closest('[data-settings]');
  if (settingsBtn) {
    settingsOpen = settingsBtn.dataset.settings === 'close' ? null : settingsBtn.dataset.settings;
    return render();
  }

  const removeEmployee = event.target.closest('[data-remove-employee]');
  if (removeEmployee) {
    const name = removeEmployee.dataset.name;
    view.querySelector('#remove-employee-box')?.remove();
    removeEmployee.closest('td').insertAdjacentHTML('beforeend', `
      <div id="remove-employee-box" class="card" style="margin-top:.5rem;padding:.75rem">
        <p style="margin:0 0 .5rem">Remove ${esc(name)}?</p>
        <div class="row">
          <button class="btn secondary" data-remove-confirm="keep" data-account="${esc(removeEmployee.dataset.removeEmployee)}">Hide, keep their XP</button>
          <button class="btn" data-remove-confirm="purge" data-account="${esc(removeEmployee.dataset.removeEmployee)}">Remove everything</button>
        </div>
      </div>`);
    return;
  }
  const removeConfirm = event.target.closest('[data-remove-confirm]');
  if (removeConfirm) {
    await api('/api/admin/remove-employee', {
      method: 'POST',
      body: JSON.stringify({ accountId: removeConfirm.dataset.account, keepHistory: removeConfirm.dataset.removeConfirm === 'keep' }),
    });
    toast('Removed');
    return render();
  }
  const libRemove = event.target.closest('[data-lib-remove]');
  if (libRemove) {
    await api('/api/admin/library-remove', { method: 'POST', body: JSON.stringify({ id: libRemove.dataset.libRemove }) });
    toast('Entry removed');
    return render();
  }

  const personEditBtn = event.target.closest('[data-person-edit]');
  if (personEditBtn) {
    const id = personEditBtn.dataset.personEdit;
    personEdit = id === 'new'
      ? { name: '', role: 'engineer', xpRate: 60, order: 50, icons: [], groups: [], teams: [], leadOf: [] }
      : { ...(peopleCache.people.find((p) => p.accountId === id) || {}) };
    // Saving leaves the rating alone unless it was edited, so a job rated
    // while the form is open isn't overwritten.
    personEdit.eloLoaded = String(personEdit.elo ?? '');
    return render();
  }
  const personActionBtn = event.target.closest('[data-person-action]');
  if (personActionBtn) return personAction(personActionBtn.dataset.personAction);
  const personIcon = event.target.closest('[data-person-icon]');
  if (personIcon) {
    collectPerson();
    const id = personIcon.dataset.personIcon;
    personEdit.icons = (personEdit.icons || []).includes(id)
      ? personEdit.icons.filter((i) => i !== id)
      : [...(personEdit.icons || []), id];
    return render();
  }

  const orgBtn = event.target.closest('[data-org]');
  if (orgBtn) {
    try { await orgDownload(); } catch (err) { toast(err.message); }
    return;
  }

  if (await draftDeleteClick(event)) return;
  const obsBtn = event.target.closest('[data-obs]');
  if (obsBtn) return obsControl(obsBtn.dataset.obs);
  const obsClient = event.target.closest('[data-obs-client]');
  if (obsClient) return obsPickClient(obsClient.dataset.obsClient);
  const obsOpen = event.target.closest('[data-obs-open]');
  if (obsOpen) {
    const record = await api(`/api/obs/survey?id=${encodeURIComponent(obsOpen.dataset.obsOpen)}`);
    obsSurvey = record.data;
    obsSection = 0;
    if (!obsLibrary) obsLibrary = await api('/api/obs/library').catch(() => ({}));
    return render();
  }
  const obsStatus = event.target.closest('[data-obs-status]');
  if (obsStatus) { setPath(obsSurvey, obsStatus.dataset.obsStatus, obsStatus.dataset.value); return render(); }
  const obsRemove = event.target.closest('[data-obs-remove]');
  if (obsRemove) { removePath(obsRemove.dataset.obsRemove); obsSaveDraft(); return render(); }
  const obsDup = event.target.closest('[data-obs-dup]');
  if (obsDup) {
    const added = obsDuplicate(obsDup.dataset.obsDup);
    await render();
    if (added) obsScrollTo(added);
    return obsSaveDraft();
  }
  const obsRead = event.target.closest('[data-obs-read]');
  if (obsRead) {
    const queue = await api('/api/obs/sales');
    obsReading = queue.reports.find((r) => r.key === obsRead.dataset.obsRead);
    return render();
  }
  const obsQuote = event.target.closest('[data-obs-quote]');
  if (obsQuote) return obsDecide(obsQuote.dataset.obsQuote === 'yes');

  const shopBtn = event.target.closest('[data-shop]');
  if (shopBtn) return shopControl(shopBtn.dataset.shop);

  const callsBtn = event.target.closest('[data-calls]');
  if (callsBtn) return callsControl(callsBtn.dataset.calls);
  const callBtn = event.target.closest('[data-call]');
  if (callBtn) {
    return ['job', 'psc', 'new-psc', 'discard'].includes(callBtn.dataset.call)
      ? callAction(callBtn.dataset.call, callBtn.dataset.value)
      : callsControl(callBtn.dataset.call);
  }
  const callCustomer = event.target.closest('[data-call-customer]');
  if (callCustomer) {
    await api('/api/calls/link', {
      method: 'POST',
      body: JSON.stringify({ phone: callFlow.call.other, projectKey: callCustomer.dataset.callCustomer, label: callCustomer.dataset.label }),
    });
    callFlow.projectKey = callCustomer.dataset.callCustomer;
    return callContinue();
  }

  const itBtn = event.target.closest('[data-it]');
  if (itBtn) return itControl(itBtn.dataset.it);
  const itCat = event.target.closest('[data-it-cat]');
  if (itCat) return itControl('category', itCat.dataset.itCat);
  const itUrg = event.target.closest('[data-it-urgency]');
  if (itUrg) return itControl('urgency', itUrg.dataset.itUrgency);
  const itAsset = event.target.closest('[data-it-asset]');
  if (itAsset) return itControl('asset', itAsset.dataset.itAsset);

  const vehView = event.target.closest('[data-veh-view]');
  if (vehView) return vehicleControl('view', vehView.dataset.vehView);
  const vehWeek = event.target.closest('[data-veh-week]');
  if (vehWeek) return vehicleControl('week', vehWeek.dataset.vehWeek);
  const vehCheck = event.target.closest('[data-veh-check]');
  if (vehCheck) return vehicleControl('start-check', vehCheck.dataset.vehCheck);
  const vehCancel = event.target.closest('[data-veh-cancel]');
  if (vehCancel) return vehicleControl('cancel-booking', vehCancel.dataset.vehCancel);
  const vehResolve = event.target.closest('[data-veh-resolve]');
  if (vehResolve) return vehicleControl('resolve', vehResolve.dataset.vehResolve);
  const vehBtn = event.target.closest('[data-veh]');
  if (vehBtn) return vehicleControl(vehBtn.dataset.veh);

  const adminVeh = event.target.closest('[data-admin-vehicle]');
  if (adminVeh) {
    const vehicles = (await api('/api/admin/vehicles')).vehicles;
    const v = vehicles.find((x) => x.id === adminVeh.dataset.adminVehicle) || {};
    document.getElementById('vehicle-form').innerHTML = `
      <input type="hidden" id="veh-form-id" value="${esc(v.id || '')}">
      <div class="row" style="margin-top:1rem">
        <label>Registration <input id="veh-form-reg" value="${esc(v.registration || '')}" autocomplete="off"></label>
        <label>Make <input id="veh-form-make" value="${esc(v.make || '')}" autocomplete="off"></label>
        <label>Model <input id="veh-form-model" value="${esc(v.model || '')}" autocomplete="off"></label>
        <label>Type <input id="veh-form-kind" value="${esc(v.kind || 'Van')}" autocomplete="off"></label>
      </div>
      <div class="row" style="margin-top:.75rem">
        <label>MOT due <input id="veh-form-mot" type="date" value="${esc(v.mot_due || '')}"></label>
        <label>Insurance due <input id="veh-form-ins" type="date" value="${esc(v.insurance_due || '')}"></label>
        <label>Tax due <input id="veh-form-tax" type="date" value="${esc(v.tax_due || '')}"></label>
        <label>Service due <input id="veh-form-service" type="date" value="${esc(v.service_due || '')}"></label>
      </div>
      <div class="row" style="margin-top:.75rem">
        <label>Mileage <input id="veh-form-miles" type="number" value="${v.mileage || ''}"></label>
        <label style="flex:1">Who looks after repairs <input id="veh-form-email" type="email" value="${esc(v.responsible_email || '')}" placeholder="name@promtek.com"></label>
        <label>In service <select id="veh-form-active"><option value="1"${v.active === 0 ? '' : ' selected'}>Yes</option><option value="0"${v.active === 0 ? ' selected' : ''}>Retired</option></select></label>
      </div>
      <div class="row" style="margin-top:1rem"><button class="btn" data-action="save-vehicle">Save vehicle</button></div>`;
    return;
  }
  const raToggle = event.target.closest('[data-ra-toggle]');
  if (raToggle) {
    await api('/api/admin/ra-save', {
      method: 'POST',
      body: JSON.stringify({ id: raToggle.dataset.raToggle, title: raToggle.dataset.raTitle, active: raToggle.dataset.raActive === '1' }),
    });
    return render();
  }

  const tileBtn = event.target.closest('[data-tile]');
  if (tileBtn) return tileControl(tileBtn.dataset.tile, tileBtn.dataset.value);

  const powBtn = event.target.closest('[data-pow]');
  if (powBtn) return powControl(powBtn.dataset.pow);
  if (event.target.closest('[data-pow-crumb]')) { powNode = 'root'; powTrail = []; return render(); }
  const powOpen = event.target.closest('[data-pow-open]');
  if (powOpen) return powOpenDraft(powOpen.dataset.powOpen);
  const toggleBtn = event.target.closest('[data-toggle]');
  if (toggleBtn) return powToggle(toggleBtn.dataset.toggle, toggleBtn.dataset.value);
  const setBtn = event.target.closest('[data-set]');
  if (setBtn) return powSet(setBtn.dataset.set, setBtn.dataset.value);

  const metricBtn = event.target.closest('button[data-leader-metric]');
  if (metricBtn) {
    leaderMetric = metricBtn.dataset.leaderMetric;
    if (!LEADER_PERIODS[leaderMetric].some(([p]) => p === leaderPeriod)) leaderPeriod = leaderMetric === 'elo' ? 'quarter' : 'week';
    leaderExpanded = false;
    return loadLeaderboard();
  }
  const periodBtn = event.target.closest('button[data-period]');
  if (periodBtn) { leaderPeriod = periodBtn.dataset.period; leaderExpanded = false; return loadLeaderboard(); }
  const leaderBtn = event.target.closest('button[data-leader]');
  if (leaderBtn) { leaderExpanded = !leaderExpanded; return loadLeaderboard(); }
  if (event.target.closest('.day-card') && await dayClick(event) !== false) return;
  if (currentRoute() === '#/condor' && !settingsOpen && await condorClick(event) !== false) return;
  if (currentRoute() === '#/psc' && settingsOpen !== '#/psc' && await pscClick(event) !== false) return;
  if (currentRoute() === '#/contracts' && settingsOpen !== '#/contracts' && await contractsClick(event) !== false) return;
  if (currentRoute() === '#/requests' && await requestsClick(event) !== false) return;
  if (currentRoute() === '#/jobs' && await jobsClick(event) !== false) return;
  const stageGroupBtn = event.target.closest('[data-stage-group]');
  if (stageGroupBtn) { stageGroup = stageGroupBtn.dataset.stageGroup; return render(); }
  const teamChip = event.target.closest('[data-person-team]');
  if (teamChip) {
    teamChip.classList.toggle('on');
    const lead = view.querySelector(`[data-lead-for="${CSS.escape(teamChip.dataset.personTeam)}"]`);
    if (lead) { lead.hidden = !teamChip.classList.contains('on'); if (lead.hidden) lead.querySelector('input').checked = false; }
    return;
  }
  if (event.target.closest('[data-qcfg-save]')) return saveQuoteSettings(event.target.closest('[data-qcfg-save]'));
  if (settingsOpen === '#/org' && await orgSettingsClick(event)) return;
  if (settingsOpen === '#/contracts' && await contractsSettingsClick(event)) return;
  if (settingsOpen === '#/psc' && await pscSettingsClick(event)) return;
  if (event.target.closest('[data-audit-more]')) return loadAudit(true);
  const bb = event.target.closest('[data-bb]');
  if (bb) {
    const out = document.getElementById('bb-result');
    bb.disabled = true; out.innerHTML = '<span class="spinner" aria-hidden="true"></span> Asking Bitbucket';
    try {
      if (bb.dataset.bb === 'test') {
        const r = await api('/api/admin/bitbucket-test', { method: 'POST' });
        out.textContent = `Connected. ${r.repositories != null ? `${n(r.repositories)} repositories, ` : ''}most recently updated: ${r.recent.join(', ') || 'none'}.`;
      } else {
        const r = await api('/api/admin/bitbucket-poll', { method: 'POST' });
        if (r.skipped) out.textContent = r.skipped;
        else { bb.disabled = false; return render(); }
      }
    } catch (err) { out.textContent = err.message; }
    bb.disabled = false;
    return;
  }
  if (currentRoute() === '#/quotes' && !settingsOpen && await quotesClick(event) !== false) return;
  if (currentRoute() === '#/xp' && event.target.closest('#modifiers') && await modifiersClick(event) !== false) return;
  if (event.target.closest('button[data-elo-more]')) { eloExpanded = !eloExpanded; return loadEloHistory(eloHistoryFor); }
  const eloUndo = event.target.closest('button[data-elo-undo]');
  if (eloUndo) {
    if (!confirm('Undo this rating change? The points go back to where they were and the job keeps its own rating.')) return;
    eloUndo.disabled = true;
    try {
      await api('/api/admin/elo-reverse', { method: 'POST', body: JSON.stringify({ id: eloUndo.dataset.eloUndo }) });
      toast('Undone');
    } catch (err) { toast(err.message); }
    return loadEloHistory(eloHistoryFor);
  }
  const engineerBtn = event.target.closest('button[data-engineer]');
  if (engineerBtn) { reportAccount = engineerBtn.dataset.engineer || null; return render(); }
  const viewBtn = event.target.closest('button[data-view]');
  if (viewBtn) { reportView = viewBtn.dataset.view; return render(); }
  const eloWeeksBtn = event.target.closest('button[data-elo-weeks]');
  if (eloWeeksBtn) { eloWeeks = Number(eloWeeksBtn.dataset.eloWeeks); return render(); }
  const weeksBtn = event.target.closest('button[data-weeks]');
  if (weeksBtn) { reportWeeks = Number(weeksBtn.dataset.weeks); return render(); }
  const actionBtn = event.target.closest('button[data-action]');
  if (actionBtn) {
    const logActions = ['save-log', 'cancel-log', 'create-psc', 'cancel-psc', 'flag-stage'];
    return logActions.includes(actionBtn.dataset.action)
      ? logAction(actionBtn.dataset.action, actionBtn)
      : adminAction(actionBtn.dataset.action, actionBtn);
  }
  const weekBtn = event.target.closest('button[data-week]');
  if (weekBtn) {
    weekOffset = Math.min(0, weekOffset + Number(weekBtn.dataset.week));
    render();
  }
});

// ---------- routing ----------

function currentRoute() {
  // A link can open a page on one of its tabs, as #/condor?notes.
  const hash = location.hash.split('?')[0].replace(/\/$/, '');
  return pages[hash] ? hash : '#/';
}

// The loading animation: three balls bouncing in turn, in the brand blues.
const loaderHtml = (label = 'Loading', size = '') => `<div class="loader-block${size ? ` ${size}` : ''}" role="status">
    <span class="loader" aria-hidden="true"><i></i><i></i><i></i></span><span class="loader-label">${esc(label)}…</span></div>`;
// A whole page loading.
const spinner = (label = 'Loading') => `<div class="card loading-card">${loaderHtml(label)}</div>`;
// One part of a page loading after the rest has arrived.
const sectionLoading = (label = 'Loading') => `<div class="card loading-card small">${loaderHtml(label, 'small')}</div>`;

// Some pages know what they are waiting for.
const WAITING_FOR = {
  '#/jobs': () => (jobsView ? 'Loading the job from Jira' : 'Fetching open jobs from Jira'),
  '#/quotes': () => (quotesView?.kind === 'new' ? 'Fetching customers from Jira' : quotesOpenRefresh ? 'Reading quotes from Jira' : 'Loading'),
  '#/condor': () => (condorTab === 'triage' || condorTab === 'plan' ? 'Fetching releases from Jira' : condorTab === 'notes' && (rn.stale || !rn.data) ? 'Reading the release from Jira' : 'Loading'),
  '#/obs': () => (obsSurvey?.picking ? 'Fetching the client list from Jira' : 'Loading'),
  '#/calls': () => 'Loading',
  '#/contracts': () => (conOpen ? 'Loading the contract' : 'Loading contracts'),
  '#/psc': () => (pscOpen ? 'Loading the PSC' : 'Loading PSCs'),
};

// Settings live with the app they configure. The cog appears in the header of
// any tile that has some, and only for admins.
const TILE_SETTINGS = {
  '#/org': {
    band: () => `<h1>Company chart</h1><p>Who reports to whom, built from the employee list.</p>`,
    async render() {
      await loadOrgLogo();
      orgData = await api('/api/org');
      return orgHtml(orgData);
    },
  },

  '#/obs': { label: 'Obsolescence settings', render: () => settingsObsHtml() },
  '#/pow': { label: 'Point of work settings', render: () => settingsPowHtml() },
  '#/vehicles': { label: 'Vehicle settings', render: () => settingsVehiclesHtml() },
  '#/calls': { label: '8x8 settings', render: () => settingsCallsHtml() },
  '#/it': { label: 'IT support settings', render: () => settingsItHtml() },
  '#/reports': { label: 'Reporting settings', render: () => settingsReportsHtml() },
  '#/quotes': { label: 'Quote settings', render: () => settingsQuotesHtml() },
  '#/condor': { label: 'Condor Dev settings', render: () => bitbucketAdminHtml(settingsData.bitbucket) },
  '#/contracts': { label: 'Service contract settings', render: () => settingsContractsHtml() },
  '#/psc': { label: 'PSC settings', render: () => settingsPscHtml() },
  '#/org': { label: 'Company chart versions', render: () => settingsOrgHtml() },
};
let settingsOpen = null;
let settingsData = null;

function cogButton(route) {
  if (PRACTICE || !me?.user?.isAdmin || !TILE_SETTINGS[route]) return '';
  return `<button class="cog" data-settings="${route}" aria-label="${esc(TILE_SETTINGS[route].label)}" title="${esc(TILE_SETTINGS[route].label)}">
      ${svgIcon('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>')}
    </button>`;
}

let renderToken = 0;

// Redrawing the page you're already on keeps you where you were; going to a
// different page starts at the top.
let lastView = null;

// While a page you're on reloads, a loader floats over it.
let pageLoaderEl = null;
function pageLoader(label) {
  if (!pageLoaderEl) {
    pageLoaderEl = document.createElement('div');
    pageLoaderEl.className = 'page-loader';
    document.body.appendChild(pageLoaderEl);
  }
  if (label) pageLoaderEl.innerHTML = loaderHtml(label);
  pageLoaderEl.classList.toggle('show', Boolean(label));
}

async function render() {
  const token = ++renderToken;
  const route = currentRoute();
  const viewKey = `${route}|${settingsOpen || ''}`;
  const samePage = lastView === viewKey;
  const keepY = samePage ? scrollY : 0;
  const page = pages[route];
  back.hidden = route === '#/';
  avatar.textContent = initials();
  band.innerHTML = settingsOpen === route
    ? `<h1>${esc(TILE_SETTINGS[route].label)}</h1><p>Admin only.</p>`
    : page.band() + tourButton(route) + cogButton(route);

  // Anything slow gets a spinner, but only while it is still the newest render.
  // On the same page the content stays put, dimmed, so the scroll position isn't lost.
  const slow = setTimeout(() => {
    if (token !== renderToken) return;
    if (samePage) { view.classList.add('refreshing'); pageLoader(WAITING_FOR[route]?.() || 'Loading'); }
    else view.innerHTML = spinner(WAITING_FOR[route]?.() || 'Loading');
  }, 160);

  try {
    let html = settingsOpen === route ? await renderSettings(route) : await page.render();
    if (route === '#/admin' && settingsOpen !== route && me.user.isAdmin) html = adminSections(html);
    if (token === renderToken && currentRoute() === route) {
      view.innerHTML = html;
      lastView = viewKey;
      scrollTo(0, samePage ? keepY : 0);
      if (!settingsOpen) maybeTour(route);
      if (route === '#/xp') { loadLeaderboard(); loadEloHistory(); loadModifiers(); }
      if (route === '#/condor' && condorTab === 'day' && !mesEst) loadDayDrafts();
      if (route === '#/admin' && !settingsOpen && me.user.isAdmin) { loadAudit(); loadHomeAdmin(); }
      if (route === '#/') loadHomeFeed();
      if (route !== '#/condor') mesEst = null;
      if (route === '#/reports' && reportAccount) loadEloHistory(reportAccount);
      if (route !== '#/jobs') { jobsView = null; jobsDraft = null; }
      if (route !== '#/quotes') { quotesView = null; quoteData = null; }
    }
  } catch (err) {
    if (token === renderToken) {
      view.innerHTML = `<div class="card notice error"><p><strong>That didn't load.</strong></p>
        <p>${esc(err.message)}</p>
        <p><button class="btn secondary" data-retry="1">Try again</button></p></div>`;
    }
  } finally {
    clearTimeout(slow);
    if (token === renderToken) { view.classList.remove('refreshing'); pageLoader(null); }
  }
}

// Contract cards open with Enter or Space too.
view.addEventListener('keydown', (event) => {
  const card = event.target.closest?.('[data-con-open], [data-psc-open]');
  if (card && (event.key === 'Enter' || event.key === ' ') && event.target === card) { event.preventDefault(); card.click(); }
});

let searchTimer = null;
view.addEventListener('input', (event) => {
  if (currentRoute() === '#/quotes' && quotesInput(event)) return;
  if (currentRoute() === '#/condor' && condorInput(event)) return;
  if (currentRoute() === '#/contracts' && settingsOpen === '#/contracts' && contractsSettingsInput(event)) return;
  if (currentRoute() === '#/contracts' && contractsInput(event)) return;
  if (currentRoute() === '#/psc' && pscInput(event)) return;
  if (event.target.matches('[data-person-group="lead"]')) { const box = view.querySelector('.access-leads'); if (box) box.hidden = !event.target.checked; return; }
  if (event.target.matches('[data-report-team]')) { reportTeam = event.target.value; render(); return; }
  if (event.target.matches('[data-elo-sort]')) { eloSort = event.target.value; render(); return; }
  if (homeAdminInput(event)) return;
  if (event.target.matches('[data-stage-customer]')) { stageCustomer = event.target.value; render(); return; }
  if (event.target.matches('[data-leader-team]')) { leaderTeam = event.target.value; loadLeaderboard(); return; }
  if (event.target.matches('[data-audit-q]')) {
    clearTimeout(loadAudit.timer);
    auditFilter.q = event.target.value;
    loadAudit.timer = setTimeout(() => loadAudit(), 400);
    return;
  }
  if (event.target.matches('[data-audit-area]')) { auditFilter.area = event.target.value; loadAudit(); return; }
  if (event.target.dataset?.jobsField && jobsDraft) { jobsDraft[event.target.dataset.jobsField] = event.target.value; return; }
  if (event.target.dataset?.modField && modDraft) { modDraft[event.target.dataset.modField] = event.target.value; return; }
  if (event.target.id === 'jobs-search') {
    const query = event.target.value.toLowerCase();
    document.querySelectorAll('[data-job-order]').forEach((el) => { el.hidden = query.length > 1 && !el.textContent.toLowerCase().includes(query); });
    return;
  }
  if (event.target.dataset?.obsField !== undefined && obsSurvey) {
    setPath(obsSurvey, event.target.dataset.obsField, event.target.value);
    obsFieldChanged(event.target.dataset.obsField, !event.inputType || event.inputType === 'insertReplacementText' ? obsIsPick(event.target) : false);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => obsSaveDraft(), 1200);
    return;
  }
  if (event.target.id === 'obs-search') {
    const query = event.target.value.toLowerCase();
    document.querySelectorAll('[data-obs-client]').forEach((el) => {
      el.hidden = query.length > 1 && !el.textContent.toLowerCase().includes(query);
    });
    return;
  }
  if (event.target.id === 'call-customer-search') {
    const query = event.target.value.toLowerCase();
    document.querySelectorAll('[data-call-customer]').forEach((el) => {
      el.hidden = query.length > 1 && !el.textContent.toLowerCase().includes(query);
    });
    return;
  }
  if (event.target.id === 'it-asset-search') {
    clearTimeout(searchTimer);
    const query = event.target.value;
    searchTimer = setTimeout(async () => {
      itAssets = (await api(`/api/it/assets?q=${encodeURIComponent(query)}`).catch(() => ({ assets: [] }))).assets;
      await render();
      const box = document.getElementById('it-asset-search');
      if (box) { box.value = query; box.focus(); }
    }, 400);
    return;
  }
  if (event.target.dataset?.checkNote !== undefined && checkForm) {
    // Kept as it's typed, so ticking the next item doesn't lose it.
    const entry = checkForm.results[event.target.dataset.checkNote];
    if (entry) entry.note = event.target.value;
    return;
  }
  if (['log-hours', 'log-minutes'].includes(event.target.id)) return updateXpPreview();
  if (event.target.id === 'log-search') {
    logSearch = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (logSearch.trim().length < 2) { logResults = null; return render(); }
      logResults = await api(`/api/log/search?q=${encodeURIComponent(logSearch)}`).catch((err) => ({ options: [], error: err.message }));
      await render();
      const box = document.getElementById('log-search');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }, 350);
  }
});

view.addEventListener('change', async (event) => {
  if (event.target.dataset?.obsField !== undefined && obsSurvey) {
    obsFieldChanged(event.target.dataset.obsField, obsIsPick(event.target));
    return;
  }
  if (event.target.dataset?.obsPick !== undefined && obsSurvey) {
    const m = event.target.dataset.obsPick.match(/^plcCards\[(\d+)\]\.cards\[(\d+)\]$/);
    const card = m && obsSurvey.plcCards?.[Number(m[1])]?.cards?.[Number(m[2])];
    if (card) { if (event.target.checked) obsPicked.add(card); else obsPicked.delete(card); }
    return render();
  }
  if (event.target.dataset?.obsAddcard !== undefined && obsSurvey) {
    const panel = obsSurvey.plcCards?.[Number(event.target.dataset.obsAddcard)];
    if (panel && event.target.value) {
      (panel.cards ||= []).push(obsBlankCard(event.target.value));
      await render();
      obsScrollTo(`plcCards[${event.target.dataset.obsAddcard}].cards[${panel.cards.length - 1}]`);
      obsSaveDraft();
    }
    return;
  }
  if (settingsOpen === '#/contracts' && await contractsSettingsChange(event)) return;
  if (currentRoute() === '#/psc' && !settingsOpen && await pscChange(event)) return;
  if (event.target.id === 'avatar-input' && personEdit) {
    const file = event.target.files?.[0];
    if (!file) return;
    collectPerson();
    try {
      personEdit.avatar = await readAvatar(file);
    } catch {
      toast('That picture could not be read.');
    }
    return render();
  }
  if (event.target.dataset?.orgField) {
    const accountId = event.target.dataset.account;
    const row = event.target.closest('tr');
    const value = (field) => row.querySelector(`[data-org-field="${field}"]`)?.value ?? '';
    try {
      await api('/api/admin/org-person', {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          jobTitle: value('title'),
          department: value('department'),
          managerId: value('manager') || null,
          order: value('order'),
        }),
      });
      toast('Saved');
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (event.target.dataset?.extension !== undefined) {
    await api('/api/admin/set-extension', {
      method: 'POST',
      body: JSON.stringify({ accountId: event.target.dataset.extension, extension: event.target.value }),
    }).catch((err) => toast(err.message));
    return;
  }
  if (event.target.dataset?.itMap !== undefined) {
    const select = event.target;
    const option = select.options[select.selectedIndex];
    try {
      await api('/api/admin/it-types', {
        method: 'POST',
        body: JSON.stringify({ hubKey: select.dataset.itMap, requestTypeId: select.value, serviceDeskId: itServiceDeskId, label: option.textContent }),
      });
      document.getElementById('it-map-result').textContent = 'Saved.';
    } catch (err) {
      document.getElementById('it-map-result').textContent = err.message;
    }
    return;
  }
  if (event.target.id === 'it-photos') {
    itForm.attachments = await readPhotos(event.target.files);
    return render();
  }
  if (event.target.id === 'quoting-discipline') { quotingDiscipline = event.target.value; render(); }
  if (event.target.id === 'quoting-all') { quotingAll = event.target.checked; render(); }
});

window.addEventListener('hashchange', () => {
  if (!tour?.practice) endTour(false);     // a walkthrough can lead from one page to the next
  setTimeout(trackerBar, 0);
  settingsOpen = null;
  if (currentRoute() !== '#/time') weekOffset = 0;
  if (currentRoute() !== '#/reports') reportAccount = null;
  if (currentRoute() !== '#/') arrangeMode = false;
  if (currentRoute() !== '#/admin') personEdit = null;
  if (currentRoute() !== '#/shop') shopSimulation = null;
  if (currentRoute() !== '#/obs') { obsSurvey = null; obsSection = 0; obsReading = null; obsView = null; }
  if (currentRoute() !== '#/calls' && currentRoute() !== '#/log') { callFlow = null; pendingCall = null; }
  if (currentRoute() !== '#/it') { itForm = null; itAssets = []; }
  if (currentRoute() !== '#/contracts') conOpen = null;
  if (currentRoute() !== '#/psc') pscOpen = null;
  if (currentRoute() !== '#/vehicles') { vehicleView = 'home'; checkForm = null; weekOffsetVehicles = 0; }
  if (currentRoute() !== '#/pow') { powStep = 'home'; powForm = null; powNode = 'root'; powTrail = []; }
  if (currentRoute() !== '#/log') { logChosen = null; logNode = null; logTrail = []; logResults = null; logSearch = ''; logPscProject = null; }
  if (accountDialog.open) accountDialog.close();
  render();
  window.scrollTo({ top: 0 });
  view.focus({ preventScroll: true });
});

// Pull brand-new Tempo worklogs, then refresh the page if anything changed.
async function syncAndRefresh(announce = false) {
  try {
    const result = await api('/api/sync', { method: 'POST' });
    if (result.changed > 0) {
      me = await api('/api/me');
      if (currentRoute() !== '#/admin') render();
      toast(`${result.changed} new time ${result.changed === 1 ? 'log' : 'logs'} added`);
    } else if (announce) {
      toast('Your XP is up to date');
    }
  } catch (err) {
    if (announce) toast(err.message);
  }
}

async function start() {
  if (PRACTICE) {
    // A walkthrough always starts on its own page, even after a reload part-way through.
    if (location.hash.replace(/\/$/, '') !== PRACTICE_ROUTE.replace(/\/$/, '')) history.replaceState(null, '', `${location.pathname}${location.search}${PRACTICE_ROUTE}`);
    document.body.classList.add('practice');
    practiceBar();
  }
  try {
    me = await api('/api/me');
  } catch (err) {
    band.innerHTML = '<h1>Promtek Hub</h1>';
    view.innerHTML = `<div class="card notice error"><p><strong>Couldn't load the hub.</strong></p><p>${esc(err.message)}</p></div>`;
    return;
  }
  try { tilePrefs = { hidden: [], ...(await api('/api/prefs/tiles')) }; } catch { /* defaults are fine */ }
  try { toursSeen = new Set((await api('/api/prefs/tours')).seen || []); } catch { /* no guides rather than repeating them */ }
  await render();
  logFab();
  if (PRACTICE) startTour(PRACTICE_ROUTE, { practice: true });
  syncAndRefresh();
  trackerInit();
  powFlushQueue();
  window.addEventListener('online', () => powFlushQueue());

  // Refresh when the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { syncAndRefresh(); trackerPoll(); }
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

start();
