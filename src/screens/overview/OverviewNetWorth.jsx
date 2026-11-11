import { scopeLabel, incompleteNote } from '../overviewMath';
import { formatPct } from '../../lib/money';
import { Link } from 'react-router-dom';

// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// Net worth: today's figure, what makes it up, and how it has moved.
export default function OverviewNetWorth({ scope, me, members, netWorthTrustworthy, money, nw, netWorthIsProvisional, unconfirmed, nwChange1mo, nwChange12mo, runway }) {
  return (
    <section className="ov-hero-section ov-hero-compact">
      {/* Net worth sits below the month's money and what needs doing:
          for day-to-day use those come first (product review, 15
          October). It still says which balances it rests on. */}
      <div className="ov-kicker">Net worth{scope !== 'both' ? ` · ${scopeLabel(scope, me, members)}` : ''}</div>
      <div className="ov-hero fig">
        {netWorthTrustworthy ? (
          <>
            <span className="ov-hero-currency">{money.code}</span> {money.fmtBalance(nw.netWorth)}
          </>
        ) : (
          <span className="ov-hero-unavailable">Not available</span>
        )}
      </div>
      {netWorthTrustworthy && netWorthIsProvisional && (
        <div className="ov-muted" style={{ marginTop: 6, fontSize: 12 }}>
          Provisional — {unconfirmed.length} account{unconfirmed.length === 1 ? '' : 's'} without a confirmed balance{' '}
          {unconfirmed.length === 1 ? 'is' : 'are'} counted as zero.
        </div>
      )}
      {/* Separate from "provisional", and separate on purpose: an
          account with no AED conversion is not counted as zero, it is
          not counted at all. netWorthSummary has always returned that
          count; nothing used to read it, so an unconverted loan simply
          vanished from a total that still looked complete (QA #4). */}
      {netWorthTrustworthy && incompleteNote({ accounts: nw.unvalued, holdings: nw.unpricedHoldings }) && (
        <div className="ov-warn" style={{ marginTop: 6, fontSize: 12 }}>
          Incomplete — {incompleteNote({ accounts: nw.unvalued, holdings: nw.unpricedHoldings }, { capitalised: false })}
        </div>
      )}
      {scope === 'both' && (nwChange1mo || nwChange12mo) && (
        <div className="ov-nwchange">
          {nwChange1mo && (
            <span className={nwChange1mo.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
              {nwChange1mo.absolute >= 0 ? '▲' : '▼'} {money.fmtSigned(nwChange1mo.absolute)}
            </span>
          )}
          {nwChange1mo && <span className="ov-muted"> this month</span>}
          {nwChange1mo && nwChange12mo && <span className="ov-muted"> · </span>}
          {nwChange12mo && (
            <span className="ov-muted">
              12-mo{' '}
              <span className={nwChange12mo.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
                {nwChange12mo.pct !== null ? formatPct(nwChange12mo.pct) : money.fmtSigned(nwChange12mo.absolute)}
              </span>
            </span>
          )}
        </div>
      )}
      <div className="ov-strip">
        <span>
          Assets <b>{money.fmtBalance(nw.assets)}</b>
        </span>
        <span>
          Liabilities <b>{money.fmtBalance(nw.liabilities)}</b>
        </span>
        {runway.available ? (
          <span>
            Runway <b>{runway.months.toFixed(1)} months</b>
          </span>
        ) : (
          <span className="ov-muted">Runway needs {2 - runway.monthsOfHistory} more closed month(s) of spending</span>
        )}
        <Link className="ov-link" to="/wealth">
          History →
        </Link>
      </div>
    </section>
  );
}
