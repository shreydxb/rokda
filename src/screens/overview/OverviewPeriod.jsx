import { PERIOD_LABELS } from '../../lib/period';
import { Link } from 'react-router-dom';
import { activityHref, isoDay } from '../../lib/activityLink';
import Kpi from './Kpi';
import { periodChange } from '../overviewMath';
import { expectedDatesLabel } from '../../lib/expectedIncome';
import { formatPct } from '../../lib/money';

// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// The period's figures: income, spending and what is left, against the
// period before.
export default function OverviewPeriod({ period, p, money, now, prev, prevLabel, expected, children = null }) {
  // "New" only when nothing was recorded then: records that net to zero are
  // a real comparison (the fresh review).
  const fromNothing = (current) => prev.count === 0 && current !== 0;
  return (
    <section className="ov-period-section">
      <div className="ov-section-head">
        <div className="ov-kicker">{PERIOD_LABELS[period]}</div>
        <div className="ov-muted">
          {p.count} record{p.count === 1 ? '' : 's'} · {money.code}
          {money.rateNote ? ` · ${money.rateNote}` : ''} ·{' '}
          {/* A real link, so Enter follows it (outside review, E-13). */}
          <Link className="ov-link" to={activityHref({ from: isoDay(p.start), to: isoDay(now) })}>
            Records →
          </Link>
        </div>
      </div>
      {/* Each figure with the same stretch of the period before, so a
          month to date is never set against a whole month. */}
      <div className="ov-kpi-row">
        <Kpi
          label="Income"
          figure={money.fmt(p.income)}
          change={periodChange(p.income, prev.income)}
          goodWhenUp
          prevLabel={prevLabel}
          fmt={money.fmt}
          hint={expected.items.length > 0 ? `${p.income > 0 ? 'More pay' : 'Pay'} expected ${expectedDatesLabel(expected.items)} · ${money.fmt(expected.total)}` : null}
          isNew={fromNothing(p.income)}
        />
        <Kpi label="Net spend" figure={money.fmt(p.spend)} change={periodChange(p.spend, prev.spend)} goodWhenUp={false} prevLabel={prevLabel} fmt={money.fmt} isNew={fromNothing(p.spend)} />
        <Kpi label="Income less spending" figure={money.fmtSigned(p.saved)} change={periodChange(p.saved, prev.saved)} goodWhenUp prevLabel={prevLabel} fmt={money.fmt} isNew={fromNothing(p.saved)} />
        {/* Coloured by its sign: a month that spent more than it earned
            has a negative rate, and painting that green said the
            opposite of the figure. */}
        <Kpi
          label="Savings rate"
          figure={p.rate !== null ? formatPct(p.rate) : '—'}
          tone={p.rate === null ? '' : p.rate < 0 ? 'ov-neg' : 'ov-pos'}
          change={periodChange(p.rate, prev.rate, { asPoints: true })}
          goodWhenUp
          prevLabel={prevLabel}
        />
        {/* Net worth, the fifth figure (the Overview redesign). */}
        {children}
      </div>
    </section>
  );
}
