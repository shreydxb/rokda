import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney, formatPct } from '../../lib/money';
import { monthActualsByCategory } from '../../lib/budget';
import { trailingAverageByCategory, topMerchants } from '../../lib/insights';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TRAILING_MONTHS = 6;

export default function Insights({ me, members, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { transactions, categories } = data;

  const now = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const year = cursor.getFullYear();
  const month = cursor.getMonth() + 1;

  const catById = new Map(categories.map((c) => [c.id, c]));

  const thisMonth = useMemo(() => monthActualsByCategory(transactions, year, month, scopeMemberId), [transactions, year, month, scopeMemberId]);
  const { averages, monthsWithData } = useMemo(
    () => trailingAverageByCategory(transactions, year, month, TRAILING_MONTHS, scopeMemberId),
    [transactions, year, month, scopeMemberId]
  );
  const merchants = useMemo(() => topMerchants(transactions, scopeMemberId), [transactions, scopeMemberId]);

  const catIds = [...new Set([...thisMonth.keys(), ...averages.keys()])].sort((a, b) => (thisMonth.get(b) ?? 0) - (thisMonth.get(a) ?? 0));

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div>
      <div className="cal-nav" style={{ marginTop: 22 }}>
        <button type="button" className="om-btn" onClick={() => setCursor(new Date(year, month - 2, 1))}>
          ← Prev
        </button>
        <div className="fig">
          {MONTH_LABELS[month - 1]} {year}
        </div>
        <button type="button" className="om-btn" onClick={() => setCursor(new Date(year, month, 1))}>
          Next →
        </button>
      </div>

      <div className="ov-triple" style={{ marginTop: 26, gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)' }}>
        <div>
          <div className="ov-kicker" style={{ marginBottom: 10 }}>
            {monthsWithData > 0 ? `vs ${monthsWithData}-month average` : 'No prior months to average yet'}
          </div>
          {catIds.length === 0 ? (
            <div className="ov-muted">No spend recorded this month.</div>
          ) : (
            <div className="mn-list">
              {catIds.map((cid) => {
                const actual = thisMonth.get(cid) ?? 0;
                const avg = averages.get(cid);
                const delta = avg && avg > 0 ? (actual - avg) / avg : null;
                return (
                  <div key={cid} className="mn-row" style={{ cursor: 'default' }}>
                    <div className="mn-row-main">
                      <div>{catById.get(cid)?.name ?? 'Uncategorised'}</div>
                      <div className="ov-muted">
                        {avg !== undefined ? (
                          <>
                            average <span className="fig">{formatMoney(avg)}</span>
                            {delta !== null && (
                              <span className={delta > 0 ? 'ov-warn' : 'ov-pos'}>
                                {' · '}
                                {delta > 0 ? '+' : ''}
                                {formatPct(delta)} vs average
                              </span>
                            )}
                          </>
                        ) : (
                          'no prior history'
                        )}
                      </div>
                    </div>
                    <div className="fig mn-row-amt">{formatMoney(actual)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div className="ov-kicker" style={{ marginBottom: 10 }}>
            Top merchants
          </div>
          {merchants.length === 0 ? (
            <div className="ov-muted">Nothing yet.</div>
          ) : (
            <div className="mn-list">
              {merchants.map((m) => (
                <div key={m.name} className="mn-row" style={{ cursor: 'default' }}>
                  <div className="mn-row-main">
                    <div>{m.name}</div>
                    <div className="ov-muted">
                      {m.count} transaction{m.count === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="fig mn-row-amt">{formatMoney(m.total)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
