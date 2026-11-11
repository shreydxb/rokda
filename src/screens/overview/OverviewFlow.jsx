import { CHART_TITLES, isRunningBucket } from '../overviewMath';
import { formatPct } from '../../lib/money';
import { Link } from 'react-router-dom';
import { activityHref, bucketRange } from '../../lib/activityLink';

// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// Income and spending by month or week for the period, one bar each, and
// the records behind the bar chosen.
export default function OverviewFlow({ period, money, maxColValue, columns, selected, setSelectedKey, now }) {
  return (
    <div>
      <div className="ov-section-head">
        <div className="ov-kicker">{CHART_TITLES[period]}</div>
        {/* The scale: the tallest bar's figure, so a bar's height
            means an amount. */}
        <div className="ov-muted">top of chart {money.fmt(maxColValue)} {money.code}</div>
      </div>
      <div className="ov-chart">
        {columns.map((c) => (
          <button
            key={c.key}
            type="button"
            className="ov-col"
            data-active={selected?.key === c.key}
            onClick={() => setSelectedKey(c.key)}
            data-running={isRunningBucket(c, now)}
            title={c.hasData ? `${c.label}${isRunningBucket(c, now) ? ' so far' : ''}: income ${money.fmt(c.income)}, net spend ${money.fmt(c.spend)}` : `${c.label}: no records`}
            aria-label={c.hasData ? `${c.label}${isRunningBucket(c, now) ? ' so far' : ''}: income ${money.fmt(c.income)}, net spend ${money.fmt(c.spend)}` : `${c.label}: no records`}
          >
            {/* A period with nothing recorded says so, rather than
                drawing two empty bars that read as a verified zero. */}
            <div className="ov-col-bars">
              {c.hasData ? (
                <>
                  <span className="ov-bar-inc" style={{ height: `${(c.income / maxColValue) * 100}%` }} />
                  <span className="ov-bar-out" style={{ height: `${(Math.max(0, c.spend) / maxColValue) * 100}%` }} />
                </>
              ) : (
                <span className="ov-col-none">no records</span>
              )}
            </div>
            <div className="ov-col-label">
              {c.label}
              {isRunningBucket(c, now) ? ' · so far' : ''}
            </div>
          </button>
        ))}
      </div>
      {selected && (
        <div className="ov-chart-readout">
          <span className="fig">
            {selected.label}
            {isRunningBucket(selected, now) ? ' so far' : ''}
          </span>
          <span>
            Income <b className="fig">{money.fmt(selected.income)}</b>
          </span>
          <span>
            Net spend <b className="fig">{money.fmt(selected.spend)}</b>
          </span>
          <span>
            Rate <b className={`fig ${selected.rate === null ? '' : selected.rate < 0 ? 'ov-neg' : 'ov-pos'}`}>{selected.rate !== null ? formatPct(selected.rate) : '—'}</b>
          </span>
          {/* The bar's own records: its dates, up to today for the
              bucket still running. */}
          <Link className="ov-link" to={activityHref(bucketRange(selected, now))}>
            Records →
          </Link>
        </div>
      )}
      <div className="ov-legend">
        <span><i className="ov-dot-inc" />Income</span>
        <span><i className="ov-dot-out" />Net spend</span>
      </div>
    </div>
  );
}
