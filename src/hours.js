// What someone is contracted to work: hours across the week, and the days they
// usually work (1 Monday to 7 Sunday). How the hours fall across the days is up
// to them, so only the weekly total is kept.
export const DEFAULT_WEEK_HOURS = 37.5;
export const DEFAULT_DAYS = '12345';

export const workDaysOf = (v) => [...new Set(String(v || DEFAULT_DAYS).replace(/[^1-7]/g, ''))].sort().join('') || DEFAULT_DAYS;
export const weekHoursOf = (emp) => (Number(emp?.weekly_hours) > 0 ? Number(emp.weekly_hours) : DEFAULT_WEEK_HOURS);
export const weekdayOf = (iso) => String(((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1);

// The days of a week to show someone: the days they work, plus any other day
// they logged time on, so that time isn't hidden.
export function daysToShow(dates, workDays, logged) {
  const days = workDaysOf(workDays);
  return dates.filter((d) => days.includes(weekdayOf(d)) || (logged.get(d) || 0) > 0);
}
