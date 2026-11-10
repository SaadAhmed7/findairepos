// Star history for the Trending view. GitHub doesn't report star counts over time,
// so each refresh records them and gains are worked out from those snapshots.
const WINDOW_DAYS = 7;
const DAY = 864e5;

const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / DAY;

// Returns a copy with today's counts added and anything older than the window removed.
export function addSnapshot(history, today, repos) {
  const stars = Object.fromEntries(repos.map((r) => [r.n, r.s]));
  const next = { ...history, [today]: stars };
  for (const date of Object.keys(next)) {
    if (dayNumber(today) - dayNumber(date) > WINDOW_DAYS) delete next[date];
  }
  return next;
}

// Sets r.g (stars gained) by comparing with the oldest snapshot. Returns the days covered.
export function applyGains(history, today, repos) {
  const oldest = Object.keys(history).filter((d) => d < today).sort()[0];
  if (!oldest) return 0;
  for (const r of repos) {
    const before = history[oldest][r.n];
    if (before !== undefined) r.g = r.s - before;
  }
  return dayNumber(today) - dayNumber(oldest);
}
