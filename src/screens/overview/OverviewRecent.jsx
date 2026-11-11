import { Link } from 'react-router-dom';

// Part of Overview (Overview.jsx), split out with the round 2 cleanup
// (SHR-383).
//
// Recent activity: the latest records in the scope shown.
export default function OverviewRecent({ recent, money }) {
  return (
    <div>
      <div className="ov-section-head">
        <div className="ov-kicker">Recent activity</div>
        <Link className="ov-link" to="/money">
          Activity →
        </Link>
      </div>
      <div className="ov-list">
        {recent.length === 0 ? (
          <div className="ov-muted" style={{ padding: '11px 0' }}>
            Nothing yet.
          </div>
        ) : (
          recent.map((t) => (
            <div key={t.id} className="ov-list-row">
              <div className="ov-list-main">
                <div>{t.kind === 'transfer' ? 'Transfer between accounts' : (t.merchant ?? 'Transaction')}</div>
                <div className="ov-muted">
                  {new Date(t.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  {t.categories?.name ? ` · ${t.categories.name}` : ''}
                  {t.needs_review ? <span className="ov-warn"> · needs review</span> : null}
                </div>
              </div>
              <div className={`fig ov-list-amt ${Number(t.amount) > 0 ? 'ov-pos' : ''}`}>
                {money.fmtSigned(t.amount)}
              </div>
            </div>
          ))
        )}
      </div>
      {/* Real links, so Enter follows them and they open in a new
          tab; these moved only on a click (round 2 of the outside
          review, E2-7). */}
      {recent.length > 0 && (
        <Link className="ov-link ov-list-more" to="/money">
          All records in Activity →
        </Link>
      )}
    </div>
  );
}
