import { scopeLabel, incompleteNote } from '../overviewMath';
import { Link } from 'react-router-dom';

// Part of Overview (Overview.jsx).
//
// Net worth, the fifth of the period's figures (the Overview redesign,
// November 2026): today's figure and how it moved this month. What it rests
// on stays said here, as warnings; assets, liabilities and the history are a
// click away on Wealth, and the runway is this figure's one line of help.
export default function OverviewNetWorth({ scope, me, members, netWorthTrustworthy, money, nw, netWorthIsProvisional, unconfirmed, nwChange1mo, runway }) {
  const incomplete = netWorthTrustworthy && incompleteNote({ accounts: nw.unvalued, holdings: nw.unpricedHoldings });
  return (
    <div className="ov-kpi-nw">
      <div className="ov-kpi-label">
        Net worth{scope !== 'both' ? ` · ${scopeLabel(scope, me, members)}` : ''}
      </div>
      <div className="ov-kpi-fig fig">
        {netWorthTrustworthy ? (
          <>
            <span className="ov-hero-currency">{money.code}</span> {money.fmtBalance(nw.netWorth)}
          </>
        ) : (
          <span className="ov-hero-unavailable">Not available</span>
        )}
      </div>
      {netWorthTrustworthy && scope === 'both' && nwChange1mo && (
        <div className="ov-kpi-change">
          <span className={nwChange1mo.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
            {nwChange1mo.absolute >= 0 ? '▲' : '▼'} {money.fmtSigned(nwChange1mo.absolute)}
          </span>
          <span className="ov-muted"> this month</span>
        </div>
      )}
      {netWorthTrustworthy && netWorthIsProvisional && (
        <div className="ov-kpi-change ov-warn">
          Provisional — {unconfirmed.length} balance{unconfirmed.length === 1 ? '' : 's'} not confirmed, counted as zero
        </div>
      )}
      {/* An account with no AED conversion is not counted at all, so the
          total says it is incomplete (QA #4). */}
      {incomplete && <div className="ov-kpi-change ov-warn">Incomplete — {incompleteNote({ accounts: nw.unvalued, holdings: nw.unpricedHoldings }, { capitalised: false })}</div>}
      {runway.available && <div className="ov-kpi-change ov-muted ov-kpi-hint">Runway {Math.round(runway.months)} months</div>}
      <div className="ov-kpi-change">
        <Link className="ov-link" to="/wealth">
          Net worth →
        </Link>
      </div>
    </div>
  );
}
