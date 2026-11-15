import { Link } from 'react-router-dom';
import { tabHref } from '../../lib/activityLink';
import { formatMoney } from '../../lib/money';
import { payoffMonthLabel } from '../../lib/debt';
import { couldntLoad } from '../../lib/loadState';
import { Banner, Card, Chip, ProgressBar } from '../../design-system/kit';

// The Plan strip, the cockpit's last band (the revamp, phase 3; review
// S-overview-12): when work can stop, the goals for the next 3 years, the
// debts and when they clear, and the cash reserve. The same figures as
// Planning -> Plan (planning/usePlanFigures.js), in dirhams as Planning
// shows them; each tile opens its page.
const aed = (v) => formatMoney(v);

export default function OverviewPlan({ f, unread, onRetry }) {
  if (unread.length > 0) {
    return (
      <Card title="Plan" className="ov-plan">
        <Banner tone="warn" onRetry={onRetry}>
          {couldntLoad(unread)} The plan isn&apos;t shown.
        </Banner>
      </Card>
    );
  }
  const verdict = (r) => (
    <Chip key={r.label} tone={r.lasts ? 'pos' : 'neg'}>
      {r.lasts ? `${r.label}: lasts to ${r.endYear}` : `${r.label}: ${r.shortWorking ? 'short' : 'runs out'} ${r.shortYear}`}
    </Chip>
  );
  const clears = f.canProjectDebt ? f.debtPlan?.months : f.atMinimums.never.length || f.atMinimums.tooLong.length ? null : f.atMinimums.months;
  const reserve = f.reserve;
  return (
    <Card title="Plan" className="ov-plan" flush>
      <div className="ov-plan-tiles">
        <Tile label="Stop working" to={tabHref('/planning', 'life')} missing={f.answerMissing}>
          {f.stop ? (
            <>
              <div className="ds-fig">{f.stop.stopYear}</div>
              <div className="ov-plan-chips">{f.stop.range.map(verdict)}</div>
            </>
          ) : (
            <>
              <div className="ds-fig ov-muted">—</div>
              <div className="ov-plan-sub">{f.forecast.ready ? 'Set each birth year on the Life plan' : 'Not enough to project yet'}</div>
            </>
          )}
        </Tile>
        <Tile label="Goals · next 3 years" to={tabHref('/planning', 'goals')} missing={f.goalsMissing}>
          {f.nearGoals.length > 0 ? (
            <>
              <div className="ds-fig">
                {aed(f.nearCash)} <span className="ov-plan-of">of {aed(f.nearCost)}</span>
              </div>
              <div className="ov-plan-bar">
                <ProgressBar label="Goals in cash" value={f.nearCash} max={f.nearCost} format={aed} />
              </div>
            </>
          ) : (
            <>
              <div className="ds-fig ov-muted">—</div>
              <div className="ov-plan-sub">Nothing due within 3 years</div>
            </>
          )}
        </Tile>
        <Tile label="Debts" to={tabHref('/planning', 'debt')} missing={f.debtsMissing}>
          {f.visibleDebts.length > 0 ? (
            <>
              <div className="ds-fig">−{aed(f.totalOwed)}</div>
              <div className="ov-plan-sub">
                {clears != null ? `Clears ${payoffMonthLabel(clears, f.now)}` : 'No payoff date'}
                {f.visibleDebts.some((d) => !d.inNetWorth) && <Chip tone="warn">Not all in net worth</Chip>}
              </div>
            </>
          ) : (
            <>
              <div className="ds-fig ov-muted">—</div>
              <div className="ov-plan-sub">No debts</div>
            </>
          )}
        </Tile>
        <Tile label="Cash reserve" to={tabHref('/planning', 'plan')} missing={f.reserveMissing}>
          {reserve.months != null ? (
            <>
              <div className="ds-fig">
                {reserve.months.toFixed(1)} <span className="ov-plan-of">months of spending</span>
              </div>
              {reserve.target != null && <div className="ov-plan-sub">{reserve.liquid >= reserve.target ? <Chip tone="pos">Covers kept goals</Chip> : <Chip tone="warn">Short of kept goals</Chip>}</div>}
            </>
          ) : (
            <>
              <div className="ds-fig ov-muted">—</div>
              <div className="ov-plan-sub">Needs the plan&apos;s monthly spending</div>
            </>
          )}
        </Tile>
      </div>
    </Card>
  );
}

function Tile({ label, to, missing, children }) {
  return (
    <Link className="ov-plan-tile" to={to}>
      <span className="ov-plan-label">
        {label}
        <span aria-hidden="true">→</span>
      </span>
      {missing.length > 0 ? <span className="ov-plan-sub">{couldntLoad(missing)}</span> : children}
    </Link>
  );
}
