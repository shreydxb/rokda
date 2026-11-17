import { lifePlan } from './lifePlan';
import { monthsUntil, NEAR_TERM_MONTHS } from './goals';

// What Planning -> Plan draws beyond the plan itself (the revamp, phase 6;
// design/prototype screens-planning.js): the band the chart shades, the gap
// "Short by" gives, the rows the year-by-year fold lists, and how a goal sits
// on the timeline. The plan's own sums stay in lifePlan.js.

// The pot at the start of each year on Conservative and on Optimistic, at the
// same stop year and spending: the chart's grey band. `basisFor(key)` is the
// planning model's basis on that scenario, the screen's other what-ifs held.
export function planBand(basisFor) {
  const low = lifePlan(basisFor('conservative').args).rows;
  const high = lifePlan(basisFor('optimistic').args).rows;
  return { years: low.map((r) => r.year), low: low.map((r) => r.start), high: high.map((r) => r.start) };
}

// How far short the plan is, read straight off the two figures above it:
// what the pot must hold the year work stops, less what it will (decision 2
// of the phase 6 design). A goal the pot can't pay while still working is
// short by that goal's gap in its year, since stopping later doesn't help.
// Null while the money lasts, or when the pot needed couldn't be worked out.
export function shortAtStop({ result, need }) {
  if (result.lasts) return null;
  const row = result.rows.find((r) => r.year === result.shortYear);
  if (row?.working) return row.short;
  if (need == null || result.potAtStop == null) return null;
  return Math.max(0, need - result.potAtStop);
}

// The fold under the chart: every fifth year from this one, and the stop
// year, each with where the plan is then. `status` is 'working', 'stop' (the
// year work stops), 'after', or 'empty' once the money has run out.
export function yearRows(result, { startYear, stopYear }) {
  return result.rows
    .filter((r) => (r.year - startYear) % 5 === 0 || r.year === stopYear)
    .map((r) => ({
      year: r.year,
      start: r.start,
      status:
        r.year === stopYear
          ? 'stop'
          : !r.working && result.shortYear !== null && r.year >= result.shortYear
            ? 'empty'
            : r.working
              ? 'working'
              : 'after',
    }));
}

// A goal's chip on Plan's "Goals on the timeline", by the rule Goals uses
// (lib/goals.js goalStatuses): kept money stays in cash, a goal with no date
// is in no plan, one due within three years is paid from cash, and a later
// one by the plan in its year, or falls short there.
export function timelineChip(goal, { now = new Date(), result }) {
  if (goal.counts_in_life_plan === false) return { label: 'Kept', tone: 'neutral' };
  if (!goal.target_date) return { label: 'No date', tone: 'neutral' };
  const year = Math.max(now.getFullYear(), Number(String(goal.target_date).slice(0, 4)));
  if (monthsUntil(goal.target_date, now) < NEAR_TERM_MONTHS) return { label: `From cash ${year}`, tone: 'neutral' };
  const row = result?.rows.find((r) => r.year === year);
  return row && row.short > 0 ? { label: `Short ${year}`, tone: 'warn' } : { label: `Paid ${year}`, tone: 'pos' };
}
