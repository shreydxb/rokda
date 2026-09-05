import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatBalance, formatMoney } from '../../lib/money';
import { monthActualsByCategory, monthIncome, monthPace, projectedClose } from '../../lib/budget';
import BudgetEditor from './BudgetEditor';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function Budget({ household, me, members, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { transactions, categories, budgets, reload } = data;

  const [view, setView] = useState('month'); // 'month' | 'year'
  const now = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [yearCursor, setYearCursor] = useState(now.getFullYear());
  const [editing, setEditing] = useState(null); // null | 'new' | a budget row

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const catById = new Map(categories.map((c) => [c.id, c]));

  return (
    <div>
      <div className="mn-filters">
        <div className="mn-viewtoggle" style={{ marginLeft: 0 }}>
          <button type="button" className="om-seg" data-active={view === 'month'} onClick={() => setView('month')}>
            Month
          </button>
          <button type="button" className="om-seg" data-active={view === 'year'} onClick={() => setView('year')}>
            Year
          </button>
        </div>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Set budget
        </button>
      </div>

      {view === 'month' ? (
        <MonthView
          cursor={cursor}
          setCursor={setCursor}
          budgets={budgets}
          transactions={transactions}
          catById={catById}
          scopeMemberId={scopeMemberId}
          now={now}
          onEdit={setEditing}
        />
      ) : (
        <YearView
          year={yearCursor}
          setYear={setYearCursor}
          budgets={budgets}
          transactions={transactions}
          categories={categories}
          scopeMemberId={scopeMemberId}
          now={now}
        />
      )}

      {editing && (
        <BudgetEditor
          item={editing === 'new' ? null : editing}
          householdId={household?.id}
          categories={categories}
          year={view === 'year' ? yearCursor : cursor.getFullYear()}
          month={cursor.getMonth() + 1}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function MonthView({ cursor, setCursor, budgets, transactions, catById, scopeMemberId, now, onEdit }) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth() + 1;
  const rows = budgets.filter((b) => b.year === year && b.month === month);
  const actuals = monthActualsByCategory(transactions, year, month, scopeMemberId);
  const pace = monthPace(year, month, now);

  const totalBudget = rows.reduce((s, r) => s + Number(r.amount), 0);
  const totalActual = rows.reduce((s, r) => s + (actuals.get(r.category_id) ?? 0), 0);
  const totalProjected = pace.canProject ? projectedClose(totalActual, pace.elapsedFraction) : null;

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

      {rows.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No budget set</div>
          <div className="ov-empty-body">Nothing budgeted for {MONTH_LABELS[month - 1]} {year} yet.</div>
        </div>
      ) : (
        <div className="mn-list">
          {rows.map((r) => {
            const actual = actuals.get(r.category_id) ?? 0;
            const projected = pace.isPast ? actual : pace.canProject ? projectedClose(actual, pace.elapsedFraction) : null;
            const over = projected !== null && projected > Number(r.amount);
            return (
              <button key={r.id} type="button" className="mn-row bud-row" onClick={() => onEdit(r)}>
                <div className="mn-row-main" style={{ flex: '0 0 180px' }}>
                  <div>{catById.get(r.category_id)?.name ?? 'Unknown'}</div>
                  <div className="ov-muted">
                    Budget <span className="fig">{formatMoney(r.amount)}</span>
                  </div>
                </div>
                <div className="bud-bar-wrap">
                  <div className="bud-bar">
                    <span className="bud-bar-elapsed" style={{ width: `${Math.min(100, pace.elapsedFraction * 100)}%` }} />
                    <span
                      className={`bud-bar-spent ${over ? 'bud-bar-over' : ''}`}
                      style={{ width: `${Math.min(100, (actual / Number(r.amount || 1)) * 100)}%` }}
                    />
                  </div>
                  <div className="ov-muted" style={{ marginTop: 4 }}>
                    Spent <span className="fig">{formatMoney(actual)}</span>
                    {' · '}
                    {pace.isPast ? (
                      'final'
                    ) : projected !== null ? (
                      <>
                        projected <span className={`fig ${over ? 'ov-warn' : ''}`}>{formatMoney(projected)}</span>
                      </>
                    ) : actual > 0 ? (
                      'too early to project'
                    ) : (
                      'not started'
                    )}
                  </div>
                </div>
              </button>
            );
          })}
          <div className="mn-row bud-total">
            <div className="mn-row-main" style={{ flex: '0 0 180px' }}>
              <div>Total</div>
            </div>
            <div className="bud-bar-wrap">
              <div className="ov-muted">
                Budget <span className="fig">{formatMoney(totalBudget)}</span> · Spent{' '}
                <span className="fig">{formatMoney(totalActual)}</span>
                {pace.isPast ? (
                  ' · final'
                ) : (
                  totalProjected !== null && (
                    <>
                      {' · projected '}
                      <span className={`fig ${totalProjected > totalBudget ? 'ov-warn' : ''}`}>{formatMoney(totalProjected)}</span>
                    </>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function YearView({ year, setYear, budgets, transactions, categories, scopeMemberId, now }) {
  const catIds = [...new Set(budgets.filter((b) => b.year === year).map((b) => b.category_id))];
  const catById = new Map(categories.map((c) => [c.id, c]));

  function cellValue(categoryId, month) {
    const isPastOrCurrent =
      year < now.getFullYear() || (year === now.getFullYear() && month <= now.getMonth() + 1);
    if (isPastOrCurrent) {
      const actuals = monthActualsByCategory(transactions, year, month, scopeMemberId);
      return { value: actuals.get(categoryId) ?? 0, kind: 'actual' };
    }
    const b = budgets.find((x) => x.year === year && x.month === month && x.category_id === categoryId);
    return { value: b ? Number(b.amount) : 0, kind: 'planned' };
  }

  const monthTotals = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    return catIds.reduce((s, cid) => s + cellValue(cid, month).value, 0);
  });

  const netSaved = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const isPastOrCurrent = year < now.getFullYear() || (year === now.getFullYear() && month <= now.getMonth() + 1);
    if (!isPastOrCurrent) return null;
    return monthIncome(transactions, year, month, scopeMemberId) - monthTotals[i];
  });

  return (
    <div>
      <div className="cal-nav" style={{ marginTop: 22 }}>
        <button type="button" className="om-btn" onClick={() => setYear(year - 1)}>
          ← {year - 1}
        </button>
        <div className="fig">{year}</div>
        <button type="button" className="om-btn" onClick={() => setYear(year + 1)}>
          {year + 1} →
        </button>
      </div>

      {catIds.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No budget set</div>
          <div className="ov-empty-body">Nothing budgeted for {year} yet.</div>
        </div>
      ) : (
        <div className="bud-yearwrap">
          <table className="bud-year">
            <thead>
              <tr>
                <th>Category</th>
                {MONTH_LABELS.map((m) => (
                  <th key={m}>{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {catIds.map((cid) => (
                <tr key={cid}>
                  <td>{catById.get(cid)?.name ?? 'Unknown'}</td>
                  {Array.from({ length: 12 }, (_, i) => {
                    const { value, kind } = cellValue(cid, i + 1);
                    return (
                      <td key={i} className={kind === 'planned' ? 'bud-planned' : ''}>
                        {formatMoney(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="bud-totalrow">
                <td>Total</td>
                {monthTotals.map((t, i) => (
                  <td key={i}>{formatMoney(t)}</td>
                ))}
              </tr>
              <tr>
                <td>Net saved</td>
                {netSaved.map((v, i) => (
                  <td key={i} className={v !== null && v < 0 ? 'ov-warn' : ''}>
                    {v === null ? '—' : formatBalance(v)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
