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
    band: () => `<h1>Admin</h1><p>Sync status, shadow-mode checks and account links.</p>`,
    async render() {
      if (!me.user.isAdmin) return `<div class="card"><p>Only admins can see this page.</p></div>`;
      const [data, itTypes, adminVehicles, raList] = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/it-types').catch((err) => ({ categories: [], types: [], error: err.message })),
        api('/api/admin/vehicles').catch(() => ({ vehicles: [] })),
        api('/api/admin/ra-library').catch(() => ({ items: [] })),
      ]);
      const s = data.state;
      itServiceDeskId = itTypes.serviceDeskId || itServiceDeskId;
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
            <button class="btn secondary" data-action="refresh-profiles">Refresh profiles from Jira</button>
            <button class="btn secondary" data-action="snapshot">Record last week's snapshot</button>
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

        <h2>Completed job tracking</h2>
        <div class="card">
          <p style="margin-top:0">Finished customer work is recorded for quoting. It never changes anyone's XP or ELO.</p>
          <dl class="state">
            <dt>Items recorded</dt><dd>${n(data.jobs.rows || 0)} (${n(data.jobs.epics || 0)} orders, ${n(data.jobs.categories || 0)} categories, ${n(data.jobs.stages || 0)} stages)</dd>
            <dt>Covering</dt><dd>${data.jobs.earliest ? `${esc(data.jobs.earliest)} to ${esc(data.jobs.latest)}` : 'Nothing yet'}</dd>
            <dt>Backfill</dt><dd>${!data.jobs.until ? 'Not started'
              : data.jobs.done ? `Finished, back to ${esc(data.jobs.until)}`
              : `Working backwards, reached ${esc(data.jobs.before)} of ${esc(data.jobs.until)}`}</dd>
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

        <h2>Roles</h2>
        <div class="card">
          <p>Admins see everything and manage roles. Team leads see all reports and handle alerts and approvals for their team. Engineers see their own data, plus the leaderboard.</p>
          <div class="row">
            <label>Engineer <select id="role-account">${options}</select></label>
            <label>Role <select id="role-role">
              <option value="engineer">Engineer</option><option value="lead">Team lead</option><option value="admin">Admin</option>
            </select></label>
            <label>Team <select id="role-team">
              <option value="">None</option><option>Projecting</option><option>Service</option><option>Condor</option>
            </select></label>
            <button class="btn" data-action="set-role">Save role</button>
          </div>
          <div class="result" id="role-result" role="status"></div>
        </div>

        <h2>Engineers</h2>
        <p class="muted">During shadow mode, Difference compares the hub's XP with the XP field in Jira. Jira's figure refreshes hourly.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Role</th><th>Team</th><th>Signed in as</th><th class="num">ELO</th><th class="num">Hub XP</th><th class="num">Jira XP</th><th class="num">Difference</th><th class="num">Worklogs</th></tr></thead>
          <tbody>${data.employees.map((e) => `<tr>
            <td>${esc(e.name)}</td>
            <td>${e.role === 'lead' ? 'Team lead' : e.role === 'admin' ? 'Admin' : 'Engineer'}</td>
            <td>${e.team ? esc(e.team) : '<span class="muted">—</span>'}</td>
            <td>${e.email ? esc(e.email) : '<span class="muted">Not linked</span>'}</td>
            <td class="num">${e.elo != null ? n(Math.round(e.elo)) : '—'}</td>
            <td class="num">${n(e.app_xp)}</td>
            <td class="num">${n(e.jira_xp)}</td>
            <td class="num ${Math.abs(e.difference) > 50 ? 'bad' : 'good'}">${e.difference > 0 ? '+' : ''}${n(e.difference)}</td>
            <td class="num">${n(e.worklogs)}</td>
          </tr>`).join('') || '<tr><td colspan="9" class="muted">No engineers yet. Refresh profiles from Jira.</td></tr>'}</tbody>
        </table></div>

        <h2>Time from people without a profile</h2>
        ${data.unmatched.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Atlassian account ID</th><th class="num">Worklogs</th><th class="num">Time</th><th>Latest</th></tr></thead>
          <tbody>${data.unmatched.map((u) => `<tr><td>${esc(u.account_id)}</td><td class="num">${n(u.worklogs)}</td><td class="num">${duration(u.seconds)}</td><td>${esc(u.latest)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="muted">Give these people an Employee issue in DNM with their account ID in the UserID field, then refresh profiles. Any of their time from the last two weeks is picked up within about 30 minutes.</p>`
        : '<div class="card"><p class="muted">None. Every worklog belongs to someone with a profile.</p></div>'}

        <h2>Vehicles</h2>
        <div class="card">
          <div class="table-wrap"><table>
            <thead><tr><th>Registration</th><th>Vehicle</th><th>Status</th><th>MOT</th><th>Insurance</th><th>Tax</th><th>Service</th><th class="num">Miles</th></tr></thead>
            <tbody>${adminVehicles.vehicles.map((v) => `<tr>
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
        </div>

        <h2>IT request types</h2>
        <div class="card">
          <p style="margin-top:0">What the hub offers engineers, and the Jira request type each one raises.</p>
          ${itTypes.error ? `<p class="bad">${esc(itTypes.error)}</p>` : `
            <div class="table-wrap"><table>
              <thead><tr><th>In the hub</th><th>Raises in Jira</th></tr></thead>
              <tbody>${itTypes.categories.map((c) => `<tr>
                <td>${esc(c.label)}</td>
                <td><select data-it-map="${esc(c.id)}">
                  <option value="">Not set up</option>
                  ${itTypes.types.map((t) => `<option value="${esc(t.id)}"${t.id === c.mapped ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
                </select></td>
              </tr>`).join('')}</tbody>
            </table></div>`}
          <div class="result" id="it-map-result" role="status"></div>
        </div>

        <h2>Risk assessments and safe systems of work</h2>
        <div class="card">
          <p style="margin-top:0">What engineers can pick from on a point of work assessment.</p>
          <ul class="list" style="box-shadow:none">${raList.items.map((r) => `<li>
              <span class="title">${esc(r.title)}</span>
              <span class="sub">${r.active ? 'In the list' : 'Hidden'}</span>
              <span class="xp"><button class="linklike" data-ra-toggle="${esc(r.id)}" data-ra-active="${r.active ? 0 : 1}" data-ra-title="${esc(r.title)}">${r.active ? 'Hide' : 'Show'}</button></span>
            </li>`).join('') || '<li><span class="muted">Nothing yet.</span></li>'}</ul>
          <div class="row" style="margin-top:1rem">
            <label style="flex:1">Add one <input id="ra-title" placeholder="RA - 1021 - Working at Height" autocomplete="off"></label>
            <button class="btn" data-action="ra-add">Add</button>
          </div>
          <div class="result" id="ra-result" role="status"></div>
        </div>

        <h2>Link a Google account</h2>
        <div class="card">
          <p>People are linked automatically the first time they sign in. Use this if someone's account didn't match.</p>
          <div class="row">
            <label>Engineer <select id="link-account">${options}</select></label>
            <label>Google email <input id="link-email" type="email" placeholder="name@promtek.com"></label>
            <button class="btn" data-action="link">Link account</button>
          </div>
          <div class="result" id="link-result" role="status"></div>
        </div>`;
    },
  },
};

// ---------- account panel ----------

// ---------- arranging tiles ----------

let tilePrefs = { order: null, hidden: [] };
let arrangeMode = false;

const allowedTile = (m) => (!m.adminOnly || me.user.isAdmin) && (!m.leadOnly || me.user.isLead);

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
        <label>Hours <input id="log-hours" type="number" min="0" max="16" step="1" value="1" inputmode="numeric"></label>
        <label>Minutes <input id="log-minutes" type="number" min="0" max="59" step="5" value="0" inputmode="numeric"></label>
      </div>
      <label style="margin-top:.75rem">What did you do? <input id="log-note" placeholder="Optional" autocomplete="off"></label>
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

const DISCIPLINE_NAMES = { software: 'Software', hardware: 'Hardware', engineering: 'Engineering', condor: 'Condor' };

function quotingHtml(data) {
  const ratioCell = (ratio) => {
    if (ratio == null) return '<td class="num muted">—</td>';
    const over = ratio > 1.25, under = ratio < 0.75;
    return `<td class="num${over ? ' bad' : under ? ' low' : ' good'}">${ratio.toFixed(2)}×</td>`;
  };
  const bands = data.byBand.map((b) => `<tr>
      <td>${esc(DISCIPLINE_NAMES[b.discipline] || b.discipline)}</td>
      <td class="num">${n(b.storyPoints)}</td>
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
      <td class="num">${j.story_points == null ? '—' : n(j.story_points)}</td>
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
      One sprint is ${data.sprintHours} hours. ${n(good)} of ${n(counted)} recorded items have an estimate,
      a story point band and believable hours; the rest are excluded unless you tick the box.</p>
    </div>

    <h2>How long each story point band really takes</h2>
    ${data.byBand.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Discipline</th><th class="num">Story points</th><th class="num">Jobs</th>
        <th class="num">Estimate (median)</th><th class="num">Actual (median)</th><th class="num">Actual vs estimate</th><th class="num">Range</th></tr></thead>
      <tbody>${bands}</tbody>
    </table></div>
    <p class="muted">Where actual and estimate differ consistently, the sprint value table for that band is the thing to change.</p>`
    : '<div class="card"><p class="muted">No finished categories with story points yet. Run the historical backfill from the Admin page to build up a starting set.</p></div>'}

    ${groupTable('By customer', data.byCustomer)}
    ${groupTable('By team', data.byTeam)}

    <h2>Recently finished</h2>
    ${jobs ? `<div class="table-wrap"><table>
      <thead><tr><th>Finished</th><th>Customer</th><th>Item</th><th>Discipline</th><th class="num">Points</th>
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
  const trend = snapshots.length > 1 ? `<h2>Level and ELO over time</h2>
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
    if (action === 'cancel-psc') { logPscProject = null; return render(); }

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

async function adminAction(action, button) {
  const out = (id, text, isError) => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = `result ${isError ? 'bad' : ''}`;
  };
  const target = { 'sync-now': 'sync-result', 'refresh-profiles': 'sync-result', snapshot: 'sync-result',
    'start-ledger': 'start-result', link: 'link-result', 'set-role': 'role-result',
    'scan-jobs': 'jobs-result', 'backfill-start': 'jobs-result', 'recompute-stages': 'jobs-result',
    'vehicle-expiries': 'vehicle-result', 'save-vehicle': 'vehicle-result', 'ra-add': 'ra-result' }[action];
  button.disabled = true;
  try {
    if (action === 'sync-now') {
      const r = await api('/api/admin/sync-now', { method: 'POST' });
      out(target, r.skipped ? r.skipped : `Checked ${r.fetched} worklogs, updated ${r.changed}.`);
    } else if (action === 'refresh-profiles') {
      const r = await api('/api/admin/refresh-profiles', { method: 'POST' });
      out(target, `Refreshed ${r.employees} profiles.${r.skippedNoUserId.length ? ` Skipped (no UserID): ${r.skippedNoUserId.join(', ')}` : ''}`);
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
      out(target, `Recorded ${r.epics} finished orders and ${r.rows} items.`);
    } else if (action === 'backfill-start') {
      const months = document.getElementById('backfill-months').value;
      const r = await api('/api/admin/backfill-start', { method: 'POST', body: JSON.stringify({ months }) });
      out(target, `Backfill started, working back to ${r.until}. It runs in the background, a batch every couple of minutes.`);
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
    } else if (action === 'ra-add') {
      const title = document.getElementById('ra-title').value.trim();
      if (!title) return out('ra-result', 'Type the name first.', true);
      await api('/api/admin/ra-save', { method: 'POST', body: JSON.stringify({ title }) });
      out('ra-result', 'Added.');
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
    if (!['sync-now', 'snapshot', 'scan-jobs', 'backfill-start', 'recompute-stages', 'vehicle-expiries'].includes(action)) {
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
  if (pscBtn) { logPscProject = pscBtn.dataset.psc; view.innerHTML = pscFormHtml(logPscProject); return; }
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

async function render() {
  const route = currentRoute();
  const page = pages[route];
  back.hidden = route === '#/';
  avatar.textContent = initials();
  band.innerHTML = page.band();
  try {
    const html = await page.render();
    if (currentRoute() === route) {
      view.innerHTML = html;
      if (route === '#/xp') loadLeaderboard();
    }
  } catch (err) {
    view.innerHTML = `<div class="card notice error"><p>${esc(err.message)}</p></div>`;
  }
}

let searchTimer = null;
view.addEventListener('input', (event) => {
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
  if (currentRoute() !== '#/time') weekOffset = 0;
  if (currentRoute() !== '#/reports') reportAccount = null;
  if (currentRoute() !== '#/') arrangeMode = false;
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
