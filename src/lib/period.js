const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function periodBounds(kind, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  if (kind === 'qtd') {
    const q = Math.floor(now.getMonth() / 3);
    start.setMonth(q * 3, 1);
  } else if (kind === 'ytd') {
    start.setMonth(0, 1);
  }
  start.setHours(0, 0, 0, 0);
  // `end` is "now"; callers turn it into an exclusive end-of-today bound. The
  // window is always whole local days (QA-06).
  return { start, end: now };
}

export const PERIOD_LABELS = { mtd: 'Month to date', qtd: 'Quarter to date', ytd: 'Year to date' };

// Cash-flow chart granularity follows the period toggle: months under MTD,
// quarters under QTD, years (5) under YTD.
export function chartBuckets(kind, now = new Date()) {
  if (kind === 'qtd') return quarterBuckets(4, now);
  if (kind === 'ytd') return yearBuckets(5, now);
  return monthBuckets(6, now);
}

function monthBuckets(count, now) {
  const buckets = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    buckets.push({
      key: `${start.getFullYear()}-${start.getMonth()}`,
      label: MONTH_LABELS[start.getMonth()],
      start,
      end,
    });
  }
  return buckets;
}

function quarterBuckets(count, now) {
  const buckets = [];
  const currentQ = Math.floor(now.getMonth() / 3);
  for (let i = count - 1; i >= 0; i--) {
    const qIndex = currentQ - i;
    const year = now.getFullYear() + Math.floor(qIndex / 4);
    const q = ((qIndex % 4) + 4) % 4;
    const start = new Date(year, q * 3, 1);
    const end = new Date(year, q * 3 + 3, 1);
    buckets.push({ key: `${year}-Q${q + 1}`, label: `Q${q + 1}`, start, end });
  }
  return buckets;
}

function yearBuckets(count, now) {
  const buckets = [];
  for (let i = count - 1; i >= 0; i--) {
    const year = now.getFullYear() - i;
    buckets.push({ key: String(year), label: String(year), start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) });
  }
  return buckets;
}

export function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}
