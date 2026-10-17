import { useSearchParams } from 'react-router-dom';

// A screen's month, kept in the address as `?month=YYYY-MM`, so Back from the
// records it opened, and a reload, return to the month that was on screen
// (QA re-review, 17 October: Insights went back to this month). The current
// month is left out of the address. Changing month replaces the history
// entry rather than adding one per step.
const MONTH = /^(\d{4})-(\d{2})$/;

// The first of the month a `month` value names, or null when it names none.
export function monthFromParam(value) {
  const match = MONTH.exec(value ?? '');
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? new Date(Number(match[1]), month - 1, 1) : null;
}

export function monthParam(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function useMonthParam(now = new Date()) {
  const [params, setParams] = useSearchParams();
  const current = new Date(now.getFullYear(), now.getMonth(), 1);
  const cursor = monthFromParam(params.get('month')) ?? current;
  const setCursor = (date) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (monthParam(date) === monthParam(current)) next.delete('month');
        else next.set('month', monthParam(date));
        return next;
      },
      { replace: true },
    );
  return [cursor, setCursor];
}
