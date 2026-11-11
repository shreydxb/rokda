import { formatSigned } from '../../lib/money';
import { parseDay } from '../../lib/day';

// Part of the transaction editor (TransactionEditor.jsx), split out with
// the round 2 cleanup (SHR-383).
//
// A record whose other side is already in the ledger (the card payment out
// of the current account, and the same payment arriving on the card), which
// can be made one transfer so neither counts as income or spending.
export default function TransferPairs({ pairs, accounts, saving, onMake }) {
  if (pairs.length === 0) return null;
  return (
    <div className="te-duplicate" role="status">
      <div className="te-duplicate-title">This looks like one side of a transfer</div>
      <div className="te-duplicate-body">
        The same amount went the other way on another account within a few days. If this was money moved between your own accounts, make the two one
        transfer: it then counts as neither income nor spending.
      </div>
      <div className="mn-list" style={{ marginTop: 8 }}>
        {pairs.slice(0, 3).map((p) => (
          <div key={p.id} className="mn-row" style={{ cursor: 'default', alignItems: 'center' }}>
            <div className="mn-row-main">
              <div>{accounts.find((a) => a.id === p.account_id)?.name ?? 'Another account'}</div>
              <div className="ov-muted">
                {p.merchant || 'No merchant'} · {parseDay(p.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {formatSigned(p.amount)}
              </div>
            </div>
            <button type="button" className="om-btn" disabled={saving} onClick={() => onMake(p)}>
              Make these one transfer
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
