import { MODULES } from './modules.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
let me = null;

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v || 0).toLocaleString('en-GB');

function duration(seconds) {
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function shortDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  // An expired sign-in comes back as a redirect to the Google login page.
  if (res.type === 'opaqueredirect' || res.status === 0) {
    location.reload();
    throw new Error('Your sign-in expired. Reloading…');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

// ---------- pieces ----------

function renderNav(route) {
  const links = [['#/', 'Home'], ['#/profile', 'Profile']];
  if (me?.user?.isAdmin) links.push(['#/admin', 'Admin']);
  const initials = (me?.employee?.name || me?.user?.email || '?')
    .split(/[\s.@]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  nav.innerHTML =
    links.map(([href, label]) => `<a href="${href}"${route === href ? ' aria-current="page"' : ''}>${label}</a>`).join('') +
    `<span class="avatar" title="${esc(me?.user?.email)}" aria-label="Signed in as ${esc(me?.user?.email)}">${esc(initials)}</span>`;
}

function readout(emp) {
  const p = emp.progress;
  const pct = Math.min(100, (p.xpIntoLevel / p.levelSpan) * 100);
  const rank = emp.rank;
  const titleNote = p.nextTitle
    ? `${p.nextTitle} at level ${p.nextTitleLevel}`
    : 'Highest title reached';
  return `
    <section class="readout" aria-label="Your progress">
      <div>
        <div class="display">
          <div class="display-row">
            <span class="display-label">Level</span>
            <span class="display-label">${n(p.xp)} XP</span>
          </div>
          <div class="digits">${n(p.level)}</div>
          <div class="title-line">${esc(p.title)}</div>
        </div>
        <div class="scale">
          <div class="scale-track" role="progressbar" aria-valuemin="0" aria-valuemax="${p.levelSpan}" aria-valuenow="${p.xpIntoLevel}" aria-label="Progress to level ${p.level + 1}">
            <div class="scale-fill" style="width:${pct.toFixed(1)}%"></div>
            <div class="scale-ticks"></div>
          </div>
          <div class="scale-caption">${n(p.xpToNextLevel)} XP to level ${n(p.level + 1)}. ${esc(titleNote)}.</div>
        </div>
      </div>
      <dl class="stats">
        <div><dt>ELO rating</dt><dd>${emp.elo != null ? n(Math.round(emp.elo)) : '—'}${rank ? `<small>${esc(rank.name)}</small>` : ''}</dd></div>
        <div><dt>Next rank</dt><dd>${rank?.nextAt ? n(rank.nextAt) : '—'}${rank?.nextName ? `<small>${esc(rank.nextName)}</small>` : ''}</dd></div>
        <div><dt>XP this week</dt><dd>${n(emp.week.xp)}</dd></div>
        <div><dt>Time this week</dt><dd>${duration(emp.week.seconds)}</dd></div>
      </dl>
    </section>`;
}

function logList(entries) {
  if (!entries.length) {
    return `<div class="panel"><p class="muted">No XP logged yet. Log time in Tempo as usual and it will appear here within a couple of minutes.</p></div>`;
  }
  return `<ul class="log">${entries.map((e) => {
    const how = e.job_elo
      ? `Job ELO ${n(Math.round(e.job_elo))}, yours ${n(Math.round(e.engineer_elo))}`
      : 'No job rating, baseline rate';
    const override = e.override != null && e.override !== 1 ? `, override ×${e.override}` : '';
    const issue = e.issue_key
      ? `<a href="${esc(me.jiraBaseUrl)}/browse/${esc(e.issue_key)}" target="_blank" rel="noopener">${esc(e.issue_key)}</a>`
      : '<span class="muted">Issue</span>';
    return `<li>
      <span class="date">${shortDate(e.work_date)}</span>
      <span class="what">${issue} <span class="summary">${esc(e.summary || e.description)}</span></span>
      <span class="xp">+${n(e.xp)}<small>${duration(e.seconds)}</small></span>
      <span class="how">${how}${override}. ${Number(e.rate).toFixed(2)} XP per minute.</span>
    </li>`;
  }).join('')}</ul>`;
}

function appTiles() {
  const visible = MODULES.filter((m) => !m.adminOnly || me?.user?.isAdmin);
  return `<div class="apps">${visible.map((m) => m.comingSoon
    ? `<div class="app" aria-disabled="true">${m.icon}<strong>${esc(m.name)}</strong><span>${esc(m.description)}</span><em class="soon">Coming soon</em></div>`
    : `<a class="app" href="${esc(m.href)}">${m.icon}<strong>${esc(m.name)}</strong><span>${esc(m.description)}</span></a>`
  ).join('')}</div>`;
}

function notLinkedNotice() {
  return `<div class="notice">
    <p><strong>Your account isn't linked to an engineer profile yet.</strong></p>
    <p>You're signed in as ${esc(me.user.email)}. An admin can link you from the Admin page. You can still use the apps below.</p>
  </div>`;
}

function notStartedNotice() {
  return me.user.isAdmin
    ? `<div class="notice"><p><strong>XP tracking hasn't started yet.</strong> Open <a href="#/admin">Admin</a> and start the ledger.</p></div>`
    : '';
}

// ---------- pages ----------

function homePage() {
  const first = (me.employee?.name || '').split(' ')[0];
  return `
    <h1>${greeting()}${first ? `, ${esc(first)}` : ''}</h1>
    <p class="lede">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
    ${me.ledgerStart ? '' : notStartedNotice()}
    ${me.linked ? readout(me.employee) : notLinkedNotice()}
    <h2>Apps</h2>
    ${appTiles()}
    ${me.linked ? `<h2>Recent XP</h2>${logList(me.recent.slice(0, 5))}<a class="more" href="#/profile">See all your XP</a>` : ''}
  `;
}

function profilePage() {
  if (!me.linked) return `<h1>Profile</h1>${notLinkedNotice()}`;
  const e = me.employee;
  return `
    <h1>${esc(e.name)}</h1>
    <p class="lede">${esc(me.user.email)}${e.profileKey ? `. Profile <a href="${esc(me.jiraBaseUrl)}/browse/${esc(e.profileKey)}" target="_blank" rel="noopener">${esc(e.profileKey)}</a> in Jira` : ''}</p>
    ${readout(e)}
    <h2>Where your XP came from</h2>
    ${logList(me.recent)}
  `;
}

async function adminPage() {
  if (!me.user.isAdmin) return `<h1>Admin</h1><p>Only admins can see this page.</p>`;
  const data = await api('/api/admin/overview');
  const s = data.state;
  const options = data.employees.map((e) => `<option value="${esc(e.account_id)}">${esc(e.name)}${e.email ? ` (${esc(e.email)})` : ''}</option>`).join('');

  return `
    <h1>Admin</h1>
    <p class="lede">Sync status, shadow-mode checks and account links.</p>

    ${s.last_error ? `<div class="notice error"><p><strong>Last sync problem</strong></p><p>${esc(s.last_error)}</p></div>` : ''}

    <h2>Sync</h2>
    <div class="panel">
      <dl class="state">
        <dt>Ledger started</dt><dd>${esc(s.ledger_start || 'Not started')}</dd>
        <dt>Last scheduled run</dt><dd>${s.last_scheduled_run ? new Date(s.last_scheduled_run).toLocaleString('en-GB') : 'Not yet'}</dd>
        <dt>Profiles refreshed</dt><dd>${s.last_profile_refresh ? new Date(s.last_profile_refresh).toLocaleString('en-GB') : 'Not yet'}</dd>
      </dl>
      <div class="row" style="margin-top:1rem">
        <button class="secondary" data-action="sync-now">Sync Tempo now</button>
        <button class="secondary" data-action="refresh-profiles">Refresh profiles from Jira</button>
      </div>
      <div class="result" id="sync-result" role="status"></div>
    </div>

    <h2>Start the XP ledger</h2>
    <div class="panel">
      <p>This copies everyone's current XP from Jira as their starting balance, then counts XP from Tempo worklogs dated from today onwards. Run it once, before anyone logs time for the day. Running it again wipes the ledger and starts over.</p>
      <div class="row">
        <label>Type START to confirm <input id="confirm-start" autocomplete="off" size="8"></label>
        <button data-action="start-ledger">Start ledger</button>
      </div>
      <div class="result" id="start-result" role="status"></div>
    </div>

    <h2>Engineers</h2>
    <p class="muted">During shadow mode, the difference column compares the hub's XP with the XP field in Jira. Jira's figure refreshes hourly.</p>
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

    <h2>Worklogs from people without a profile</h2>
    ${data.unmatched.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Atlassian account ID</th><th class="num">Worklogs</th><th class="num">Time</th><th>Latest</th></tr></thead>
      <tbody>${data.unmatched.map((u) => `<tr><td>${esc(u.account_id)}</td><td class="num">${n(u.worklogs)}</td><td class="num">${duration(u.seconds)}</td><td>${esc(u.latest)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="muted">Give these people an Employee issue in DNM with their account ID in the UserID field, then refresh profiles. Any of their time logged in the last two weeks is picked up within about 30 minutes.</p>`
    : '<div class="panel"><p class="muted">None. Every worklog belongs to someone with a profile.</p></div>'}

    <h2>Link a Google account</h2>
    <div class="panel">
      <p>People are linked automatically the first time they sign in. Use this if someone's account didn't match.</p>
      <div class="row">
        <label>Engineer <select id="link-account">${options}</select></label>
        <label>Google email <input id="link-email" type="email" placeholder="name@promtek.com"></label>
        <button data-action="link">Link account</button>
      </div>
      <div class="result" id="link-result" role="status"></div>
    </div>
  `;
}

async function adminAction(action, button) {
  const out = (id, text, isError) => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = `result ${isError ? 'bad' : ''}`;
  };
  button.disabled = true;
  try {
    if (action === 'sync-now') {
      const r = await api('/api/admin/sync-now', { method: 'POST' });
      out('sync-result', r.skipped ? r.skipped : `Checked ${r.fetched} worklogs, updated ${r.changed}.`);
    } else if (action === 'refresh-profiles') {
      const r = await api('/api/admin/refresh-profiles', { method: 'POST' });
      out('sync-result', `Refreshed ${r.employees} profiles.${r.skippedNoUserId.length ? ` Skipped (no UserID): ${r.skippedNoUserId.join(', ')}` : ''}`);
    } else if (action === 'start-ledger') {
      const confirm = document.getElementById('confirm-start').value.trim();
      const r = await api('/api/admin/start-ledger', { method: 'POST', body: JSON.stringify({ confirm }) });
      out('start-result', `Ledger started for ${r.ledgerStart} with ${r.employees} engineers.`);
      me = await api('/api/me');
    } else if (action === 'link') {
      await api('/api/admin/link', {
        method: 'POST',
        body: JSON.stringify({ accountId: document.getElementById('link-account').value, email: document.getElementById('link-email').value }),
      });
      out('link-result', 'Linked.');
    }
    if (action !== 'sync-now') setTimeout(render, 1200);
  } catch (err) {
    const target = { 'sync-now': 'sync-result', 'refresh-profiles': 'sync-result', 'start-ledger': 'start-result', link: 'link-result' }[action];
    out(target, err.message, true);
  } finally {
    button.disabled = false;
  }
}

// ---------- routing ----------

async function render() {
  const route = location.hash.replace(/\/$/, '') || '#';
  const key = route === '#' ? '#/' : route;
  renderNav(key);
  try {
    if (key === '#/profile') view.innerHTML = profilePage();
    else if (key === '#/admin') view.innerHTML = await adminPage();
    else view.innerHTML = homePage();
  } catch (err) {
    view.innerHTML = `<div class="notice error"><p>${esc(err.message)}</p></div>`;
  }
}

view.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (button) adminAction(button.dataset.action, button);
});

window.addEventListener('hashchange', () => { render(); view.focus(); });

async function start() {
  try {
    me = await api('/api/me');
  } catch (err) {
    view.innerHTML = `<div class="notice error"><p><strong>Couldn't load the hub.</strong></p><p>${esc(err.message)}</p></div>`;
    return;
  }
  await render();

  // Pull any brand-new Tempo worklogs, then refresh if anything changed.
  try {
    const sync = await api('/api/sync', { method: 'POST' });
    if (sync.changed > 0) {
      me = await api('/api/me');
      if (location.hash !== '#/admin') render();
    }
  } catch (err) {
    console.warn(err.message);
  }
}

start();
