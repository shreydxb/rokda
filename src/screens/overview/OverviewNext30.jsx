import { Link } from 'react-router-dom';
import { tabHref } from '../../lib/activityLink';
import { nativeAmountLabel } from '../../lib/recurring';

// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// Next 30 days: what is due, and what is committed.
export default function OverviewNext30({ next30, recurring, money, committedTotal, withoutAutopay }) {
  return (
    <section className="ov-next30">
      <div className="ov-kicker">Next 30 days</div>
      {next30.length === 0 ? (
        <div className="ov-next30-empty">
          {recurring.length === 0
            ? 'No recurring bills or income set up yet.'
            : 'Nothing due in the next 30 days.'}{' '}
          <Link className="ov-link" to={tabHref('/money', 'recurring')}>
            Recurring →
          </Link>
        </div>
      ) : (
        <>
          <div className="ov-next30-row">
            {next30.map((r) => (
              <div key={r.occurrenceKey} className="ov-next30-cell">
                <div className="ov-muted">{r.dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>
                <div className="ov-next30-name">{r.name}</div>
                <div className={`fig ov-next30-amt ${Number(r.amount) > 0 ? 'ov-pos' : ''}`}>{money.fmtSigned(r.amount)}</div>
                {nativeAmountLabel(r) && <div className="ov-muted">{nativeAmountLabel(r)}</div>}
                <div className={Number(r.amount) < 0 && !r.autopay ? 'ov-warn' : 'ov-muted'}>
                  {Number(r.amount) > 0 ? 'expected' : r.autopay ? 'autopay' : 'no autopay'}
                </div>
              </div>
            ))}
          </div>
          <div className="ov-next30-foot">
            <span>
              Committed {money.fmt(committedTotal)}
              {withoutAutopay > 0 ? ` · ${withoutAutopay} without autopay` : ''}
            </span>
            <Link className="ov-link" to={tabHref('/money', 'recurring')}>
              Recurring →
            </Link>
          </div>
        </>
      )}
    </section>
  );
}
