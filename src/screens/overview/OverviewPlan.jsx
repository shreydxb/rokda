import { Link } from 'react-router-dom';
import { tabHref } from '../../lib/activityLink';
import { formatMoney } from '../../lib/money';
import { minimumOnlyText, payoffMonthLabel } from '../../lib/debt';
import { leftOutText } from '../../lib/lifePlanBasis';
import { couldntLoad } from '../../lib/loadState';
import { Banner, Card, Chip, ProgressBar } from '../../design-system/kit';

// The Plan strip, the cockpit's last band (the revamp, phase 3; review
// S-overview-12): when work can stop, the goals for the next 3 years, the
// debts and when they clear, and the cash reserve. The same figures as
// Planning -> Plan (planning/usePlanFigures.js), in dirhams as Planning
// shows them, and said so whatever the display currency; each tile opens its
// page. The warnings Plan shows beside the same figures stay here as chips,
// and a figure that is the household's whoever is selected says so (fresh
// review of the cockpit).
const aed = (v) => formatMoney(v);
const Aed = () => <span className="ov-plan-code">AED</span>;

export default function OverviewPlan({ f, scope = 'both', unread, onRetry }) {
  const household = scope !== 'both' ? <Chip>Household</Chip> : null;
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
        <Tile label="Stop working" to={tabHref('/planning', 'plan')} missing={f.answerMissing}>
          {f.stop ? (
            <>
              <div className="ds-fig">{f.stop.stopYear}</div>
              <div className="ov-plan-chips">
                {f.stop.range.map(verdict)}
                {f.stop.stopAssumed && <Chip title="Until you choose a year on Plan">Assumed year</Chip>}
                {f.stop.leftOut?.length > 0 && (
                  <Chip tone="warn" title={leftOutText(f.stop.leftOut)}>
                    Not everyone in the plan
                  </Chip>
                )}
                {household}
              </div>
            </>
          ) : (
            <>
              <div className="ds-fig ov-muted">—</div>
              <div className="ov-plan-sub">{f.forecast.ready ? 'Set each birth year on Plan' : 'Not enough to project yet'}</div>
            </>
          )}
          {/* Balances nobody has entered count as 0 in every projection, so
              the strip says so whether or not a year is worked out yet. */}
          {f.provisional && (
            <div className="ov-plan-sub">
              <Chip tone="warn" title={f.provisional}>
                Provisional
              </Chip>
            </div>
          )}
        </Tile>
        <Tile label="Goals · next 3 years" to={tabHref('/planning', 'goals')} missing={f.goalsMissing}>
          {f.nearGoals.length > 0 ? (
            <>
              <div className="ds-fig">
                <Aed />
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
        <Tile label="Debts" to={tabHref('/planning', 'goals')} missing={f.debtsMissing}>
          {f.visibleDebts.length > 0 ? (
            <>
              <div className="ds-fig">
                <Aed />−{aed(f.totalOwed)}
              </div>
              <div className="ov-plan-sub">
                {clears != null ? `Clears ${payoffMonthLabel(clears, f.now)}${f.canProjectDebt ? ' with the extra payment' : ''}` : minimumOnlyText(f.atMinimums, f.now)}
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
        <Tile label="Cash reserve" to={tabHref('/planning', 'goals')} missing={f.reserveMissing}>
          {reserve.months != null ? (
            <>
              <div className="ds-fig">
                {reserve.months.toFixed(1)} <span className="ov-plan-of">months of spending</span>
              </div>
              <div className="ov-plan-sub">
                {reserve.target != null && (reserve.liquid >= reserve.target ? <Chip tone="pos">Covers kept goals</Chip> : <Chip tone="warn">Short of kept goals</Chip>)}
                {reserve.unvalued > 0 && (
                  <Chip tone="warn" title={`${reserve.unvalued} account${reserve.unvalued === 1 ? '' : 's'} with no dirham value left out`}>
                    Incomplete
                  </Chip>
                )}
                {household}
              </div>
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
