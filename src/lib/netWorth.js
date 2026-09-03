const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Stored monthly snapshots (completed months only) plus one live point for
// the current, still-open month computed from real account balances — so
// history and "now" always agree, since "now" isn't a snapshot at all.
export function buildNetWorthSeries(snapshots, liveAssets, liveLiabilities, now = new Date()) {
  const series = snapshots.map((s) => {
    const d = new Date(s.snapshot_date);
    return {
      date: d,
      label: `${MONTH_LABELS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
      assets: Number(s.assets),
      liabilities: Number(s.liabilities),
      net: Number(s.assets) - Number(s.liabilities),
      isLive: false,
    };
  });
  const liveDate = new Date(now.getFullYear(), now.getMonth(), 1);
  series.push({
    date: liveDate,
    label: `${MONTH_LABELS[liveDate.getMonth()]} ${String(liveDate.getFullYear()).slice(2)}`,
    assets: liveAssets,
    liabilities: liveLiabilities,
    net: liveAssets - liveLiabilities,
    isLive: true,
  });
  return series.sort((a, b) => a.date - b.date);
}

// Change from N months before the latest point to the latest point, using
// whatever snapshot is closest to that target month (there may be gaps).
export function changeOverMonths(series, monthsAgo) {
  if (series.length < 2) return null;
  const latest = series[series.length - 1];
  const targetTime = new Date(latest.date.getFullYear(), latest.date.getMonth() - monthsAgo, 1).getTime();
  let closest = null;
  let closestDiff = Infinity;
  for (const point of series) {
    const diff = Math.abs(point.date.getTime() - targetTime);
    if (diff < closestDiff) {
      closest = point;
      closestDiff = diff;
    }
  }
  if (!closest || closest === latest) return null;
  const monthsSpanned = Math.round((latest.date - closest.date) / (30.44 * 86400000));
  if (monthsSpanned < monthsAgo * 0.75) return null; // not enough history yet
  const absolute = latest.net - closest.net;
  const pct = closest.net !== 0 ? absolute / Math.abs(closest.net) : null;
  return { absolute, pct, from: closest, to: latest };
}
