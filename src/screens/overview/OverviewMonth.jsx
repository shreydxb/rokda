import { Link } from 'react-router-dom';
import { activityHref, isoDay, tabHref } from '../../lib/activityLink';
import { expectedDatesLabel } from '../../lib/expectedIncome';
import { formatPct } from '../../lib/money';
import { Card, KpiStrip, InfoButton, ProgressBar } from '../../design-system/kit';
import Unread from './Unread';

const TITLES = { mtd: 'This month', qtd: 'Quarter to date', ytd: 'Year to date' };

// The period's figures, the second panel of the cockpit (the revamp, phase
// 3; review S-overview-2): income, what was spent and what was saved, and in
// a month the budget's track against how far through the month it is.
// "Net spend" is "Spent" and "Income less spending" is "Saved" (review W9).
export default function OverviewMonth({ period, p, money, now, expected, budget, unread = [] }) {
  if (unread.length > 0) {
    return (
      <Card title={TITLES[period]} className="ov-month">
        <Unread sources={unread} what="Income, spending and saving aren’t shown." />
      </Card>
    );
  }
  const saved = p.saved;
  const used = budget && budget.budgeted > 0 ? budget.spent / budget.budgeted : null;
  return (
    <Card
      title={TITLES[period]}
      className="ov-month"
      flush
      right={
        <>
          {/* A real link to the period's records (outside review, E-13). */}
          <Link className="ov-link" to={activityHref({ from: isoDay(p.start), to: isoDay(now) })}>
            {p.count} transaction{p.count === 1 ? '' : 's'}
          </Link>
          {money.rateNote && <span>{money.rateNote}</span>}
          <Link className="ov-link" to={tabHref('/money', 'budget')}>
            Budget →
          </Link>
        </>
      }
    >
      <KpiStrip
        items={[
          {
            label: 'Income',
            value: money.fmt(p.income),
            sub: expected.items.length > 0 ? `${p.income > 0 ? 'More pay' : 'Pay'} expected ${expectedDatesLabel(expected.items)} · ${money.fmt(expected.total)}` : null,
          },
          {
            label: 'Spent',
            value: money.fmt(p.spend),
            info: <InfoButton about="Spent">Purchases less refunds. Money moved between your own accounts counts as neither income nor spending.</InfoButton>,
          },
          {
            label: 'Saved',
            value: money.fmtSigned(saved),
            tone: saved < 0 ? 'neg' : null,
            sub: p.rate !== null ? `${formatPct(p.rate)} of income` : null,
          },
        ]}
      />
      {period === 'mtd' && budget && (
        <div className="ov-budget">
          <div className="ov-budget-line">
            <span>
              Budget · {money.fmt(budget.spent)} of {money.fmt(budget.budgeted)}
            </span>
            <span className="ov-muted">
              {formatPct(used)} spent · {formatPct(budget.elapsedFraction)} of month gone
            </span>
          </div>
          <ProgressBar label="Budget" value={budget.spent} max={budget.budgeted} tick={budget.elapsedFraction * budget.budgeted} tone={used > 1 ? 'neg' : 'accent'} format={money.fmt} />
        </div>
      )}
    </Card>
  );
}
