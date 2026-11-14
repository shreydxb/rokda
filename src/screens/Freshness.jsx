import { loadedLabel } from '../lib/freshness';
import Icon from '../design-system/Icon';
import './Freshness.css';

// When this page last read the household's records, and a way to read them
// again (product review, 15 October). It is the page's own read time: a
// balance keeps its "as of" date and a price its "priced" date, and reading
// the page again changes neither. The page also reads again by itself when it
// comes back into view and every few minutes (lib/useSources.js).
export default function Freshness({ title, loadedAt, refreshing, onRefresh }) {
  const label = refreshing ? 'Refreshing…' : loadedLabel(loadedAt);
  // The revamp (design/prototype): the button is a refresh icon with the time
  // it last read beside it; the full "Loaded 14 Nov, 14:32" is its hover.
  const time = loadedAt ? loadedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className="fresh-row">
      {title ? <h1 className="fresh-title">{title}</h1> : <span />}
      <span className="fresh" aria-live="polite">
        {/* "Refreshing…" is a status and shows; "Loaded 14:32" is said to
            screen readers, and shown as the button's time. */}
        <span className={refreshing ? 'fresh-status' : 'fresh-when'}>{label}</span>
        {onRefresh && (
          <button type="button" className="fresh-btn" data-spin={refreshing || undefined} onClick={onRefresh} disabled={refreshing} title={label || undefined} aria-label="Refresh">
            <Icon name="refresh" />
            {time && <span aria-hidden="true">{time}</span>}
          </button>
        )}
      </span>
    </div>
  );
}
