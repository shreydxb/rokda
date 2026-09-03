const CADENCES = ['weekly', 'monthly', 'quarterly', 'yearly'];

function startOfDay(d) {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  return nd;
}

function step(date, cadence) {
  const nd = new Date(date);
  if (cadence === 'weekly') nd.setDate(nd.getDate() + 7);
  else if (cadence === 'monthly') nd.setMonth(nd.getMonth() + 1);
  else if (cadence === 'quarterly') nd.setMonth(nd.getMonth() + 3);
  else if (cadence === 'yearly') nd.setFullYear(nd.getFullYear() + 1);
  return nd;
}

// Rolls a (possibly past) next_due_date forward by cadence until it's today
// or later, so a bill paid last month still shows correctly without the
// user having to bump the stored date after every payment.
export function rollForward(dateStr, cadence, now = new Date()) {
  const today = startOfDay(now);
  let d = startOfDay(new Date(dateStr));
  let guard = 0;
  while (d < today && guard < 1000) {
    d = step(d, cadence);
    guard++;
  }
  return d;
}

export function upcomingItems(rows, days, now = new Date()) {
  const today = startOfDay(now);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + days);
  return rows
    .filter((r) => r.active !== false)
    .map((r) => ({ ...r, dueDate: rollForward(r.next_due_date, r.cadence, now) }))
    .filter((r) => r.dueDate >= today && r.dueDate <= horizon)
    .sort((a, b) => a.dueDate - b.dueDate);
}

export { CADENCES };
