import { formatMoney } from '../../lib/money';

// Part of the transaction editor (TransactionEditor.jsx), split out with
// the round 2 cleanup (SHR-383).
//
// A new record that looks like one already saved: saving both is allowed, and
// "Both are real" remembers the pair so the monthly review doesn't ask again.
export default function DuplicateNotice({ duplicate, onBothReal, onOpenOther }) {
  if (!duplicate) return null;
  return (
    <div className="te-duplicate" role="status">
      <div className="te-duplicate-title">A record like this already exists</div>
      <div className="te-duplicate-body">
        {duplicate.merchant}, {formatMoney(duplicate.amount)},{' '}
        {new Date(duplicate.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — within a few days
        of this one. Saving both is allowed if the household really spent twice.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 11, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="om-btn"
          onClick={onBothReal}
        >
          Both are real
        </button>
        {onOpenOther && (
          <button type="button" className="om-btn" onClick={() => onOpenOther(duplicate)}>
            Open the other record
          </button>
        )}
      </div>
    </div>
  );
}
