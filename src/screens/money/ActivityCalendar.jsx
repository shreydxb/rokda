import { useMemo, useState } from 'react';
import { formatMoney, formatSigned } from '../../lib/money';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export default function ActivityCalendar({ rows, members }) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedKey, setSelectedKey] = useState(null);

  const byDay = useMemo(() => {
    const map = new Map();
    for (const t of rows) {
      const d = new Date(t.occurred_at);
      const key = dayKey(d);
      if (!map.has(key)) map.set(key, { spend: 0, income: 0, items: [] });
      const bucket = map.get(key);
      const v = Number(t.amount);
      if (v < 0) bucket.spend += -v;
      else bucket.income += v;
      bucket.items.push(t);
    }
    return map;
  }, [rows]);

  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    const startOffset = (firstOfMonth.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const list = [];
    for (let i = 0; i < startOffset; i++) list.push(null);
    for (let d = 1; d <= daysInMonth; d++) list.push(new Date(year, month, d));
    while (list.length % 7 !== 0) list.push(null);
    return list;
  }, [cursor]);

  const today = new Date();
  const selected = selectedKey ? byDay.get(selectedKey) : null;

  return (
    <div className="cal">
      <div className="cal-nav">
        <button type="button" className="om-btn" onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}>
          ← Prev
        </button>
        <div className="fig">
          {MONTH_LABELS[cursor.getMonth()]} {cursor.getFullYear()}
        </div>
        <button type="button" className="om-btn" onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}>
          Next →
        </button>
      </div>

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
          const key = dayKey(d);
          const bucket = byDay.get(key);
          const isToday = dayKey(today) === key;
          return (
            <button
              key={key}
              type="button"
              className="cal-cell"
              data-today={isToday}
              data-active={selectedKey === key}
              onClick={() => setSelectedKey(selectedKey === key ? null : key)}
            >
              <div className="cal-daynum">{d.getDate()}</div>
              {bucket && (
                <div className="cal-amounts">
                  {bucket.spend > 0 && <div className="cal-spend">−{formatMoney(bucket.spend)}</div>}
                  {bucket.income > 0 && <div className="cal-income">+{formatMoney(bucket.income)}</div>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="cal-daylist">
          <div className="ov-kicker">
            {(() => {
              const [y, m, d] = selectedKey.split('-').map(Number);
              return new Date(y, m, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
            })()}
          </div>
          <div className="mn-list">
            {selected.items.map((t) => (
              <div key={t.id} className="mn-row">
                <div className="mn-row-main">
                  <div>{t.merchant || 'Transaction'}</div>
                  <div className="ov-muted">
                    {t.categories?.name ?? 'Uncategorised'} · {t.is_shared ? 'Shared' : members.find((m) => m.id === t.owner_member_id)?.display_name ?? 'Unassigned'}
                  </div>
                </div>
                <div className={`fig mn-row-amt ${Number(t.amount) > 0 ? 'ov-pos' : ''}`}>{formatSigned(t.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
