// Dashboard tiles. To add a tool: put its files in public/apps/<id>/ (or give it
// a page in app.js) and add an entry here.
//   route:        a page inside the hub, e.g. '#/xp'
//   href:         a separate app, e.g. '/apps/obsolescence/'
//   construction: true shows a greyed-out "Under construction" tile
//   adminOnly:    true shows the tile to admins only
//   detail(me):   optional live line of text under the name (may return HTML)

const icon = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const fmt = (v) => Number(v || 0).toLocaleString('en-GB');
const hours = (s) => {
  const m = Math.round((s || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim() : `${m}m`;
};

export const MODULES = [
  {
    id: 'xp',
    name: 'XP & rank',
    route: '#/xp',
    icon: icon('<path d="M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.8z"/>'),
    detail: (me) => me.linked
      ? `Level <b>${fmt(me.employee.progress.level)}</b>, ${fmt(me.employee.progress.xpToNextLevel)} XP to go`
      : 'See your level, title and ELO rank',
  },
  {
    id: 'time',
    name: 'My time',
    route: '#/time',
    icon: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    detail: (me) => me.linked ? `<b>${hours(me.employee.week.seconds)}</b> logged this week` : 'Your Tempo time logs',
  },
  {
    id: 'log',
    name: 'Log time',
    route: '#/log',
    icon: icon('<path d="M12 6.5v11M6.5 12h11"/><circle cx="12" cy="12" r="9"/>'),
    detail: () => 'Find the job and log it in seconds',
  },
  {
    id: 'obsolescence',
    name: 'Obsolescence reports',
    href: '/apps/obsolescence/',
    icon: icon('<path d="M5 3.5h9l5 5V20.5H5z"/><path d="M14 3.5v5h5"/><path d="M8.5 13h7M8.5 16.5h4.5"/>'),
    detail: () => 'Check parts for end-of-life risk',
  },
  {
    id: 'pow',
    name: 'Point of work',
    route: '#/pow',
    icon: icon('<path d="M12 3l7.5 3.5v5c0 4.4-3.2 8.2-7.5 9.2-4.3-1-7.5-4.8-7.5-9.2v-5z"/><path d="M9 12l2 2 4-4"/>'),
    detail: () => 'Risk assessment before you start on site',
  },
  {
    id: 'shop',
    name: 'XP shop',
    construction: true,
    icon: icon('<path d="M4.5 8.5h15l-1.2 11.5H5.7z"/><path d="M9 8.5V7a3 3 0 016 0v1.5"/>'),
    detail: () => 'Trade XP for rewards',
  },
  {
    id: 'reports',
    name: 'Reports',
    route: '#/reports',
    leadOnly: true,
    icon: icon('<path d="M4 19.5V4.5M4 19.5h16"/><path d="M8 16V11M12.5 16V7M17 16v-3"/>'),
    detail: () => 'Effort and progress, week by week',
  },
  {
    id: 'admin',
    name: 'Admin',
    route: '#/admin',
    adminOnly: true,
    icon: icon('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 00-2-1.2L14.2 3h-4.4l-.4 2.6a7 7 0 00-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 000 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 002 1.2l.4 2.6h4.4l.4-2.6a7 7 0 002-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>'),
    detail: () => 'Sync, profiles and accounts',
  },
];
