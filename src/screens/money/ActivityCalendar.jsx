import { useMemo, useState } from 'react';
import { formatMoney } from '../../lib/money';
import { dayKeyOf, dayTotals } from '../../lib/activity';
import { Card } from '../../design-system/kit';
import { parseDay } from '../../lib/day';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Each day shows what the list's totals would say for that day alone: the
// selected person's share, net of refunds (dayTotals). A day whose refunds
// outweigh its purchases shows the money back, not income. The month is the
// header stepper's (the revamp, phase 4); a day chosen lists its records
// beneath the calendar, as a table like the list's.
export default function ActivityCalendar({ rows, scopeMemberId = null, month, amountOf, renderDay }) {
  const [selectedKey, setSelectedKey] = useState(null);
  const byDay = useMemo(() => dayTotals(rows, scopeMemberId, amountOf), [rows, scopeMemberId, amountOf]);
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const cells = [];
  const startOffset = (new Date(year, monthIndex, 1).getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, monthIndex, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const today = dayKeyOf(new Date());
  // A day of another month (the stepper moved on) is no longer chosen.
  const selected = selectedKey && selectedKey.startsWith(dayKeyOf(month).slice(0, 8)) ? byDay.get(selectedKey) : null;

  return (
    <>
      <Card title={month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} right={<span className="ds-muted">Net amount each day · choose a day</span>}>
        <div className="cal">
          <div className="cal-grid cal-grid-head">
            {WEEKDAYS.map((w) => (
              <div key={w} className="cal-weekday">
                {w}
              </div>
            ))}
          </div>
          <div className="cal-grid">
            {cells.map((d, i) => {
              if (!d) return <div key={`empty-${i}`} className="cal-cell cal-cell-empty" />;
              const key = dayKeyOf(d);
              const bucket = byDay.get(key);
              return (
                <button key={key} type="button" className="cal-cell" data-today={today === key} data-active={selectedKey === key} data-none={!bucket || undefined} aria-pressed={selectedKey === key} onClick={() => setSelectedKey(selectedKey === key ? null : key)}>
                  <div className="cal-daynum">{d.getDate()}</div>
                  {bucket && (
                    <div className="cal-amounts">
                      {bucket.spend > 0.005 && <div className="cal-spend">−{formatMoney(bucket.spend)}</div>}
                      {bucket.spend < -0.005 && <div className="cal-income">+{formatMoney(bucket.spend)} back</div>}
                      {bucket.income > 0 && <div className="cal-income">+{formatMoney(bucket.income)}</div>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </Card>
      {selectedKey && selected && renderDay(parseDay(selectedKey), selected.items)}
    </>
  );
}
