import { Link } from 'react-router-dom';
import { tabHref } from '../../lib/activityLink';
import { nativeAmountLabel } from '../../lib/recurring';
import { Card, Chip } from '../../design-system/kit';
import { DatedStrip } from '../../design-system/charts';

const ROWS = 5;
const DAY = 86400000;

// The next 30 days (the revamp, phase 3; review S-overview-11): a dated
// strip of every bill and pay day, the next five as rows, and whether the
// cash to hand covers what is committed. A bill late or an autopay not yet
// confirmed comes first, on today. The rows say in words what the strip
// shows, so nothing is only on the strip.
export default function OverviewNext30({ items, money, cover, now }) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOf = (it) => Math.max(0, Math.round((it.dueDate - today) / DAY));
  const statusOf = (it) => (it.late ? 'late' : it.unconfirmed ? 'unconfirmed' : null);
  const tone = (it) => (Number(it.amount) > 0 ? 'pos' : it.late ? 'neg' : it.unconfirmed ? 'warn' : '');
  const amountText = (it) => (Number(it.amount) > 0 ? '+' : '−') + money.fmt(Math.abs(Number(it.amount)));
  const label = (it) =>
    `${it.dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${it.name} · ${amountText(it)}${statusOf(it) === 'late' ? ' · late' : statusOf(it) === 'unconfirmed' ? ' · not confirmed' : ''}`;
  return (
    <Card
      title="Next 30 days"
      className="ov-next30"
      flush
      right={
        <Link className="ov-link" to={tabHref('/money', 'recurring')}>
          Recurring →
        </Link>
      }
    >
      {items.length === 0 ? (
        <div className="ov-next30-none">Nothing due in the next 30 days.</div>
      ) : (
        <>
          <div className="ov-next30-strip">
            <DatedStrip days={30} ariaLabel={`${items.length} bills and pay days in the next 30 days`} marks={items.map((it) => ({ key: it.occurrenceKey, day: dayOf(it), amount: Number(it.amount), tone: tone(it), label: label(it) }))} />
          </div>
          <ul className="ov-next30-list" role="list">
            {items.slice(0, ROWS).map((it) => {
              // The native amount sits with the amount, never in the name
              // that may be cut short (fresh review of the Overview redesign).
              const native = nativeAmountLabel(it);
              const status = statusOf(it);
              return (
                <li key={it.occurrenceKey} className="ov-next30-item">
                  <span className="ov-next30-date">{it.dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                  <span className="ov-next30-name">{it.name}</span>
                  {status === 'late' ? (
                    <Chip tone="neg">Late</Chip>
                  ) : status === 'unconfirmed' ? (
                    <Chip tone="warn">Not confirmed</Chip>
                  ) : (
                    <span className="ov-next30-kind">{Number(it.amount) > 0 ? 'expected' : it.autopay ? 'autopay' : 'manual'}</span>
                  )}
                  <span className={`ov-next30-amount${Number(it.amount) > 0 ? ' ds-pos' : ''}`}>
                    {amountText(it)}
                    {native && <span className="ov-next30-native">{native}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {cover && (
        <div className="ov-next30-foot">
          <span>
            Committed {money.fmt(cover.dueAed)} · cash on hand {money.fmt(cover.liquidAed)}
          </span>
          {/* An unconverted bill makes the committed total too low, so a
              "covered" is not said on it (SHR-292). */}
          {!cover.certain ? <Chip tone="warn">Not all converted</Chip> : cover.covered ? <Chip tone="pos">Covered</Chip> : <Chip tone="neg">Short by {money.fmt(cover.shortfallAed)}</Chip>}
        </div>
      )}
    </Card>
  );
}
