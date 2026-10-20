import { addMonthsClamped, parseDay, startOfDay } from './day';
import { matchWindowDays, occurrenceAt } from './recurring';
import { isIncomeRow } from './transactionKind';
import { scopedValue } from './scope';

// Pay that is due in the period but has not been recorded yet.
//
// Overview's Income is what has been recorded so far this month, quarter or
// year. Pay lands late in the month, so for most of every month Income read 0
// with nothing to say that a salary was on its way. Each expected-income
// reminder (a recurring row with a positive amount) contributes its dates
// inside the whole calendar period that have no matching income recorded:
// a positive income row within the reminder's window (matchWindowDays) and
// within 20% of its amount, the same rule billStatus uses. A date whose window
// has already passed is late rather than expected, and Needs attention says
// so, so it is left out here.
//
// `start` is the period's first day and `kind` its length ('mtd', 'qtd',
// 'ytd'). Amounts follow the scope the way every Overview figure does.
export function expectedIncome(recurring = [], transactions = [], { kind, start, now = new Date(), scopeMemberId = null }) {
  const today = startOfDay(now);
  const end = addMonthsClamped(start, kind === 'ytd' ? 12 : kind === 'qtd' ? 3 : 1);
  const items = [];
  for (const r of recurring) {
    const amount = Number(r.amount);
    if (r.active === false || !(amount > 0)) continue;
    if (scopeMemberId !== null && !r.is_shared && r.owner_member_id !== scopeMemberId) continue;
    const days = matchWindowDays(r);
    for (let n = 0; n < 1000; n++) {
      const due = occurrenceAt(r.next_due_date, r.cadence, n, r.interval_count);
      if (due >= end || (r.ends_on && due > parseDay(r.ends_on))) break;
      if (due < start) continue;
      const windowStart = new Date(due);
      windowStart.setDate(windowStart.getDate() - days);
      const windowEnd = new Date(due);
      windowEnd.setDate(windowEnd.getDate() + days);
      if (windowEnd < today) continue;
      const recorded = transactions.some((t) => {
        const v = Number(t.amount);
        if (!isIncomeRow(t, v)) return false;
        const d = parseDay(t.occurred_at);
        return d >= windowStart && d <= windowEnd && Math.abs(v - amount) <= amount * 0.2;
      });
      if (!recorded) items.push({ id: r.id, name: r.name, due, amount: scopedValue(amount, r, scopeMemberId) });
    }
  }
  items.sort((a, b) => a.due - b.due);
  return { items, total: items.reduce((s, i) => s + i.amount, 0) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "25 and 30 Oct", "28 Sep and 25 Oct", "25 Oct, 25 Nov and 25 Dec".
export function expectedDatesLabel(items) {
  const parts = items.map((i, idx) => {
    const next = items[idx + 1];
    const sameMonthAsNext = next && next.due.getMonth() === i.due.getMonth() && next.due.getFullYear() === i.due.getFullYear();
    return sameMonthAsNext ? String(i.due.getDate()) : `${i.due.getDate()} ${MONTHS[i.due.getMonth()]}`;
  });
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
