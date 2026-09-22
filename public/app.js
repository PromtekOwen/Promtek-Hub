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
      const tiles = MODULES.filter((m) => !m.adminOnly || me.user.isAdmin).map((m) => {
        const detail = m.detail ? `<span class="detail">${m.detail(me)}</span>` : '';
        const inner = `<span class="tile-icon">${m.icon}</span><strong>${esc(m.name)}</strong>${detail}`;
        if (m.construction) return `<div class="tile construction" aria-disabled="true">${inner}<span class="badge">Under construction</span></div>`;
        return `<a class="tile" href="${esc(m.route || m.href)}">${inner}</a>`;
      }).join('');
      const setup = me.user.isAdmin && !me.ledgerStart
        ? `<div class="card notice" style="margin-bottom:1rem"><p><strong>XP tracking hasn't started yet.</strong> Open <a href="#/admin">Admin</a> to start the ledger.</p></div>`
        : '';
      return `${setup}${me.linked ? '' : notLinkedCard()}<div class="tiles">${tiles}</div>
        ${me.linked ? `<h2>Latest XP</h2>${xpList(me.recent.slice(0, 4), 'Log time in Tempo and your XP appears here within a couple of minutes.')}` : ''}`;
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
        <div class="card notice" style="margin-top:1rem">
          <p><strong>Logging time from the hub is coming next.</strong></p>
          <p class="muted">For now, keep logging in Tempo. New time shows up here within a couple of minutes.</p>
          <p style="margin-top:.75rem"><a class="btn secondary" href="${esc(me.jiraBaseUrl)}/plugins/servlet/ac/io.tempo.jira/tempo-app" target="_blank" rel="noopener">Open Tempo</a></p>
        </div>
        ${listByDay || `<h2>Time logs</h2><div class="card"><p class="muted">Nothing logged ${weekOffset === 0 ? 'yet this week' : 'this week'}.</p></div>`}`;
    },
  },

  '#/admin': {
    band: () => `<h1>Admin</h1><p>Sync status, shadow-mode checks and account links.</p>`,
    async render() {
      if (!me.user.isAdmin) return `<div class="card"><p>Only admins can see this page.</p></div>`;
      const data = await api('/api/admin/overview');
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
            <button class="btn secondary" data-action="refresh-profiles">Refresh profiles from Jira</button>
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

        <h2>Engineers</h2>
        <p class="muted">During shadow mode, Difference compares the hub's XP with the XP field in Jira. Jira's figure refreshes hourly.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Signed in as</th><th class="num">ELO</th><th class="num">Hub XP</th><th class="num">Jira XP</th><th class="num">Difference</th><th class="num">Worklogs</th></tr></thead>
          <tbody>${data.employees.map((e) => `<tr>
            <td>${esc(e.name)}</td>
            <td>${e.email ? esc(e.email) : '<span class="muted">Not linked</span>'}</td>
            <td class="num">${e.elo != null ? n(Math.round(e.elo)) : '—'}</td>
            <td class="num">${n(e.app_xp)}</td>
            <td class="num">${n(e.jira_xp)}</td>
            <td class="num ${Math.abs(e.difference) > 50 ? 'bad' : 'good'}">${e.difference > 0 ? '+' : ''}${n(e.difference)}</td>
            <td class="num">${n(e.worklogs)}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">No engineers yet. Refresh profiles from Jira.</td></tr>'}</tbody>
        </table></div>

        <h2>Time from people without a profile</h2>
        ${data.unmatched.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Atlassian account ID</th><th class="num">Worklogs</th><th class="num">Time</th><th>Latest</th></tr></thead>
          <tbody>${data.unmatched.map((u) => `<tr><td>${esc(u.account_id)}</td><td class="num">${n(u.worklogs)}</td><td class="num">${duration(u.seconds)}</td><td>${esc(u.latest)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="muted">Give these people an Employee issue in DNM with their account ID in the UserID field, then refresh profiles. Any of their time from the last two weeks is picked up within about 30 minutes.</p>`
        : '<div class="card"><p class="muted">None. Every worklog belongs to someone with a profile.</p></div>'}

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

async function adminAction(action, button) {
  const out = (id, text, isError) => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = `result ${isError ? 'bad' : ''}`;
  };
  const target = { 'sync-now': 'sync-result', 'refresh-profiles': 'sync-result', 'start-ledger': 'start-result', link: 'link-result' }[action];
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
    } else if (action === 'link') {
      await api('/api/admin/link', {
        method: 'POST',
        body: JSON.stringify({ accountId: document.getElementById('link-account').value, email: document.getElementById('link-email').value }),
      });
      out(target, 'Linked.');
    }
    if (action !== 'sync-now') setTimeout(render, 1200);
  } catch (err) {
    out(target, err.message, true);
  } finally {
    button.disabled = false;
  }
}

view.addEventListener('click', (event) => {
  const actionBtn = event.target.closest('button[data-action]');
  if (actionBtn) return adminAction(actionBtn.dataset.action, actionBtn);
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
    if (currentRoute() === route) view.innerHTML = html;
  } catch (err) {
    view.innerHTML = `<div class="card notice error"><p>${esc(err.message)}</p></div>`;
  }
}

window.addEventListener('hashchange', () => {
  if (currentRoute() !== '#/time') weekOffset = 0;
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
  await render();
  syncAndRefresh();

  // Refresh when the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncAndRefresh();
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

start();
