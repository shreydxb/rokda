import { loadedLabel } from '../lib/freshness';
import './Freshness.css';

// When this page last read the household's records, and a way to read them
// again (product review, 15 October). It is the page's own read time: a
// balance keeps its "as of" date and a price its "priced" date, and reading
// the page again changes neither. The page also reads again by itself when it
// comes back into view and every few minutes (lib/useSources.js).
export default function Freshness({ title, loadedAt, refreshing, onRefresh }) {
  const label = refreshing ? 'Refreshing…' : loadedLabel(loadedAt);
  return (
    <div className="fresh-row">
      {title ? <div className="ov-kicker">{title}</div> : <span />}
      <span className="fresh" aria-live="polite">
        {label}
        {onRefresh && (
          <>
            {label && ' · '}
            <button type="button" className="fresh-btn" onClick={onRefresh} disabled={refreshing}>
              Refresh
            </button>
          </>
        )}
      </span>
    </div>
  );
}
