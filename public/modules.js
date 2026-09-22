// The hub's app registry. To add a new tool, put its files in public/apps/<id>/
// and add an entry here. Set comingSoon: true to show a placeholder tile.
// adminOnly: true hides the tile from everyone except admins.

const icon = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const MODULES = [
  {
    id: 'obsolescence',
    name: 'Obsolescence reports',
    description: 'Check parts and equipment for end-of-life risk and build reports.',
    href: '/apps/obsolescence/',
    icon: icon('<path d="M4 4h11l5 5v11H4z"/><path d="M15 4v5h5"/><path d="M8 13h8M8 17h5"/>'),
  },
  {
    id: 'point-of-work',
    name: 'Point of work reports',
    description: 'Record on-site risk checks before starting a job.',
    comingSoon: true,
    icon: icon('<path d="M12 3l8 4v5c0 4.5-3.3 8.3-8 9-4.7-.7-8-4.5-8-9V7z"/><path d="M9 12l2 2 4-4"/>'),
  },
  {
    id: 'store',
    name: 'XP store',
    description: 'Spend the credits you earn on rewards.',
    comingSoon: true,
    icon: icon('<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 016 0v2"/>'),
  },
];
