import { couldntLoad } from '../../lib/loadState';

// In place of a list or a figure whose records never arrived. An empty
// placeholder reads as "you have none", which can send someone to add their
// goals or debts a second time, and a figure worked out without them reads as
// the answer. Nothing is lost: the records are still there to load.
export default function Withheld({ missing, children, onRetry }) {
  return (
    <div className="ov-empty" style={{ marginTop: 22 }}>
      <div className="ov-empty-kicker">{couldntLoad(missing)}</div>
      <div className="ov-empty-body">{children}</div>
      {onRetry && (
        <div className="ov-empty-actions">
          <button type="button" className="om-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
