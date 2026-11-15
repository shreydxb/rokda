import { useState } from 'react';
import { Link } from 'react-router-dom';
import { scopeLabel, incompleteNote } from '../overviewMath';
import { Card, Chip } from '../../design-system/kit';
import { TrendLine } from '../../design-system/charts';

// Net worth, the first panel of the cockpit (the revamp, phase 3; review
// S-overview-2 and 6): today's figure, its change this month and a trend of
// the closed months, up to twelve. What it rests on stays said here, as
// warnings: a balance nobody has confirmed, or a value not converted.
export default function OverviewNetWorth({ scope, me, members, netWorthTrustworthy, money, nw, netWorthIsProvisional, unconfirmed, nwChange1mo, series = [] }) {
  const [pick, setPick] = useState(null);
  const incomplete = netWorthTrustworthy && incompleteNote({ accounts: nw.unvalued, holdings: nw.unpricedHoldings }, { capitalised: false });
  const points = series.slice(-12).map((p) => ({ key: p.date.toISOString(), label: p.isLive ? 'Today' : p.label, value: p.net }));
  const picked = pick !== null ? points[pick] : null;
  const title = `Net worth${scope !== 'both' ? ` · ${scopeLabel(scope, me, members)}` : ''}`;
  return (
    <Card
      title={title}
      className="ov-nw"
      right={
        <Link className="ov-link" to="/wealth">
          Net worth →
        </Link>
      }
    >
      {netWorthTrustworthy ? (
        <>
          <div className="ov-nw-head">
            <div className="ds-hero">
              <span className="ds-code">{money.code}</span>
              {money.fmtBalance(nw.netWorth)}
            </div>
            {netWorthIsProvisional && <Chip tone="warn">Provisional</Chip>}
            {incomplete && <Chip tone="warn">Incomplete</Chip>}
          </div>
          {scope === 'both' && nwChange1mo && (
            <div className="ov-nw-change">
              <span className={nwChange1mo.absolute >= 0 ? 'ds-pos' : 'ds-neg'}>
                {nwChange1mo.absolute >= 0 ? '▲' : '▼'} {money.fmtSigned(nwChange1mo.absolute)}
              </span>
              <span className="ov-muted"> this month</span>
              {points.length > 1 && <span className="ov-muted"> · {points.length} months</span>}
            </div>
          )}
          {/* The warnings in words as well as chips, so neither is only a colour. */}
          {netWorthIsProvisional && (
            <div className="ov-nw-warn">
              Provisional — {unconfirmed.length} balance{unconfirmed.length === 1 ? '' : 's'} not confirmed, counted as zero
            </div>
          )}
          {incomplete && <div className="ov-nw-warn">Incomplete — {incomplete}.</div>}
          {points.length > 1 && (
            <div className="ov-nw-trend">
              <TrendLine points={points} ariaLabel={`Net worth over ${points.length} months`} activeIndex={pick} onActiveChange={setPick} />
              <div className="ov-readout" aria-live="polite">
                {picked ? `${picked.label} · ${money.code} ${money.fmtBalance(picked.value)}` : ' '}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="ds-hero ov-muted">Not available</div>
      )}
    </Card>
  );
}
