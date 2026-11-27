import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { activityHref, monthRange, tabHref } from '../../lib/activityLink';
import { formatPct } from '../../lib/money';
import { BarList, Card, Chip, InfoButton } from '../../design-system/kit';
import Unread from './Unread';

// Where this month's money went, and what changed (the revamp, phase 3;
// review S-overview-3 and N2): the five categories spent on most, each with
// a tick at its usual month, on Insights' own figures (lib/insights.js), net
// of refunds, so a bar and its tick are counted the same way and agree with
// Insights and Budget; and up to three categories running ahead of their
// usual pace, Needs attention's own check (lib/attention.js). Each opens the
// month's transactions in that category.
export default function OverviewWhere({ categories, moves, money, now, period = 'mtd', unread = [] }) {
  const navigate = useNavigate();
  const range = monthRange(now.getFullYear(), now.getMonth() + 1);
  const open = (categoryId) => navigate(activityHref({ categoryId, ...range }));
  return (
    <Card
      title={period === 'mtd' ? 'Where it went' : 'Where it went · this month'}
      className="ov-where"
      info={
        <InfoButton about="Where it went">
          The five categories spent on most this month, net of refunds. The tick on each bar is that category&apos;s usual month: its average over the months before with any records, up to six. What changed compares this month so far with the last three months&apos; pace by the same day, so its usual is not the tick&apos;s.
        </InfoButton>
      }
      right={
        <Link className="ov-link" to={tabHref('/money', 'budget')}>
          Budget →
        </Link>
      }
    >
      {unread.length > 0 ? (
        <Unread sources={unread} what="Where it went isn’t shown." />
      ) : categories.length === 0 ? (
        <div className="ov-muted">No spending this month.</div>
      ) : (
        <BarList items={categories.map((c) => ({ id: c.id, label: c.name, value: c.value, usual: c.usual ?? undefined, display: money.fmt(c.value) }))} onSelect={(item) => open(item.id)} />
      )}
      {unread.length === 0 && moves.length > 0 && (
        <div className="ov-changed">
          <h3 className="ov-todo-head">What changed</h3>
          <ul className="ov-changed-list">
            {moves.map((m) => (
              <li key={m.categoryId}>
                <Link className="ov-changed-row" to={activityHref({ categoryId: m.categoryId, ...range })}>
                  <Chip tone="warn">{`+${formatPct(m.pct)} vs usual pace`}</Chip>
                  <span className="ov-changed-text">
                    <span className="ov-todo-title">{m.categoryName}</span>
                    <span className="ov-muted">
                      {' '}
                      · {money.fmt(m.actual)} so far, {money.fmt(m.expectedSoFar)} by now in the last three months
                    </span>
                  </span>
                  <span className="ov-muted" aria-hidden="true">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
