import { PERIOD_LABELS } from '../../lib/period';
import { formatPct } from '../../lib/money';

// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// Gross spending by category for the period.
export default function OverviewSpending({ period, composition, money }) {
  return (
    <div>
        <div className="ov-kicker">Gross spending by category · {PERIOD_LABELS[period]}</div>
        <div className="ov-muted" style={{ marginTop: 6 }}>
          Before refunds. Spending totals above include refunds.
        </div>
      {composition.rows.length === 0 ? (
        <div className="ov-muted" style={{ marginTop: 12 }}>
          No spend recorded this period.
        </div>
      ) : (
        <>
          <div className="ov-comp-fig fig">{money.fmt(composition.total)}</div>
          <div className="ov-comp-bar">
            {composition.rows.map((r, i) => (
              <span
                key={r.name}
                title={r.name}
                style={{ width: `${r.share * 100}%`, opacity: 1 - i * 0.16 }}
              />
            ))}
          </div>
          <div className="ov-comp-list">
            {composition.rows.map((r, i) => (
              <div key={r.name} className="ov-comp-row">
                <span className="ov-comp-dot" style={{ opacity: 1 - i * 0.16 }} />
                <div className="ov-comp-name">{r.name}</div>
                <div className="ov-comp-value">
                  <div className="fig">{money.fmt(r.value)}</div>
                  <div className="ov-muted">{formatPct(r.share)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
