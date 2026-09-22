// XP, level, title and ELO rank rules, matching the existing Jira automations.

export const DEFAULT_ELO = 1100;
export const DEFAULT_BASELINE = 60;

export const TITLES = [
  'Apprentice of the Scale',
  'Journeyman of the Balance',
  'Squire of Strain Gauges',
  'Knight of Calibration',
  'Baron of Batch Weighing',
  'Viscount of Verification',
  'Earl of Encoders',
  'Marquess of Metrology',
  'Duke of Digital Load Cells',
  'Lord of the Load',
  'Chancellor of the Checkweigher',
  'Viceroy of the Vessel',
  'Archduke of Accuracy',
  'Prince of Process Weighing',
  'Crown Prince of Calibration',
  'Lord Protector of the Pound',
  'Regent of the Realm',
  'High Sovereign of the Scale',
  'King of the Kilo',
  'Emperor of Equilibrium',
  'Grand Monarch of Measurement',
];

// [upper bound (exclusive), rank name] — same thresholds as "ELO - Rank Tiers".
export const RANKS = [
  [800, 'Gram I'],
  [1100, 'Gram II'],
  [1300, 'Kilogram I'],
  [1500, 'Kilogram II'],
  [1700, 'Tonne I'],
  [1900, 'Tonne II'],
  [2100, 'Megatonne I'],
  [2300, 'Megatonne II'],
  [2500, 'Gigatonne I'],
  [2800, 'Gigatonne II'],
  [3100, 'Gigatonne III'],
  [Infinity, 'Neutron Star'],
];

// Level = floor((sqrt(1 + 4 * XP) - 1) / 2); level L starts at L * (L + 1) XP.
export function levelFromXp(xp) {
  return Math.floor((Math.sqrt(1 + 4 * Math.max(0, xp)) - 1) / 2);
}

export function progressFor(xp) {
  const level = levelFromXp(xp);
  const start = level * (level + 1);
  const next = (level + 1) * (level + 2);
  const titleIndex = Math.min(Math.floor(level / 50), TITLES.length - 1);
  const hasNextTitle = titleIndex + 1 < TITLES.length;
  return {
    xp,
    level,
    title: TITLES[titleIndex],
    nextTitle: hasNextTitle ? TITLES[titleIndex + 1] : null,
    nextTitleLevel: hasNextTitle ? (titleIndex + 1) * 50 : null,
    xpIntoLevel: xp - start,
    levelSpan: next - start,
    xpToNextLevel: next - xp,
  };
}

export function rankFor(elo) {
  if (elo == null || Number.isNaN(elo)) return null;
  const i = RANKS.findIndex(([max]) => elo < max);
  const [max, name] = RANKS[i];
  return {
    name,
    nextAt: Number.isFinite(max) ? max : null,
    nextName: RANKS[i + 1] ? RANKS[i + 1][1] : null,
  };
}

// XP earned per minute of logged time.
export function xpRate({ jobElo, engineerElo, baseline, override }) {
  const o = override ?? 1;
  if (jobElo) return o * Math.max(0.5, 1 + (jobElo - engineerElo) / 800);
  return o * ((baseline ?? DEFAULT_BASELINE) / 60);
}
