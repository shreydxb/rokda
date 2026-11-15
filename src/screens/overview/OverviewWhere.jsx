import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { activityHref, monthRange, tabHref } from '../../lib/activityLink';
import { formatPct } from '../../lib/money';
import { BarList, Card, Chip, InfoButton } from '../../design-system/kit';

// Where this month's money went, and what changed (the revamp, phase 3;
// review S-overview-3 and N2): the five categories spent on most, each with
// a tick at its usual month, and up to three categories that moved against
// their usual. Both on Insights' own figures (lib/insights.js), net of
// refunds, so a bar and its tick are counted the same way and agree with
// Insights and Budget. Each opens the month's transactions in that category.
export default function OverviewWhere({ categories, moves, money, now }) {
  const navigate = useNavigate();
  const range = monthRange(now.getFullYear(), now.getMonth() + 1);
  const open = (categoryId) => navigate(activityHref({ categoryId, ...range }));
  return (
    <Card
      title="Where it went"
      className="ov-where"
      info={
        <InfoButton about="Where it went">
          The five categories spent on most this month, net of refunds. The tick on each bar is that category&apos;s usual month: its average over the months before with any records, up to six.
        </InfoButton>
      }
      right={
        <Link className="ov-link" to={tabHref('/money', 'budget')}>
          Budget →
        </Link>
      }
    >
      {categories.length === 0 ? (
        <div className="ov-muted">No spending this month.</div>
      ) : (
        <BarList items={categories.map((c) => ({ id: c.id, label: c.name, value: c.value, usual: c.usual ?? undefined, display: money.fmt(c.value) }))} onSelect={(item) => open(item.id)} />
      )}
      {moves.length > 0 && (
        <div className="ov-changed">
          <h3 className="ov-todo-head">What changed</h3>
          <ul className="ov-changed-list">
            {moves.map((m) => (
              <li key={m.categoryId}>
                <Link className="ov-changed-row" to={activityHref({ categoryId: m.categoryId, ...range })}>
                  <Chip tone={m.pct > 0 ? 'warn' : 'neutral'}>{`${m.pct > 0 ? '+' : '−'}${formatPct(Math.abs(m.pct))} vs usual`}</Chip>
                  <span className="ov-changed-text">
                    <span className="ov-todo-title">{m.categoryName}</span>
                    <span className="ov-muted">
                      {' '}
                      · {money.fmt(m.actual)} against {money.fmt(m.avg)}
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
