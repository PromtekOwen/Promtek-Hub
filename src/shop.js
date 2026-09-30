// The XP shop, for demonstration while the rewards are being agreed.
// It works out eligibility and what a reward would cost, but nothing is
// spent: there is no route that changes anyone's XP or level.
import { progressFor, levelFromXp } from './progression.js';

export const REWARDS = [
  // [id, name, levels, minimum level, cooldown, kind]
  ['cash-100', '£100 cash bonus or voucher', 120, 250, 'Once every 2 months', 'money'],
  ['cash-500', '£500 cash bonus', 200, 400, 'Once every 6 months', 'money'],
  ['home-office', 'Home office upgrade, £750 budget', 250, 450, 'Once a year', 'money'],
  ['pay-review', 'Promotion or pay rise discussion', 250, 500, 'Once a year', 'money'],
  ['cash-1000', '£1,000 cash bonus', 350, 600, 'Once a year', 'money'],
  ['senior-band', 'Senior salary band review or fast-track promotion', 350, 650, 'Once a year', 'money'],
  ['cash-5000', '£5,000 cash bonus', 600, 850, 'Once a year', 'money'],
  ['equity', 'Significant share or equity award', 750, 900, 'Once every 2 years', 'money'],
  ['legend', 'Legend reward: £10,000 or equivalent', 1000, 950, 'Once every 5 years', 'money'],
  ['early-friday', 'Early finish on a Friday', 50, 150, null, 'time'],
  ['half-day', 'Half day off', 80, 200, null, 'time'],
  ['extra-day', 'One extra holiday day', 150, 300, null, 'time'],
  ['extra-two-days', 'Two extra holiday days', 280, 500, null, 'time'],
  ['extra-week', 'An extra week of holiday', 400, 700, null, 'time'],
  ['sabbatical', 'Paid sabbatical, four weeks', 500, 800, null, 'time'],
];

const xpForLevel = (level) => Math.max(0, level) * (Math.max(0, level) + 1);
const hoursAt = (xp, rate) => Math.round(xp / rate);

// Time off costs a fixed amount of XP, set at the level it unlocks, so it
// stays reachable however far up the ladder someone is. Cash and career
// rewards cost a number of levels, so they get dearer the higher you climb.
function fixedXpFor(levels, minimumLevel) {
  return xpForLevel(minimumLevel) - xpForLevel(minimumLevel - levels);
}

// What a reward would cost this person, and how long it would take to recover.
export function priceFor(xp, reward) {
  const [id, name, levels, minimumLevel, cooldown, kind] = reward;
  const level = levelFromXp(xp);
  const fixed = kind === 'time';

  const xpCost = fixed ? Math.min(xp, fixedXpFor(levels, minimumLevel)) : xp - xpForLevel(Math.max(0, level - levels));
  const levelAfter = fixed ? levelFromXp(xp - xpCost) : Math.max(0, level - levels);
  const levelsLost = level - levelAfter;

  return {
    id,
    name,
    levels,
    levelsLost,
    fixedPrice: fixed,
    minimumLevel,
    cooldown,
    kind,
    eligible: level >= minimumLevel && (fixed || level >= levels),
    levelsShort: Math.max(0, minimumLevel - level),
    levelAfter,
    xpCost,
    regainSlowHours: hoursAt(xpCost, 60),
    regainFastHours: hoursAt(xpCost, 400),
  };
}

export function catalogue(env, viewer, xp) {
  const progress = progressFor(xp);
  return {
    demonstration: true,
    you: { level: progress.level, title: progress.title, xp },
    rewards: REWARDS.map((reward) => priceFor(xp, reward)),
  };
}

// Shows what would happen, and says plainly that nothing has.
export function simulate(xp, rewardId) {
  const reward = REWARDS.find(([id]) => id === rewardId);
  if (!reward) throw new Error('No such reward.');
  const price = priceFor(xp, reward);
  const after = progressFor(xp - price.xpCost);
  return {
    ...price,
    before: progressFor(xp),
    after: { level: after.level, title: after.title, xp: xp - price.xpCost },
    changed: false,
  };
}
