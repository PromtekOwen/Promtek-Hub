import { MODULES } from './modules.js';

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

async function api(path, options = {}) {
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
      const summary = me.linked
        ? `<a class="summary" href="#/xp">
            ${ring(e.progress, 92)}
            <div>
              <strong>${esc(e.progress.title)}</strong>
              <span class="meta">${n(e.progress.xp)} XP. ${n(e.progress.xpToNextLevel)} to level ${n(e.progress.level + 1)}.</span>
              ${e.rank ? `<br><span class="chip">${esc(e.rank.name)}</span>` : ''}
            </div>
          </a>`
        : '';
      return `<h1>${greeting()}${first ? `, ${esc(first)}` : ''}</h1><p>${longDate(todayIso())}</p>${summary}`;
    },
    render() {
      const visible = orderedTiles();
      const hidden = MODULES.filter((m) => allowedTile(m) && tilePrefs.hidden.includes(m.id));
      const tiles = visible.map((m, i) => {
        const detail = m.detail ? `<span class="detail">${m.detail(me)}</span>` : '';
        const inner = `<span class="tile-icon">${m.icon}</span><strong>${esc(m.name)}</strong>${detail}`;
        if (arrangeMode) {
          return `<div class="tile arranging">${inner}<span class="arrange">
              <button class="icon-btn" data-tile="up" data-value="${esc(m.id)}" aria-label="Move ${esc(m.name)} earlier"${i === 0 ? ' disabled' : ''}>${svgIcon('<path d="M5 15l7-7 7 7"/>')}</button>
              <button class="icon-btn" data-tile="down" data-value="${esc(m.id)}" aria-label="Move ${esc(m.name)} later"${i === visible.length - 1 ? ' disabled' : ''}>${svgIcon('<path d="M19 9l-7 7-7-7"/>')}</button>
              <button class="icon-btn" data-tile="hide" data-value="${esc(m.id)}" aria-label="Hide ${esc(m.name)}">${svgIcon('<path d="M4 4l16 16"/><path d="M12 6c5 0 9 6 9 6a15 15 0 01-3 3.4M7.5 7.6A15 15 0 003 12s4 6 9 6a8 8 0 003.7-.9"/>')}</button>
            </span></div>`;
        }
        if (m.construction) return `<div class="tile construction" aria-disabled="true">${inner}<span class="badge">Under construction</span></div>`;
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
        <div class="tiles">${tiles}</div>${hiddenBlock}
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
        <div id="elo-history"><div class="card"><p class="muted">Loading your ELO history…</p></div></div>
        <h2>Taken into account</h2>
        <div id="modifiers"><div class="card"><p class="muted">Loading…</p></div></div>
        <h2>Leaderboard</h2>
        <div id="leaderboard" class="card"><p class="muted">Loading the leaderboard…</p></div>
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
      const tabs = `<div class="tabs" style="margin-bottom:1rem">
        <button class="tab${reportView === 'team' ? ' on' : ''}" data-view="team">Effort</button>
        <button class="tab${reportView === 'quoting' ? ' on' : ''}" data-view="quoting">Quoting</button>
        <button class="tab${reportView === 'stages' ? ' on' : ''}" data-view="stages">Stages</button>
      </div>`;
      if (reportView === 'stages') {
        const params = new URLSearchParams();
        if (quotingDiscipline) params.set('discipline', quotingDiscipline);
        return tabs + stagesHtml(await api(`/api/reports/stages?${params}`));
      }
      if (reportView === 'quoting') {
        const params = new URLSearchParams();
        if (quotingDiscipline) params.set('discipline', quotingDiscipline);
        if (quotingAll) params.set('all', '1');
        return tabs + quotingHtml(await api(`/api/reports/quoting?${params}`));
      }
      return tabs + teamReportHtml(await api(`/api/reports/team?weeks=${reportWeeks}`));
    },
  },

  '#/log': {
    band: () => `<h1>Log time</h1><p>Find the job, say how long, and it's in Tempo.</p>`,
    async render() {
      if (!me.linked) return notLinkedCard();
      return logChosen ? logFormHtml() : await logPickerHtml();
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
      if (!me.user.isAdmin) return `<div class="card"><p>The shop is still being worked on.</p></div>`;
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
      if (!me.user.isAdmin) return `<div class="card"><p>Only admins can see this page.</p></div>`;
      const [data, peopleData, elo] = await Promise.all([api('/api/admin/overview'), api('/api/admin/people'), api('/api/admin/elo')]);
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

        <h2>Audit log</h2>
        <p class="muted">Changes made by hand to employees, vehicles and settings: who changed what, when, and what it was before.</p>
        <div id="audit-log"><div class="card"><p class="muted" style="margin:0"><span class="spinner" aria-hidden="true"></span> Loading</p></div></div>

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

// ---------- arranging tiles ----------

let tilePrefs = { order: null, hidden: [] };
let arrangeMode = false;

const allowedTile = (m) => (!m.adminOnly || me.user.isAdmin) && (!m.leadOnly || me.user.isLead)
  && (!m.teams || me.user.isAdmin || m.teams.includes(me.user.team));

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
      <label style="margin-top:.75rem">Team <select data-person="department">
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
        <label>Role in the hub <select data-person="role">
          ${[['engineer', 'Engineer'], ['lead', 'Team lead'], ['admin', 'Admin']].map(([key, label]) =>
            `<option value="${key}"${(p.role || 'engineer') === key ? ' selected' : ''}>${label}</option>`).join('')}
        </select></label>
        <label>Alerts team <select data-person="team">
          <option value="">Not set</option>
          ${['Projecting', 'Service', 'Condor', 'Sales'].map((t) =>
            `<option value="${t}"${p.team === t ? ' selected' : ''}>${t}</option>`).join('')}
        </select></label>
      </div>

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

function obsHomeHtml(data) {
  const drafts = data.surveys.filter((s) => s.status === 'draft');
  const done = data.surveys.filter((s) => s.status !== 'draft');
  const row = (s) => `<li>
      <span class="title">${esc(s.client || 'No client')} ${s.report_key ? `<span class="muted">${esc(s.report_key)}</span>` : ''}</span>
      <span class="sub">${s.status === 'draft' ? `Draft, last touched ${shortDate((s.updated_at || '').slice(0, 10))}`
        : `Completed ${shortDate((s.submitted_at || '').slice(0, 10))}`}${s.delivery_note ? ', needs filing by hand' : ''}</span>
      <span class="xp">${s.status === 'draft'
        ? `<button class="linklike" data-obs-open="${esc(s.id)}">Continue</button>`
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

function conditionPicker(path, value) {
  return `<div class="segment" style="margin-top:.6rem">${obsConfig.conditions.map((c) =>
    `<button class="seg${value === c ? ' on' : ''}" data-obs-status="${esc(path)}" data-value="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
}

function itemCard(section, item, index) {
  const base = `${section.id}[${index}]`;
  return `<div class="card" style="margin-top:.85rem">
      <div class="row" style="justify-content:space-between;align-items:center">
        <input class="hdr" data-obs-field="${base}.label" value="${esc(item.label || '')}" placeholder="Name" autocomplete="off">
        <button class="linklike" data-obs-remove="${base}">Remove</button>
      </div>
      ${conditionPicker(`${base}.status`, item.status)}
      ${section.fields.map(([key, label]) => obsField(`${base}.${key}`, label, item[key], `lib-${section.id}-${key}`)).join('')}
      ${obsField(`${base}.comments`, 'Comments', item.comments)}
    </div>`;
}

function panelCard(panel, index) {
  const base = `plcCards[${index}]`;
  return `<div class="card" style="margin-top:.85rem">
      <div class="row" style="justify-content:space-between;align-items:center">
        <input class="hdr" data-obs-field="${base}.label" value="${esc(panel.label || '')}" autocomplete="off">
        <button class="linklike" data-obs-remove="${base}">Remove</button>
      </div>
      ${(panel.cards || []).map((card, c) => `<div class="sig">
          <strong>${esc(card.title)}</strong>
          ${conditionPicker(`${base}.cards[${c}].status`, card.status)}
          ${obsField(`${base}.cards[${c}].manufacturer`, 'Manufacturer', card.manufacturer, 'lib-plcCards-manufacturer')}
          ${obsField(`${base}.cards[${c}].partNo`, 'Part number', card.partNo, 'lib-plcCards-partNo')}
          ${obsField(`${base}.cards[${c}].voltage`, 'Control voltage', card.voltage)}
          ${obsField(`${base}.cards[${c}].density`, 'Density / I/O count', card.density)}
          ${obsField(`${base}.cards[${c}].comments`, 'Comments', card.comments)}
        </div>`).join('')}
    </div>`;
}

function datalists() {
  if (!obsLibrary) return '';
  const lists = [];
  for (const section of obsConfig.sections) {
    const rows = obsLibrary[section.library] || [];
    for (const [key, label] of section.fields) {
      const values = [...new Set(rows.map((r) => r[label]).filter(Boolean))].slice(0, 200);
      if (values.length) lists.push(`<datalist id="lib-${section.id}-${key}">${values.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`);
    }
  }
  return lists.join('');
}

function obsSurveyHtml() {
  const sections = obsConfig.sections;
  const step = obsSection;
  const progress = `<div class="card" style="padding:.85rem 1rem">
      <div class="row" style="justify-content:space-between">
        <strong>${step === 0 ? 'Site details' : sections[step - 1].name}</strong>
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
        <p class="muted">Filled in from Jira where possible.</p>
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
    const spares = items.length ? items : [];
    return `${progress}<div class="card">
        <h2 style="margin-top:0">${esc(section.name)}</h2>
        <p class="muted">Tick what's on the shelf. Add anything missing from the list.</p>
        ${spares.map((sp, i) => `<div class="qrow">
            <span>${esc(sp.description)}<br><span class="muted">${esc(sp.area || '')}</span></span>
            <span class="segment">${['Yes', 'No', 'N/A'].map((v) =>
              `<button class="seg${sp.inStock === v ? ' on' : ''}" data-obs-status="criticalSpares[${i}].inStock" data-value="${v}">${v}</button>`).join('')}</span>
          </div>`).join('') || '<p class="muted">Nothing added yet.</p>'}
        <div class="row" style="margin-top:1rem"><button class="btn secondary" data-obs="add-spares">Add the standard spares list</button>
        <button class="btn secondary" data-obs="add-${esc(section.id)}">Add one</button></div>
      </div>${nav}`;
  }

  return `${progress}
    <div class="card">
      <h2 style="margin-top:0">${esc(section.name)}</h2>
      <p class="muted">${items.length ? `${items.length} recorded.` : 'Nothing recorded yet.'} Start typing a part number and the library suggests what Promtek has seen before.</p>
    </div>
    ${items.map((item, i) => (section.cards ? panelCard(item, i) : itemCard(section, item, i))).join('')}
    <div class="row" style="margin-top:.85rem"><button class="btn secondary" data-obs="add-${esc(section.id)}">Add ${esc(section.addLabel || 'item')}</button></div>
    ${datalists()}${nav}`;
}

function setPath(target, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) node = node[part];
  node[parts[parts.length - 1]] = value;
}

function removePath(path) {
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
    await obsSaveDraft();
    return render();
  }
  if (action === 'next') {
    if (obsSection === obsConfig.sections.length + 1) return obsSubmit();
    obsSection++;
    await obsSaveDraft();
    return render();
  }
  if (action === 'add-spares') {
    const standard = (obsLibrary?.criticalSpares || []).slice(0, 60);
    obsSurvey.criticalSpares = standard.map((sp) => ({ description: sp.Description || sp.description || '', area: sp.Area || '', inStock: '', comments: '' }));
    return render();
  }
  if (action.startsWith('add-')) {
    const id = action.slice(4);
    const section = obsConfig.sections.find((s) => s.id === id);
    const list = (obsSurvey[id] ||= []);
    if (section.cards) {
      list.push({ label: `PLC Panel ${list.length + 1}`, cards: obsConfig.cardTypes.map((title) => ({ title, cardType: title, manufacturer: '', partNo: '', voltage: '', density: '', comments: '', status: '' })) });
    } else if (section.spares) {
      list.push({ description: '', area: '', inStock: '', comments: '' });
    } else {
      list.push({ label: `${section.addLabel || 'Item'} ${list.length + 1}`, status: '', comments: '' });
    }
    return render();
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

const localDrafts = {
  read() { try { return JSON.parse(localStorage.getItem('pow-drafts') || '{}'); } catch { return {}; } },
  write(map) { try { localStorage.setItem('pow-drafts', JSON.stringify(map)); } catch { /* full or blocked */ } },
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
      <span class="xp">${f.status === 'draft'
        ? `<button class="linklike" data-pow-open="${esc(f.id)}">Continue</button>`
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

function stagesHtml(data) {
  const stages = data.stages.map((st) => `<tr>
      <td>${esc(DISCIPLINE_NAMES[st.discipline] || 'Legacy')}</td>
      <td>${esc(st.stage)}</td>
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
        <a class="btn secondary" href="/api/reports/export?type=stages">Stage library CSV</a>
      </div>
      <p class="muted" style="margin:.85rem 0 0">How long each kind of stage actually takes, built from finished work.
      Stages don't carry their own estimates, so this is the closest thing to one: quote a category, then split it by
      the share column, or add up the stage hours directly. Stages seen fewer than ${data.minJobs} times are left out
      (${n(data.skipped)} of them so far).</p>
    </div>

    <h2>Stage library</h2>
    ${data.stages.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Discipline</th><th>Stage</th><th class="num">Times done</th><th class="num">Typical hours</th>
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
    <div id="elo-history"><div class="card"><p class="muted">Loading ELO history…</p></div></div>
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

function leaderboardHtml(data) {
  const rows = (leaderExpanded ? data.all : data.top);
  const youShown = rows.some((r) => r.isYou);
  const list = rows.map((r) => `<li${r.isYou ? ' class="you"' : ''}>
      <span class="pos">${r.position}</span>
      <span class="who">${esc(r.name)}</span>
      <span class="lvl">Level ${n(r.level)}</span>
      <span class="pts">${n(r.xp)} XP</span>
    </li>`).join('');
  const you = !youShown && data.you ? `<li class="you break">
      <span class="pos">${data.you.position}</span>
      <span class="who">${esc(data.you.name)}</span>
      <span class="lvl">Level ${n(data.you.level)}</span>
      <span class="pts">${n(data.you.xp)} XP</span>
    </li>` : '';
  const periods = [['week', 'This week'], ['month', 'This month'], ['all', 'All time']];
  return `
    <div class="tabs">${periods.map(([p, label]) =>
      `<button class="tab${p === leaderPeriod ? ' on' : ''}" data-period="${p}">${label}</button>`).join('')}</div>
    <ol class="board">${list}${you}</ol>
    ${data.total > data.top.length ? `<button class="btn secondary" data-leader="toggle" style="margin-top:.85rem">
      ${leaderExpanded ? 'Show top 10 only' : `Show all ${n(data.total)}`}</button>` : ''}`;
}

async function loadLeaderboard() {
  const host = document.getElementById('leaderboard');
  if (!host) return;
  try {
    const data = await api(`/api/leaderboard?period=${leaderPeriod}`);
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
  return `<div class="card"><p style="margin:0"><strong>${esc(q.title)}</strong><br>
      <span class="muted">${esc(q.customer || q.project_key)}. Quote ${jira}. ${status}.</span></p>
      ${q.jira_error && !q.quote_key ? `<p class="help">${esc(q.jira_error)}. Everything here is saved; it goes to Jira when it can.</p>` : ''}
      ${q.handoff_error ? `<p class="help">The order's figures are waiting to go into Jira: ${esc(q.handoff_error)}</p>` : ''}
      ${actions}<div class="result" id="q-status-result" role="status"></div></div>
    ${quoteData.sections.map((s) => qSectionHtml(s, quoteData)).join('')}
    <div class="row"><button class="btn secondary" data-q-back="1">Back to quotes</button></div>`;
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
      <h3>Categories</h3>
      <div class="chips">${['software', 'hardware', 'engineering', 'condor'].map((d) =>
        `<button class="chip${quoteNew.disciplines.includes(d) ? ' on' : ''}" data-q-new-disc="${d}">${qDisc(d)}</button>`).join('')}</div>
      <p class="help">The quote is created in Jira under the customer's quote list, and its key is the quote number in Quoter.</p>
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
      ${r.note ? `<blockquote class="dispute-words">${esc(r.note)}</blockquote>` : ''}
      <div data-q-section="answer">${qSectionFields({ ...answerDraft, discipline: r.discipline }, data.config, true, 'answer')}</div>
      <label style="margin-top:1rem">Anything else <span class="muted">(optional)</span>
        <textarea rows="3" data-q-answer-comment="1" placeholder="What the estimate depends on, or what worries you">${esc(answerDraft.comment)}</textarea></label>
      <div class="row"><button class="btn" data-q-answer="1">Send my estimate</button><button class="btn secondary" data-q-back="1">Back</button></div>
      <div class="result" id="q-answer-result" role="status"></div></div>`;
}

async function quotesHomeHtml() {
  const data = await api(`/api/quotes?scope=${quotesScope}`);
  const asks = data.requests.length ? `<h2>Waiting for your estimate</h2><ul class="list approvals">${data.requests.map((r) => `<li>
      <span class="title">${esc(r.title)}, ${qDisc(r.discipline)}</span>
      <span class="sub">${esc(r.customer || '')}. Asked by ${esc(r.requested_name || 'someone')}.</span>
      <button class="btn secondary" data-q-answer-open="${r.id}" style="margin-top:.6rem">Give my estimate</button></li>`).join('')}</ul>` : '';
  const scopes = [['open', 'Open'], ['mine', 'Mine'], ['all', 'All']];
  const status = { open: 'Being worked on', ready: 'Ready to send', won: 'Became an order', lost: 'Not going ahead' };
  const rows = data.quotes.map((q) => `<li data-q-row><button class="linklike title" data-q-open="${q.id}">${esc(q.title)}</button>
      <span class="sub">${esc(q.customer || q.project_key)}${q.quote_key ? `, ${esc(q.quote_key)}` : ''}. ${status[q.status]}${q.created_name ? `. ${esc(q.created_name)}` : ''}.</span></li>`).join('');
  return `${asks}
    ${data.canCreate ? `<div class="row" style="margin:1rem 0"><button class="btn" data-q-new-open="1">Start a quote</button></div>
      <div class="row jobs-tools"><span class="segment">${scopes.map(([k, l]) => `<button class="seg${quotesScope === k ? ' on' : ''}" data-q-scope="${k}">${l}</button>`).join('')}</span>
      <input type="search" id="q-search" placeholder="Search quotes" aria-label="Search quotes"></div>` : ''}
    ${rows ? `<ul class="list q-list">${rows}</ul>` : `<div class="card"><p style="margin:0">${data.canCreate ? 'No quotes here yet.' : 'When someone asks for your estimate on a quote, it appears here.'}</p></div>`}`;
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
  if (nd) { const d = nd.dataset.qNewDisc; quoteNew.disciplines = quoteNew.disciplines.includes(d) ? quoteNew.disciplines.filter((x) => x !== d) : [...quoteNew.disciplines, d]; nd.classList.toggle('on'); return true; }
  const create = t('[data-q-create]');
  if (create) {
    create.disabled = true;
    try {
      const r = await api('/api/quotes/create', { method: 'POST', body: JSON.stringify(quoteNew) });
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
let mesTriage = { versionId: null, skipped: [] };
let mesRatingFor = null;

function condorTabs() {
  const tabs = [['day', 'My day'], ['estimate', 'Estimate'], ...(me.user.isAdmin || (me.user.isLead && me.user.team === 'Condor') ? [['triage', 'Triage']] : []), ['plan', 'Plan'], ['ratings', 'Ratings']];
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
        <p>Compared with ${mesLink(q.next.key)} <strong>${esc(q.next.summary)}</strong>,<br><span class="muted">${mesMeta(q.next)}, which took ${hoursLabel(Math.round(q.next.hours * 4) / 4)}</span></p>
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

async function mesTriageHtml() {
  const data = await api('/api/mes/outstanding?filter=untriaged');
  if (!data.versions.length) return '<div class="card"><p style="margin:0">There are no open releases in MES. Create the next version in Jira, with its start and release dates, and it appears here.</p></div>';
  if (!mesTriage.versionId || !data.versions.some((v) => v.id === mesTriage.versionId)) mesTriage.versionId = data.versions[0].id;
  const version = data.versions.find((v) => v.id === mesTriage.versionId);
  const queue = data.tickets.filter((t) => !mesTriage.skipped.includes(t.issue_id));
  const t = queue[0];
  const picker = `<label>Release<select data-mes-version>${data.versions.map((v) => `<option value="${esc(v.id)}"${v.id === version.id ? ' selected' : ''}>${esc(v.name)}${v.releaseDate ? `, due ${shortDate(v.releaseDate)}` : ''}</option>`).join('')}</select></label>`;
  if (!t && data.catchingUp) return `${mesReadingHtml(data)}<div class="card">${picker}<p style="margin-bottom:0">Tickets to triage appear here as MES is read.</p></div>`;
  if (!t) return `<div class="card">${picker}<p style="margin-bottom:0">Everything open has been triaged.${mesTriage.skipped.length ? ` ${mesTriage.skipped.length} skipped for now. <button class="linklike" data-mes-unskip="1">Go back to them</button>` : ''}</p></div>`;
  return `${mesReadingHtml(data)}<div class="card">${picker}
      <p class="muted">${n(queue.length)} left to triage${data.catchingUp ? ' so far' : ''}</p>
      <div class="triage-ticket">
        <p style="margin-top:0"><strong>${mesLink(t.issue_key)} ${esc(t.summary)}</strong><br><span class="muted">${mesMeta(t)}</span></p>
        <p>${t.hours != null ? `${t.timebox ? 'Time-boxed at' : 'Estimated at'} ${hoursLabel(t.hours)}, difficulty ${n(t.difficulty)}.` : 'No estimate yet.'}
          <button class="linklike" data-mes-estimate="${esc(t.issue_id)}" data-from="triage">${t.hours != null ? 'Re-estimate' : 'Estimate it now'}</button></p>
        <div class="row triage-actions">${data.priorities.map((p) => `<button class="btn" data-mes-triage="${p}" data-issue="${esc(t.issue_id)}">${p}</button>`).join('')}
          <button class="btn secondary" data-mes-triage="none" data-issue="${esc(t.issue_id)}">Not this time</button>
          <button class="btn secondary" data-mes-skip="${esc(t.issue_id)}">Skip for now</button></div>
        <p class="help">Must, Should and Could put it in ${esc(version.name)} and set its Fix Version in Jira. When work has to give way, Coulds go first.</p>
      </div><div class="result" id="mes-result" role="status"></div></div>`;
}

async function mesRatingsHtml() {
  const isLead = me.user.isAdmin || (me.user.isLead && me.user.team === 'Condor');
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
  let body;
  if (mesEst) body = await mesEstimateHtml();
  else if (condorTab === 'estimate') body = await mesListHtml();
  else if (condorTab === 'triage') body = await mesTriageHtml();
  else if (condorTab === 'ratings') body = await mesRatingsHtml();
  else if (condorTab === 'plan') body = await mesPlanHtml();
  else body = '<div id="day-drafts"><div class="card"><p class="muted" style="margin:0"><span class="spinner" aria-hidden="true"></span> Loading your days</p></div></div>';
  return `${mesEst ? '' : condorTabs()}${body}`;
}

async function condorClick(event) {
  const t = (sel) => event.target.closest(sel);
  if (condorTab === 'plan' && !mesEst && await planClick(event) !== false) return true;
  if (t('[data-condor-tab]')) { condorTab = t('[data-condor-tab]').dataset.condorTab; mesRatingFor = null; return render(); }
  if (t('[data-mes-filter]')) { mesFilter = t('[data-mes-filter]').dataset.mesFilter; return render(); }
  const est = t('[data-mes-estimate]');
  if (est) { mesEst = { issueId: est.dataset.mesEstimate, answers: [], tags: [], difficulty: null, timeboxHours: 4, from: est.dataset.from || null }; window.scrollTo(0, 0); return render(); }
  if (t('[data-mes-back]')) { mesEst = null; return render(); }
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
  const tri = t('[data-mes-triage]');
  if (tri) {
    tri.disabled = true;
    try {
      const r = await api('/api/mes/triage', { method: 'POST', body: JSON.stringify({ issueId: tri.dataset.issue, versionId: tri.dataset.mesTriage === 'none' ? null : mesTriage.versionId, priority: tri.dataset.mesTriage }) });
      if (!r.jiraSynced) toast('Saved. Jira will catch up');
      return render();
    } catch (err) { document.getElementById('mes-result').textContent = err.message; tri.disabled = false; }
    return true;
  }
  if (t('[data-mes-skip]')) { mesTriage.skipped.push(t('[data-mes-skip]').dataset.mesSkip); return render(); }
  if (t('[data-mes-unskip]')) { mesTriage.skipped = []; return render(); }
  return false;
}

function condorInput(event) {
  const el = event.target;
  if (el.dataset.mesField && mesEst) { mesEst[el.dataset.mesField] = el.value; return true; }
  if (el.matches('[data-mes-version]')) { mesTriage.versionId = el.value; render(); return true; }
  if (el.matches('[data-plan-version]')) { planVersion = el.value; planCapacityOpen = null; render(); return true; }
  if (el.id === 'mes-search') {
    const q = el.value.toLowerCase();
    document.querySelectorAll('[data-mes-row]').forEach((r) => { r.hidden = q.length > 1 && !r.textContent.toLowerCase().includes(q); });
    return true;
  }
  return false;
}

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
      <rect x="${x(s.start) + 1}" y="${y}" width="${bw}" height="${rowH - 12}" rx="5" fill="${s.fits ? PRIORITY_COLOURS[s.priority] : 'var(--danger)'}" opacity="${s.fits ? 1 : 0.75}"/>
      ${bw > 52 ? `<text x="${x(s.start) + 6}" y="${y + 15}" font-size="11" fill="#fff">${esc(s.key)}</text>` : ''}</g>`;
  }).join('');
  const names = rows.map((id, i) => `<text x="0" y="${top + i * rowH + 21}" font-size="12" fill="var(--ink)">${esc((p.names[id] || 'Unassigned').split(' ')[0])}</text>`).join('');
  const rel = x(p.version.releaseDate) + dw;
  return `<div class="plan-timeline"><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Timeline of planned tickets">
      ${ticks}${names}${bars}
      <line x1="${rel}" x2="${rel}" y1="${top - 6}" y2="${h}" stroke="var(--danger)" stroke-width="2" stroke-dasharray="4 3"/>
      <text x="${rel + 3}" y="${top + 4}" font-size="11" fill="var(--danger)">Release</text></svg></div>
    <p class="help">${Object.entries(PRIORITY_COLOURS).map(([k, c]) => `<span class="key-dot" style="background:${c}"></span>${k}`).join(' ')} <span class="key-dot" style="background:var(--danger)"></span>After the release</p>`;
}

function planRowsHtml(list, p) {
  return `<div class="table-wrap"><table><thead><tr><th>Ticket</th><th>Priority</th>${p.canPlan ? '<th>Who</th>' : ''}<th>Starts</th><th>Due</th><th class="num">Hours left</th></tr></thead>
    <tbody>${list.map((s) => `<tr${s.fits ? '' : ' class="unfit"'}>
      <td>${mesLink(s.key)}<br><span class="muted">${esc(s.summary)}</span></td><td>${esc(s.priority)}</td>
      ${p.canPlan ? `<td>${esc(p.names[s.personId] || '—')}${s.plannedAssignee && s.personId ? '<br><span class="muted">suggested</span>' : ''}</td>` : ''}
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
        ? `<div><dt>Doesn't fit</dt><dd class="bad">${hoursLabel(Math.round(unfitHours))}<small>${n(unfit.length)} ${unfit.length === 1 ? 'ticket' : 'tickets'} past the release</small></dd></div>`
        : `<div><dt>Room left</dt><dd>${hoursLabel(Math.round(Math.max(0, free)))}<small>before the reserve</small></dd></div>`}</dl>`;
  const sugg = p.suggestions.length ? `<h2>Suggested changes</h2><ul class="list approvals">${p.suggestions.map((s) => `<li>
      <span class="title">Move ${mesLink(s.key)} ${esc(s.summary)}</span>
      <span class="sub">${esc(s.priority)}, ${hoursLabel(Math.round(s.hours * 4) / 4)} left. To ${p.next ? esc(p.next.name) : 'no release'}, ${esc(s.reason)}.</span>
      <div class="row" style="margin-top:.6rem"><button class="btn" data-plan-suggest="accept" data-issue="${esc(s.id)}">Move it</button>
        <button class="btn secondary" data-plan-suggest="decline" data-issue="${esc(s.id)}">Keep it in</button></div></li>`).join('')}</ul>` : '';
  const stuck = p.stillOut.length ? `<div class="card notice"><p style="margin:0">${p.stillOut.map((s) => mesLink(s.key)).join(', ')} still ${p.stillOut.length === 1 ? "doesn't" : "don't"} fit before the release, even with the suggested changes. Their time may need more people, a later release date, or using some of the reserve.</p></div>` : '';
  const needs = p.needsEstimate.length ? `<h2>Needs an estimate first</h2><ul class="list mes-list">${p.needsEstimate.map((t) => `<li>
      <span class="title">${mesLink(t.key)} ${esc(t.summary)}</span><span class="sub">${esc(t.priority)}</span>
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
      <p class="help">Accepting writes each planned ticket's start and due dates to Jira for the timeline, and the suggested person where nobody is assigned.</p>
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
      toast(r.waiting ? `Plan accepted. ${r.waiting} more go to Jira over the next few minutes` : 'Plan accepted and in Jira');
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
  if (edit) { planCapacityOpen = planCapacityOpen === edit.dataset.capEdit ? null : edit.dataset.capEdit; return render(); }
  const row = t('[data-cap]');
  if (row && planCapacityOpen) {
    const p = planCache?.people.find((x) => x.id === row.dataset.cap);
    if (!p) return false;
    const day = t('[data-cap-day]');
    if (day) { const d = day.dataset.capDay; p.days = p.days.includes(d) ? p.days.replace(d, '') : [...p.days, d].sort().join(''); day.classList.toggle('on'); return true; }
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
          ${me.user.isAdmin ? `<li><a href="#/admin" data-account="close">${svgIcon('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>')}Admin tools</a></li>` : ''}
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
    if (action === 'cancel-log') { logChosen = null; return render(); }
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
    'start-ledger': 'start-result', link: 'link-result', 'set-role': 'role-result',
    'scan-jobs': 'jobs-result', 'backfill-start': 'jobs-result', 'recompute-stages': 'jobs-result',
    'vehicle-expiries': 'vehicle-result', 'save-vehicle': 'vehicle-result', 'ra-add': 'ra-result',
    'test-8x8': 'eight8-result', 'lib-list': 'lib-result',
    'elo-start': 'elo-result', 'elo-stop': 'elo-result', 'elo-step': 'elo-result',
 }[action];
  button.disabled = true;
  try {
    if (action === 'sync-now') {
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
    } else if (action === 'set-role') {
      await api('/api/admin/set-role', {
        method: 'POST',
        body: JSON.stringify({
          accountId: document.getElementById('role-account').value,
          role: document.getElementById('role-role').value,
          team: document.getElementById('role-team').value || null,
        }),
      });
      out(target, 'Role saved.');
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
  const onPow = currentRoute() === '#/pow';

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
      location.hash = '#/log';
      return;
    }
    logChosen = picked;
    await render();
    updateXpPreview();
    return loadStageHint();
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
      ? { name: '', role: 'engineer', xpRate: 60, order: 50, icons: [] }
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
  if (obsRemove) { removePath(obsRemove.dataset.obsRemove); return render(); }
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

  const periodBtn = event.target.closest('button[data-period]');
  if (periodBtn) { leaderPeriod = periodBtn.dataset.period; leaderExpanded = false; return loadLeaderboard(); }
  const leaderBtn = event.target.closest('button[data-leader]');
  if (leaderBtn) { leaderExpanded = !leaderExpanded; return loadLeaderboard(); }
  if (event.target.closest('.day-card') && await dayClick(event) !== false) return;
  if (currentRoute() === '#/condor' && !settingsOpen && await condorClick(event) !== false) return;
  if (currentRoute() === '#/jobs' && await jobsClick(event) !== false) return;
  if (event.target.closest('[data-qcfg-save]')) return saveQuoteSettings(event.target.closest('[data-qcfg-save]'));
  if (settingsOpen === '#/org' && await orgSettingsClick(event)) return;
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
  const hash = location.hash.replace(/\/$/, '');
  return pages[hash] ? hash : '#/';
}

const spinner = (label = 'Loading') => `<div class="card loading-card"><span class="spinner" aria-hidden="true"></span>
    <span>${esc(label)}…</span></div>`;

// Some pages know what they are waiting for.
const WAITING_FOR = {
  '#/jobs': () => (jobsView ? 'Loading the job from Jira' : 'Fetching open jobs from Jira'),
  '#/quotes': () => (quotesView?.kind === 'new' ? 'Fetching customers from Jira' : 'Loading'),
  '#/condor': () => (condorTab === 'triage' || condorTab === 'plan' ? 'Fetching releases from Jira' : 'Loading'),
  '#/obs': () => (obsSurvey?.picking ? 'Fetching the client list from Jira' : 'Loading'),
  '#/calls': () => 'Loading',
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
  '#/org': { label: 'Company chart versions', render: () => settingsOrgHtml() },
};
let settingsOpen = null;
let settingsData = null;

function cogButton(route) {
  if (!me?.user?.isAdmin || !TILE_SETTINGS[route]) return '';
  return `<button class="cog" data-settings="${route}" aria-label="${esc(TILE_SETTINGS[route].label)}" title="${esc(TILE_SETTINGS[route].label)}">
      ${svgIcon('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>')}
    </button>`;
}

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const route = currentRoute();
  const page = pages[route];
  back.hidden = route === '#/';
  avatar.textContent = initials();
  band.innerHTML = settingsOpen === route
    ? `<h1>${esc(TILE_SETTINGS[route].label)}</h1><p>Admin only.</p>`
    : page.band() + cogButton(route);

  // Anything slow gets a spinner, but only while it is still the newest render.
  const slow = setTimeout(() => {
    if (token === renderToken) view.innerHTML = spinner(WAITING_FOR[route]?.() || 'Loading');
  }, 160);

  try {
    const html = settingsOpen === route ? await renderSettings(route) : await page.render();
    if (token === renderToken && currentRoute() === route) {
      view.innerHTML = html;
      if (route === '#/xp') { loadLeaderboard(); loadEloHistory(); loadModifiers(); }
      if (route === '#/condor' && condorTab === 'day' && !mesEst) loadDayDrafts();
      if (route === '#/admin' && !settingsOpen) loadAudit();
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
  }
}

let searchTimer = null;
view.addEventListener('input', (event) => {
  if (currentRoute() === '#/quotes' && quotesInput(event)) return;
  if (currentRoute() === '#/condor' && condorInput(event)) return;
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
  settingsOpen = null;
  if (currentRoute() !== '#/time') weekOffset = 0;
  if (currentRoute() !== '#/reports') reportAccount = null;
  if (currentRoute() !== '#/') arrangeMode = false;
  if (currentRoute() !== '#/admin') personEdit = null;
  if (currentRoute() !== '#/shop') shopSimulation = null;
  if (currentRoute() !== '#/obs') { obsSurvey = null; obsSection = 0; obsReading = null; obsView = null; }
  if (currentRoute() !== '#/calls' && currentRoute() !== '#/log') { callFlow = null; pendingCall = null; }
  if (currentRoute() !== '#/it') { itForm = null; itAssets = []; }
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
  try {
    me = await api('/api/me');
  } catch (err) {
    band.innerHTML = '<h1>Promtek Hub</h1>';
    view.innerHTML = `<div class="card notice error"><p><strong>Couldn't load the hub.</strong></p><p>${esc(err.message)}</p></div>`;
    return;
  }
  try { tilePrefs = { hidden: [], ...(await api('/api/prefs/tiles')) }; } catch { /* defaults are fine */ }
  await render();
  syncAndRefresh();
  powFlushQueue();
  window.addEventListener('online', () => powFlushQueue());

  // Refresh when the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncAndRefresh();
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

start();
